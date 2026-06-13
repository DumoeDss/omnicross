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
  UsageTotals,
} from '@omnicross/contracts/usage-stats-types';

export interface UsageEventStore {
  /** Persist one event row; the store assigns `id` (and `ts` when absent). Returns the new row id. */
  insert(input: UsageEventInput): Promise<string>;
  /** Aggregated totals over a date range. */
  getTotals(range: UsageDateRange): Promise<UsageTotals>;
  /** Per-model breakdown over a date range. */
  getByModel(range: UsageDateRange): Promise<ModelUsageRow[]>;
  /** Per-API-key breakdown over a date range. */
  getByApiKey(range: UsageDateRange): Promise<ApiKeyUsageRow[]>;
  /** Message-level rows for one session. */
  getMessagesForSession(sessionId: string): Promise<MessageUsageRow[]>;
  /** Cumulative cache hit/miss stats for one session. */
  getSessionCacheStats(sessionId: string): Promise<SessionCacheStats>;
}
