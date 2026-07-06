/**
 * JsonlUsageEventStore — the daemon's file-backed `UsageEventStore` port impl.
 *
 * Usage is APPEND-dominated (one row per served request), so the store uses an
 * append-only JSON-lines file (`usage-events.jsonl`, a sibling of `config.json`)
 * instead of a rewrite-per-mutation JSON array: `insert` appends exactly one
 * line in O(1) and a crash can only tear the FINAL line, which reads skip
 * defensively (malformed lines never poison a query).
 *
 * Queries parse the file on demand and aggregate in memory — admin stats
 * queries are rare and a full scan of even hundreds of thousands of lines is
 * fast enough; an invalidate-on-append cache is a deliberate non-feature until
 * it ever matters.
 *
 * `unpriced` on the by-model view is derived through an INJECTED lookup
 * `(providerId, model) => boolean` wired from the pricing engine at bootstrap,
 * keeping this store free of any engine coupling.
 *
 * @module @omnicross/daemon/ports/JsonlUsageEventStore
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

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

/** Pricing-presence lookup injected at bootstrap (true = a pricing row resolves). */
export type IsPricedLookup = (providerId: string, model: string) => Promise<boolean>;

export class JsonlUsageEventStore implements UsageEventStore {
  constructor(
    private readonly eventsPath: string,
    private readonly isPriced: IsPricedLookup,
  ) {}

  /** Persist one event: assign `id`, stamp `ts` when absent, append ONE line. */
  async insert(input: UsageEventInput): Promise<string> {
    const row: UsageEventRecord = {
      ...input,
      id: randomUUID(),
      ts: input.ts ?? Date.now(),
    };
    appendFileSync(this.eventsPath, JSON.stringify(row) + '\n', 'utf8');
    return row.id;
  }

  async getTotals(range: UsageDateRange): Promise<UsageTotals> {
    const totals: UsageTotals = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      costUsd: 0,
      costSavedByCacheUsd: 0,
      eventCount: 0,
    };
    for (const row of this.readRows(range)) {
      totals.inputTokens += row.inputTokens;
      totals.outputTokens += row.outputTokens;
      totals.cacheReadTokens += row.cacheReadTokens;
      totals.cacheCreationTokens += row.cacheCreationTokens;
      totals.reasoningTokens += row.reasoningTokens;
      totals.costUsd += row.costUsd;
      totals.costSavedByCacheUsd += row.costSavedByCacheUsd;
      totals.eventCount += 1;
    }
    return totals;
  }

  async getByModel(range: UsageDateRange): Promise<ModelUsageRow[]> {
    const groups = new Map<string, ModelUsageRow>();
    for (const row of this.readRows(range)) {
      const key = `${row.providerId}::${row.model}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          providerId: row.providerId,
          model: row.model,
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
      g.eventCount += 1;
      g.inputTokens += row.inputTokens;
      g.outputTokens += row.outputTokens;
      g.cacheReadTokens += row.cacheReadTokens;
      g.cacheCreationTokens += row.cacheCreationTokens;
      g.costUsd += row.costUsd;
      g.costSavedByCacheUsd += row.costSavedByCacheUsd;
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
    for (const row of this.readRows(range)) {
      const key = row.apiKeyId;
      let g = groups.get(key);
      if (!g) {
        g = {
          apiKeyId: key,
          label: key ?? 'unattributed',
          providerId: key === null ? null : row.providerId,
          eventCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
        };
        groups.set(key, g);
      }
      g.eventCount += 1;
      g.inputTokens += row.inputTokens;
      g.outputTokens += row.outputTokens;
      g.costUsd += row.costUsd;
    }
    return Array.from(groups.values());
  }

  /**
   * ONE pass over a single key's events (`ts < endTs`) summing its `costUsd` into
   * `totalUsd` / `dailyUsd` (`ts >= dayStartTs`) / `weeklyUsd` (`ts >= weekStartTs`).
   * Used to lazily seed the outbound key-policy spend tracker (once per key). A
   * key with no attributed events yields all zeros.
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
    // Scan the whole history up to endTs once; bucket each row into every window
    // it qualifies for (daily/weekly are sub-ranges of total).
    for (const row of this.readRows({ startTs: 0, endTs: query.endTs })) {
      if (row.apiKeyId !== query.apiKeyId) continue;
      totalUsd += row.costUsd;
      if (row.ts >= query.dayStartTs) dailyUsd += row.costUsd;
      if (row.ts >= query.weekStartTs) weeklyUsd += row.costUsd;
    }
    return { totalUsd, dailyUsd, weeklyUsd };
  }

  /**
   * Time-series aggregation over LOCAL-time bucket boundaries. Every bucket in
   * `[floor(startTs), endTs)` is present (empty ones zero-filled), ascending by
   * `bucketStartTs`; an empty range (`startTs >= endTs`) returns `[]`. Reuses
   * `readRows` so malformed lines are skipped and only in-range rows contribute.
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
    for (const row of this.readRows(range)) {
      const g = buckets.get(floorToBucket(row.ts, bucket));
      if (!g) continue; // defensive — every in-range row floors into an enumerated bucket
      g.requests += 1;
      g.inputTokens += row.inputTokens;
      g.outputTokens += row.outputTokens;
      g.cacheReadTokens += row.cacheReadTokens;
      g.cacheCreationTokens += row.cacheCreationTokens;
      g.costUsd += row.costUsd;
    }
    return Array.from(buckets.values());
  }

  async getMessagesForSession(sessionId: string): Promise<MessageUsageRow[]> {
    return this.readAllRows()
      .filter((r) => r.sessionId === sessionId)
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
    for (const r of this.readAllRows()) {
      if (r.sessionId !== sessionId) continue;
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

  /** Rows inside `startTs <= ts < endTs` (endTs EXCLUSIVE). */
  private readRows(range: UsageDateRange): UsageEventRecord[] {
    return this.readAllRows().filter((r) => r.ts >= range.startTs && r.ts < range.endTs);
  }

  /** Parse every line, skipping malformed/torn lines defensively. */
  private readAllRows(): UsageEventRecord[] {
    if (!existsSync(this.eventsPath)) return [];
    let raw: string;
    try {
      raw = readFileSync(this.eventsPath, 'utf8');
    } catch {
      return [];
    }
    const rows: UsageEventRecord[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (isUsageEventRecord(parsed)) rows.push(parsed);
      } catch {
        // torn/garbage line — skip (crash-tolerance contract)
      }
    }
    return rows;
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

/** Frozen locale-agnostic label from LOCAL parts: hour `MM-DD HH:00`, day `YYYY-MM-DD`, month `YYYY-MM`. */
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

// ── Row guard ─────────────────────────────────────────────────────────────────

const NUMERIC_FIELDS = [
  'ts',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheCreationTokens',
  'reasoningTokens',
  'costUsd',
  'costSavedByCacheUsd',
] as const;

const NULLABLE_STRING_FIELDS = ['messageId', 'parentMessageId', 'sessionId', 'apiKeyId'] as const;

const isStringOrNull = (v: unknown): boolean => v === null || typeof v === 'string';

/**
 * Full defensive row guard: a parseable-but-PARTIAL line (e.g. hand-edited or
 * produced by a different writer) must not poison aggregations with NaN.
 * Requires string identity/required fields (nullable where the record says
 * so) and FINITE numbers for every token/cost field.
 */
function isUsageEventRecord(parsed: unknown): parsed is UsageEventRecord {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const r = parsed as Record<string, unknown>;
  if (typeof r['id'] !== 'string') return false;
  if (typeof r['providerId'] !== 'string') return false;
  if (typeof r['model'] !== 'string') return false;
  if (typeof r['engineOrigin'] !== 'string') return false;
  for (const f of NULLABLE_STRING_FIELDS) {
    if (!isStringOrNull(r[f])) return false;
  }
  for (const f of NUMERIC_FIELDS) {
    const v = r[f];
    if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  }
  return true;
}
