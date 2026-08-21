/**
 * throughputModel — pure projection of the daemon's live-throughput snapshot
 * into what the Overview's rate card renders.
 *
 * Same discipline as `overviewModel`: a source is never coerced into a value
 * when its read failed. In particular the three "nothing to show" cases stay
 * distinguishable, because conflating them would be a lie:
 *   - `loading`      — the first poll has not returned yet;
 *   - `unavailable`  — the read failed, or this daemon predates the endpoint;
 *   - ready + `idle` — the daemon answered and the honest answer is zero.
 *
 * @module features/overview/throughputModel
 */

import type { DataSourceState, OverviewSource } from './overviewModel';

import type {
  UsageThroughputBucket,
  UsageThroughputResult,
  UsageThroughputWindow,
} from '../../daemon/types-usage-pricing';

/** Selectable trailing windows, shortest first. Mirrors the daemon's list. */
export const THROUGHPUT_WINDOW_OPTIONS = [60_000, 300_000, 900_000] as const;

export type ThroughputWindowMs = (typeof THROUGHPUT_WINDOW_OPTIONS)[number];

/** Default selection: steady enough to read, recent enough to feel live. */
export const DEFAULT_THROUGHPUT_WINDOW_MS: ThroughputWindowMs = 300_000;

export interface ThroughputView {
  state: DataSourceState;
  /** The window actually resolved (may differ if the daemon omits the requested one). */
  windowMs: number;
  /** The headline TPM — total tokens per minute. Undefined unless ready. */
  tokensPerMinute?: number;
  requestsPerMinute?: number;
  inputTokensPerMinute?: number;
  outputTokensPerMinute?: number;
  costUsdPerMinute?: number;
  /** Requests observed in the window (the rate's denominator-free raw count). */
  requests?: number;
  /** Ready, and the honest answer is "nothing served in this window". */
  idle: boolean;
  /** False when the daemon's sample cap evicted events inside the window. */
  complete: boolean;
  /** The daemon has been observing for less than the selected window. */
  warmingUp: boolean;
  /** Sparkline series, oldest → newest. Empty unless ready. */
  points: number[];
}

const NOT_READY = (state: DataSourceState, windowMs: number): ThroughputView => ({
  state,
  windowMs,
  idle: false,
  complete: true,
  warmingUp: false,
  points: [],
});

/** Pick the requested window, falling back to the closest one the daemon sent. */
export function selectThroughputWindow(
  windows: readonly UsageThroughputWindow[],
  windowMs: number,
): UsageThroughputWindow | undefined {
  if (windows.length === 0) return undefined;
  const exact = windows.find((row) => row.windowMs === windowMs);
  if (exact) return exact;
  return [...windows].sort(
    (left, right) => Math.abs(left.windowMs - windowMs) - Math.abs(right.windowMs - windowMs),
  )[0];
}

/**
 * Trim the trend series to the buckets that fall inside the selected window, so
 * the sparkline shows the same span the headline number describes. Falls back to
 * the full series when the window is wider than what the daemon retains.
 */
export function windowBuckets(
  buckets: readonly UsageThroughputBucket[],
  windowMs: number,
  bucketMs: number,
): UsageThroughputBucket[] {
  if (buckets.length === 0) return [];
  if (!Number.isFinite(bucketMs) || bucketMs <= 0) return [...buckets];
  const wanted = Math.max(2, Math.min(buckets.length, Math.ceil(windowMs / bucketMs)));
  return buckets.slice(buckets.length - wanted);
}

export function buildThroughputView(
  source: OverviewSource<UsageThroughputResult>,
  windowMs: number,
): ThroughputView {
  if (source.state !== 'ready' || !source.data) return NOT_READY(source.state, windowMs);
  const data = source.data;
  // A daemon without the endpoint is UNAVAILABLE, never a measured zero.
  if (data.available !== true) return NOT_READY('unavailable', windowMs);

  const row = selectThroughputWindow(data.windows, windowMs);
  if (!row) return NOT_READY('unavailable', windowMs);

  const series = windowBuckets(data.buckets, row.windowMs, data.bucketMs);
  return {
    state: 'ready',
    windowMs: row.windowMs,
    tokensPerMinute: row.tokensPerMinute,
    requestsPerMinute: row.requestsPerMinute,
    inputTokensPerMinute: row.inputTokensPerMinute,
    outputTokensPerMinute: row.outputTokensPerMinute,
    costUsdPerMinute: row.costUsdPerMinute,
    requests: row.requests,
    idle: row.requests === 0,
    complete: row.complete,
    warmingUp: data.collectedAt - data.startedAt < row.windowMs,
    points: series.map((bucket) => bucket.tokens),
  };
}

/**
 * An SVG polyline `points` attribute for the sparkline, oldest → newest.
 *
 * Returns `''` for fewer than two samples (a single point is not a trend, and a
 * one-vertex polyline renders as nothing anyway). An all-zero series is drawn as
 * a flat line on the baseline rather than dividing by a zero range.
 */
export function sparklinePoints(values: readonly number[], width: number, height: number): string {
  if (values.length < 2 || width <= 0 || height <= 0) return '';
  const max = Math.max(...values);
  const step = width / (values.length - 1);
  // Inset by half a stroke so the peak is not clipped by the viewBox edge.
  const top = 1;
  const usable = Math.max(0, height - top * 2);
  return values
    .map((value, index) => {
      const ratio = max > 0 ? value / max : 0;
      const x = index * step;
      const y = top + usable * (1 - ratio);
      return `${round(x)},${round(y)}`;
    })
    .join(' ');
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
