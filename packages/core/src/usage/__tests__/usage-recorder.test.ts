/**
 * Unit tests for `UsageRecorder` against an in-memory `UsageEventStore` fake.
 *
 * Covers: cost stamping via the pricing engine, optional-field normalization,
 * rawUsage stringification (incl. circular → ''), insert rejection → null +
 * warn, fire-and-forget `record()` defer behavior, and aggregate pass-through
 * delegation.
 */

import type {
  ApiKeyUsageRow,
  MessageUsageRow,
  ModelUsageRow,
  SessionCacheStats,
  UsageEventInput,
  UsageTotals,
} from '@omnicross/contracts/usage-stats-types';
import type { UsageTokens } from '@omnicross/contracts/usage-types';
import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../ports/logger';
import type { UsageEventStore } from '../../ports/usage-event-store';
import type { PricingEngine } from '../pricing-engine';
import type { UsageRecordInput } from '../usage-recorder';
import { UsageRecorder } from '../usage-recorder';

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makePricing(cost = { costUsd: 0.5, costSavedByCacheUsd: 0.1 }): PricingEngine {
  return { calculateCost: vi.fn(async () => cost) } as unknown as PricingEngine;
}

const totals: UsageTotals = {
  inputTokens: 1,
  outputTokens: 2,
  cacheReadTokens: 3,
  cacheCreationTokens: 4,
  reasoningTokens: 5,
  costUsd: 6,
  costSavedByCacheUsd: 7,
  eventCount: 8,
};
const modelRows: ModelUsageRow[] = [];
const keyRows: ApiKeyUsageRow[] = [];
const messageRows: MessageUsageRow[] = [];
const cacheStats: SessionCacheStats = {
  sessionId: 's',
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  eventCount: 0,
  hitRate: 0,
};

function makeStore(): UsageEventStore & { inserted: UsageEventInput[] } {
  const inserted: UsageEventInput[] = [];
  return {
    inserted,
    insert: vi.fn(async (input: UsageEventInput) => {
      inserted.push(input);
      return 'row-1';
    }),
    getTotals: vi.fn(async () => totals),
    getByModel: vi.fn(async () => modelRows),
    getByApiKey: vi.fn(async () => keyRows),
    getMessagesForSession: vi.fn(async () => messageRows),
    getSessionCacheStats: vi.fn(async () => cacheStats),
  };
}

const usage: UsageTokens = {
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 25,
  cacheCreationTokens: 10,
  reasoningTokens: 5,
};

const baseInput: UsageRecordInput = {
  providerId: 'p',
  model: 'm',
  engineOrigin: 'completion',
  usage,
};

describe('UsageRecorder.recordAsync', () => {
  it('stamps cost from the pricing engine and persists the row', async () => {
    const store = makeStore();
    const pricing = makePricing();
    const recorder = new UsageRecorder(store, pricing, makeLogger());

    const id = await recorder.recordAsync({
      ...baseInput,
      messageId: 'msg-1',
      sessionId: 'sess-1',
      apiKeyId: 'key-1',
      rawUsage: { a: 1 },
      runId: 'run-1',
      eventId: 'ev-1',
    });

    expect(id).toBe('row-1');
    expect(pricing.calculateCost).toHaveBeenCalledWith('p', 'm', usage);
    expect(store.inserted[0]).toEqual({
      messageId: 'msg-1',
      parentMessageId: null,
      sessionId: 'sess-1',
      providerId: 'p',
      model: 'm',
      apiKeyId: 'key-1',
      engineOrigin: 'completion',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 25,
      cacheCreationTokens: 10,
      reasoningTokens: 5,
      costUsd: 0.5,
      costSavedByCacheUsd: 0.1,
      rawUsage: '{"a":1}',
      runId: 'run-1',
      eventId: 'ev-1',
    });
  });

  it('normalizes absent optional fields to null', async () => {
    const store = makeStore();
    const recorder = new UsageRecorder(store, makePricing(), makeLogger());
    await recorder.recordAsync(baseInput);
    expect(store.inserted[0]).toMatchObject({
      messageId: null,
      parentMessageId: null,
      sessionId: null,
      apiKeyId: null,
      rawUsage: null,
      runId: null,
      eventId: null,
    });
  });

  it('stringifies rawUsage defensively — circular value becomes ""', async () => {
    const store = makeStore();
    const recorder = new UsageRecorder(store, makePricing(), makeLogger());
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await recorder.recordAsync({ ...baseInput, rawUsage: circular });
    expect(store.inserted[0].rawUsage).toBe('');
  });

  it('resolves to null and warns when the store insert rejects', async () => {
    const store = makeStore();
    (store.insert as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('disk full'));
    const logger = makeLogger();
    const recorder = new UsageRecorder(store, makePricing(), logger);

    await expect(recorder.recordAsync(baseInput)).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('insert failed'),
      expect.objectContaining({ error: 'disk full' }),
    );
  });
});

describe('UsageRecorder.record (fire-and-forget)', () => {
  it('returns synchronously before the store is touched; the captured callback performs the persist', async () => {
    const store = makeStore();
    const deferred: Array<() => void> = [];
    const recorder = new UsageRecorder(store, makePricing(), makeLogger(), {
      defer: fn => deferred.push(fn),
    });

    recorder.record(baseInput);

    expect(store.insert).not.toHaveBeenCalled();
    expect(deferred).toHaveLength(1);

    deferred[0]();
    await vi.waitFor(() => expect(store.insert).toHaveBeenCalledTimes(1));
  });

  it('swallows deferred failures — no exception reaches the caller, a warning is logged', async () => {
    const store = makeStore();
    (store.insert as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('nope'));
    const logger = makeLogger();
    const deferred: Array<() => void> = [];
    const recorder = new UsageRecorder(store, makePricing(), logger, {
      defer: fn => deferred.push(fn),
    });

    expect(() => recorder.record(baseInput)).not.toThrow();
    expect(() => deferred[0]()).not.toThrow();
    // recordAsync swallows the insert error itself (warn + null), nothing propagates
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalled());
  });

  it('swallows pricing failures in the deferred path via the catch wrapper', async () => {
    const store = makeStore();
    const pricing = {
      calculateCost: vi.fn(async () => {
        throw new Error('pricing exploded');
      }),
    } as unknown as PricingEngine;
    const logger = makeLogger();
    const deferred: Array<() => void> = [];
    const recorder = new UsageRecorder(store, pricing, logger, { defer: fn => deferred.push(fn) });

    recorder.record(baseInput);
    expect(() => deferred[0]()).not.toThrow();
    await vi.waitFor(() =>
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('failed to persist usage event'),
        expect.objectContaining({ error: 'pricing exploded' }),
      ),
    );
    expect(store.insert).not.toHaveBeenCalled();
  });

  it('defaults to a zero-delay timer when no defer is injected', async () => {
    const store = makeStore();
    const recorder = new UsageRecorder(store, makePricing(), makeLogger());
    recorder.record(baseInput);
    expect(store.insert).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(store.insert).toHaveBeenCalledTimes(1));
  });
});

describe('UsageRecorder aggregate delegates', () => {
  it('passes arguments through unchanged and returns the store results unmodified', async () => {
    const store = makeStore();
    const recorder = new UsageRecorder(store, makePricing(), makeLogger());
    const range = { startTs: 1, endTs: 2 };

    await expect(recorder.getTotals(range)).resolves.toBe(totals);
    expect(store.getTotals).toHaveBeenCalledWith(range);

    await expect(recorder.getByModel(range)).resolves.toBe(modelRows);
    expect(store.getByModel).toHaveBeenCalledWith(range);

    await expect(recorder.getByApiKey(range)).resolves.toBe(keyRows);
    expect(store.getByApiKey).toHaveBeenCalledWith(range);

    await expect(recorder.getMessagesForSession('sess')).resolves.toBe(messageRows);
    expect(store.getMessagesForSession).toHaveBeenCalledWith('sess');

    await expect(recorder.getSessionCacheStats('sess')).resolves.toBe(cacheStats);
    expect(store.getSessionCacheStats).toHaveBeenCalledWith('sess');
  });
});
