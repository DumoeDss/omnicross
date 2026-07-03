/**
 * jsonl-usage-event-store-timeseries.test.ts — `getTimeSeries` semantics:
 * LOCAL-time bucket boundaries (hour/day/month), zero-fill across gaps,
 * endTs-EXCLUSIVE ranges, month-length transitions, empty store / empty range,
 * malformed-line resilience, and pinned label formats.
 *
 * All boundary math is asserted against `new Date(y, mo, d, h)` so the suite
 * is timezone-agnostic (it computes expected LOCAL boundaries the same way the
 * store does, rather than hard-coding a zone).
 */

import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { UsageEventInput } from '@omnicross/contracts/usage-stats-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JsonlUsageEventStore } from '../ports/JsonlUsageEventStore';

let tmpDir: string;
let eventsPath: string;
let store: JsonlUsageEventStore;

const event = (over: Partial<UsageEventInput> = {}): UsageEventInput => ({
  messageId: null,
  parentMessageId: null,
  sessionId: null,
  providerId: 'prov-a',
  model: 'model-x',
  apiKeyId: null,
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

/** Local wall-clock → unix millis (matches how the store floors buckets). */
const local = (y: number, mo1: number, d: number, h = 0, mi = 0): number =>
  new Date(y, mo1 - 1, d, h, mi).getTime();

/** Expected LOCAL boundary millis for the given wall-clock parts. */
const hourStart = (y: number, mo1: number, d: number, h: number): number =>
  new Date(y, mo1 - 1, d, h).getTime();
const dayStart = (y: number, mo1: number, d: number): number => new Date(y, mo1 - 1, d).getTime();
const monthStart = (y: number, mo1: number): number => new Date(y, mo1 - 1, 1).getTime();

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-usage-ts-'));
  eventsPath = join(tmpDir, 'usage-events.jsonl');
  store = new JsonlUsageEventStore(eventsPath, async () => true);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('JsonlUsageEventStore.getTimeSeries', () => {
  it('aggregates same-hour events into ONE bucket and the next hour into the next bucket', async () => {
    await store.insert(event({ ts: local(2026, 3, 10, 8, 5) }));
    await store.insert(event({ ts: local(2026, 3, 10, 8, 50) }));
    await store.insert(event({ ts: local(2026, 3, 10, 9, 1) }));
    const series = await store.getTimeSeries(
      { startTs: local(2026, 3, 10, 8), endTs: local(2026, 3, 10, 10) },
      'hour',
    );
    expect(series).toHaveLength(2);
    expect(series[0].bucketStartTs).toBe(hourStart(2026, 3, 10, 8));
    expect(series[0].requests).toBe(2);
    expect(series[0].inputTokens).toBe(20);
    expect(series[0].outputTokens).toBe(40);
    expect(series[0].cacheReadTokens).toBe(10);
    expect(series[0].cacheCreationTokens).toBe(4);
    expect(series[0].costUsd).toBeCloseTo(1.0);
    expect(series[1].bucketStartTs).toBe(hourStart(2026, 3, 10, 9));
    expect(series[1].requests).toBe(1);
  });

  it('zero-fills every bucket across gaps, ascending, count = number of boundaries', async () => {
    // Events only in hour 8 and hour 11; range spans 08:00..13:00 (5 hours).
    await store.insert(event({ ts: local(2026, 3, 10, 8, 30) }));
    await store.insert(event({ ts: local(2026, 3, 10, 11, 15) }));
    const series = await store.getTimeSeries(
      { startTs: local(2026, 3, 10, 8), endTs: local(2026, 3, 10, 13) },
      'hour',
    );
    expect(series.map((b) => b.bucketStartTs)).toEqual([
      hourStart(2026, 3, 10, 8),
      hourStart(2026, 3, 10, 9),
      hourStart(2026, 3, 10, 10),
      hourStart(2026, 3, 10, 11),
      hourStart(2026, 3, 10, 12),
    ]);
    expect(series.map((b) => b.requests)).toEqual([1, 0, 0, 1, 0]);
    // ascending
    for (let i = 1; i < series.length; i++) {
      expect(series[i].bucketStartTs).toBeGreaterThan(series[i - 1].bucketStartTs);
    }
  });

  it('first bucket CONTAINS startTs (floors to the boundary) even when startTs is mid-bucket', async () => {
    await store.insert(event({ ts: local(2026, 3, 10, 8, 45) }));
    const series = await store.getTimeSeries(
      { startTs: local(2026, 3, 10, 8, 20), endTs: local(2026, 3, 10, 9) },
      'hour',
    );
    expect(series).toHaveLength(1);
    expect(series[0].bucketStartTs).toBe(hourStart(2026, 3, 10, 8));
    expect(series[0].requests).toBe(1);
  });

  it('splits across a local day boundary into two day buckets with YYYY-MM-DD labels', async () => {
    await store.insert(event({ ts: local(2026, 3, 10, 23, 30) }));
    await store.insert(event({ ts: local(2026, 3, 11, 0, 15) }));
    const series = await store.getTimeSeries(
      { startTs: dayStart(2026, 3, 10), endTs: dayStart(2026, 3, 12) },
      'day',
    );
    expect(series).toHaveLength(2);
    expect(series[0].bucketStartTs).toBe(dayStart(2026, 3, 10));
    expect(series[0].label).toBe('2026-03-10');
    expect(series[0].requests).toBe(1);
    expect(series[1].bucketStartTs).toBe(dayStart(2026, 3, 11));
    expect(series[1].label).toBe('2026-03-11');
    expect(series[1].requests).toBe(1);
  });

  it('handles month-length transition (Jan 31 → Feb 1) via Date-part advance', async () => {
    await store.insert(event({ ts: local(2026, 1, 31, 12) }));
    await store.insert(event({ ts: local(2026, 2, 1, 1) }));
    const series = await store.getTimeSeries(
      { startTs: monthStart(2026, 1), endTs: monthStart(2026, 3) },
      'month',
    );
    expect(series).toHaveLength(2);
    expect(series[0].bucketStartTs).toBe(monthStart(2026, 1));
    expect(series[0].label).toBe('2026-01');
    expect(series[0].requests).toBe(1);
    expect(series[1].bucketStartTs).toBe(monthStart(2026, 2));
    expect(series[1].label).toBe('2026-02');
    expect(series[1].requests).toBe(1);
  });

  it('enumerates day buckets correctly across a 31-day month (Jan) — no drift', async () => {
    const series = await store.getTimeSeries(
      { startTs: dayStart(2026, 1, 30), endTs: dayStart(2026, 2, 2) },
      'day',
    );
    expect(series.map((b) => b.label)).toEqual(['2026-01-30', '2026-01-31', '2026-02-01']);
  });

  it('endTs is EXCLUSIVE: an event exactly at endTs is excluded; endTs-1 lands in the last bucket', async () => {
    const start = local(2026, 3, 10, 8);
    const end = local(2026, 3, 10, 10); // exclusive
    await store.insert(event({ ts: end })); // exactly endTs → excluded (and no bucket enumerated for it)
    await store.insert(event({ ts: end - 1 })); // last ms of hour 9 → last bucket
    const series = await store.getTimeSeries({ startTs: start, endTs: end }, 'hour');
    expect(series.map((b) => b.bucketStartTs)).toEqual([
      hourStart(2026, 3, 10, 8),
      hourStart(2026, 3, 10, 9),
    ]);
    expect(series[0].requests).toBe(0);
    expect(series[1].requests).toBe(1); // endTs-1 counted here; endTs itself not counted
  });

  it('pins the hour label format MM-DD HH:00', async () => {
    const series = await store.getTimeSeries(
      { startTs: local(2026, 3, 5, 7), endTs: local(2026, 3, 5, 8) },
      'hour',
    );
    expect(series).toHaveLength(1);
    expect(series[0].label).toBe('03-05 07:00');
  });

  it('empty store → all-zero buckets across the range (NOT [])', async () => {
    const series = await store.getTimeSeries(
      { startTs: local(2026, 3, 10, 8), endTs: local(2026, 3, 10, 11) },
      'hour',
    );
    expect(series).toHaveLength(3);
    expect(series.every((b) => b.requests === 0 && b.inputTokens === 0 && b.costUsd === 0)).toBe(true);
    expect(series.map((b) => b.label)).toEqual(['03-10 08:00', '03-10 09:00', '03-10 10:00']);
  });

  it('empty RANGE (startTs >= endTs) → []', async () => {
    const t = local(2026, 3, 10, 8);
    expect(await store.getTimeSeries({ startTs: t, endTs: t }, 'hour')).toEqual([]);
    expect(await store.getTimeSeries({ startTs: t + 1, endTs: t }, 'day')).toEqual([]);
  });

  it('malformed/partial lines do not poison any bucket (finite sums)', async () => {
    await store.insert(event({ ts: local(2026, 3, 10, 8, 10) }));
    // torn final-line fragment
    appendFileSync(eventsPath, '{"id":"torn","ts":1', 'utf8');
    const series = await store.getTimeSeries(
      { startTs: local(2026, 3, 10, 8), endTs: local(2026, 3, 10, 9) },
      'hour',
    );
    expect(series).toHaveLength(1);
    expect(series[0].requests).toBe(1);
    expect(series[0].inputTokens).toBe(10);
    expect(series.every((b) => Number.isFinite(b.costUsd) && Number.isFinite(b.inputTokens))).toBe(true);
  });

  it('skips a parseable-but-PARTIAL row (missing token fields) without NaN', async () => {
    await store.insert(event({ ts: local(2026, 3, 10, 8, 10) }));
    appendFileSync(
      eventsPath,
      JSON.stringify({ id: 'partial', ts: local(2026, 3, 10, 8, 20), providerId: 'p', model: 'm' }) + '\n',
      'utf8',
    );
    const series = await store.getTimeSeries(
      { startTs: local(2026, 3, 10, 8), endTs: local(2026, 3, 10, 9) },
      'hour',
    );
    expect(series[0].requests).toBe(1); // only the genuine row
    expect(Number.isFinite(series[0].costUsd)).toBe(true);
    expect(series[0].costUsd).toBeCloseTo(0.5);
  });
});
