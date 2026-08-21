/**
 * auditJsonl — bounded NEWEST-FIRST line reading for the audit store
 * (audit-store-sharding, design D5).
 *
 * Audit files are append-only and timestamp-ascending, so the newest records live
 * at the END. A query wants the newest N rows, which made the previous
 * `readFileSync(wholeFile)` pathological: it materialized an entire day — every
 * captured prompt and response included — just to render a metadata table, and
 * grew into an OOM as the store did.
 *
 * {@link forEachLineFromTail} walks a file backwards in fixed windows and hands
 * back complete lines newest-first, stopping the moment the caller says it has
 * enough. Windows are stitched at BYTE level, not string level, so a multi-byte
 * UTF-8 sequence straddling a window boundary is never split into replacement
 * characters.
 *
 * @module @omnicross/daemon/audit/auditJsonl
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs';

/** Bytes read per backward step. */
const WINDOW_BYTES = 1 << 20;

/**
 * Longest single line reassembled across windows. A line beyond this is skipped
 * rather than buffered without bound — only reachable on a legacy flat file that
 * inlined an enormous captured body.
 */
const MAX_LINE_BYTES = 32 * 1024 * 1024;

const NEWLINE = 0x0a;

/**
 * Visit a JSONL file's non-empty lines NEWEST-FIRST. `onLine` returns `true` to
 * stop early. Never throws: an unreadable file simply yields nothing.
 */
export function forEachLineFromTail(path: string, onLine: (line: string) => boolean): void {
  let fd: number;
  let end: number;
  try {
    end = statSync(path).size;
    if (end === 0) return;
    fd = openSync(path, 'r');
  } catch {
    return;
  }

  try {
    /** Bytes of a line that continues into the window before this one. */
    let carry = Buffer.alloc(0);

    while (end > 0) {
      const start = Math.max(0, end - WINDOW_BYTES);
      const window = Buffer.allocUnsafe(end - start);
      let read: number;
      try {
        read = readSync(fd, window, 0, end - start, start);
      } catch {
        return;
      }
      const chunk = carry.length > 0
        ? Buffer.concat([window.subarray(0, read), carry])
        : window.subarray(0, read);

      let lineEnd = chunk.length;
      let nl = lineEnd > 0 ? chunk.lastIndexOf(NEWLINE, lineEnd - 1) : -1;
      while (nl >= 0) {
        if (nl + 1 < lineEnd) {
          const line = chunk.subarray(nl + 1, lineEnd).toString('utf8').trim();
          if (line && onLine(line)) return;
        }
        lineEnd = nl;
        nl = lineEnd > 0 ? chunk.lastIndexOf(NEWLINE, lineEnd - 1) : -1;
      }

      if (start === 0) {
        // Reached the head of the file: what remains is a complete first line.
        if (lineEnd > 0) {
          const line = chunk.subarray(0, lineEnd).toString('utf8').trim();
          if (line) onLine(line);
        }
        return;
      }
      if (lineEnd > MAX_LINE_BYTES) return; // pathological line — stop, never buffer it
      carry = Buffer.from(chunk.subarray(0, lineEnd));
      end = start;
    }
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Closing a already-invalid descriptor must not surface into a query.
    }
  }
}
