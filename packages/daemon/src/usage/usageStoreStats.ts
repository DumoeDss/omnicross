/**
 * usageStoreStats — on-disk size + day coverage of the sharded usage store.
 *
 * Powers the admin Settings → Data "usage storage" card: the operator sees what
 * the store costs before deciding a retention window. The breakdown mirrors the
 * three file classes' retention semantics:
 *
 *  - `shardBytes`  lean event rows — pruned past retention
 *  - `rawBytes`    forensic `rawUsage` sidecars — pruned WITH the shard, and the
 *                  overwhelmingly dominant term (a Codex attribution blob can be
 *                  tens of KB per event)
 *  - `rollupBytes` day aggregates — never pruned
 *
 * Read-only: stats never create, touch, or invalidate anything. A missing or
 * unreadable directory is an empty store, not an error.
 *
 * @module @omnicross/daemon/usage/usageStoreStats
 */

import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  listUsageDays,
  usageRawShardName,
  usageRollupName,
  usageShardName,
} from './usageFiles';

/** The usage store's disk footprint, split by retention class. */
export interface UsageStoreStats {
  /** Every file in the store (the three classes below). */
  totalBytes: number;
  shardBytes: number;
  rawBytes: number;
  rollupBytes: number;
  /** Days with at least one file on disk (a pruned day still counts via its rollup). */
  days: number;
  oldestDay?: string;
  newestDay?: string;
}

/** Byte size of one file; 0 when it is absent (or unreadable). */
async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/**
 * Measure the store at `usageDir`. One stat per file on disk (three per day at
 * most), run concurrently — cheap even for a multi-year history, and it never
 * reads file CONTENTS (so a 300 MB day costs the same as an empty one).
 */
export async function readUsageStoreStats(usageDir: string): Promise<UsageStoreStats> {
  const entries = await listUsageDays(usageDir);
  const stats: UsageStoreStats = {
    totalBytes: 0,
    shardBytes: 0,
    rawBytes: 0,
    rollupBytes: 0,
    days: 0,
  };

  const measured = await Promise.all(
    entries.map(async (entry) => {
      const [shardBytes, rawBytes, rollupBytes] = await Promise.all([
        entry.hasShard ? sizeOf(join(usageDir, usageShardName(entry.dayKey))) : 0,
        entry.hasRaw ? sizeOf(join(usageDir, usageRawShardName(entry.dayKey))) : 0,
        entry.hasRollup ? sizeOf(join(usageDir, usageRollupName(entry.dayKey))) : 0,
      ]);
      return { entry, shardBytes, rawBytes, rollupBytes };
    }),
  );

  for (const { entry, shardBytes, rawBytes, rollupBytes } of measured) {
    if (!entry.hasShard && !entry.hasRaw && !entry.hasRollup) continue;
    stats.days += 1;
    stats.shardBytes += shardBytes;
    stats.rawBytes += rawBytes;
    stats.rollupBytes += rollupBytes;
    // `listUsageDays` is ascending, so the first/last present day wins.
    stats.oldestDay ??= entry.dayKey;
    stats.newestDay = entry.dayKey;
  }
  stats.totalBytes = stats.shardBytes + stats.rawBytes + stats.rollupBytes;
  return stats;
}
