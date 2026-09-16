/**
 * jsonl-usage-event-store-filter.test.ts — the optional attribute filter on
 * the four aggregate views (usage-filter):
 *  - exact filtering while rows are read (today / partial days) AND, since
 *    rollup v2, for closed days answered from the rollup's attribute splits
 *    (totals / by-model / by-api-key / timeseries all agree with an unfiltered
 *    query over the same subset);
 *  - PRUNED days: a v2 rollup keeps every filtered view exact (the pre-v2
 *    limitations — key-filtered by-model and filtered trends could not see a
 *    pruned day — are lifted); a hand-written V1 sidecar (a day pruned before
 *    v2 existed) keeps the historical v1 composition and limitations.
 */

import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { UsageEventInput, UsageEventRecord } from '@omnicross/contracts/usage-stats-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Spy on `streamShardRows` — the rollup builder's and session drilldown's
// whole-shard reader — so a test can prove an aggregate query was answered
// from ROLLUPS by asserting no shard was streamed for it. The real function
// still runs; the days it touched are just recorded.
const streamSpy = vi.hoisted(() => ({ days: [] as string[] }));
vi.mock('../usage/usageShardCache', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../usage/usageShardCache')>();
  const real = mod.streamShardRows;
  return {
    ...mod,
    streamShardRows: (
      usageDir: string,
      dayKey: string,
      onRow: (row: UsageEventRecord) => void,
    ): Promise<void> => {
      streamSpy.days.push(dayKey);
      return real(usageDir, dayKey, onRow);
    },
  };
});

import { JsonlUsageEventStore } from '../ports/JsonlUsageEventStore';
import { usageRollupName, usageShardName } from '../usage/usageFiles';

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

  it('a combined provider+key filter intersects exactly', async () => {
    const filtered = await store.getTotals(range, { providerId: 'codex', apiKeyId: 'key-2' });
    expect(filtered.eventCount).toBe(1); // only DAY_B's model-y row
    expect(filtered.inputTokens).toBe(400);
    expect(filtered.costUsd).toBeCloseTo(0.5, 10);
  });
});

describe('filtered closed days are served from the rollup, not the shard', () => {
  beforeEach(async () => {
    await store.insert(event({ ts: DAY_A, providerId: 'codex', apiKeyId: 'key-1', inputTokens: 100 }));
    await store.insert(event({ ts: DAY_A, providerId: 'z-ai', apiKeyId: 'key-2', inputTokens: 200 }));
    await store.insert(event({ ts: DAY_B, providerId: 'codex', apiKeyId: 'key-2', model: 'model-y', inputTokens: 400 }));
    // Build both closed days' rollups (this streams both shards), then start
    // counting: any whole-shard stream from here on is a query falling off the
    // rollup path — exactly the regression this suite pins.
    await store.getTotals(range);
    streamSpy.days.length = 0;
  });

  it('filtered totals/by-model/timeseries return full data and stream no shard', async () => {
    const totals = await store.getTotals(range, { providerId: 'codex' });
    expect(totals.eventCount).toBe(2);
    expect(totals.inputTokens).toBe(500);

    const models = await store.getByModel(range, { apiKeyId: 'key-2' });
    expect(models.map((m) => `${m.providerId}:${m.model}`).sort()).toEqual(['codex:model-y', 'z-ai:model-x']);

    const series = await store.getTimeSeries(range, 'day', { providerId: 'codex' });
    expect(series[0]).toMatchObject({ requests: 1, inputTokens: 100 });
    expect(series[1]).toMatchObject({ requests: 1, inputTokens: 400 });

    expect(streamSpy.days).toEqual([]); // answered from sidecars, not shards
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

  it('provider- AND key-filtered by-model both see the pruned day (v2 splits)', async () => {
    const byProvider = await store.getByModel(range, { providerId: 'codex' });
    expect(byProvider).toHaveLength(1);
    expect(byProvider[0].eventCount).toBe(2);
    expect(byProvider[0].inputTokens).toBe(500);

    const byKey = await store.getByModel(range, { apiKeyId: 'key-1' });
    expect(byKey).toHaveLength(1);
    expect(byKey[0].eventCount).toBe(2); // DAY_A (rollup cells) + DAY_B (rows)
    expect(byKey[0].inputTokens).toBe(500);
  });

  it('filtered timeseries sees the pruned day (v2 hour cells)', async () => {
    const series = await store.getTimeSeries(range, 'day', { providerId: 'codex' });
    expect(series[0]).toMatchObject({ requests: 1, inputTokens: 100 }); // pruned DAY_A, exact
    expect(series[1]).toMatchObject({ requests: 1, inputTokens: 400 }); // DAY_B streamed
  });

  it('unfiltered queries still answer the pruned day from its whole-day rollup', async () => {
    const all = await store.getTotals(range);
    expect(all.eventCount).toBe(3);
    expect(all.inputTokens).toBe(700);
  });
});

describe('a V1 sidecar (pruned before rollup v2) keeps the historical composition', () => {
  beforeEach(async () => {
    await store.insert(event({ ts: DAY_A, providerId: 'codex', apiKeyId: 'key-1', inputTokens: 100 }));
    await store.insert(event({ ts: DAY_A, providerId: 'z-ai', apiKeyId: 'key-2', inputTokens: 200 }));
    await store.insert(event({ ts: DAY_B, providerId: 'codex', apiKeyId: 'key-1', inputTokens: 400 }));
    // Build DAY_A's rollup, then DOWNGRADE its sidecar to the v1 shape a day
    // pruned before v2 would have on disk: version 1, no attribute splits.
    await store.getTotals(range);
    const sidecar = join(tmpDir, 'usage', usageRollupName('2026-01-05'));
    const doc = JSON.parse(readFileSync(sidecar, 'utf8')) as Record<string, unknown>;
    delete doc['byAttribute'];
    delete doc['byModelKey'];
    delete doc['byHourKey'];
    doc['version'] = 1;
    writeFileSync(sidecar, JSON.stringify(doc), 'utf8');
    // Prune the shard; the v1 sidecar is now the sole authority for DAY_A.
    unlinkSync(join(tmpDir, 'usage', usageShardName('2026-01-05')));
    store.resetCaches();
  });

  it('provider-filtered totals still compose from the v1 sub-groups', async () => {
    const filtered = await store.getTotals(range, { providerId: 'codex' });
    expect(filtered.eventCount).toBe(2);
    expect(filtered.inputTokens).toBe(500);
  });

  it('a key-filtered by-model cannot see the v1 day (historical limitation)', async () => {
    const byKey = await store.getByModel(range, { apiKeyId: 'key-1' });
    expect(byKey).toHaveLength(1);
    expect(byKey[0].eventCount).toBe(1); // DAY_B only
  });

  it('a filtered timeseries cannot see the v1 day (historical limitation)', async () => {
    const series = await store.getTimeSeries(range, 'day', { providerId: 'codex' });
    expect(series[0]).toMatchObject({ requests: 0, inputTokens: 0 });
    expect(series[1]).toMatchObject({ requests: 1, inputTokens: 400 });
  });

  it('a v1 sidecar whose shard EXISTS is upgraded to v2 on first touch', async () => {
    // Downgrade DAY_B's sidecar the same way, but KEEP its shard — the
    // upgrade path (rebuild from rows) must then fire on the next touch.
    const sidecar = join(tmpDir, 'usage', usageRollupName('2026-01-06'));
    const doc = JSON.parse(readFileSync(sidecar, 'utf8')) as Record<string, unknown>;
    delete doc['byAttribute'];
    delete doc['byModelKey'];
    delete doc['byHourKey'];
    doc['version'] = 1;
    writeFileSync(sidecar, JSON.stringify(doc), 'utf8');
    store.resetCaches();

    const totals = await store.getTotals(range); // touches both days
    expect(totals.eventCount).toBe(3);
    const upgraded = JSON.parse(
      readFileSync(sidecar, 'utf8'),
    ) as { version: number; byAttribute?: unknown[] };
    expect(upgraded.version).toBe(2);
    expect(Array.isArray(upgraded.byAttribute)).toBe(true);
    // Query-visible: a key-filtered timeseries sees DAY_B's hour cells — a
    // still-v1 sidecar would contribute nothing to a filtered trend. (DAY_A
    // stays v1-pruned and invisible to a key filter, as above.)
    const series = await store.getTimeSeries(range, 'day', { apiKeyId: 'key-1' });
    expect(series[1]).toMatchObject({ requests: 1, inputTokens: 400 });
  });
});
