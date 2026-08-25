import { describe, expect, it } from 'vitest';

import {
  buildThroughputView,
  selectThroughputWindow,
  sparklinePoints,
  windowBuckets,
  DEFAULT_THROUGHPUT_WINDOW_MS,
  THROUGHPUT_WINDOW_OPTIONS,
} from '../throughputModel';

import type { OverviewSource } from '../overviewModel';
import type {
  UsageThroughputResult,
  UsageThroughputSnapshot,
  UsageThroughputWindow,
} from '../../../daemon/types-usage-pricing';

const NOW = Date.parse('2026-08-20T12:00:00.000Z');
const BUCKET_MS = 30_000;

function windowRow(
  windowMs: number,
  overrides: Partial<UsageThroughputWindow> = {},
): UsageThroughputWindow {
  const minutes = windowMs / 60_000;
  const inputTokens = overrides.inputTokens ?? 0;
  const outputTokens = overrides.outputTokens ?? 0;
  const cacheReadTokens = overrides.cacheReadTokens ?? 0;
  const cacheCreationTokens = overrides.cacheCreationTokens ?? 0;
  const totalTokens = overrides.totalTokens ?? inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;
  return {
    windowMs,
    requests: 0,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    reasoningTokens: 0,
    totalTokens,
    costUsd: 0,
    requestsPerMinute: (overrides.requests ?? 0) / minutes,
    tokensPerMinute: totalTokens / minutes,
    inputTokensPerMinute: inputTokens / minutes,
    outputTokensPerMinute: outputTokens / minutes,
    cacheTokensPerMinute: (cacheReadTokens + cacheCreationTokens) / minutes,
    costUsdPerMinute: (overrides.costUsd ?? 0) / minutes,
    complete: true,
    ...overrides,
  };
}

function snapshot(overrides: Partial<UsageThroughputSnapshot> = {}): UsageThroughputSnapshot {
  return {
    available: true,
    collectedAt: NOW,
    startedAt: NOW - 60 * 60_000,
    retentionMs: 900_000,
    bucketMs: BUCKET_MS,
    windows: THROUGHPUT_WINDOW_OPTIONS.map((windowMs) => windowRow(windowMs)),
    buckets: Array.from({ length: 30 }, (_unused, index) => ({
      startTs: NOW - 900_000 + index * BUCKET_MS,
      requests: 0,
      tokens: 0,
    })),
    ...overrides,
  };
}

function ready(data: UsageThroughputResult): OverviewSource<UsageThroughputResult> {
  return { state: 'ready', data };
}

describe('buildThroughputView', () => {
  it('keeps loading distinct from a measured value', () => {
    const view = buildThroughputView({ state: 'loading' }, DEFAULT_THROUGHPUT_WINDOW_MS);
    expect(view.state).toBe('loading');
    expect(view.tokensPerMinute).toBeUndefined();
    expect(view.idle).toBe(false);
    expect(view.points).toEqual([]);
  });

  it('keeps a failed read distinct from a measured value', () => {
    const view = buildThroughputView({ state: 'unavailable', message: 'boom' }, DEFAULT_THROUGHPUT_WINDOW_MS);
    expect(view.state).toBe('unavailable');
    expect(view.tokensPerMinute).toBeUndefined();
  });

  it('reports a daemon without the endpoint as unavailable, never as zero', () => {
    const view = buildThroughputView(
      ready({ available: false, collectedAt: NOW }),
      DEFAULT_THROUGHPUT_WINDOW_MS,
    );
    expect(view.state).toBe('unavailable');
    expect(view.tokensPerMinute).toBeUndefined();
    expect(view.idle).toBe(false);
  });

  it('projects the selected window rates', () => {
    const view = buildThroughputView(
      ready(
        snapshot({
          windows: [
            windowRow(60_000, { requests: 2, inputTokens: 900, outputTokens: 300 }),
            windowRow(300_000, {
              requests: 5,
              inputTokens: 3_000,
              outputTokens: 1_000,
              cacheReadTokens: 5_000,
              cacheCreationTokens: 1_000,
            }),
            windowRow(900_000, { requests: 6, inputTokens: 3_600, outputTokens: 1_200 }),
          ],
        }),
      ),
      300_000,
    );

    expect(view.state).toBe('ready');
    expect(view.windowMs).toBe(300_000);
    expect(view.requests).toBe(5);
    expect(view.tokensPerMinute).toBe(2_000);
    expect(view.inputTokensPerMinute).toBe(600);
    expect(view.outputTokensPerMinute).toBe(200);
    expect(view.cacheTokensPerMinute).toBe(1_200);
    expect(view.requestsPerMinute).toBe(1);
    expect(view.idle).toBe(false);
    expect(view.complete).toBe(true);
  });

  it('flags a truly empty window as idle rather than blanking it', () => {
    const view = buildThroughputView(ready(snapshot()), 300_000);
    expect(view.state).toBe('ready');
    expect(view.idle).toBe(true);
    expect(view.tokensPerMinute).toBe(0);
  });

  it('flags warming up when the daemon has observed for less than the window', () => {
    const short = buildThroughputView(
      ready(snapshot({ startedAt: NOW - 120_000 })),
      300_000,
    );
    expect(short.warmingUp).toBe(true);

    // The same snapshot read over a 1-minute window is fully observed.
    const long = buildThroughputView(ready(snapshot({ startedAt: NOW - 120_000 })), 60_000);
    expect(long.warmingUp).toBe(false);
  });

  it('carries the daemon incompleteness flag through', () => {
    const view = buildThroughputView(
      ready(
        snapshot({
          windows: [
            windowRow(60_000, { complete: false, requests: 1, inputTokens: 10 }),
            windowRow(300_000),
            windowRow(900_000),
          ],
        }),
      ),
      60_000,
    );
    expect(view.complete).toBe(false);
  });

  it('trims the trend series to the selected window and trends output tokens', () => {
    const buckets = Array.from({ length: 30 }, (_unused, index) => ({
      startTs: NOW - 900_000 + index * BUCKET_MS,
      requests: index,
      tokens: index * 10,
      outputTokens: index * 2,
    }));
    const view = buildThroughputView(ready(snapshot({ buckets })), 300_000);
    // 300s / 30s = 10 buckets, taken from the newest end.
    expect(view.points).toHaveLength(10);
    // Output, not the all-in total — the headline it must describe.
    expect(view.points[view.points.length - 1]).toBe(58);
  });

  it('falls back to all-in bucket tokens when the daemon predates the output split', () => {
    const buckets = Array.from({ length: 30 }, (_unused, index) => ({
      startTs: NOW - 900_000 + index * BUCKET_MS,
      requests: index,
      tokens: index * 10,
    }));
    const view = buildThroughputView(ready(snapshot({ buckets })), 300_000);
    expect(view.points[view.points.length - 1]).toBe(290);
  });
});

describe('selectThroughputWindow', () => {
  it('returns the exact window when the daemon sent it', () => {
    const rows = THROUGHPUT_WINDOW_OPTIONS.map((windowMs) => windowRow(windowMs));
    expect(selectThroughputWindow(rows, 300_000)?.windowMs).toBe(300_000);
  });

  it('falls back to the closest window a daemon with a different list sent', () => {
    const rows = [windowRow(120_000), windowRow(600_000)];
    expect(selectThroughputWindow(rows, 300_000)?.windowMs).toBe(120_000);
    expect(selectThroughputWindow(rows, 900_000)?.windowMs).toBe(600_000);
  });

  it('returns undefined for an empty list', () => {
    expect(selectThroughputWindow([], 60_000)).toBeUndefined();
  });
});

describe('windowBuckets', () => {
  it('keeps at least two buckets so a line can still be drawn', () => {
    const buckets = Array.from({ length: 30 }, (_unused, index) => ({
      startTs: index * BUCKET_MS,
      requests: 0,
      tokens: 0,
    }));
    expect(windowBuckets(buckets, 10_000, BUCKET_MS)).toHaveLength(2);
  });

  it('returns the full series when bucketMs is unusable', () => {
    const buckets = [{ startTs: 0, requests: 0, tokens: 0 }];
    expect(windowBuckets(buckets, 60_000, 0)).toHaveLength(1);
    expect(windowBuckets([], 60_000, BUCKET_MS)).toEqual([]);
  });
});

describe('sparklinePoints', () => {
  it('renders nothing for fewer than two samples', () => {
    expect(sparklinePoints([], 100, 28)).toBe('');
    expect(sparklinePoints([5], 100, 28)).toBe('');
  });

  it('draws an all-zero series as a flat baseline without dividing by zero', () => {
    const line = sparklinePoints([0, 0, 0], 100, 28);
    expect(line).not.toContain('NaN');
    const ys = line.split(' ').map((pair) => Number(pair.split(',')[1]));
    expect(new Set(ys).size).toBe(1);
  });

  it('puts the peak at the top and spans the full width', () => {
    const line = sparklinePoints([0, 10], 100, 28);
    expect(line).not.toContain('NaN');
    const [first, last] = line.split(' ');
    expect(Number(first!.split(',')[0])).toBe(0);
    expect(Number(last!.split(',')[0])).toBe(100);
    // Higher value → smaller y (SVG y grows downwards).
    expect(Number(last!.split(',')[1])).toBeLessThan(Number(first!.split(',')[1]));
  });
});
