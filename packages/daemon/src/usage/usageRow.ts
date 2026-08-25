/**
 * usageRow — the defensive row guard for a persisted usage event, plus the
 * JSONL line parser built on it.
 *
 * Lifted out of `JsonlUsageEventStore` when the store was sharded, because the
 * shard reader, the rollup builder and the one-shot migration must all agree on
 * exactly which lines count — a row the migration accepts but a query rejects
 * (or vice versa) would show up as a silent totals drift across the migration.
 *
 * @module @omnicross/daemon/usage/usageRow
 */

import type {
  UsageCacheKeySource,
  UsageEventRecord,
} from '@omnicross/contracts/usage-stats-types';

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

const CACHE_KEY_SOURCES = new Set<UsageCacheKeySource>([
  'client',
  'session-header',
  'thread-header',
  'body-session-id',
  'body-thread-id',
  'content-fingerprint',
  'none',
]);

/**
 * Full defensive row guard: a parseable-but-PARTIAL line (e.g. hand-edited or
 * produced by a different writer) must not poison aggregations with NaN.
 * Requires string identity/required fields (nullable where the record says
 * so) and FINITE numbers for every token/cost field.
 */
export function isUsageEventRecord(parsed: unknown): parsed is UsageEventRecord {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const r = parsed as Record<string, unknown>;
  if (typeof r['id'] !== 'string') return false;
  if (typeof r['providerId'] !== 'string') return false;
  if (typeof r['model'] !== 'string') return false;
  if (typeof r['engineOrigin'] !== 'string') return false;
  if (
    r['cacheKeySource'] !== undefined &&
    (typeof r['cacheKeySource'] !== 'string' ||
      !CACHE_KEY_SOURCES.has(r['cacheKeySource'] as UsageCacheKeySource))
  ) return false;
  if (r['cacheKeyInjected'] !== undefined && typeof r['cacheKeyInjected'] !== 'boolean') {
    return false;
  }
  for (const f of NULLABLE_STRING_FIELDS) {
    if (!isStringOrNull(r[f])) return false;
  }
  for (const f of NUMERIC_FIELDS) {
    const v = r[f];
    if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  }
  return true;
}

/**
 * Parse ONE JSONL line into a row, or `null` for anything unusable — a blank
 * line, a torn final write, garbage, or a shape the guard rejects. Never throws:
 * the crash-tolerance contract is that a bad line is skipped, not fatal.
 */
export function parseUsageLine(line: string): UsageEventRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isUsageEventRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
