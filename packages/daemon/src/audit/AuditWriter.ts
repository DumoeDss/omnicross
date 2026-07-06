/**
 * AuditWriter — the daemon's file-backed audit sink (request-audit-log, design
 * D4/D5). Registered as `@omnicross/core`'s audit sink when audit is enabled; its
 * {@link record} is what `recordAudit` hands each assembled record to.
 *
 * FIRE-AND-FORGET (hard constraint): {@link record} DEFERS the fs append off the
 * caller's stack (an injectable `defer`, default a zero-delay timer — the
 * `UsageRecorder` precedent) and returns immediately, so the relay response path
 * never waits on disk I/O. A write error is swallowed + logged (a failing audit
 * store must never affect a relay). Each record is appended as ONE JSON line to
 * `audit/audit-YYYY-MM-DD.jsonl` (the record's LOCAL date), matching the
 * `usage-events.jsonl` pattern — no new dependency, TTL is a whole-file unlink.
 *
 * @module @omnicross/daemon/audit/AuditWriter
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { AuditRecord } from '@omnicross/contracts/audit-types';
import type { Logger } from '@omnicross/core';

import { auditFileName } from './auditFiles';

export class AuditWriter {
  private dirEnsured = false;

  constructor(
    private readonly auditDir: string,
    private readonly logger: Logger,
    /** Deferral used by `record()` to schedule the append off the caller's path. */
    private readonly defer: (fn: () => void) => void = (fn) => setTimeout(fn, 0),
  ) {}

  /**
   * Enqueue one record for append. Returns IMMEDIATELY (fire-and-forget); the fs
   * write happens on the deferred tick. A failure is logged, never thrown.
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

  /**
   * Append synchronously — the awaitable form tests use to assert the line landed.
   * Ensures the `audit/` directory exists on first write (lazy, like the usage
   * store's lazy file creation).
   */
  appendNow(record: AuditRecord): void {
    if (!this.dirEnsured) {
      mkdirSync(this.auditDir, { recursive: true });
      this.dirEnsured = true;
    }
    const file = join(this.auditDir, auditFileName(record.ts));
    appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
  }
}
