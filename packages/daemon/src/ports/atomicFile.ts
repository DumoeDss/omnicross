/**
 * atomicFile — the daemon's shared ATOMIC file-replace for credential-bearing
 * state files (`keys.json`, `tokens.json`, …).
 *
 * A bare `writeFileSync(target, …)` is truncate-then-write: a crash, ENOSPC,
 * or power loss mid-write leaves the target HALF-WRITTEN and the prior content
 * is gone. For `tokens.json` that is account data — the 2026-09-06 incident
 * lost every stored OAuth account exactly this way (a truncated file that the
 * reader then silently treated as "no accounts"). Same-directory temp-write +
 * fsync + rename means a FAILED write only ever discards the temp file; the
 * prior target survives byte-equal.
 *
 * The temp name embeds pid + random bytes (never collides with a live temp of
 * another process) and lives in the target's own directory so the final
 * `renameSync` never crosses a volume (POSIX and win32 both make the replace
 * atomic there; Node maps rename-over-existing to MoveFileEx with
 * REPLACE_EXISTING on Windows).
 *
 * Extracted verbatim from `JsonOutboundKeyDb` (its original + only user) so
 * every file-backed port shares ONE implementation instead of re-deriving it.
 *
 * @module @omnicross/daemon/ports/atomicFile
 */

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Injectable seam (tests pass a throwing/stubbed replace to prove the prior file survives). */
export type AtomicFileReplace = (targetPath: string, contents: string) => void;

/** Same-directory temp-write + fsync + rename, so a failed write preserves the prior file. */
export function atomicReplaceUtf8(targetPath: string, contents: string): void {
  const tempPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(tempPath, 'wx', 0o600);
    writeFileSync(fd, contents, { encoding: 'utf8' });
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, targetPath);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the original write error.
      }
    }
    if (existsSync(tempPath)) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Preserve the original write error; stale temp cleanup is best-effort.
      }
    }
    throw error;
  }
}
