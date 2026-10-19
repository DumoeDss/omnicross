/**
 * UsagePruneSweeper — retention for the sharded usage store.
 *
 * Prunes RAW day shards (and their `usage-*.raw.jsonl` forensic sidecars) past
 * `retentionDays` and NEVER touches a rollup. That
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

import { stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import type { Logger } from '@omnicross/core';

import { dayKeyStartTs, listUsageDays, usageRawShardName, usageShardName } from './usageFiles';
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

/** Outcome of one prune pass — what the admin "clean now" surface reports. */
export interface UsagePruneResult {
  /** Days whose detail (shard and/or raw sidecar) was retired by this pass. */
  removedDays: number;
  /** Bytes reclaimed by this pass. */
  freedBytes: number;
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

  /** The live retention window (`0` ⇒ keep everything). */
  get configuredRetentionDays(): number {
    return this.config.retentionDays ?? 0;
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
    return (await this.runSweep()).removedDays;
  }

  /**
   * Run one prune pass NOW and report what it reclaimed — the admin "clean now"
   * surface (`POST /admin/api/usage-store/prune`). The same pass the hourly
   * sweep runs, so it can never delete more than the configured window allows
   * (with retention `0` it deletes nothing). Never throws.
   */
  async pruneNow(): Promise<UsagePruneResult> {
    return this.runSweep();
  }

  private async runSweep(): Promise<UsagePruneResult> {
    const result: UsagePruneResult = { removedDays: 0, freedBytes: 0 };
    if (!this.enabled || this.sweeping) return result;
    this.sweeping = true;
    try {
      const retentionDays = this.config.retentionDays ?? DEFAULT_USAGE_RETENTION_DAYS;
      // A day dated strictly before this is expired (`retentionDays:1` keeps today).
      const cutoff = this.todayMidnight() - (retentionDays - 1) * DAY_MS;
      for (const entry of await listUsageDays(this.usageDir)) {
        const startTs = dayKeyStartTs(entry.dayKey);
        if (Number.isNaN(startTs) || startTs >= cutoff) continue;

        // No shard but a raw sidecar: a day whose detail was pruned before the
        // sidecar split (or by a manual shard-only delete). Raw is forensic-only
        // — never aggregated, no rollup needed — so it follows the SAME TTL and
        // is retired here instead of lingering invisible to the shard-driven pass.
        if (!entry.hasShard) {
          if (!entry.hasRaw) continue;
          const raw = await this.removeFile(usageRawShardName(entry.dayKey));
          if (raw.removed) {
            result.removedDays += 1;
            result.freedBytes += raw.bytes;
          }
          continue;
        }

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

        const shard = await this.removeFile(usageShardName(entry.dayKey));
        if (!shard.removed) {
          this.logger.warn('[usage] retention: could not remove expired shard', {
            day: entry.dayKey,
          });
          continue;
        }
        result.removedDays += 1;
        result.freedBytes += shard.bytes;
        // The day's raw sidecar (usage-raw) is the same retention class as the
        // shard — forensic payload, never aggregated — so it goes with it. A
        // missing sidecar (days written before the split) is not an error.
        const raw = await this.removeFile(usageRawShardName(entry.dayKey));
        result.freedBytes += raw.bytes;
        // The rollup just became the sole authority for this day; drop the memo
        // so the next read re-resolves it against a now-absent shard.
        this.rollups.invalidate(entry.dayKey);
      }
      if (result.removedDays > 0) {
        this.logger.info('[usage] retention: pruned raw shards (rollups retained)', {
          removed: result.removedDays,
          freedBytes: result.freedBytes,
          retentionDays,
        });
      }
      return result;
    } catch (error) {
      this.logger.warn('[usage] retention sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return result;
    } finally {
      this.sweeping = false;
    }
  }

  /** Unlink one store file, reporting whether it was actually removed + its size. */
  private async removeFile(name: string): Promise<{ removed: boolean; bytes: number }> {
    const path = join(this.usageDir, name);
    let bytes = 0;
    try {
      bytes = (await stat(path)).size;
    } catch {
      // Absent already — the unlink below is still attempted so a concurrent
      // writer's freshly-created file is the one reported.
    }
    try {
      await unlink(path);
      return { removed: true, bytes };
    } catch {
      return { removed: false, bytes: 0 };
    }
  }

  /** The LOCAL-midnight epoch ms of the current day. */
  private todayMidnight(): number {
    const today = new Date(this.now());
    return new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  }
}
