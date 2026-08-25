/**
 * usage-rollup-equivalence.test.ts — the load-bearing assertion for the sharded
 * usage store: answering a range from per-day ROLLUPS must produce the same
 * numbers as scanning the raw rows.
 *
 * Everything else in the store is an optimisation around that equality. The
 * expectations here are computed by an independent reference aggregation over
 * the same generated rows, deliberately NOT by calling the store a second way —
 * a bug shared between two code paths would cancel out.
 *
 * Also pins the two properties that make retention safe to turn on at all:
 *  - deleting a day's shard changes NO aggregate, because its rollup survives;
 *  - `getSpendByKey().totalUsd` (the LIFETIME figure the outbound key policy
 *    seeds from) still sums correctly across pruned days.
 */

import { existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { UsageEventInput, UsageEventRecord } from '@omnicross/contracts/usage-stats-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JsonlUsageEventStore } from '../ports/JsonlUsageEventStore';
import { usageRollupName, usageShardName } from '../usage/usageFiles';

let tmpDir: string;
let store: JsonlUsageEventStore;

/** Local wall-clock → unix millis. */
const local = (y: number, mo1: number, d: number, h = 0, mi = 0): number =>
  new Date(y, mo1 - 1, d, h, mi).getTime();
const dayStart = (y: number, mo1: number, d: number): number => new Date(y, mo1 - 1, d).getTime();

const MODELS = [
  { providerId: 'prov-a', model: 'model-x' },
  { providerId: 'prov-a', model: 'model-y' },
  { providerId: 'prov-b', model: 'model-x' },
];
const KEYS: (string | null)[] = ['k1', 'k2', null];

/** Deterministic pseudo-random so a failure is reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

/** Rows spread across three CLOSED days, varied enough to exercise every group. */
function generate(): UsageEventInput[] {
  const rand = lcg(20260826);
  const out: UsageEventInput[] = [];
  for (const [dayIndex, day] of [12, 13, 14].entries()) {
    for (let i = 0; i < 60; i++) {
      const m = MODELS[Math.floor(rand() * MODELS.length)]!;
      const cacheRead = Math.floor(rand() * 500);
      out.push({
        messageId: null,
        parentMessageId: null,
        sessionId: i % 7 === 0 ? `sess-${dayIndex}` : null,
        providerId: m.providerId,
        model: m.model,
        apiKeyId: KEYS[Math.floor(rand() * KEYS.length)]!,
        engineOrigin: 'completion',
        inputTokens: Math.floor(rand() * 400),
        outputTokens: Math.floor(rand() * 200),
        cacheReadTokens: cacheRead,
        cacheCreationTokens: i % 5 === 0 ? Math.floor(rand() * 100) : 0,
        reasoningTokens: Math.floor(rand() * 50),
        costUsd: Math.round(rand() * 1000) / 100,
        costSavedByCacheUsd: Math.round(rand() * 100) / 100,
        rawUsage: null,
        ts: local(2026, 6, day, Math.floor(rand() * 24), Math.floor(rand() * 60)),
      });
    }
  }
  return out;
}

/** Independent reference aggregation — the thing the store must agree with. */
function reference(rows: UsageEventRecord[], startTs: number, endTs: number) {
  const inRange = rows.filter((r) => r.ts >= startTs && r.ts < endTs);
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    costSavedByCacheUsd: 0,
    eventCount: 0,
    cacheEligibleEventCount: 0,
    coldCacheEventCount: 0,
  };
  const rates: number[] = [];
  const byModel = new Map<string, { eventCount: number; costUsd: number; inputTokens: number }>();
  const byKey = new Map<string | null, { eventCount: number; costUsd: number }>();
  for (const r of inRange) {
    totals.inputTokens += r.inputTokens;
    totals.outputTokens += r.outputTokens;
    totals.cacheReadTokens += r.cacheReadTokens;
    totals.cacheCreationTokens += r.cacheCreationTokens;
    totals.reasoningTokens += r.reasoningTokens;
    totals.costUsd += r.costUsd;
    totals.costSavedByCacheUsd += r.costSavedByCacheUsd;
    totals.eventCount += 1;
    const promptSide = r.inputTokens + r.cacheReadTokens + r.cacheCreationTokens;
    if (promptSide > 0) {
      totals.cacheEligibleEventCount += 1;
      if (r.cacheReadTokens === 0) totals.coldCacheEventCount += 1;
      rates.push(r.cacheReadTokens / promptSide);
    }
    const mk = `${r.providerId}::${r.model}`;
    const m = byModel.get(mk) ?? { eventCount: 0, costUsd: 0, inputTokens: 0 };
    m.eventCount += 1;
    m.costUsd += r.costUsd;
    m.inputTokens += r.inputTokens;
    byModel.set(mk, m);
    const k = byKey.get(r.apiKeyId) ?? { eventCount: 0, costUsd: 0 };
    k.eventCount += 1;
    k.costUsd += r.costUsd;
    byKey.set(r.apiKeyId, k);
  }
  rates.sort((a, b) => a - b);
  const mid = Math.floor(rates.length / 2);
  const median =
    rates.length === 0
      ? null
      : rates.length % 2 === 1
        ? rates[mid]!
        : (rates[mid - 1]! + rates[mid]!) / 2;
  return { totals, median, byModel, byKey, inRange };
}

let inserted: UsageEventRecord[];

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-usage-rollup-'));
  store = new JsonlUsageEventStore(join(tmpDir, 'usage-events.jsonl'), async () => true);
  inserted = [];
  for (const input of generate()) {
    const id = await store.insert(input);
    inserted.push({ ...input, id, ts: input.ts as number });
  }
  // A fresh store instance: nothing carried over in memory, so the queries below
  // genuinely go through the on-disk rollup path rather than a warm cache.
  store = new JsonlUsageEventStore(join(tmpDir, 'usage-events.jsonl'), async () => true);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('rollup-served ranges equal raw aggregation', () => {
  it('getTotals matches the reference over whole closed days', async () => {
    const startTs = dayStart(2026, 6, 12);
    const endTs = dayStart(2026, 6, 15);
    const expected = reference(inserted, startTs, endTs);
    const totals = await store.getTotals({ startTs, endTs });
    expect(totals.eventCount).toBe(expected.totals.eventCount);
    expect(totals.inputTokens).toBe(expected.totals.inputTokens);
    expect(totals.outputTokens).toBe(expected.totals.outputTokens);
    expect(totals.cacheReadTokens).toBe(expected.totals.cacheReadTokens);
    expect(totals.cacheCreationTokens).toBe(expected.totals.cacheCreationTokens);
    expect(totals.reasoningTokens).toBe(expected.totals.reasoningTokens);
    expect(totals.costUsd).toBeCloseTo(expected.totals.costUsd, 6);
    expect(totals.costSavedByCacheUsd).toBeCloseTo(expected.totals.costSavedByCacheUsd, 6);
    expect(totals.cacheEligibleEventCount).toBe(expected.totals.cacheEligibleEventCount);
    expect(totals.coldCacheEventCount).toBe(expected.totals.coldCacheEventCount);
    // Binned median: within half a bin (0.0005) of the exact value.
    expect(totals.medianCacheHitRate).not.toBeNull();
    expect(Math.abs((totals.medianCacheHitRate as number) - (expected.median as number)))
      .toBeLessThanOrEqual(0.0005);
  });

  it('writes a rollup sidecar per closed day and keeps the shard', async () => {
    await store.getTotals({ startTs: dayStart(2026, 6, 12), endTs: dayStart(2026, 6, 15) });
    for (const day of ['2026-06-12', '2026-06-13', '2026-06-14']) {
      expect(existsSync(join(tmpDir, 'usage', usageRollupName(day)))).toBe(true);
      expect(existsSync(join(tmpDir, 'usage', usageShardName(day)))).toBe(true);
    }
  });

  it('getByModel and getByApiKey match the reference groups', async () => {
    const startTs = dayStart(2026, 6, 12);
    const endTs = dayStart(2026, 6, 15);
    const expected = reference(inserted, startTs, endTs);

    const models = await store.getByModel({ startTs, endTs });
    expect(models).toHaveLength(expected.byModel.size);
    for (const row of models) {
      const want = expected.byModel.get(`${row.providerId}::${row.model}`)!;
      expect(row.eventCount).toBe(want.eventCount);
      expect(row.inputTokens).toBe(want.inputTokens);
      expect(row.costUsd).toBeCloseTo(want.costUsd, 6);
    }

    const keys = await store.getByApiKey({ startTs, endTs });
    expect(keys).toHaveLength(expected.byKey.size);
    for (const row of keys) {
      const want = expected.byKey.get(row.apiKeyId)!;
      expect(row.eventCount).toBe(want.eventCount);
      expect(row.costUsd).toBeCloseTo(want.costUsd, 6);
    }
    expect(keys.find((r) => r.apiKeyId === null)?.label).toBe('unattributed');
    expect(keys.find((r) => r.apiKeyId === null)?.providerId).toBeNull();
  });

  it('getTimeSeries day buckets match the reference per day', async () => {
    const startTs = dayStart(2026, 6, 12);
    const endTs = dayStart(2026, 6, 15);
    const series = await store.getTimeSeries({ startTs, endTs }, 'day');
    expect(series).toHaveLength(3);
    for (const bucket of series) {
      const from = bucket.bucketStartTs;
      const to = new Date(new Date(from).getFullYear(), new Date(from).getMonth(), new Date(from).getDate() + 1).getTime();
      const want = reference(inserted, from, to);
      expect(bucket.requests).toBe(want.totals.eventCount);
      expect(bucket.inputTokens).toBe(want.totals.inputTokens);
      expect(bucket.costUsd).toBeCloseTo(want.totals.costUsd, 6);
    }
  });

  it('a PARTIALLY covered day is read from rows, so a mid-day start still excludes', async () => {
    const startTs = local(2026, 6, 13, 12);
    const endTs = dayStart(2026, 6, 15);
    const expected = reference(inserted, startTs, endTs);
    const totals = await store.getTotals({ startTs, endTs });
    expect(totals.eventCount).toBe(expected.totals.eventCount);
    expect(totals.costUsd).toBeCloseTo(expected.totals.costUsd, 6);
    // Sanity: the partial range really is smaller than the whole-day one.
    expect(totals.eventCount).toBeLessThan(inserted.length);
  });
});

describe('pruned days keep answering from their rollup', () => {
  it('aggregates and LIFETIME key spend are unchanged after a shard is deleted', async () => {
    const startTs = dayStart(2026, 6, 12);
    const endTs = dayStart(2026, 6, 15);
    const before = await store.getTotals({ startTs, endTs });
    const spendBefore = await store.getSpendByKey({
      apiKeyId: 'k1',
      dayStartTs: dayStart(2026, 6, 14),
      weekStartTs: dayStart(2026, 6, 13),
      endTs,
    });

    // Simulate retention: the rollups exist (the queries above built them), so
    // drop the raw rows for the two oldest days.
    unlinkSync(join(tmpDir, 'usage', usageShardName('2026-06-12')));
    unlinkSync(join(tmpDir, 'usage', usageShardName('2026-06-13')));
    const fresh = new JsonlUsageEventStore(join(tmpDir, 'usage-events.jsonl'), async () => true);

    const after = await fresh.getTotals({ startTs, endTs });
    expect(after.eventCount).toBe(before.eventCount);
    expect(after.costUsd).toBeCloseTo(before.costUsd, 6);
    expect(after.inputTokens).toBe(before.inputTokens);

    const spendAfter = await fresh.getSpendByKey({
      apiKeyId: 'k1',
      dayStartTs: dayStart(2026, 6, 14),
      weekStartTs: dayStart(2026, 6, 13),
      endTs,
    });
    expect(spendAfter.totalUsd).toBeCloseTo(spendBefore.totalUsd, 6);
    expect(spendAfter.weeklyUsd).toBeCloseTo(spendBefore.weeklyUsd, 6);
    expect(spendAfter.dailyUsd).toBeCloseTo(spendBefore.dailyUsd, 6);
    expect(spendAfter.totalUsd).toBeGreaterThan(0);
  });

  it('session drilldown only covers days whose rows survive', async () => {
    const withRows = await store.getMessagesForSession('sess-0');
    expect(withRows.length).toBeGreaterThan(0);
    // Build the rollup, then prune that day's rows.
    await store.getTotals({ startTs: dayStart(2026, 6, 12), endTs: dayStart(2026, 6, 15) });
    unlinkSync(join(tmpDir, 'usage', usageShardName('2026-06-12')));
    const fresh = new JsonlUsageEventStore(join(tmpDir, 'usage-events.jsonl'), async () => true);
    expect(await fresh.getMessagesForSession('sess-0')).toHaveLength(0);
    // A session on a day that still has rows is unaffected.
    expect((await fresh.getMessagesForSession('sess-2')).length).toBeGreaterThan(0);
  });
});

describe('concurrent readers do not double-count', () => {
  it('parallel queries over the same day agree with a serial one', async () => {
    const range = { startTs: local(2026, 6, 13, 6), endTs: local(2026, 6, 13, 18) };
    const serial = await store.getTotals(range);
    const fresh = new JsonlUsageEventStore(join(tmpDir, 'usage-events.jsonl'), async () => true);
    const [a, b, c] = await Promise.all([
      fresh.getTotals(range),
      fresh.getTotals(range),
      fresh.getTotals(range),
    ]);
    expect(a.eventCount).toBe(serial.eventCount);
    expect(b.eventCount).toBe(serial.eventCount);
    expect(c.eventCount).toBe(serial.eventCount);
    expect(a.costUsd).toBeCloseTo(serial.costUsd, 6);
  });
});
