/**
 * usageRollup — the immutable per-day aggregate that lets a range query skip a
 * day's rows entirely.
 *
 * A rollup is computed ONCE, when a day is closed (strictly before today's local
 * date), and is then never rewritten. It is deliberately kept FOREVER, outliving
 * the raw shard it was built from, for one load-bearing reason:
 * `getSpendByKey().totalUsd` is a LIFETIME number that seeds the outbound key
 * spend policy (`core/outbound-api/keySpendTracker`). Pruning raw rows without
 * keeping a per-key aggregate behind would silently reset every key's lifetime
 * spend and quietly re-open budgets the operator had already spent.
 *
 * WHAT IS EXACT AND WHAT IS NOT
 *
 * Every count, token sum and cost in a rollup is exact — it is a plain sum of
 * the same rows a raw scan would have visited. The ONE approximation is
 * `medianCacheHitRate`: a median cannot be composed from per-day medians, so
 * each day stores a 1000-bin histogram of its per-event hit rates instead. The
 * median recovered from bins is off by at most half a bin — 0.0005, i.e. well
 * under a twentieth of a percentage point. Storing the raw rates instead would
 * make a "permanent" sidecar grow with traffic, which is the property this whole
 * layout exists to avoid.
 *
 * STALENESS: a rollup records the byte size of the shard it was built from.
 * Because a shard is append-only, a size change means rows were added after the
 * rollup was computed (only reachable by inserting into a past day — the tests
 * do it, production does not) and the rollup is recomputed. A shard that is GONE
 * is the pruned case, where the rollup is the sole surviving authority.
 *
 * @module @omnicross/daemon/usage/usageRollup
 */

import type {
  ApiKeyUsageRow,
  ModelUsageRow,
  UsageEventRecord,
  UsageTotals,
} from '@omnicross/contracts/usage-stats-types';

/** Bins across [0, 1] for the cache-hit-rate histogram. Half-bin error = 0.0005. */
export const HIT_RATE_BINS = 1_000;

/**
 * Session ids retained per day for the session-drilldown index. Past this the
 * list is marked truncated and a session lookup falls back to scanning that
 * day's rows — correctness never depends on the index being complete.
 */
export const SESSION_INDEX_LIMIT = 5_000;

/** Everything in `UsageTotals` except the one field that cannot be summed. */
export type SummableTotals = Omit<UsageTotals, 'medianCacheHitRate'>;

/** Per-model group inside a rollup. `unpriced` is deliberately absent — it is
 *  derived at query time from the injected pricing lookup, so a pricing change
 *  never requires rewriting an immutable rollup. */
export type RollupModelRow = Omit<ModelUsageRow, 'unpriced'>;

/** Per-key group inside a rollup. `label` is absent for the same reason: it is
 *  resolved by the admin handler against the live key registry. */
export type RollupApiKeyRow = Omit<ApiKeyUsageRow, 'label'>;

/** One hour of a day. Only hours that saw traffic are stored. */
export interface RollupHourRow {
  /** LOCAL hour of day, 0–23. */
  hour: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

/** The on-disk `usage-YYYY-MM-DD.rollup.json` document. */
export interface UsageDayRollup {
  version: 1;
  /** `YYYY-MM-DD`, LOCAL. Must match the file name. */
  date: string;
  /** Byte size of the shard this was built from; the staleness guard. */
  sourceBytes: number;
  totals: SummableTotals;
  /** Sparse `binIndex -> count` over per-event cache-hit rates. */
  hitRateBins: Record<string, number>;
  byModel: RollupModelRow[];
  byApiKey: RollupApiKeyRow[];
  byHour: RollupHourRow[];
  /** Distinct non-null session ids seen that day (drilldown index). */
  sessionIds: string[];
  /** True when `sessionIds` hit {@link SESSION_INDEX_LIMIT} and is incomplete. */
  sessionIdsTruncated: boolean;
}

/** A zeroed {@link SummableTotals}. */
export function emptyTotals(): SummableTotals {
  return {
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
}

/** Prompt-side tokens — the cache-hit-rate denominator (output excluded). */
export function promptSideTokens(row: UsageEventRecord): number {
  return row.inputTokens + row.cacheReadTokens + row.cacheCreationTokens;
}

/** Bin index for a hit rate in [0, 1]. 1.0 clamps into the last bin. */
export function hitRateBin(rate: number): number {
  const idx = Math.floor(rate * HIT_RATE_BINS);
  if (idx < 0) return 0;
  return idx >= HIT_RATE_BINS ? HIT_RATE_BINS - 1 : idx;
}

/** The representative value of a bin — its midpoint. */
function binValue(index: number): number {
  return (index + 0.5) / HIT_RATE_BINS;
}

/** Fold one row into a running {@link SummableTotals}. */
export function addRowToTotals(totals: SummableTotals, row: UsageEventRecord): void {
  totals.inputTokens += row.inputTokens;
  totals.outputTokens += row.outputTokens;
  totals.cacheReadTokens += row.cacheReadTokens;
  totals.cacheCreationTokens += row.cacheCreationTokens;
  totals.reasoningTokens += row.reasoningTokens;
  totals.costUsd += row.costUsd;
  totals.costSavedByCacheUsd += row.costSavedByCacheUsd;
  totals.eventCount += 1;
  if (promptSideTokens(row) > 0) {
    totals.cacheEligibleEventCount += 1;
    if (row.cacheReadTokens === 0) totals.coldCacheEventCount += 1;
  }
}

/** Add `from` into `into`, field by field. */
export function mergeTotals(into: SummableTotals, from: SummableTotals): void {
  into.inputTokens += from.inputTokens;
  into.outputTokens += from.outputTokens;
  into.cacheReadTokens += from.cacheReadTokens;
  into.cacheCreationTokens += from.cacheCreationTokens;
  into.reasoningTokens += from.reasoningTokens;
  into.costUsd += from.costUsd;
  into.costSavedByCacheUsd += from.costSavedByCacheUsd;
  into.eventCount += from.eventCount;
  into.cacheEligibleEventCount += from.cacheEligibleEventCount;
  into.coldCacheEventCount += from.coldCacheEventCount;
}

/** Accumulate a sparse hit-rate histogram in place. */
export function addRateToBins(bins: Map<number, number>, rate: number): void {
  const idx = hitRateBin(rate);
  bins.set(idx, (bins.get(idx) ?? 0) + 1);
}

/** Merge a serialized sparse histogram into an in-memory one. */
export function mergeBins(into: Map<number, number>, from: Record<string, number>): void {
  for (const [key, count] of Object.entries(from)) {
    const idx = Number(key);
    if (!Number.isInteger(idx) || idx < 0 || idx >= HIT_RATE_BINS) continue;
    if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) continue;
    into.set(idx, (into.get(idx) ?? 0) + count);
  }
}

/**
 * Median recovered from a sparse histogram, matching the exact-median contract:
 * `null` for no samples, the middle value for an odd count, the mean of the two
 * middle values for an even count. Values are bin midpoints, so the result is
 * within half a bin of the true median.
 */
export function medianFromBins(bins: Map<number, number>): number | null {
  let total = 0;
  for (const count of bins.values()) total += count;
  if (total === 0) return null;
  const ordered = Array.from(bins.entries()).sort((a, b) => a[0] - b[0]);
  // Positions of the one (odd) or two (even) middle samples, 0-indexed.
  const lower = Math.floor((total - 1) / 2);
  const upper = Math.floor(total / 2);
  let seen = 0;
  let lowerValue: number | null = null;
  for (const [idx, count] of ordered) {
    const next = seen + count;
    if (lowerValue === null && next > lower) lowerValue = binValue(idx);
    if (next > upper) {
      const upperValue = binValue(idx);
      return lowerValue === null ? upperValue : (lowerValue + upperValue) / 2;
    }
    seen = next;
  }
  return lowerValue;
}

/** Serialize a sparse histogram for the on-disk document. */
export function binsToRecord(bins: Map<number, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [idx, count] of Array.from(bins.entries()).sort((a, b) => a[0] - b[0])) {
    out[String(idx)] = count;
  }
  return out;
}

/**
 * Streaming accumulator for ONE day's rollup.
 *
 * Exists so the one-shot migration can build every day's rollup during the SAME
 * pass that splits the legacy file into shards, instead of re-reading everything
 * a second time. It also keeps the memory profile honest: a day's rollup is a
 * handful of small maps, not the day's rows.
 *
 * Group ORDER is first-seen order over the rows fed in, which is what keeps
 * `byApiKey[].providerId` matching the legacy "first row for this key wins"
 * behaviour once days are merged ascending.
 */
export class DayRollupAccumulator {
  private readonly totals = emptyTotals();
  private readonly bins = new Map<number, number>();
  private readonly models = new Map<string, RollupModelRow>();
  private readonly keys = new Map<string | null, RollupApiKeyRow>();
  private readonly hours = new Map<number, RollupHourRow>();
  private readonly sessionIds = new Set<string>();
  private sessionIdsTruncated = false;

  add(row: UsageEventRecord): void {
    addRowToTotals(this.totals, row);
    const promptSide = promptSideTokens(row);
    if (promptSide > 0) addRateToBins(this.bins, row.cacheReadTokens / promptSide);

    const modelKey = `${row.providerId}::${row.model}`;
    let m = this.models.get(modelKey);
    if (!m) {
      m = {
        providerId: row.providerId,
        model: row.model,
        eventCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
        costSavedByCacheUsd: 0,
      };
      this.models.set(modelKey, m);
    }
    m.eventCount += 1;
    m.inputTokens += row.inputTokens;
    m.outputTokens += row.outputTokens;
    m.cacheReadTokens += row.cacheReadTokens;
    m.cacheCreationTokens += row.cacheCreationTokens;
    m.costUsd += row.costUsd;
    m.costSavedByCacheUsd += row.costSavedByCacheUsd;

    let k = this.keys.get(row.apiKeyId);
    if (!k) {
      k = {
        apiKeyId: row.apiKeyId,
        providerId: row.apiKeyId === null ? null : row.providerId,
        eventCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      };
      this.keys.set(row.apiKeyId, k);
    }
    k.eventCount += 1;
    k.inputTokens += row.inputTokens;
    k.outputTokens += row.outputTokens;
    k.costUsd += row.costUsd;

    const hour = new Date(row.ts).getHours();
    let h = this.hours.get(hour);
    if (!h) {
      h = {
        hour,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
      };
      this.hours.set(hour, h);
    }
    h.requests += 1;
    h.inputTokens += row.inputTokens;
    h.outputTokens += row.outputTokens;
    h.cacheReadTokens += row.cacheReadTokens;
    h.cacheCreationTokens += row.cacheCreationTokens;
    h.costUsd += row.costUsd;

    if (row.sessionId !== null) {
      if (this.sessionIds.size < SESSION_INDEX_LIMIT) this.sessionIds.add(row.sessionId);
      else if (!this.sessionIds.has(row.sessionId)) this.sessionIdsTruncated = true;
    }
  }

  /** Seal the accumulator into the on-disk document for `date`. */
  finish(date: string, sourceBytes: number): UsageDayRollup {
    return {
      version: 1,
      date,
      sourceBytes,
      totals: this.totals,
      hitRateBins: binsToRecord(this.bins),
      byModel: Array.from(this.models.values()),
      byApiKey: Array.from(this.keys.values()),
      byHour: Array.from(this.hours.values()).sort((a, b) => a.hour - b.hour),
      sessionIds: Array.from(this.sessionIds),
      sessionIdsTruncated: this.sessionIdsTruncated,
    };
  }
}

/**
 * Build the rollup for ONE day from that day's rows.
 *
 * `rows` must all belong to `date` — the caller owns that (it read the day's
 * shard).
 */
export function buildDayRollup(
  date: string,
  sourceBytes: number,
  rows: Iterable<UsageEventRecord>,
): UsageDayRollup {
  const acc = new DayRollupAccumulator();
  for (const row of rows) acc.add(row);
  return acc.finish(date, sourceBytes);
}

/**
 * Shape-guard a rollup read off disk. A corrupt or future-version sidecar reads
 * as `null` so the caller recomputes it from the shard rather than serving
 * nonsense — the rollup is a cache of the rows, never a separate source of truth
 * (until the rows are pruned, at which point it is all that is left, and a
 * corrupt one simply reports that day as empty).
 */
export function isUsageDayRollup(parsed: unknown): parsed is UsageDayRollup {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const r = parsed as Record<string, unknown>;
  if (r['version'] !== 1) return false;
  if (typeof r['date'] !== 'string') return false;
  if (typeof r['sourceBytes'] !== 'number' || !Number.isFinite(r['sourceBytes'])) return false;
  const totals = r['totals'];
  if (!totals || typeof totals !== 'object') return false;
  for (const field of Object.keys(emptyTotals())) {
    const v = (totals as Record<string, unknown>)[field];
    if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  }
  if (!Array.isArray(r['byModel'])) return false;
  if (!Array.isArray(r['byApiKey'])) return false;
  if (!Array.isArray(r['byHour'])) return false;
  if (!Array.isArray(r['sessionIds'])) return false;
  if (!r['hitRateBins'] || typeof r['hitRateBins'] !== 'object') return false;
  return true;
}
