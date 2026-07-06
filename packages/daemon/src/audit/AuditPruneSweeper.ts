/**
 * AuditPruneSweeper — the TTL prune for the audit store (request-audit-log,
 * design D4). Deletes whole `audit-YYYY-MM-DD.jsonl` files whose date is older
 * than `retentionDays` — a cheap file UNLINK, never a line-level rewrite of a
 * live file (which jsonl makes awkward). So the store never grows unbounded and
 * TTL is O(files).
 *
 * Modeled on the #8 `AccountHealthProbeScheduler` / `AccountHealthSweeper`:
 * `start()` arms an `unref()`ed interval, `dispose()` clears it, a single-sweep
 * re-entrancy guard prevents overlap. A prune ALSO runs once at boot (`start`
 * fires an immediate sweep). Disabled/zero-retention config ⇒ armed-off ⇒ no-op
 * (byte-identical zero regression). Never throws.
 *
 * @module @omnicross/daemon/audit/AuditPruneSweeper
 */

import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import type { AuditConfig } from '@omnicross/contracts/audit-types';
import type { Logger } from '@omnicross/core';

import { auditFileDateMs } from './auditFiles';

const DAY_MS = 24 * 60 * 60_000;
/** Prune cadence — hourly is ample for a day-granular TTL. */
const SWEEP_INTERVAL_MS = 60 * 60_000;

export class AuditPruneSweeper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  constructor(
    private readonly auditDir: string,
    private readonly logger: Logger,
    private config: AuditConfig,
    private readonly intervalMs: number = SWEEP_INTERVAL_MS,
    /** Injectable clock (ms) for deterministic tests. */
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether pruning is active (audit enabled). */
  get enabled(): boolean {
    return this.config.enabled;
  }

  /** Re-apply config to the live instance (boot + admin PUT hot-reload). */
  configure(config: AuditConfig): void {
    this.config = config;
  }

  /**
   * Arm the prune interval AND run one prune immediately (boot cleanup). No-op
   * when audit is disabled (zero regression). Idempotent.
   */
  start(): void {
    if (this.timer || !this.config.enabled) return;
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), this.intervalMs);
    this.timer.unref?.();
  }

  /** Clear the interval (daemon shutdown / test teardown). Idempotent. */
  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One prune: unlink every audit date file strictly OLDER than the retention
   * cutoff (`now - retentionDays` days, at local-midnight granularity). Exposed
   * for tests; never throws. Returns the number of files removed.
   */
  async sweep(): Promise<number> {
    if (!this.config.enabled || this.sweeping) return 0;
    this.sweeping = true;
    try {
      if (!existsSync(this.auditDir)) return 0;
      // Cutoff = the local-midnight of `now`, minus retention days. A file dated
      // strictly before this is expired (a `retentionDays:1` keeps today only).
      const today = new Date(this.now());
      const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
      const cutoff = todayMidnight - (this.config.retentionDays - 1) * DAY_MS;
      let removed = 0;
      for (const file of readdirSync(this.auditDir)) {
        const dateMs = auditFileDateMs(file);
        if (dateMs === null || dateMs >= cutoff) continue;
        try {
          unlinkSync(join(this.auditDir, file));
          removed += 1;
        } catch (error) {
          this.logger.warn('[AuditPruneSweeper] failed to unlink expired audit file', {
            file,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (removed > 0) this.logger.debug('audit prune complete', { removed });
      return removed;
    } catch (error) {
      this.logger.warn('audit prune sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    } finally {
      this.sweeping = false;
    }
  }
}
