/**
 * auditFiles — shared date naming + parsing for the audit store
 * (request-audit-log design D4, extended by audit-store-sharding design D2).
 * One SSOT for the on-disk convention shared by the writer (where to append), the
 * prune sweeper (what is past retention / due for archiving), and the readers
 * (what a query spans).
 *
 * TWO layouts coexist:
 *
 *  - LEGACY (pre-sharding): a flat `audit-YYYY-MM-DD.jsonl` per day with bodies
 *    inline on every line. Still READ and still pruned; never written to again.
 *  - CURRENT: a per-day DIRECTORY `audit-YYYY-MM-DD/` holding
 *      `meta.jsonl`            metadata-only records (the query hot path)
 *      `meta.stats.json`       the exact-count sidecar
 *      `bodies/<sessionKey>.jsonl[.gz]`
 *    Bodies are sharded per conversation session and delta-encoded turn over
 *    turn, which is what keeps a long session from costing O(n^2) on disk.
 *
 * The date is the LOCAL calendar date of the record's timestamp (parity with the
 * usage-events LOCAL-time bucketing) so a boundary matches the operator's day.
 * TTL stays a whole-file unlink / whole-directory remove — never a line-level
 * rewrite.
 *
 * @module @omnicross/daemon/audit/auditFiles
 */

/** Matches a LEGACY flat audit date file name, capturing Y/M/D. */
export const AUDIT_FILE_RE = /^audit-(\d{4})-(\d{2})-(\d{2})\.jsonl$/;

/** Matches a CURRENT per-day audit directory name, capturing Y/M/D. */
export const AUDIT_DAY_DIR_RE = /^audit-(\d{4})-(\d{2})-(\d{2})$/;

/** The metadata file inside a per-day directory. */
export const AUDIT_META_FILE = 'meta.jsonl';

/** The body-shard subdirectory inside a per-day directory. */
export const AUDIT_BODIES_DIR = 'bodies';

/**
 * A session key is accepted into a path ONLY when it is bare lowercase hex.
 * `deriveAuditSessionKey` always produces that shape; enforcing it here is the
 * defense-in-depth that makes path traversal structurally impossible.
 */
export const AUDIT_SESSION_KEY_RE = /^[0-9a-f]{8,64}$/;

const pad2 = (n: number): string => String(n).padStart(2, '0');

const localDateStamp = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

/** The LEGACY `audit-YYYY-MM-DD.jsonl` file name for a timestamp (LOCAL date). */
export function auditFileName(ts: number): string {
  return `audit-${localDateStamp(ts)}.jsonl`;
}

/** The CURRENT `audit-YYYY-MM-DD` day-directory name for a timestamp (LOCAL date). */
export function auditDayDirName(ts: number): string {
  return `audit-${localDateStamp(ts)}`;
}

/** Whether a directory entry name is a per-day audit directory. */
export function isAuditDayDir(name: string): boolean {
  return AUDIT_DAY_DIR_RE.test(name);
}

/** Whether a session key is safe to use as a path segment. */
export function isSafeSessionKey(key: string | undefined | null): key is string {
  return typeof key === 'string' && AUDIT_SESSION_KEY_RE.test(key);
}

/** The body shard file name for one session (relative to `bodies/`). */
export function auditBodyFileName(sessionKey: string): string {
  return `${sessionKey}.jsonl`;
}

/**
 * The LOCAL-midnight epoch ms of an audit entry's date, or `null` when the name
 * is neither a legacy date file nor a day directory. Used by the prune sweeper to
 * compare against the retention cutoff and by the readers to skip whole days.
 */
export function auditFileDateMs(name: string): number | null {
  const m = AUDIT_FILE_RE.exec(name) ?? AUDIT_DAY_DIR_RE.exec(name);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(year, month - 1, day);
  // Guard against impossible dates (e.g. audit-2026-13-40) that Date rolls over.
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
    return null;
  }
  return d.getTime();
}
