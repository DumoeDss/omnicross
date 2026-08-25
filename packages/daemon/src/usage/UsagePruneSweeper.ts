/**
 * UsagePruneSweeper — retention for the sharded usage store.
 *
 * Prunes RAW day shards past `retentionDays` and NEVER touches a rollup. That
 * asymmetry is the whole design: aggregates (totals, per-model, per-key, hourly
 * trend) stay complete for the lifetime of the install, while the per-row detail
 * that costs 5 MB a day is bounded. In particular `getSpendByKey().totalUsd` —
 * the LIFETIME figure seeding the outbound key spend policy — keeps summing
 * correctly across pruned days, which a naive "delete old rows" would silently
 * zero, reopening budgets the operator had already spent.
 *
 * ORDERING IS LOAD-BEARING: a shard is only ever deleted AFTER its rollup exists
 * on disk. If the rollup cannot be built, the shard is kept and the day is
 * retried on the next tick. Deleting rows whose aggregate was never computed
 * would destroy that day permanently.
 *
 * Shaped like `audit/AuditPruneSweeper`: `start()` arms an `unref()`ed interval
 * plus one immediate pass, `dispose()` clears it, a re-entrancy guard prevents
 * overlap, and nothing throws — a failed sweep is logged and retried, never
 * fatal to the daemon.
 *
 * @module @omnicross/daemon/usage/UsagePruneSweeper
 */

import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

import type { Logger } from '@omnicross/core';

import { dayKeyStartTs, listUsageDays, usageShardName } from './usageFiles';
import type { UsageRollupStore } from './usageRollupStore';

const DAY_MS = 24 * 60 * 60_000;

/** Prune cadence — hourly is ample for a day-granular TTL. */
const SWEEP_INTERVAL_MS = 60 * 60_000;

/** Retention for RAW rows when the config says nothing. Rollups ignore this. */
export const DEFAULT_USAGE_RETENTION_DAYS = 90;

/** The `usage` config segment. */
export interface UsageRetentionConfig {
  /** Days of RAW rows to keep. `0` or absent ⇒ keep everything. */
  retentionDays?: number;
}

export class UsagePruneSweeper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  constructor(
    private readonly usageDir: string,
    private readonly rollups: UsageRollupStore,
    private readonly logger: Logger,
    private config: UsageRetentionConfig = {},
    private readonly intervalMs: number = SWEEP_INTERVAL_MS,
    /** Injectable clock (ms) for deterministic tests. */
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether raw rows are pruned at all. */
  get enabled(): boolean {
    return (this.config.retentionDays ?? 0) > 0;
  }

  /** Re-apply config to the live instance (boot + admin PUT hot-reload). */
  configure(config: UsageRetentionConfig): void {
    this.config = config;
  }

  /**
   * Arm the interval AND run one pass immediately (boot cleanup). No-op when
   * retention is off (keep-everything is the zero-regression default).
   * Idempotent.
   */
  start(): void {
    if (this.timer || !this.enabled) return;
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
   * One prune pass: for every day strictly OLDER than the retention cutoff that
   * still has a shard, make sure its rollup exists and only then delete the
   * shard. Exposed for tests; never throws. Returns the number of shards
   * removed.
   */
  async sweep(): Promise<number> {
    if (!this.enabled || this.sweeping) return 0;
    this.sweeping = true;
    try {
      const retentionDays = this.config.retentionDays ?? DEFAULT_USAGE_RETENTION_DAYS;
      // A day dated strictly before this is expired (`retentionDays:1` keeps today).
      const cutoff = this.todayMidnight() - (retentionDays - 1) * DAY_MS;
      let removed = 0;
      for (const entry of await listUsageDays(this.usageDir)) {
        if (!entry.hasShard) continue;
        const startTs = dayKeyStartTs(entry.dayKey);
        if (Number.isNaN(startTs) || startTs >= cutoff) continue;

        // Build-or-verify the aggregate FIRST. No rollup ⇒ no delete, ever.
        let rollup;
        try {
          rollup = await this.rollups.ensure(entry.dayKey);
        } catch (error) {
          this.logger.warn('[usage] retention: rollup build failed, keeping shard', {
            day: entry.dayKey,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        if (!rollup) {
          this.logger.warn('[usage] retention: no rollup for expired day, keeping shard', {
            day: entry.dayKey,
          });
          continue;
        }

        try {
          await unlink(join(this.usageDir, usageShardName(entry.dayKey)));
          removed += 1;
        } catch (error) {
          this.logger.warn('[usage] retention: could not remove expired shard', {
            day: entry.dayKey,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        // The rollup just became the sole authority for this day; drop the memo
        // so the next read re-resolves it against a now-absent shard.
        this.rollups.invalidate(entry.dayKey);
      }
      if (removed > 0) {
        this.logger.info('[usage] retention: pruned raw shards (rollups retained)', {
          removed,
          retentionDays,
        });
      }
      return removed;
    } catch (error) {
      this.logger.warn('[usage] retention sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    } finally {
      this.sweeping = false;
    }
  }

  /** The LOCAL-midnight epoch ms of the current day. */
  private todayMidnight(): number {
    const today = new Date(this.now());
    return new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  }
}
