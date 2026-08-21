/**
 * auditReader — read + filter the audit store (request-audit-log design D4/D6,
 * re-laid-out by audit-store-sharding design D5). Backs the AUTHED admin query
 * only (records carry IP/UA). Returns NEWEST-FIRST up to a bounded limit.
 *
 * Reads BOTH on-disk layouts: the current `audit-YYYY-MM-DD/meta.jsonl` and the
 * legacy flat `audit-YYYY-MM-DD.jsonl` left behind by an older daemon (still
 * queryable until TTL prunes it — there is no migration step).
 *
 * BOUNDED BY CONSTRUCTION. Days are visited newest-first and each file is walked
 * BACKWARDS from its tail, so a query touches only as much of the store as it
 * needs. Two stops apply:
 *  - cross-day: once `limit` rows are in hand, no older day is opened at all.
 *    Exact, because day files never overlap in date.
 *  - within-day: at most `limit + OVERSCAN` rows are taken from one file. The
 *    overscan absorbs the slight append-order skew from a slow request landing
 *    after a fast one that started later.
 *
 * A returned record NEVER carries a body — those live in the per-session shards
 * and are fetched one at a time. `hasBody` says whether one exists.
 *
 * @module @omnicross/daemon/audit/auditReader
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { AuditRecord } from '@omnicross/contracts/audit-types';

import {
  AUDIT_DAY_DIR_RE,
  AUDIT_FILE_RE,
  AUDIT_META_FILE,
  auditFileDateMs,
} from './auditFiles';
import { forEachLineFromTail } from './auditJsonl';

/** Default page size when a query omits `limit`. */
const DEFAULT_LIMIT = 200;
/** Hard cap on a single query's returned rows (bounds memory + response size). */
const MAX_LIMIT = 2000;
/** Extra rows taken per file to absorb append-order skew before the final sort. */
const OVERSCAN = 256;

/** Filters for an audit query (all optional). */
export interface AuditQuery {
  /** Restrict to one outbound key id. */
  keyId?: string;
  /** Restrict to one conversation-session key. */
  sessionKey?: string;
  /** Inclusive lower bound (epoch ms). */
  from?: number;
  /** Inclusive upper bound (epoch ms). */
  to?: number;
  /** Max rows (default 200, capped 2000). */
  limit?: number;
}

/** One day's metadata source, whichever layout it is stored in. */
interface DaySource {
  /** Path of the JSONL file holding that day's metadata lines. */
  path: string;
  /** LOCAL-midnight epoch ms of the day, used only to order the sources. */
  dateMs: number;
}

/** Enumerate every day's metadata file across both layouts, NEWEST FIRST. */
function daySources(auditDir: string): DaySource[] {
  let names: string[];
  try {
    names = readdirSync(auditDir);
  } catch {
    return [];
  }
  const sources: DaySource[] = [];
  for (const name of names) {
    const dateMs = auditFileDateMs(name);
    if (dateMs === null) continue;
    if (AUDIT_DAY_DIR_RE.test(name)) {
      const path = join(auditDir, name, AUDIT_META_FILE);
      if (existsSync(path)) sources.push({ path, dateMs });
    } else if (AUDIT_FILE_RE.test(name)) {
      sources.push({ path: join(auditDir, name), dateMs });
    }
  }
  return sources.sort((a, b) => b.dateMs - a.dateMs);
}

/** Minimal structural guard: a parseable line with the required record shape. */
function isAuditRecord(value: unknown): value is AuditRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r['id'] === 'string' &&
    typeof r['ts'] === 'number' &&
    typeof r['method'] === 'string' &&
    typeof r['path'] === 'string' &&
    typeof r['status'] === 'number'
  );
}

/**
 * Strip any inline body (only a legacy line still has one) while preserving the
 * fact that a body exists, so every returned row has the same bounded shape.
 */
function toMetaRecord(record: AuditRecord): AuditRecord {
  if (record.requestBody === undefined && record.responseBody === undefined) return record;
  const { requestBody: _req, responseBody: _res, ...meta } = record;
  return { ...meta, hasBody: true };
}

/**
 * Read matching audit records, newest-first. Missing dir yields `[]`. Malformed
 * lines are skipped. `keyId`/`sessionKey`/`from`/`to` narrow the result; `limit`
 * bounds it.
 */
export function readAuditRecords(auditDir: string, query: AuditQuery = {}): AuditRecord[] {
  if (!existsSync(auditDir)) return [];
  const from = typeof query.from === 'number' ? query.from : -Infinity;
  const to = typeof query.to === 'number' ? query.to : Infinity;
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(query.limit ?? DEFAULT_LIMIT)));

  const matched: AuditRecord[] = [];
  for (const source of daySources(auditDir)) {
    const before = matched.length;
    forEachLineFromTail(source.path, (line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return false; // torn/garbage line — skip
      }
      if (!isAuditRecord(parsed)) return false;
      if (query.keyId !== undefined && parsed.keyId !== query.keyId) return false;
      if (query.sessionKey !== undefined && parsed.sessionKey !== query.sessionKey) return false;
      if (parsed.ts < from || parsed.ts > to) return false;
      matched.push(toMetaRecord(parsed));
      return matched.length - before >= limit + OVERSCAN;
    });
    if (matched.length >= limit) break;
  }
  matched.sort((a, b) => b.ts - a.ts);
  return matched.slice(0, limit);
}
