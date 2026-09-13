/**
 * jsonl-usage-event-store-filter.test.ts — the optional attribute filter on
 * the four aggregate views (usage-filter):
 *  - exact per-row filtering while shards exist (totals / by-model / by-api-key
 *    / timeseries all agree with an unfiltered query over the same subset);
 *  - PRUNED days: provider-filtered totals and by-model compose from the
 *    rollup's sub-groups; an apiKeyId-filtered by-model and a filtered
 *    timeseries cannot see a pruned day (documented limitation).
 */

import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { UsageEventInput } from '@omnicross/contracts/usage-stats-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JsonlUsageEventStore } from '../ports/JsonlUsageEventStore';

let tmpDir: string;
let store: JsonlUsageEventStore;

/** Two fixed PAST local days (never "today", so rollups are eligible). */
const DAY_A = new Date(2026, 0, 5, 12, 0, 0).getTime();
const DAY_B = new Date(2026, 0, 6, 12, 0, 0).getTime();
const range = {
  startTs: new Date(2026, 0, 5, 0, 0, 0).getTime(),
  endTs: new Date(2026, 0, 7, 0, 0, 0).getTime(),
};

const event = (over: Partial<UsageEventInput> = {}): UsageEventInput => ({
  messageId: null,
  parentMessageId: null,
  sessionId: null,
  providerId: 'codex',
  model: 'model-x',
  apiKeyId: 'key-1',
  engineOrigin: 'completion',
  inputTokens: 10,
  outputTokens: 20,
  cacheReadTokens: 5,
  cacheCreationTokens: 2,
  reasoningTokens: 1,
  costUsd: 0.5,
  costSavedByCacheUsd: 0.1,
  rawUsage: null,
  ...over,
});

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-usage-filter-'));
  store = new JsonlUsageEventStore(join(tmpDir, 'usage-events.jsonl'), async () => true);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('filtered queries over retained shards', () => {
  beforeEach(async () => {
    await store.insert(event({ ts: DAY_A, providerId: 'codex', apiKeyId: 'key-1', inputTokens: 100 }));
    await store.insert(event({ ts: DAY_A, providerId: 'z-ai', apiKeyId: 'key-2', inputTokens: 200 }));
    await store.insert(event({ ts: DAY_B, providerId: 'codex', apiKeyId: 'key-2', model: 'model-y', inputTokens: 400 }));
    await store.insert(event({ ts: DAY_B, providerId: 'codex', apiKeyId: null, inputTokens: 800 }));
  });

  it('provider-filtered totals match the unfiltered subset exactly', async () => {
    const filtered = await store.getTotals(range, { providerId: 'codex' });
    const all = await store.getTotals(range);
    expect(filtered.eventCount).toBe(3);
    expect(filtered.inputTokens).toBe(100 + 400 + 800);
    expect(all.eventCount).toBe(4);

    const zai = await store.getTotals(range, { providerId: 'z-ai' });
    expect(zai.eventCount).toBe(1);
    expect(zai.inputTokens).toBe(200);
    // Cache-rate metrics cover the filtered rows too.
    expect(zai.medianCacheHitRate).not.toBeNull();
  });

  it('apiKeyId-filtered totals restrict to that key', async () => {
    const filtered = await store.getTotals(range, { apiKeyId: 'key-1' });
    expect(filtered.eventCount).toBe(1);
    expect(filtered.inputTokens).toBe(100);
    expect(filtered.costUsd).toBeCloseTo(0.5, 10);
  });

  it('by-model filters by provider and by key', async () => {
    const byProvider = await store.getByModel(range, { providerId: 'codex' });
    expect(byProvider.map((r) => r.model).sort()).toEqual(['model-x', 'model-y']);
    expect(byProvider.every((r) => r.providerId === 'codex')).toBe(true);

    const byKey = await store.getByModel(range, { apiKeyId: 'key-2' });
    expect(byKey.map((r) => `${r.providerId}:${r.model}`).sort()).toEqual(['codex:model-y', 'z-ai:model-x']);
  });

  it('by-api-key filters by provider and by key', async () => {
    const rows = await store.getByApiKey(range, { providerId: 'codex' });
    expect(rows.map((r) => r.apiKeyId).sort()).toEqual(['key-1', 'key-2', null]);

    const one = await store.getByApiKey(range, { apiKeyId: 'key-1' });
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ apiKeyId: 'key-1', eventCount: 1, inputTokens: 100 });
  });

  it('filtered timeseries buckets only matching rows', async () => {
    const series = await store.getTimeSeries(range, 'day', { providerId: 'z-ai' });
    expect(series).toHaveLength(2);
    expect(series[0]).toMatchObject({ requests: 1, inputTokens: 200 });
    expect(series[1]).toMatchObject({ requests: 0, inputTokens: 0 });
  });

  it('an empty filter object behaves as no filter', async () => {
    const withEmpty = await store.getTotals(range, {});
    const without = await store.getTotals(range);
    expect(withEmpty).toEqual(without);
  });
});

describe('filtered queries over pruned days', () => {
  beforeEach(async () => {
    await store.insert(event({ ts: DAY_A, providerId: 'codex', apiKeyId: 'key-1', inputTokens: 100, cacheReadTokens: 40 }));
    await store.insert(event({ ts: DAY_A, providerId: 'z-ai', apiKeyId: 'key-2', inputTokens: 200 }));
    await store.insert(event({ ts: DAY_B, providerId: 'codex', apiKeyId: 'key-1', inputTokens: 400 }));
    // Build both days' rollups…
    await store.getTotals(range);
    // …then prune DAY_A's shard (the sweeper deletes the raw file, keeps the
    // rollup) and drop memoised shard rows.
    unlinkSync(join(tmpDir, 'usage', 'usage-2026-01-05.jsonl'));
    store.resetCaches();
  });

  it('provider-filtered totals compose the pruned day from its rollup', async () => {
    const filtered = await store.getTotals(range, { providerId: 'codex' });
    expect(filtered.eventCount).toBe(2); // DAY_A (rollup) + DAY_B (streamed)
    expect(filtered.inputTokens).toBe(100 + 400);
    // 40 (DAY_A pruned, rollup-composed) + 5 (DAY_B streamed default).
    expect(filtered.cacheReadTokens).toBe(45);
    expect(filtered.reasoningTokens).toBe(2);
  });

  it('apiKey-filtered totals compose the pruned day including additive rollup fields', async () => {
    const filtered = await store.getTotals(range, { apiKeyId: 'key-1' });
    expect(filtered.eventCount).toBe(2);
    expect(filtered.inputTokens).toBe(100 + 400);
    expect(filtered.cacheReadTokens).toBe(45); // 40 composed + 5 streamed
    expect(filtered.costUsd).toBeCloseTo(1.0, 10);
  });

  it('provider-filtered by-model sees the pruned day; key-filtered by-model does not', async () => {
    const byProvider = await store.getByModel(range, { providerId: 'codex' });
    expect(byProvider).toHaveLength(1);
    expect(byProvider[0].eventCount).toBe(2);
    expect(byProvider[0].inputTokens).toBe(500);

    const byKey = await store.getByModel(range, { apiKeyId: 'key-1' });
    expect(byKey).toHaveLength(1);
    expect(byKey[0].eventCount).toBe(1); // DAY_B only — documented limitation
    expect(byKey[0].inputTokens).toBe(400);
  });

  it('filtered timeseries skips pruned days (documented limitation)', async () => {
    const series = await store.getTimeSeries(range, 'day', { providerId: 'codex' });
    expect(series[0]).toMatchObject({ requests: 0, inputTokens: 0 }); // pruned DAY_A
    expect(series[1]).toMatchObject({ requests: 1, inputTokens: 400 }); // DAY_B streamed
  });

  it('unfiltered queries still answer the pruned day from its whole-day rollup', async () => {
    const all = await store.getTotals(range);
    expect(all.eventCount).toBe(3);
    expect(all.inputTokens).toBe(700);
  });
});
