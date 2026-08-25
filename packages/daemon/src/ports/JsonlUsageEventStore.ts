/**
 * JsonlUsageEventStore — the daemon's file-backed `UsageEventStore` port impl.
 *
 * Usage is APPEND-dominated (one row per served request), so rows live in
 * append-only JSON-lines files: `insert` appends exactly one line in O(1) and a
 * crash can only tear the FINAL line, which reads skip defensively (malformed
 * lines never poison a query).
 *
 * SHARDED BY LOCAL DAY. Rows go to `usage/usage-YYYY-MM-DD.jsonl`, and each
 * CLOSED day gets an immutable `usage-YYYY-MM-DD.rollup.json` aggregate beside
 * it. A range query therefore reads a few KB of pre-computed JSON per whole day
 * it spans and parses rows only for today and for a partially-covered edge day.
 *
 * WHY, in one paragraph, because the previous shape was a genuine outage. Every
 * query used to `readFileSync` the ENTIRE flat `usage-events.jsonl`, split it and
 * `JSON.parse` every line, with no cache — measured at 1.2–1.6 s of fully
 * BLOCKED event loop and ~190 MB of transient allocation per call, on a file
 * growing ~5 MB/day toward V8's ~512 MB string ceiling (past which every usage
 * query throws outright). The daemon relays gateway traffic on that same event
 * loop, so opening a dashboard stalled live requests. `core/usage/
 * throughputTracker` documents having ROUTED AROUND this rather than fixing it;
 * this is the fix.
 *
 * WHAT IS PRESERVED
 *  - The port surface is unchanged: same eight methods, same signatures, same
 *    `endTs`-exclusive ranges and LOCAL-time bucket boundaries.
 *  - The constructor still takes the LEGACY flat-file path. The shard directory
 *    is derived from it (`usage/`, a sibling), so no caller had to change and
 *    `usageMigrate` knows exactly which file to fold in.
 *  - Torn-line and partial-row tolerance, via the shared guard in `usageRow`.
 *
 * WHAT CHANGED, deliberately
 *  - `medianCacheHitRate` is recovered from a 1000-bin histogram (±0.0005)
 *    rather than an exact sort, because a median is the one aggregate that
 *    cannot be composed from per-day summaries. See `usageRollup`.
 *  - Session drilldowns (`getMessagesForSession`, `getSessionCacheStats`) can
 *    only see days whose rows still exist — i.e. within the retention window.
 *    Aggregates reach back forever, because rollups are never pruned.
 *
 * `unpriced` on the by-model view is derived through an INJECTED lookup
 * `(providerId, model) => boolean` wired from the pricing engine at bootstrap,
 * keeping this store free of any engine coupling — and keeping it OUT of the
 * immutable rollups, so a pricing change never invalidates one.
 *
 * @module @omnicross/daemon/ports/JsonlUsageEventStore
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type {
  ApiKeyUsageRow,
  MessageUsageRow,
  ModelUsageRow,
  SessionCacheStats,
  UsageDateRange,
  UsageEventInput,
  UsageEventRecord,
  UsageTimeBucket,
  UsageTimeSeriesBucket,
  UsageTotals,
} from '@omnicross/contracts/usage-stats-types';
import type { UsageEventStore } from '@omnicross/core';

import {
  dayKeyEndTs,
  dayKeyStartTs,
  listUsageDays,
  usageDayKey,
  usageDirFor,
  usageShardName,
  type UsageDayEntry,
} from '../usage/usageFiles';
import {
  addRateToBins,
  addRowToTotals,
  emptyTotals,
  medianFromBins,
  mergeBins,
  mergeTotals,
  promptSideTokens,
  type UsageDayRollup,
} from '../usage/usageRollup';
import { UsageRollupStore } from '../usage/usageRollupStore';
import { streamShardRows, UsageShardCache } from '../usage/usageShardCache';

/** Pricing-presence lookup injected at bootstrap (true = a pricing row resolves). */
export type IsPricedLookup = (providerId: string, model: string) => Promise<boolean>;

/** Lazily-built session-id lookups, keyed by the rollup object they came from. */
const sessionIndexes = new WeakMap<UsageDayRollup, Set<string>>();

function sessionIndex(rollup: UsageDayRollup): Set<string> {
  let set = sessionIndexes.get(rollup);
  if (!set) {
    set = new Set(rollup.sessionIds);
    sessionIndexes.set(rollup, set);
  }
  return set;
}

/** How a single day should be answered for a given range. */
interface DayPlan {
  dayKey: string;
  startTs: number;
  endTs: number;
  /** True when the range covers the whole day AND the day is closed. */
  fromRollup: boolean;
  hasShard: boolean;
}

export class JsonlUsageEventStore implements UsageEventStore {
  private readonly usageDir: string;
  private readonly shards: UsageShardCache;
  private readonly rollups: UsageRollupStore;
  /** Day of the last append — lets `insert` skip per-request bookkeeping. */
  private lastAppendDay: string | null = null;
  private dirReady = false;

  constructor(
    private readonly eventsPath: string,
    private readonly isPriced: IsPricedLookup,
  ) {
    this.usageDir = usageDirFor(eventsPath);
    this.shards = new UsageShardCache(this.usageDir);
    this.rollups = new UsageRollupStore(this.usageDir);
  }

  /** The `usage/` shard directory — the migration and prune sweeper share it. */
  get shardDir(): string {
    return this.usageDir;
  }

  /**
   * The rollup store, so the prune sweeper builds and invalidates through the
   * SAME instance the queries read from. Handing the sweeper its own would let
   * it delete a shard while this store still served a memoised rollup built from
   * it — the two caches have to agree.
   */
  get rollupStore(): UsageRollupStore {
    return this.rollups;
  }

  /** The legacy flat-file path this store was constructed from. */
  get legacyEventsPath(): string {
    return this.eventsPath;
  }

  /** Drop every in-memory cache (after a migration or an external prune). */
  resetCaches(): void {
    this.shards.invalidate();
    this.rollups.invalidate();
    this.lastAppendDay = null;
  }

  /**
   * Persist one event: assign `id`, stamp `ts` when absent, append ONE line to
   * that timestamp's LOCAL-day shard.
   *
   * Still `appendFileSync`: a single short line is cheap, and the synchronous
   * write is what makes "the row is on disk before the request is acknowledged"
   * true. The reads are what had to stop being synchronous, not this.
   */
  async insert(input: UsageEventInput): Promise<string> {
    const row: UsageEventRecord = {
      ...input,
      id: randomUUID(),
      ts: input.ts ?? Date.now(),
    };
    const dayKey = usageDayKey(row.ts);
    this.ensureDir();
    const line = JSON.stringify(row) + '\n';
    appendFileSync(join(this.usageDir, usageShardName(dayKey)), line, 'utf8');
    // No cache write-through: the next read tails exactly these bytes off disk,
    // which costs a stat and a few hundred bytes, and cannot race a catch-up
    // that is already in flight for the same day.
    if (dayKey !== this.lastAppendDay) {
      // Day rolled over, or an event was inserted into a PAST day (the API
      // allows an explicit `ts`). Either way any memoised rollup for that day is
      // now behind the shard; drop it so the next read rebuilds. The on-disk
      // size guard would catch this too — this just avoids serving the stale
      // memo in between.
      this.rollups.invalidate(dayKey);
      this.lastAppendDay = dayKey;
    }
    return row.id;
  }

  async getTotals(range: UsageDateRange): Promise<UsageTotals> {
    const totals = emptyTotals();
    const bins = new Map<number, number>();
    for (const plan of await this.planRange(range)) {
      if (plan.fromRollup) {
        const rollup = await this.rollups.get(plan.dayKey, plan.hasShard);
        if (!rollup) continue;
        mergeTotals(totals, rollup.totals);
        mergeBins(bins, rollup.hitRateBins);
        continue;
      }
      for (const row of await this.rowsInRange(plan, range)) {
        addRowToTotals(totals, row);
        const promptSide = promptSideTokens(row);
        if (promptSide > 0) addRateToBins(bins, row.cacheReadTokens / promptSide);
      }
    }
    return { ...totals, medianCacheHitRate: medianFromBins(bins) };
  }

  async getByModel(range: UsageDateRange): Promise<ModelUsageRow[]> {
    const groups = new Map<string, ModelUsageRow>();
    const group = (providerId: string, model: string): ModelUsageRow => {
      const key = `${providerId}::${model}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          providerId,
          model,
          eventCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0,
          costSavedByCacheUsd: 0,
          unpriced: false,
        };
        groups.set(key, g);
      }
      return g;
    };
    for (const plan of await this.planRange(range)) {
      if (plan.fromRollup) {
        const rollup = await this.rollups.get(plan.dayKey, plan.hasShard);
        if (!rollup) continue;
        for (const m of rollup.byModel) {
          const g = group(m.providerId, m.model);
          g.eventCount += m.eventCount;
          g.inputTokens += m.inputTokens;
          g.outputTokens += m.outputTokens;
          g.cacheReadTokens += m.cacheReadTokens;
          g.cacheCreationTokens += m.cacheCreationTokens;
          g.costUsd += m.costUsd;
          g.costSavedByCacheUsd += m.costSavedByCacheUsd;
        }
        continue;
      }
      for (const row of await this.rowsInRange(plan, range)) {
        const g = group(row.providerId, row.model);
        g.eventCount += 1;
        g.inputTokens += row.inputTokens;
        g.outputTokens += row.outputTokens;
        g.cacheReadTokens += row.cacheReadTokens;
        g.cacheCreationTokens += row.cacheCreationTokens;
        g.costUsd += row.costUsd;
        g.costSavedByCacheUsd += row.costSavedByCacheUsd;
      }
    }
    const rows = Array.from(groups.values());
    for (const g of rows) {
      g.unpriced = !(await this.isPriced(g.providerId, g.model));
    }
    return rows;
  }

  /**
   * Group by RAW apiKeyId (null forms the unattributed sentinel group). Label
   * here is the raw id fallback — the admin handler resolves display labels
   * against the configured pool keys (the store stays config-schema-free).
   */
  async getByApiKey(range: UsageDateRange): Promise<ApiKeyUsageRow[]> {
    const groups = new Map<string | null, ApiKeyUsageRow>();
    // Days are planned ascending, so the first row/rollup to name a key sets its
    // `providerId` — matching the legacy "first row in the file wins".
    const group = (apiKeyId: string | null, providerId: string | null): ApiKeyUsageRow => {
      let g = groups.get(apiKeyId);
      if (!g) {
        g = {
          apiKeyId,
          label: apiKeyId ?? 'unattributed',
          providerId: apiKeyId === null ? null : providerId,
          eventCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
        };
        groups.set(apiKeyId, g);
      }
      return g;
    };
    for (const plan of await this.planRange(range)) {
      if (plan.fromRollup) {
        const rollup = await this.rollups.get(plan.dayKey, plan.hasShard);
        if (!rollup) continue;
        for (const k of rollup.byApiKey) {
          const g = group(k.apiKeyId, k.providerId);
          g.eventCount += k.eventCount;
          g.inputTokens += k.inputTokens;
          g.outputTokens += k.outputTokens;
          g.costUsd += k.costUsd;
        }
        continue;
      }
      for (const row of await this.rowsInRange(plan, range)) {
        const g = group(row.apiKeyId, row.providerId);
        g.eventCount += 1;
        g.inputTokens += row.inputTokens;
        g.outputTokens += row.outputTokens;
        g.costUsd += row.costUsd;
      }
    }
    return Array.from(groups.values());
  }

  /**
   * Sum ONE key's `costUsd` into `totalUsd` / `dailyUsd` (`ts >= dayStartTs`) /
   * `weeklyUsd` (`ts >= weekStartTs`) over all events with `ts < endTs`. Used to
   * lazily seed the outbound key-policy spend tracker (once per key).
   *
   * `totalUsd` is a LIFETIME figure, which is precisely why rollups outlive the
   * rows they summarise: pruning raw events without them would silently zero
   * every key's lifetime spend and reopen budgets the operator already spent.
   *
   * A whole day can be taken from its rollup only when the day sits entirely on
   * ONE side of each window boundary. In production those boundaries are local
   * midnights so that is always true; a caller passing mid-day boundaries (the
   * tests do) just falls back to scanning that day's rows.
   */
  async getSpendByKey(query: {
    apiKeyId: string;
    dayStartTs: number;
    weekStartTs: number;
    endTs: number;
  }): Promise<{ totalUsd: number; dailyUsd: number; weeklyUsd: number }> {
    let totalUsd = 0;
    let dailyUsd = 0;
    let weeklyUsd = 0;
    const range = { startTs: Number.NEGATIVE_INFINITY, endTs: query.endTs };
    for (const plan of await this.planRange(range)) {
      const wholeSideOf = (boundary: number): boolean =>
        plan.startTs >= boundary || plan.endTs <= boundary;
      if (plan.fromRollup && wholeSideOf(query.dayStartTs) && wholeSideOf(query.weekStartTs)) {
        const rollup = await this.rollups.get(plan.dayKey, plan.hasShard);
        if (!rollup) continue;
        const k = rollup.byApiKey.find((r) => r.apiKeyId === query.apiKeyId);
        if (!k) continue;
        totalUsd += k.costUsd;
        if (plan.startTs >= query.dayStartTs) dailyUsd += k.costUsd;
        if (plan.startTs >= query.weekStartTs) weeklyUsd += k.costUsd;
        continue;
      }
      for (const row of await this.rowsInRange(plan, range)) {
        if (row.apiKeyId !== query.apiKeyId) continue;
        totalUsd += row.costUsd;
        if (row.ts >= query.dayStartTs) dailyUsd += row.costUsd;
        if (row.ts >= query.weekStartTs) weeklyUsd += row.costUsd;
      }
    }
    return { totalUsd, dailyUsd, weeklyUsd };
  }

  /**
   * Time-series aggregation over LOCAL-time bucket boundaries. Every bucket in
   * `[floor(startTs), endTs)` is present (empty ones zero-filled), ascending by
   * `bucketStartTs`; an empty range (`startTs >= endTs`) returns `[]`.
   *
   * A whole closed day contributes through its rollup's per-hour rows, which
   * fold into hour, day and month buckets alike; a partial day is read from its
   * rows so a mid-bucket `startTs` still excludes the events before it.
   */
  async getTimeSeries(range: UsageDateRange, bucket: UsageTimeBucket): Promise<UsageTimeSeriesBucket[]> {
    if (range.startTs >= range.endTs) return [];
    const buckets = new Map<number, UsageTimeSeriesBucket>();
    // Enumerate LOCAL boundaries via the Date constructor (month-length/DST safe).
    for (let b = floorToBucket(range.startTs, bucket); b < range.endTs; b = nextBoundary(b, bucket)) {
      buckets.set(b, {
        bucketStartTs: b,
        label: bucketLabel(b, bucket),
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
      });
    }
    for (const plan of await this.planRange(range)) {
      if (plan.fromRollup) {
        const rollup = await this.rollups.get(plan.dayKey, plan.hasShard);
        if (!rollup) continue;
        const dayStart = new Date(plan.startTs);
        for (const h of rollup.byHour) {
          const hourStart = new Date(
            dayStart.getFullYear(),
            dayStart.getMonth(),
            dayStart.getDate(),
            h.hour,
          ).getTime();
          const g = buckets.get(floorToBucket(hourStart, bucket));
          if (!g) continue;
          g.requests += h.requests;
          g.inputTokens += h.inputTokens;
          g.outputTokens += h.outputTokens;
          g.cacheReadTokens += h.cacheReadTokens;
          g.cacheCreationTokens += h.cacheCreationTokens;
          g.costUsd += h.costUsd;
        }
        continue;
      }
      for (const row of await this.rowsInRange(plan, range)) {
        const g = buckets.get(floorToBucket(row.ts, bucket));
        if (!g) continue; // defensive — every in-range row floors into an enumerated bucket
        g.requests += 1;
        g.inputTokens += row.inputTokens;
        g.outputTokens += row.outputTokens;
        g.cacheReadTokens += row.cacheReadTokens;
        g.cacheCreationTokens += row.cacheCreationTokens;
        g.costUsd += row.costUsd;
      }
    }
    return Array.from(buckets.values());
  }

  async getMessagesForSession(sessionId: string): Promise<MessageUsageRow[]> {
    const rows = await this.rowsForSession(sessionId);
    return rows
      .sort((a, b) => a.ts - b.ts)
      .map((r) => ({
        id: r.id,
        ts: r.ts,
        messageId: r.messageId,
        parentMessageId: r.parentMessageId,
        sessionId: r.sessionId,
        providerId: r.providerId,
        model: r.model,
        apiKeyId: r.apiKeyId,
        engineOrigin: r.engineOrigin,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cacheReadTokens: r.cacheReadTokens,
        cacheCreationTokens: r.cacheCreationTokens,
        reasoningTokens: r.reasoningTokens,
        costUsd: r.costUsd,
        costSavedByCacheUsd: r.costSavedByCacheUsd,
      }));
  }

  async getSessionCacheStats(sessionId: string): Promise<SessionCacheStats> {
    const stats: SessionCacheStats = {
      sessionId,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      eventCount: 0,
      hitRate: 0,
    };
    for (const r of await this.rowsForSession(sessionId)) {
      stats.inputTokens += r.inputTokens;
      stats.cacheReadTokens += r.cacheReadTokens;
      stats.cacheCreationTokens += r.cacheCreationTokens;
      stats.outputTokens += r.outputTokens;
      stats.eventCount += 1;
    }
    const promptSide = stats.inputTokens + stats.cacheReadTokens + stats.cacheCreationTokens;
    stats.hitRate = promptSide > 0 ? stats.cacheReadTokens / promptSide : 0;
    return stats;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private ensureDir(): void {
    if (this.dirReady) return;
    mkdirSync(this.usageDir, { recursive: true });
    this.dirReady = true;
  }

  /**
   * Decide, per day that overlaps the range, whether it can be answered from its
   * rollup or has to be read row by row.
   *
   * Only days that EXIST on disk are considered — enumerating calendar days
   * would walk from the epoch for a lifetime query like `getSpendByKey`.
   */
  private async planRange(range: UsageDateRange): Promise<DayPlan[]> {
    const today = usageDayKey(Date.now());
    const plans: DayPlan[] = [];
    for (const entry of await listUsageDays(this.usageDir)) {
      const startTs = dayKeyStartTs(entry.dayKey);
      const endTs = dayKeyEndTs(entry.dayKey);
      if (Number.isNaN(startTs) || Number.isNaN(endTs)) continue;
      if (endTs <= range.startTs || startTs >= range.endTs) continue; // no overlap
      const covered = range.startTs <= startTs && range.endTs >= endTs;
      plans.push({
        dayKey: entry.dayKey,
        startTs,
        endTs,
        // Today's rows are still arriving, so today is never taken from a rollup
        // even when the range nominally covers the whole day.
        fromRollup: covered && entry.dayKey !== today,
        hasShard: entry.hasShard,
      });
    }
    return plans;
  }

  /** A partially-covered (or today's) day's rows, filtered to the range. */
  private async rowsInRange(plan: DayPlan, range: UsageDateRange): Promise<UsageEventRecord[]> {
    if (!plan.hasShard) return [];
    const rows = await this.shards.rows(plan.dayKey);
    return rows.filter((r) => r.ts >= range.startTs && r.ts < range.endTs);
  }

  /**
   * Every retained row belonging to one session.
   *
   * The per-day rollup carries the set of session ids seen that day, so a day
   * that never saw this session is skipped without opening its shard at all — an
   * exact index, not a heuristic about how long sessions run. A day whose index
   * overflowed (`sessionIdsTruncated`) is scanned rather than trusted.
   *
   * Days whose rows were pruned cannot contribute; their aggregates survive in
   * the rollup, but a per-message drilldown needs the messages.
   */
  private async rowsForSession(sessionId: string): Promise<UsageEventRecord[]> {
    const today = usageDayKey(Date.now());
    const out: UsageEventRecord[] = [];
    for (const entry of await listUsageDays(this.usageDir)) {
      if (!entry.hasShard) continue;
      if (entry.hasRollup && entry.dayKey !== today) {
        const rollup = await this.rollups.get(entry.dayKey, entry.hasShard);
        if (rollup && !rollup.sessionIdsTruncated && !sessionIndex(rollup).has(sessionId)) continue;
      }
      await streamShardRows(this.usageDir, entry.dayKey, (row) => {
        if (row.sessionId === sessionId) out.push(row);
      });
    }
    return out;
  }
}

// ── Time-series bucketing (pure, LOCAL-time boundaries) ─────────────────────────

/** Floor `ts` to its LOCAL bucket boundary by zeroing the sub-bucket Date parts. */
function floorToBucket(ts: number, bucket: UsageTimeBucket): number {
  const d = new Date(ts);
  switch (bucket) {
    case 'hour':
      return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime();
    case 'day':
      return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    case 'month':
      return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  }
}

/**
 * Advance one bucket via the `Date` constructor (NOT millis arithmetic) so
 * month lengths and DST transitions are handled correctly. `ts` is assumed to
 * already be a bucket boundary.
 */
function nextBoundary(ts: number, bucket: UsageTimeBucket): number {
  const d = new Date(ts);
  switch (bucket) {
    case 'hour':
      return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
    case 'day':
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    case 'month':
      return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  }
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Frozen label formats: hour `MM-DD HH:00`, day `YYYY-MM-DD`, month `YYYY-MM`. */
function bucketLabel(bucketStartTs: number, bucket: UsageTimeBucket): string {
  const d = new Date(bucketStartTs);
  const y = d.getFullYear();
  const mo = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  switch (bucket) {
    case 'hour':
      return `${mo}-${day} ${pad2(d.getHours())}:00`;
    case 'day':
      return `${y}-${mo}-${day}`;
    case 'month':
      return `${y}-${mo}`;
  }
}

export type { UsageDayEntry };
