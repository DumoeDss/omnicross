/**
 * usageStatsLogic.ts — pure helpers behind `useUsageStats` (range computation,
 * the parallel loader, unattributed grouping, number formatting). Kept free of
 * React so the root vitest suite (node env) can exercise them directly.
 */

// Relative imports (not the `@/` vite alias) so the root vitest config — which
// has no ui alias — can resolve this module from the test files.
import * as adapter from '../../../daemon/usagePricingAdapter';

import type {
  ApiKeyUsageRow,
  ModelUsageRow,
  UsageDateRange,
  UsageTimeBucket,
  UsageTotals,
} from '../../../daemon/types-usage-pricing';

export type RangePreset = 'today' | '7d' | '30d' | 'custom';

/**
 * Local-time midnight `daysBack` CALENDAR days before the day containing
 * `ts`. Uses `Date` calendar arithmetic (day-field rollover), never fixed
 * 24h offsets — a 23/25-hour DST day would otherwise shift the anchor off
 * local midnight.
 */
function startOfLocalDay(ts: number, daysBack = 0): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysBack).getTime();
}

/**
 * Compute the `[startTs, endTs)` window for a preset (endTs EXCLUSIVE = `now`,
 * so in-flight events are included; presets anchor to local midnight).
 */
export function computePresetRange(preset: Exclude<RangePreset, 'custom'>, now: number): UsageDateRange {
  switch (preset) {
    case 'today':
      return { startTs: startOfLocalDay(now), endTs: now };
    case '7d':
      return { startTs: startOfLocalDay(now, 6), endTs: now };
    case '30d':
      return { startTs: startOfLocalDay(now, 29), endTs: now };
  }
}

/**
 * Compute a custom `[start-of-day, end-of-day + 1ms-exclusive)` range from two
 * `YYYY-MM-DD` date-input values (local time). The end day is INCLUSIVE for
 * the user, so endTs = start of the NEXT day (exclusive bound). Returns null
 * when either date is missing/invalid or the range is inverted.
 */
export function computeCustomRange(fromDate: string, toDate: string): UsageDateRange | null {
  if (!fromDate || !toDate) return null;
  const start = new Date(`${fromDate}T00:00:00`).getTime();
  const endDayDate = new Date(`${toDate}T00:00:00`);
  if (!Number.isFinite(start) || !Number.isFinite(endDayDate.getTime())) return null;
  // Start of the NEXT local calendar day (calendar rollover, DST-safe).
  const endTs = new Date(
    endDayDate.getFullYear(),
    endDayDate.getMonth(),
    endDayDate.getDate() + 1,
  ).getTime();
  if (endTs <= start) return null;
  return { startTs: start, endTs };
}

export interface UsageData {
  totals: UsageTotals;
  byModel: ModelUsageRow[];
  byApiKey: ApiKeyUsageRow[];
}

/**
 * Parallel-load the three usage views for one range. Any single failure fails
 * the whole load (single error state — no silent partial data).
 */
export async function loadUsageData(range: UsageDateRange): Promise<UsageData> {
  const [totals, byModel, byApiKey] = await Promise.all([
    adapter.getUsageTotals(range),
    adapter.getUsageByModel(range),
    adapter.getUsageByApiKey(range),
  ]);
  return { totals, byModel, byApiKey };
}

/**
 * Split the by-api-key rows into attributed rows and the unattributed group,
 * keyed STRICTLY off `apiKeyId === null` (the daemon's sentinel label string
 * is not trusted for display). Attributed rows keep their daemon order.
 */
export function partitionApiKeyRows(rows: ApiKeyUsageRow[]): {
  attributed: ApiKeyUsageRow[];
  unattributed: ApiKeyUsageRow | null;
} {
  const attributed = rows.filter((r) => r.apiKeyId !== null);
  const unattributed = rows.find((r) => r.apiKeyId === null) ?? null;
  return { attributed, unattributed };
}

/** Sort model rows by cost descending (default by-model view order). */
export function sortByCostDesc(rows: ModelUsageRow[]): ModelUsageRow[] {
  return [...rows].sort((a, b) => b.costUsd - a.costUsd);
}

const DAY_MS = 86_400_000;

/**
 * Pick the trend bucket granularity for a range span (office-hours D4):
 * span ≤ 2 days → `hour`, ≤ 62 days → `day`, else `month`. The span is the
 * exclusive `[startTs, endTs)` width; a null/inverted span falls back to
 * `day`.
 */
export function autoBucketForRange(range: UsageDateRange): UsageTimeBucket {
  const span = range.endTs - range.startTs;
  if (span <= 2 * DAY_MS) return 'hour';
  if (span <= 62 * DAY_MS) return 'day';
  return 'month';
}

/** One doughnut slice: a model's cost and its fraction of the total cost. */
export interface ModelShare {
  providerId: string;
  model: string;
  costUsd: number;
  /** Fraction in [0, 1]; falls back to input+output token share when total cost is 0. */
  share: number;
}

/**
 * Cost-share fraction per model for the distribution doughnut, sorted by cost
 * descending. When the total cost is 0 (e.g. only unpriced models) the share
 * falls back to each model's input+output token proportion so the doughnut
 * still reads; if there are no tokens either, every share is 0.
 */
export function modelShares(rows: ModelUsageRow[]): ModelShare[] {
  const sorted = sortByCostDesc(rows);
  const totalCost = sorted.reduce((sum, r) => sum + r.costUsd, 0);
  const tokensOf = (r: ModelUsageRow) => r.inputTokens + r.outputTokens;
  const totalTokens = sorted.reduce((sum, r) => sum + tokensOf(r), 0);
  return sorted.map((r) => {
    let share = 0;
    if (totalCost > 0) share = r.costUsd / totalCost;
    else if (totalTokens > 0) share = tokensOf(r) / totalTokens;
    return { providerId: r.providerId, model: r.model, costUsd: r.costUsd, share };
  });
}

/** Locale-aware grouped-thousands integer formatting for token counts. */
export function formatTokens(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
}

/** USD with 2–4 fraction digits (small per-request costs need the precision). */
export function formatUsd(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value);
}
