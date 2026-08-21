/**
 * AuditWriter — the daemon's file-backed audit sink (request-audit-log design
 * D4/D5, re-laid-out by audit-store-sharding design D2). Registered as
 * `@omnicross/core`'s audit sink when audit is enabled; its {@link record} is
 * what `recordAudit` hands each assembled record to.
 *
 * FIRE-AND-FORGET (hard constraint): {@link record} DEFERS all fs work off the
 * caller's stack (an injectable `defer`, default a zero-delay timer — the
 * `UsageRecorder` precedent) and returns immediately, so the relay response path
 * never waits on disk I/O. Delta encoding rides that same deferred tick and is
 * pure memory, so it can never stall a response either. A write error is
 * swallowed + logged (a failing audit store must never affect a relay).
 *
 * Each record is split across TWO destinations under `audit/audit-YYYY-MM-DD/`:
 *
 *  - `meta.jsonl` — one small JSON line WITHOUT bodies. This is what queries and
 *    the stats sidecar read, so a listing no longer pays for megabytes of prompt.
 *  - `bodies/<sessionKey>.jsonl` — the captured bodies, sharded per conversation
 *    and delta-encoded against the session's previous turn.
 *
 * The two writes are INDEPENDENT: the metadata line is the canonical record, so a
 * body-shard failure is logged and the metadata still lands. When a shard write
 * fails the session's encoding base is dropped, otherwise the next turn would
 * chain a delta onto a base no reader can find.
 *
 * @module @omnicross/daemon/audit/AuditWriter
 */

import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { AuditRecord } from '@omnicross/contracts/audit-types';
import type { Logger } from '@omnicross/core';

import { encodeBodyEntry, SessionBaseCache } from './auditBodyStore';
import {
  AUDIT_BODIES_DIR,
  AUDIT_META_FILE,
  auditBodyFileName,
  auditDayDirName,
  isSafeSessionKey,
} from './auditFiles';
import { updateAuditStatsAfterAppend } from './auditStats';

export class AuditWriter {
  /** Day directories already created this process (avoids an mkdir per record). */
  private readonly ensuredDirs = new Set<string>();

  /** Per-session encoding bases. Memory-only; a miss simply writes a full snapshot. */
  private readonly bases = new SessionBaseCache();

  constructor(
    private readonly auditDir: string,
    private readonly logger: Logger,
    /** Deferral used by `record()` to schedule the writes off the caller's path. */
    private readonly defer: (fn: () => void) => void = (fn) => setTimeout(fn, 0),
  ) {}

  /**
   * Enqueue one record. Returns IMMEDIATELY (fire-and-forget); every fs write and
   * the delta encoding happen on the deferred tick. A failure is logged, never thrown.
   */
  record(record: AuditRecord): void {
    this.defer(() => {
      try {
        this.appendNow(record);
      } catch (error) {
        this.logger.warn('[AuditWriter] failed to append audit record', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  /** Drop all retained encoding bases (config reload / shutdown / test teardown). */
  reset(): void {
    this.bases.clear();
    this.ensuredDirs.clear();
  }

  /**
   * Append synchronously — the awaitable form tests use to assert a line landed.
   * Writes the metadata line first (canonical), then the body shard.
   */
  appendNow(record: AuditRecord): void {
    const dayDir = auditDayDirName(record.ts);
    const dayPath = this.ensureDir(join(this.auditDir, dayDir));
    this.appendMeta(dayPath, record);
    this.appendBody(dayPath, dayDir, record);
  }

  /** Create a directory once per process and remember it. */
  private ensureDir(path: string): string {
    if (!this.ensuredDirs.has(path)) {
      mkdirSync(path, { recursive: true });
      this.ensuredDirs.add(path);
    }
    return path;
  }

  /** Write the body-free metadata line + refresh the exact-count sidecar. */
  private appendMeta(dayPath: string, record: AuditRecord): void {
    const { requestBody: _req, responseBody: _res, ...meta } = record;
    const file = join(dayPath, AUDIT_META_FILE);
    const line = JSON.stringify(meta) + '\n';
    const bytesBefore = existsSync(file) ? statSync(file).size : 0;
    appendFileSync(file, line, 'utf8');
    try {
      updateAuditStatsAfterAppend(
        file,
        bytesBefore,
        bytesBefore + Buffer.byteLength(line, 'utf8'),
        record,
      );
    } catch (error) {
      // The raw metadata line is canonical. A summary failure only makes the stats
      // endpoint rebuild it later and must never fail audit persistence.
      this.logger.warn('[AuditWriter] failed to update audit stats', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Write the delta-encoded body shard for one record. A no-op when nothing was
   * captured or when the session key is missing/unsafe — in which case the body
   * is dropped rather than written to an unvalidated path.
   */
  private appendBody(dayPath: string, dayDir: string, record: AuditRecord): void {
    if (record.requestBody === undefined && record.responseBody === undefined) return;
    const sessionKey = record.sessionKey;
    if (!isSafeSessionKey(sessionKey)) {
      this.logger.warn('[AuditWriter] dropping audit body with no usable session key', {
        id: record.id,
      });
      return;
    }
    try {
      const line = encodeBodyEntry(record, sessionKey, dayDir, this.bases);
      if (line === null) return;
      const bodiesPath = this.ensureDir(join(dayPath, AUDIT_BODIES_DIR));
      appendFileSync(join(bodiesPath, auditBodyFileName(sessionKey)), line + '\n', 'utf8');
    } catch (error) {
      // The shard line did not land, so the base it was cached as is unreachable.
      // Forgetting it makes the next turn re-anchor instead of chaining into a hole.
      this.bases.forget(sessionKey);
      this.logger.warn('[AuditWriter] failed to append audit body shard', {
        id: record.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
