/**
 * AuditPruneSweeper — retention + archiving for the audit store
 * (request-audit-log design D4, extended by audit-store-sharding design D6).
 *
 * Two jobs run on the same hourly tick:
 *
 *  - PRUNE. Remove every day older than `retentionDays`. A current day is a
 *    DIRECTORY (removed recursively), a legacy day is a flat file (unlinked with
 *    its stats sidecar). Either way it stays a whole-day removal — never a
 *    line-level rewrite of a live file, which jsonl makes awkward.
 *  - ARCHIVE. First run the cross-session compaction pass (see
 *    {@link compactAuditDay}), then gzip the body shards of any day that is no
 *    longer today. The
 *    current day stays PLAIN TEXT so it can still be tailed and grepped while
 *    debugging; once a day is closed nothing appends to it again, so rewriting
 *    and compressing it is safe and buys a large multiple on top of the delta.
 *    `meta.jsonl` is NEVER compressed — it is the query hot path.
 *
 * Modeled on the #8 `AccountHealthProbeScheduler` / `AccountHealthSweeper`:
 * `start()` arms an `unref()`ed interval, `dispose()` clears it, a single-sweep
 * re-entrancy guard prevents overlap. Both jobs also run once at boot. Disabled
 * config means armed-off, so audit-off is byte-identical zero regression. Never
 * throws.
 *
 * @module @omnicross/daemon/audit/AuditPruneSweeper
 */

import { createReadStream, createWriteStream, existsSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

import type { AuditConfig } from '@omnicross/contracts/audit-types';
import type { Logger } from '@omnicross/core';

import { compactAuditDay } from './auditDictionary';
import { AUDIT_BODIES_DIR, auditFileDateMs, isAuditDayDir } from './auditFiles';
import { auditStatsFileName } from './auditStats';

const DAY_MS = 24 * 60 * 60_000;
/** Prune cadence — hourly is ample for a day-granular TTL. */
const SWEEP_INTERVAL_MS = 60 * 60_000;
/** Shards compressed per pass; the remainder is picked up on the next tick. */
const ARCHIVE_BATCH = 64;

export class AuditPruneSweeper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;
  private archiving = false;

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
   * Arm the interval AND run one pass immediately (boot cleanup). No-op when
   * audit is disabled (zero regression). Idempotent.
   */
  start(): void {
    if (this.timer || !this.config.enabled) return;
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    this.timer.unref?.();
  }

  /** Clear the interval (daemon shutdown / test teardown). Idempotent. */
  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Prune first, then archive — never spend CPU compressing a day about to go. */
  private async runOnce(): Promise<void> {
    await this.sweep();
    await this.archive();
  }

  /** The LOCAL-midnight epoch ms of the current day. */
  private todayMidnight(): number {
    const today = new Date(this.now());
    return new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  }

  /**
   * One prune: remove every audit day strictly OLDER than the retention cutoff
   * (`now - retentionDays` days, at local-midnight granularity). Exposed for
   * tests; never throws. Returns the number of days removed.
   */
  async sweep(): Promise<number> {
    if (!this.config.enabled || this.sweeping) return 0;
    this.sweeping = true;
    try {
      if (!existsSync(this.auditDir)) return 0;
      // A day dated strictly before this is expired (`retentionDays:1` keeps today).
      const cutoff = this.todayMidnight() - (this.config.retentionDays - 1) * DAY_MS;
      let removed = 0;
      for (const name of readdirSync(this.auditDir)) {
        const dateMs = auditFileDateMs(name);
        if (dateMs === null || dateMs >= cutoff) continue;
        try {
          if (isAuditDayDir(name)) {
            // The whole day (metadata, sidecar, every body shard) goes at once.
            rmSync(join(this.auditDir, name), { recursive: true, force: true });
          } else {
            unlinkSync(join(this.auditDir, name));
            const statsPath = join(this.auditDir, auditStatsFileName(name));
            if (existsSync(statsPath)) unlinkSync(statsPath);
          }
          removed += 1;
        } catch (error) {
          this.logger.warn('[AuditPruneSweeper] failed to remove expired audit day', {
            name,
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

  /**
   * Gzip the body shards of every CLOSED day (anything before today). Today is
   * deliberately left as plain text so it stays greppable while it is the day you
   * are debugging. Exposed for tests; never throws. Returns shards compressed.
   */
  async archive(): Promise<number> {
    if (!this.config.enabled || this.archiving) return 0;
    this.archiving = true;
    try {
      if (!existsSync(this.auditDir)) return 0;
      const today = this.todayMidnight();
      let compressed = 0;
      for (const name of readdirSync(this.auditDir)) {
        if (compressed >= ARCHIVE_BATCH) break;
        const dateMs = auditFileDateMs(name);
        // Only a CLOSED day directory is archivable: a legacy flat file inlines
        // its bodies and today's shards are still being appended to.
        if (dateMs === null || dateMs >= today || !isAuditDayDir(name)) continue;
        const dayPath = join(this.auditDir, name);
        // Cross-session compaction runs BEFORE gzip: it rewrites plain shards,
        // and it must see them as text. Once a day has a dictionary the call is
        // a no-op, so an interrupted batch never builds a second one.
        try {
          const compaction = compactAuditDay(dayPath);
          if (compaction.shards > 0) {
            this.logger.debug('audit cross-session compaction complete', {
              day: name,
              shards: compaction.shards,
              anchors: compaction.anchors,
              savedBytes: compaction.savedBytes,
            });
          }
        } catch (error) {
          this.logger.warn('[AuditPruneSweeper] cross-session compaction failed', {
            day: name,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        compressed += await this.archiveDay(join(dayPath, AUDIT_BODIES_DIR),
          ARCHIVE_BATCH - compressed);
      }
      if (compressed > 0) this.logger.debug('audit archive complete', { compressed });
      return compressed;
    } catch (error) {
      this.logger.warn('audit archive pass failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    } finally {
      this.archiving = false;
    }
  }

  /** Gzip up to `budget` plain shards in one day's `bodies/` directory. */
  private async archiveDay(bodiesPath: string, budget: number): Promise<number> {
    let shards: string[];
    try {
      shards = readdirSync(bodiesPath).filter((file) => file.endsWith('.jsonl'));
    } catch {
      return 0; // No bodies were captured that day.
    }
    let compressed = 0;
    for (const shard of shards) {
      if (compressed >= budget) break;
      const source = join(bodiesPath, shard);
      const target = `${source}.gz`;
      try {
        if (existsSync(target)) {
          // A previous pass was interrupted after writing the archive; finish it.
          unlinkSync(source);
          continue;
        }
        await pipeline(createReadStream(source), createGzip(), createWriteStream(target));
        unlinkSync(source);
        compressed += 1;
      } catch (error) {
        // Leave the plain shard in place; a partial archive is removed so the next
        // pass retries from a clean state rather than trusting a truncated file.
        try {
          if (existsSync(target)) unlinkSync(target);
        } catch {
          // Nothing further to do; the next pass will retry.
        }
        this.logger.warn('[AuditPruneSweeper] failed to archive audit body shard', {
          shard,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return compressed;
  }
}
