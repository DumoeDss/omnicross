/**
 * Usage-statistics DTOs — provider-generic stats row + aggregation views.
 *
 * The persisted usage-event row shape and the aggregate query views shared by
 * embedders that record per-request usage. Storage itself is host-owned (the
 * serving core only defines the seam); `engineOrigin` uses the OPEN
 * `UsageEngineOrigin` union from `usage-types` so hosts may narrow it to their
 * own closed engine list at their boundary.
 *
 * @module usage-stats-types
 */
import type { UsageEngineOrigin } from './usage-types';

/**
 * One captured LLM request, as persisted by the host store.
 *
 * `messageId` is nullable because indirect call paths (e.g. subagent-internal
 * requests) may not map to a host message row. `parentMessageId` is
 * best-effort — populated when the caller knows the parent, NULL otherwise.
 */
export interface UsageEventRecord {
  id: string;
  ts: number;
  messageId: string | null;
  parentMessageId: string | null;
  sessionId: string | null;
  providerId: string;
  model: string;
  apiKeyId: string | null;
  engineOrigin: UsageEngineOrigin;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  costUsd: number;
  /** Hypothetical-input-cost − actual-cost difference attributable to cache_read tokens. */
  costSavedByCacheUsd: number;
  /** JSON-serialised raw provider usage object. Kept for forensics. */
  rawUsage: string | null;
  /** Host run-correlation id (owning agent-run, when the host has one). Additive / nullable. */
  runId?: string | null;
  /** Host event-correlation id for this LLM call. NULL when unknown. Additive / nullable. */
  eventId?: string | null;
}

/** Input shape for inserting a new event. `id` and `ts` are filled by the recorder/store. */
export type UsageEventInput = Omit<UsageEventRecord, 'id' | 'ts'> & {
  ts?: number;
};

/** Date range for queries. Both bounds are unix-millis; `endTs` is exclusive. */
export interface UsageDateRange {
  startTs: number;
  endTs: number;
}

export interface UsageQueryParams {
  range: UsageDateRange;
  /** Optional filter — restrict to a particular session. */
  sessionId?: string;
}

/** Aggregated totals over a date range. */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  costUsd: number;
  costSavedByCacheUsd: number;
  /** Number of events contributing to these totals. */
  eventCount: number;
}

/** Granularity for a usage time-series query. `week` is NOT a bucket — a "week" view is a `day` bucket over a 7-day range. */
export type UsageTimeBucket = 'hour' | 'day' | 'month';

/**
 * One bucket of a usage time-series (trend chart). Buckets are query-time
 * aggregations over the daemon's LOCAL-time boundaries and every bucket in the
 * requested range is present (empty buckets are zero-filled), ascending by
 * `bucketStartTs`.
 */
export interface UsageTimeSeriesBucket {
  /** Unix-millis of the LOCAL-time bucket boundary (hour start / local midnight / local 1st-of-month). */
  bucketStartTs: number;
  /** Frozen locale-agnostic label from LOCAL parts: hour `MM-DD HH:00`, day `YYYY-MM-DD`, month `YYYY-MM`. */
  label: string;
  /** Event count in the bucket (0 for a zero-filled bucket). */
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

/** One row of the per-model breakdown. */
export interface ModelUsageRow {
  providerId: string;
  model: string;
  eventCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  costSavedByCacheUsd: number;
  /** True when no pricing row exists for (providerId, model) — UIs may show an "unpriced" badge. */
  unpriced: boolean;
}

/** One row of the per-API-key breakdown. NULL apiKeyId is mapped to a sentinel. */
export interface ApiKeyUsageRow {
  /** `null` represents the unattributed sentinel group. */
  apiKeyId: string | null;
  /** Display label resolved by the host store (its key registry, or an "unattributed" fallback). */
  label: string;
  providerId: string | null;
  eventCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * Cumulative cache stats for ONE session — a SUM over the session's usage
 * events. `hitRate` is the cost-oriented aggregate `ΣcacheRead / Σ(prompt-side
 * tokens)` where the prompt-side total is `input + cacheRead + cacheCreation`
 * (output excluded).
 */
export interface SessionCacheStats {
  sessionId: string;
  /** Σ uncached prompt tokens (cache miss). */
  inputTokens: number;
  /** Σ cache-read (hit) tokens. */
  cacheReadTokens: number;
  /** Σ cache-creation (write) tokens — Anthropic; 0 for auto-caching providers. */
  cacheCreationTokens: number;
  /** Σ output tokens (not part of the hit-rate denominator). */
  outputTokens: number;
  /** Number of usage-event rows for the session. */
  eventCount: number;
  /**
   * ΣcacheRead / Σ(input + cacheRead + cacheCreation), in [0, 1]. 0 when the
   * session has no prompt-side tokens yet (avoids divide-by-zero).
   */
  hitRate: number;
}

/** One row in the message-level list (used by message-drilldown UI components). */
export interface MessageUsageRow {
  id: string;
  ts: number;
  messageId: string | null;
  parentMessageId: string | null;
  sessionId: string | null;
  providerId: string;
  model: string;
  apiKeyId: string | null;
  engineOrigin: UsageEngineOrigin;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  costUsd: number;
  costSavedByCacheUsd: number;
}
