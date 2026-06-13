/**
 * Unit tests for `PricingEngine` against a pure in-memory `PricingStore` fake.
 *
 * Covers: getEntry layered resolution, calculateCost formula (cache-price
 * fallback, savings clamp, unpriced), upsertManual cache write-through,
 * source fetch parse (aliases, skips, per-1M conversion), refresh conflict
 * split (user-edited protection), resolveConflicts counting + unmatched
 * decision ignore, and fetch-failure log+rethrow.
 */

import type {
  PricingEntry,
  PricingEntryInput,
  PricingResolution,
} from '@omnicross/contracts/pricing-types';
import type { UsageTokens } from '@omnicross/contracts/usage-types';
import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../ports/logger';
import type { PricingStore } from '../../ports/pricing-store';
import { PricingEngine } from '../pricing-engine';

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function entry(partial: Partial<PricingEntry> & Pick<PricingEntry, 'providerId' | 'modelId'>): PricingEntry {
  return {
    inputPricePer1m: 1,
    outputPricePer1m: 2,
    cacheReadPricePer1m: null,
    cacheWritePricePer1m: null,
    source: 'builtin',
    userEdited: false,
    editedAt: null,
    updatedAt: 0,
    ...partial,
  };
}

/** In-memory PricingStore fake with the user-edited conflict-split semantics. */
class FakePricingStore implements PricingStore {
  rows = new Map<string, PricingEntry>();

  constructor(seed: PricingEntry[] = []) {
    for (const r of seed) this.rows.set(`${r.providerId}::${r.modelId}`, r);
  }

  getAll = vi.fn(async (): Promise<PricingEntry[]> => Array.from(this.rows.values()));

  upsert = vi.fn(async (input: PricingEntryInput, asUserEdit: boolean): Promise<PricingEntry> => {
    const row = entry({
      ...input,
      cacheReadPricePer1m: input.cacheReadPricePer1m ?? null,
      cacheWritePricePer1m: input.cacheWritePricePer1m ?? null,
      source: asUserEdit ? 'user' : 'litellm',
      userEdited: asUserEdit,
      editedAt: asUserEdit ? 123 : null,
      updatedAt: 123,
    });
    this.rows.set(`${row.providerId}::${row.modelId}`, row);
    return row;
  });

  bulkApplyFromSource = vi.fn(
    async (
      entries: PricingEntryInput[],
    ): Promise<{ applied: PricingEntry[]; conflicts: Array<{ current: PricingEntry; incoming: PricingEntryInput }> }> => {
      const applied: PricingEntry[] = [];
      const conflicts: Array<{ current: PricingEntry; incoming: PricingEntryInput }> = [];
      for (const incoming of entries) {
        const key = `${incoming.providerId}::${incoming.modelId}`;
        const current = this.rows.get(key);
        if (current?.userEdited) {
          conflicts.push({ current, incoming });
          continue;
        }
        const row = await this.upsert(incoming, false);
        applied.push(row);
      }
      return { applied, conflicts };
    },
  );

  applyResolutions = vi.fn(
    async (
      resolutions: Array<{ incoming: PricingEntryInput; action: 'overwrite' | 'skip' }>,
    ): Promise<PricingResolution> => {
      let overwrittenCount = 0;
      let skippedCount = 0;
      for (const r of resolutions) {
        if (r.action === 'overwrite') {
          await this.upsert(r.incoming, false);
          overwrittenCount++;
        } else {
          skippedCount++;
        }
      }
      return { overwrittenCount, skippedCount };
    },
  );
}

const usage = (u: Partial<UsageTokens> = {}): UsageTokens => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  reasoningTokens: 0,
  ...u,
});

const okJsonResponse = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

describe('PricingEngine.getEntry resolution order', () => {
  it('exact (providerId, modelId) match wins over wildcard and model-only', async () => {
    const store = new FakePricingStore([
      entry({ providerId: 'anthropic', modelId: 'm', inputPricePer1m: 10 }),
      entry({ providerId: '*', modelId: 'm', inputPricePer1m: 20 }),
      entry({ providerId: 'openai', modelId: 'm', inputPricePer1m: 30 }),
    ]);
    const engine = new PricingEngine(store, makeLogger());
    const got = await engine.getEntry('anthropic', 'm');
    expect(got?.inputPricePer1m).toBe(10);
  });

  it('wildcard provider matches when no exact entry exists', async () => {
    const store = new FakePricingStore([
      entry({ providerId: '*', modelId: 'm', inputPricePer1m: 20 }),
    ]);
    const engine = new PricingEngine(store, makeLogger());
    const got = await engine.getEntry('whatever', 'm');
    expect(got?.inputPricePer1m).toBe(20);
  });

  it('model-only fallback bridges runtime-alias provider ids (first non-wildcard wins)', async () => {
    const store = new FakePricingStore([
      entry({ providerId: 'anthropic', modelId: 'm', inputPricePer1m: 10 }),
      entry({ providerId: 'openai', modelId: 'm', inputPricePer1m: 30 }),
    ]);
    const engine = new PricingEngine(store, makeLogger());
    const got = await engine.getEntry('some-runtime-alias', 'm');
    // First non-wildcard entry per model in getAll() order.
    expect(got?.providerId).toBe('anthropic');
  });

  it('wildcard rows are excluded from the model-only index', async () => {
    const store = new FakePricingStore([
      entry({ providerId: '*', modelId: 'other-model', inputPricePer1m: 20 }),
    ]);
    const engine = new PricingEngine(store, makeLogger());
    // wildcard only matches its own modelId via step 2; model-only index skips '*'.
    expect(await engine.getEntry('p', 'missing-model')).toBeNull();
  });

  it('returns null when nothing matches', async () => {
    const engine = new PricingEngine(new FakePricingStore(), makeLogger());
    expect(await engine.getEntry('p', 'm')).toBeNull();
  });
});

describe('PricingEngine.calculateCost', () => {
  it('applies the full formula with all four prices and computes savings', async () => {
    const store = new FakePricingStore([
      entry({
        providerId: 'p',
        modelId: 'm',
        inputPricePer1m: 3,
        outputPricePer1m: 15,
        cacheReadPricePer1m: 0.3,
        cacheWritePricePer1m: 3.75,
      }),
    ]);
    const engine = new PricingEngine(store, makeLogger());
    const result = await engine.calculateCost(
      'p',
      'm',
      usage({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheCreationTokens: 100 }),
    );
    const expectedCost = (1000 * 3 + 500 * 15 + 2000 * 0.3 + 100 * 3.75) / 1_000_000;
    const expectedSavings = (2000 * (3 - 0.3)) / 1_000_000;
    expect(result.costUsd).toBeCloseTo(expectedCost, 12);
    expect(result.costSavedByCacheUsd).toBeCloseTo(expectedSavings, 12);
  });

  it('falls back to the input price for null cache prices and reports 0 savings', async () => {
    const store = new FakePricingStore([
      entry({ providerId: 'p', modelId: 'm', inputPricePer1m: 2, outputPricePer1m: 4 }),
    ]);
    const engine = new PricingEngine(store, makeLogger());
    const result = await engine.calculateCost(
      'p',
      'm',
      usage({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 30, cacheCreationTokens: 20 }),
    );
    expect(result.costUsd).toBeCloseTo((100 * 2 + 50 * 4 + 30 * 2 + 20 * 2) / 1_000_000, 12);
    expect(result.costSavedByCacheUsd).toBe(0);
  });

  it('clamps savings at 0 when cacheReadPrice >= inputPrice', async () => {
    const store = new FakePricingStore([
      entry({ providerId: 'p', modelId: 'm', inputPricePer1m: 1, outputPricePer1m: 2, cacheReadPricePer1m: 5 }),
    ]);
    const engine = new PricingEngine(store, makeLogger());
    const result = await engine.calculateCost('p', 'm', usage({ cacheReadTokens: 1000 }));
    expect(result.costSavedByCacheUsd).toBe(0);
  });

  it('returns {0, 0} for an unpriced model without throwing', async () => {
    const engine = new PricingEngine(new FakePricingStore(), makeLogger());
    await expect(engine.calculateCost('p', 'm', usage({ inputTokens: 999 }))).resolves.toEqual({
      costUsd: 0,
      costSavedByCacheUsd: 0,
    });
  });
});

describe('PricingEngine.upsertManual', () => {
  it('writes through to both cache indexes — subsequent lookup sees the edit without a store reload', async () => {
    const store = new FakePricingStore();
    const engine = new PricingEngine(store, makeLogger());
    await engine.getAll(); // load (empty) cache
    store.getAll.mockClear();

    const updated = await engine.upsertManual({
      providerId: 'p',
      modelId: 'm',
      inputPricePer1m: 7,
      outputPricePer1m: 9,
    });
    expect(updated.userEdited).toBe(true);
    expect(store.upsert).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'p' }), true);

    expect((await engine.getEntry('p', 'm'))?.inputPricePer1m).toBe(7);
    // model-only index updated too
    expect((await engine.getEntry('other', 'm'))?.inputPricePer1m).toBe(7);
    expect(store.getAll).not.toHaveBeenCalled();
  });

  it('skips the model-only index for wildcard provider rows', async () => {
    const store = new FakePricingStore();
    const engine = new PricingEngine(store, makeLogger());
    await engine.getAll();
    await engine.upsertManual({ providerId: '*', modelId: 'm', inputPricePer1m: 7, outputPricePer1m: 9 });
    // exact wildcard lookup resolves (step 2), but a different model misses
    expect(await engine.getEntry('p', 'm')).not.toBeNull();
    expect(await engine.getEntry('p', 'other')).toBeNull();
  });
});

describe('PricingEngine.fetchLatestFromSource', () => {
  const sourceJson = {
    'model-a': {
      input_cost_per_token: 0.000003,
      output_cost_per_token: 0.000015,
      cache_read_input_token_cost: 0.0000003,
      cache_creation_input_token_cost: 0.00000375,
      litellm_provider: 'anthropic',
    },
    'model-vertex': {
      input_cost_per_token: 0.000001,
      output_cost_per_token: 0.000002,
      litellm_provider: 'vertex_ai',
    },
    'model-google': {
      input_cost_per_token: 0.000001,
      output_cost_per_token: 0.000002,
      litellm_provider: 'google',
    },
    'model-bedrock': {
      input_cost_per_token: 0.000001,
      output_cost_per_token: 0.000002,
      litellm_provider: 'bedrock',
    },
    'model-azure': {
      input_cost_per_token: 0.000001,
      output_cost_per_token: 0.000002,
      litellm_provider: 'azure',
    },
    'model-no-output': { input_cost_per_token: 0.000001, litellm_provider: 'openai' },
    'model-no-provider': { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 },
  };

  it('parses per-token costs ×1e6, maps provider aliases, skips malformed entries', async () => {
    const store = new FakePricingStore();
    const fetchImpl = vi.fn(async () => okJsonResponse(sourceJson)) as unknown as typeof fetch;
    const engine = new PricingEngine(store, makeLogger(), { sourceUrl: 'https://example.test/p.json', fetchImpl });

    const result = await engine.fetchLatestFromSource();

    expect(result.sourceUrl).toBe('https://example.test/p.json');
    expect(typeof result.fetchedAt).toBe('number');
    expect(result.conflicts).toEqual([]);

    const byModel = new Map(result.applied.map(e => [e.modelId, e]));
    expect(byModel.size).toBe(5); // the two malformed entries skipped
    const a = byModel.get('model-a');
    expect(a).toMatchObject({
      providerId: 'anthropic',
      inputPricePer1m: 3,
      outputPricePer1m: 15,
    });
    expect(a?.cacheReadPricePer1m).toBeCloseTo(0.3, 9);
    expect(a?.cacheWritePricePer1m).toBeCloseTo(3.75, 9);
    expect(byModel.get('model-vertex')?.providerId).toBe('gemini');
    expect(byModel.get('model-google')?.providerId).toBe('gemini');
    expect(byModel.get('model-bedrock')?.providerId).toBe('anthropic');
    expect(byModel.get('model-azure')?.providerId).toBe('openai');
    // optional cache prices absent → null
    expect(byModel.get('model-vertex')?.cacheReadPricePer1m).toBeNull();
    expect(byModel.get('model-vertex')?.cacheWritePricePer1m).toBeNull();
  });

  it('surfaces user-edited rows as conflicts and leaves them untouched', async () => {
    const store = new FakePricingStore([
      entry({ providerId: 'anthropic', modelId: 'model-a', inputPricePer1m: 99, userEdited: true, source: 'user' }),
    ]);
    const fetchImpl = vi.fn(async () =>
      okJsonResponse({ 'model-a': sourceJson['model-a'] }),
    ) as unknown as typeof fetch;
    const engine = new PricingEngine(store, makeLogger(), { fetchImpl });

    const result = await engine.fetchLatestFromSource();

    expect(result.applied).toEqual([]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      providerId: 'anthropic',
      modelId: 'model-a',
      current: expect.objectContaining({ inputPricePer1m: 99, userEdited: true }),
      incoming: expect.objectContaining({ inputPricePer1m: 3 }),
    });
    // local row untouched
    expect((await engine.getEntry('anthropic', 'model-a'))?.inputPricePer1m).toBe(99);
  });

  it('invalidates the cache so applied entries are visible', async () => {
    const store = new FakePricingStore();
    const fetchImpl = vi.fn(async () =>
      okJsonResponse({ 'model-a': sourceJson['model-a'] }),
    ) as unknown as typeof fetch;
    const engine = new PricingEngine(store, makeLogger(), { fetchImpl });
    expect(await engine.getEntry('anthropic', 'model-a')).toBeNull();

    await engine.fetchLatestFromSource();
    expect((await engine.getEntry('anthropic', 'model-a'))?.inputPricePer1m).toBe(3);
  });

  it('logs a warning and rethrows on fetch failure', async () => {
    const logger = makeLogger();
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
    const engine = new PricingEngine(new FakePricingStore(), logger, { fetchImpl });

    await expect(engine.fetchLatestFromSource()).rejects.toThrow('status 503');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('fetch failed'),
      expect.objectContaining({ error: expect.stringContaining('503') }),
    );
  });

  it('logs and rethrows network errors from the fetch impl', async () => {
    const logger = makeLogger();
    const fetchImpl = vi.fn(async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    const engine = new PricingEngine(new FakePricingStore(), logger, { fetchImpl });

    await expect(engine.fetchLatestFromSource()).rejects.toThrow('boom');
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('PricingEngine.resolveConflicts', () => {
  it('forwards matched decisions, counts overwrite/skip, ignores unmatched decisions', async () => {
    const store = new FakePricingStore([
      entry({ providerId: 'p', modelId: 'a', inputPricePer1m: 1, userEdited: true }),
      entry({ providerId: 'p', modelId: 'b', inputPricePer1m: 1, userEdited: true }),
    ]);
    const engine = new PricingEngine(store, makeLogger());

    const pending = new Map<string, PricingEntryInput>([
      ['p::a', { providerId: 'p', modelId: 'a', inputPricePer1m: 5, outputPricePer1m: 6 }],
      ['p::b', { providerId: 'p', modelId: 'b', inputPricePer1m: 7, outputPricePer1m: 8 }],
    ]);

    const result = await engine.resolveConflicts(
      [
        { providerId: 'p', modelId: 'a', action: 'overwrite' },
        { providerId: 'p', modelId: 'b', action: 'skip' },
        { providerId: 'p', modelId: 'no-pending', action: 'overwrite' },
      ],
      pending,
    );

    expect(result).toEqual({ overwrittenCount: 1, skippedCount: 1 });
    expect(store.applyResolutions).toHaveBeenCalledWith([
      { incoming: pending.get('p::a'), action: 'overwrite' },
      { incoming: pending.get('p::b'), action: 'skip' },
    ]);
    // cache invalidated — overwritten row visible, skipped row unchanged
    expect((await engine.getEntry('p', 'a'))?.inputPricePer1m).toBe(5);
    expect((await engine.getEntry('p', 'b'))?.inputPricePer1m).toBe(1);
  });
});
