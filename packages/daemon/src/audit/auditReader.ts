/**
 * auditReader — read + filter the date-rotated audit store (request-audit-log,
 * design D4/D6). Backs the AUTHED admin query only (the records carry IP/UA +
 * possibly bodies). Reads the relevant `audit-*.jsonl` files, parses defensively
 * (a torn final line never poisons a query), filters by key id + time window, and
 * returns NEWEST-FIRST up to a bounded limit.
 *
 * @module @omnicross/daemon/audit/auditReader
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AuditRecord } from '@omnicross/contracts/audit-types';

import { AUDIT_FILE_RE } from './auditFiles';

/** Default page size when a query omits `limit`. */
const DEFAULT_LIMIT = 200;
/** Hard cap on a single query's returned rows (bounds memory + response size). */
const MAX_LIMIT = 2000;

/** Filters for an audit query (all optional). */
export interface AuditQuery {
  /** Restrict to one outbound key id. */
  keyId?: string;
  /** Inclusive lower bound (epoch ms). */
  from?: number;
  /** Inclusive upper bound (epoch ms). */
  to?: number;
  /** Max rows (default 200, capped 2000). */
  limit?: number;
}

/**
 * Read matching audit records, newest-first. Missing dir ⇒ `[]`. Malformed lines
 * are skipped. `keyId`/`from`/`to` narrow the result; `limit` bounds it.
 */
export function readAuditRecords(auditDir: string, query: AuditQuery = {}): AuditRecord[] {
  if (!existsSync(auditDir)) return [];
  let files: string[];
  try {
    files = readdirSync(auditDir).filter((f) => AUDIT_FILE_RE.test(f));
  } catch {
    return [];
  }
  const from = typeof query.from === 'number' ? query.from : -Infinity;
  const to = typeof query.to === 'number' ? query.to : Infinity;
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(query.limit ?? DEFAULT_LIMIT)));

  const matched: AuditRecord[] = [];
  // Read newest date-file first (the file name sorts lexicographically by date)
  // so the matched set trends newest-first before the explicit sort below.
  for (const file of files.sort().reverse()) {
    let raw: string;
    try {
      raw = readFileSync(join(auditDir, file), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let rec: unknown;
      try {
        rec = JSON.parse(trimmed);
      } catch {
        continue; // torn/garbage line — skip
      }
      if (!isAuditRecord(rec)) continue;
      if (query.keyId !== undefined && rec.keyId !== query.keyId) continue;
      if (rec.ts < from || rec.ts > to) continue;
      matched.push(rec);
    }
  }
  matched.sort((a, b) => b.ts - a.ts);
  return matched.slice(0, limit);
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
