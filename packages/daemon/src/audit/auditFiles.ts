/**
 * auditFiles — shared date-file naming + parsing for the audit store
 * (request-audit-log, design D4). One SSOT for the `audit-YYYY-MM-DD.jsonl`
 * convention shared by the writer (which file to append to), the prune sweeper
 * (which files are past retention), and the reader (which files a query spans).
 *
 * The date is the LOCAL calendar date of the record's timestamp (parity with the
 * usage-events LOCAL-time bucketing) so a file boundary matches the operator's
 * day. TTL is a whole-file unlink — no line-level rewrite.
 *
 * @module @omnicross/daemon/audit/auditFiles
 */

/** Matches a valid audit date file name, capturing Y/M/D. */
export const AUDIT_FILE_RE = /^audit-(\d{4})-(\d{2})-(\d{2})\.jsonl$/;

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** The `audit-YYYY-MM-DD.jsonl` file name for a timestamp (LOCAL date). */
export function auditFileName(ts: number): string {
  const d = new Date(ts);
  return `audit-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}.jsonl`;
}

/**
 * The LOCAL-midnight epoch ms of an audit file's date, or `null` when the name is
 * not a valid audit date file. Used by the prune sweeper to compare against the
 * retention cutoff.
 */
export function auditFileDateMs(fileName: string): number | null {
  const m = AUDIT_FILE_RE.exec(fileName);
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
