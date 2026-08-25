/**
 * usageRollupStore — read-or-build the per-day rollup sidecars.
 *
 * A rollup is built LAZILY, the first time a query needs a closed day, and then
 * reused forever. Building it is the only time that day's rows are ever parsed
 * again; every subsequent query for any range containing that day reads a few KB
 * of JSON instead of megabytes of JSONL.
 *
 * STALENESS is checked against the shard's byte size, not its mtime. Shards are
 * append-only, so a size that no longer matches what the rollup was built from
 * means rows were added afterwards — only reachable by inserting an event with a
 * past `ts`, which the store API permits and the tests exercise. A shard that is
 * absent entirely is the PRUNED case: the rollup is then the sole surviving
 * record of that day and is trusted unconditionally.
 *
 * Writes are atomic (temp file + rename) so a crash mid-write cannot leave a
 * half-JSON sidecar that later reads as a corrupt day.
 *
 * @module @omnicross/daemon/usage/usageRollupStore
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { UsageEventRecord } from '@omnicross/contracts/usage-stats-types';

import { usageRollupName } from './usageFiles';
import { buildDayRollup, isUsageDayRollup, type UsageDayRollup } from './usageRollup';
import { shardSize, streamShardRows } from './usageShardCache';

/**
 * Parsed rollups held in memory. Each is a few KB, so a year of them is a couple
 * of MB — cheap next to re-reading and re-parsing them on every dashboard poll.
 */
const DEFAULT_MAX_CACHED_ROLLUPS = 400;

export class UsageRollupStore {
  private readonly cache = new Map<string, UsageDayRollup | null>();
  /** In-flight builds, so a burst of concurrent queries builds a day ONCE. */
  private readonly inFlight = new Map<string, Promise<UsageDayRollup | null>>();

  constructor(
    private readonly usageDir: string,
    private readonly maxCached: number = DEFAULT_MAX_CACHED_ROLLUPS,
  ) {}

  /**
   * The rollup for a CLOSED day, building it from the shard when absent or
   * stale. `null` means the day has neither a usable rollup nor a shard — i.e.
   * nothing was ever recorded for it.
   *
   * Callers must not ask for TODAY: today's rows are still arriving, so a rollup
   * of them would be wrong the moment it was written.
   */
  async get(dayKey: string, hasShard?: boolean): Promise<UsageDayRollup | null> {
    const cached = this.cache.get(dayKey);
    if (cached !== undefined) {
      // A cached rollup still has to survive the staleness check; a cached
      // `null` (nothing recorded) is re-checked too, since a shard may appear.
      // `hasShard === false` comes from a directory listing the caller already
      // did, so a pruned day costs no stat at all — and pruned days are the
      // majority once retention has been running a while.
      const size = hasShard === false ? null : await shardSize(this.usageDir, dayKey);
      if (cached === null) {
        if (size === null) return null;
      } else if (size === null || size === cached.sourceBytes) {
        return cached;
      }
      this.cache.delete(dayKey);
    }
    const pending = this.inFlight.get(dayKey);
    if (pending) return pending;
    const build = this.resolve(dayKey, hasShard).finally(() => this.inFlight.delete(dayKey));
    this.inFlight.set(dayKey, build);
    return build;
  }

  /** Forget a day — used when an insert lands in an already-rolled-up day. */
  invalidate(dayKey?: string): void {
    if (dayKey === undefined) {
      this.cache.clear();
      return;
    }
    this.cache.delete(dayKey);
  }

  /**
   * Build (or rebuild) a day's rollup from its shard and persist it. Exposed for
   * the prune sweeper, which must guarantee a rollup exists BEFORE it deletes
   * the rows that rollup is derived from.
   */
  async ensure(dayKey: string): Promise<UsageDayRollup | null> {
    return this.get(dayKey);
  }

  private async resolve(dayKey: string, hasShard?: boolean): Promise<UsageDayRollup | null> {
    const size = hasShard === false ? null : await shardSize(this.usageDir, dayKey);
    const onDisk = await this.readSidecar(dayKey);
    if (onDisk) {
      // Pruned day ⇒ the sidecar is all there is. Otherwise it must match the
      // shard it claims to summarise.
      if (size === null || size === onDisk.sourceBytes) return this.remember(dayKey, onDisk);
    }
    if (size === null) return this.remember(dayKey, null);

    const rows: UsageEventRecord[] = [];
    await streamShardRows(this.usageDir, dayKey, (row) => rows.push(row));
    const rollup = buildDayRollup(dayKey, size, rows);
    await this.writeSidecar(dayKey, rollup);
    return this.remember(dayKey, rollup);
  }

  private async readSidecar(dayKey: string): Promise<UsageDayRollup | null> {
    try {
      const raw = await readFile(join(this.usageDir, usageRollupName(dayKey)), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      return isUsageDayRollup(parsed) && parsed.date === dayKey ? parsed : null;
    } catch {
      // Missing, unreadable, or corrupt — rebuild from the shard when there is
      // one. A corrupt sidecar is never served.
      return null;
    }
  }

  private async writeSidecar(dayKey: string, rollup: UsageDayRollup): Promise<void> {
    const target = join(this.usageDir, usageRollupName(dayKey));
    const temp = `${target}.tmp`;
    try {
      await mkdir(this.usageDir, { recursive: true });
      await writeFile(temp, JSON.stringify(rollup), 'utf8');
      await rename(temp, target);
    } catch {
      // A sidecar that could not be persisted is not fatal: the rollup was still
      // computed and is returned, it just gets rebuilt next time. Clean up the
      // temp so a retry is not blocked by a stale partial.
      await unlink(temp).catch(() => {});
    }
  }

  private remember(dayKey: string, rollup: UsageDayRollup | null): UsageDayRollup | null {
    this.cache.set(dayKey, rollup);
    while (this.cache.size > this.maxCached) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
    return rollup;
  }
}
