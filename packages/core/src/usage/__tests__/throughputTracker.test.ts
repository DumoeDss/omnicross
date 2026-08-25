import { describe, expect, it } from 'vitest';

import {
  THROUGHPUT_BUCKET_COUNT,
  THROUGHPUT_RETENTION_MS,
  THROUGHPUT_SAMPLE_LIMIT,
  THROUGHPUT_WINDOWS_MS,
  UsageThroughputTracker,
  type UsageThroughputInput,
  type UsageThroughputSnapshot,
  type UsageThroughputWindow,
} from '../throughputTracker';

const T0 = Date.parse('2026-08-20T12:00:00.000Z');

function event(overrides: Partial<UsageThroughputInput> = {}): UsageThroughputInput {
  return {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 5,
    cacheCreationTokens: 3,
    reasoningTokens: 8,
    costUsd: 0.001,
    ...overrides,
  };
}

function windowOf(snapshot: UsageThroughputSnapshot, windowMs: number): UsageThroughputWindow {
  const row = snapshot.windows.find((entry) => entry.windowMs === windowMs);
  if (!row) throw new Error(`no window for ${windowMs}`);
  return row;
}

describe('UsageThroughputTracker', () => {
  it('reports every configured window as zero before anything is recorded', () => {
    const snapshot = new UsageThroughputTracker(T0).snapshot(T0);

    expect(snapshot.available).toBe(true);
    expect(snapshot.startedAt).toBe(T0);
    expect(snapshot.collectedAt).toBe(T0);
    expect(snapshot.windows.map((w) => w.windowMs)).toEqual([...THROUGHPUT_WINDOWS_MS]);
    for (const row of snapshot.windows) {
      expect(row.requests).toBe(0);
      expect(row.totalTokens).toBe(0);
      expect(row.tokensPerMinute).toBe(0);
      expect(row.requestsPerMinute).toBe(0);
      expect(row.cacheTokensPerMinute).toBe(0);
      expect(row.complete).toBe(true);
    }
  });

  it('excludes reasoning tokens from totalTokens (they are a subset of output)', () => {
    const tracker = new UsageThroughputTracker(T0);
    tracker.record(
      event({
        inputTokens: 1_000,
        outputTokens: 200,
        cacheReadTokens: 50,
        cacheCreationTokens: 25,
        reasoningTokens: 150,
      }),
      T0,
    );

    const row = windowOf(tracker.snapshot(T0), 60_000);
    expect(row.totalTokens).toBe(1_275);
    expect(row.reasoningTokens).toBe(150);
    // 50 cache-read + 25 cache-creation over one minute.
    expect(row.cacheTokensPerMinute).toBe(75);
  });

  it('divides by the full window, not by how long the tracker has been alive', () => {
    // The tracker starts at T0 and is read only 10s later, but the 1-minute rate
    // must still divide by a full minute: the missing 50s genuinely served nothing.
    const tracker = new UsageThroughputTracker(T0);
    tracker.record(event({ inputTokens: 600, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }), T0 + 1_000);

    const row = windowOf(tracker.snapshot(T0 + 10_000), 60_000);
    expect(row.requests).toBe(1);
    expect(row.totalTokens).toBe(600);
    expect(row.tokensPerMinute).toBe(600);
    expect(row.requestsPerMinute).toBe(1);
  });

  it('keeps each window independent — an old event leaves the short window only', () => {
    const tracker = new UsageThroughputTracker(T0);
    const now = T0 + 10 * 60_000;
    // 8 minutes ago: inside 15m, outside 5m and 1m.
    tracker.record(event({ inputTokens: 900, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }), now - 8 * 60_000);
    // 30 seconds ago: inside all three.
    tracker.record(event({ inputTokens: 300, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }), now - 30_000);

    const snapshot = tracker.snapshot(now);
    expect(windowOf(snapshot, 60_000).requests).toBe(1);
    expect(windowOf(snapshot, 60_000).totalTokens).toBe(300);
    expect(windowOf(snapshot, 300_000).requests).toBe(1);
    expect(windowOf(snapshot, 900_000).requests).toBe(2);
    expect(windowOf(snapshot, 900_000).totalTokens).toBe(1_200);
    // 1200 tokens over 15 minutes = 80/min.
    expect(windowOf(snapshot, 900_000).tokensPerMinute).toBeCloseTo(80, 6);
  });

  it('drops samples past the retention horizon', () => {
    const tracker = new UsageThroughputTracker(T0);
    tracker.record(event(), T0);

    const now = T0 + THROUGHPUT_RETENTION_MS + 1;
    const snapshot = tracker.snapshot(now);
    for (const row of snapshot.windows) expect(row.requests).toBe(0);
    expect(snapshot.buckets.every((bucket) => bucket.requests === 0)).toBe(true);
  });

  it('returns a fixed-length, grid-aligned, oldest-first bucket series', () => {
    const tracker = new UsageThroughputTracker(T0);
    const now = T0 + 60_000;
    tracker.record(event({ inputTokens: 10, outputTokens: 4, cacheReadTokens: 0, cacheCreationTokens: 0 }), now - 1_000);

    const snapshot = tracker.snapshot(now);
    expect(snapshot.buckets).toHaveLength(THROUGHPUT_BUCKET_COUNT);
    expect(snapshot.bucketMs).toBe(THROUGHPUT_RETENTION_MS / THROUGHPUT_BUCKET_COUNT);

    const starts = snapshot.buckets.map((bucket) => bucket.startTs);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    for (const startTs of starts) expect(startTs % snapshot.bucketMs).toBe(0);

    const filled = snapshot.buckets.filter((bucket) => bucket.requests > 0);
    expect(filled).toHaveLength(1);
    expect(filled[0]!.tokens).toBe(14);
    // Output is carried separately so an output headline can trend without
    // rescaling the all-in total.
    expect(filled[0]!.outputTokens).toBe(4);

    // Grid alignment is stable across polls: a later read inside the same bucket
    // must not shift the boundaries (otherwise a sparkline shimmers).
    expect(tracker.snapshot(now + 500).buckets.map((b) => b.startTs)).toEqual(starts);
  });

  it('admits incompleteness once the sample cap evicts events inside a window', () => {
    const tracker = new UsageThroughputTracker(T0);
    const now = T0 + 60_000;
    for (let i = 0; i <= THROUGHPUT_SAMPLE_LIMIT; i += 1) {
      tracker.record(event(), now - 30_000);
    }

    const snapshot = tracker.snapshot(now);
    expect(windowOf(snapshot, 60_000).complete).toBe(false);
    expect(windowOf(snapshot, 60_000).requests).toBe(THROUGHPUT_SAMPLE_LIMIT);
  });

  it('clear() drops samples without rewriting startedAt', () => {
    const tracker = new UsageThroughputTracker(T0);
    tracker.record(event(), T0);
    tracker.clear();

    const snapshot = tracker.snapshot(T0 + 1_000);
    expect(snapshot.startedAt).toBe(T0);
    expect(windowOf(snapshot, 60_000).requests).toBe(0);
    expect(windowOf(snapshot, 60_000).complete).toBe(true);
  });
});
