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
