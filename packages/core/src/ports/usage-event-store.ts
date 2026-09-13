/**
 * `UsageEventStore` — core-owned port for usage-event persistence + aggregation.
 *
 * The usage recorder performs ALL persistence and aggregation through this
 * interface; the host embedder supplies the implementation at bootstrap (e.g.
 * a SQLite table or a JSON-lines file store). Aggregate shapes are the
 * `@omnicross/contracts/usage-stats-types` DTOs.
 *
 * @module ports/usage-event-store
 */
import type {
  ApiKeyUsageRow,
  MessageUsageRow,
  ModelUsageRow,
  SessionCacheStats,
  UsageDateRange,
  UsageEventInput,
  UsageQueryFilter,
  UsageTimeBucket,
  UsageTimeSeriesBucket,
  UsageTotals,
} from '@omnicross/contracts/usage-stats-types';

export interface UsageEventStore {
  /** Persist one event row; the store assigns `id` (and `ts` when absent). Returns the new row id. */
  insert(input: UsageEventInput): Promise<string>;
  /**
   * Aggregated totals over a date range. An optional `filter` restricts the
   * aggregation to matching events; hosts without attribute splits in their
   * rollups may answer a filtered query from raw rows.
   */
  getTotals(range: UsageDateRange, filter?: UsageQueryFilter): Promise<UsageTotals>;
  /** Per-model breakdown over a date range (optional attribute `filter`). */
  getByModel(range: UsageDateRange, filter?: UsageQueryFilter): Promise<ModelUsageRow[]>;
  /** Per-API-key breakdown over a date range (optional attribute `filter`). */
  getByApiKey(range: UsageDateRange, filter?: UsageQueryFilter): Promise<ApiKeyUsageRow[]>;
  /**
   * ONE scan of a single key's events (`ts < endTs`, EXCLUSIVE) summing its
   * `costUsd` into all three windows at once: `totalUsd` (whole history),
   * `dailyUsd` (`ts >= dayStartTs`) and `weeklyUsd` (`ts >= weekStartTs`). Used by
   * the outbound key-policy spend tracker to LAZILY seed a key on first use (once
   * per newly-seen key, NOT per request — a single pass, not three). A key with
   * no attributed events yields all zeros.
   */
  getSpendByKey(query: {
    apiKeyId: string;
    dayStartTs: number;
    weekStartTs: number;
    endTs: number;
  }): Promise<{ totalUsd: number; dailyUsd: number; weeklyUsd: number }>;
  /**
   * Time-series aggregation over `range`, bucketed at `bucket` granularity using
   * the store host's LOCAL-time boundaries. EVERY bucket in the range is
   * returned (empty ones zero-filled), ascending by `bucketStartTs`; an empty
   * range (`startTs >= endTs`) returns `[]`.
   */
  getTimeSeries(
    range: UsageDateRange,
    bucket: UsageTimeBucket,
    filter?: UsageQueryFilter,
  ): Promise<UsageTimeSeriesBucket[]>;
  /** Message-level rows for one session. */
  getMessagesForSession(sessionId: string): Promise<MessageUsageRow[]>;
  /** Cumulative cache hit/miss stats for one session. */
  getSessionCacheStats(sessionId: string): Promise<SessionCacheStats>;
}
