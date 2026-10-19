/**
 * usage-store-stats.test.ts — the footprint the Settings → Data card renders.
 *
 * The split by retention class is the point: raw sidecars (forensic, pruned)
 * usually dwarf the lean rows and the forever-kept rollups, and an operator
 * choosing a window needs to see which term the window actually reclaims.
 */

import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { usageRawShardName, usageRollupName, usageShardName } from '../usage/usageFiles';
import { readUsageStoreStats } from '../usage/usageStoreStats';

let tmpDir: string;
let usageDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-usage-stats-'));
  usageDir = join(tmpDir, 'usage');
  mkdirSync(usageDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('readUsageStoreStats', () => {
  it('splits the footprint by retention class and reports coverage', async () => {
    const day1 = '2026-06-01';
    const day2 = '2026-06-02';
    writeFileSync(join(usageDir, usageShardName(day1)), 'a'.repeat(10), 'utf8');
    writeFileSync(join(usageDir, usageRawShardName(day1)), 'b'.repeat(100), 'utf8');
    writeFileSync(join(usageDir, usageRollupName(day1)), 'c'.repeat(5), 'utf8');
    // A pruned day keeps only its rollup — it still counts as a day on disk.
    writeFileSync(join(usageDir, usageRollupName(day2)), 'd'.repeat(7), 'utf8');

    const stats = await readUsageStoreStats(usageDir);
    expect(stats.shardBytes).toBe(10);
    expect(stats.rawBytes).toBe(100);
    expect(stats.rollupBytes).toBe(12);
    expect(stats.totalBytes).toBe(122);
    expect(stats.days).toBe(2);
    expect(stats.oldestDay).toBe(day1);
    expect(stats.newestDay).toBe(day2);
  });

  it('ignores unrecognised files and tolerates a missing store', async () => {
    writeFileSync(join(usageDir, 'notes.txt'), 'not ours', 'utf8');
    expect(await readUsageStoreStats(usageDir)).toEqual({
      totalBytes: 0,
      shardBytes: 0,
      rawBytes: 0,
      rollupBytes: 0,
      days: 0,
    });

    const missing = join(tmpDir, 'never-created');
    expect(await readUsageStoreStats(missing)).toEqual({
      totalBytes: 0,
      shardBytes: 0,
      rawBytes: 0,
      rollupBytes: 0,
      days: 0,
    });
  });

  it('measures real file sizes (not line counts)', async () => {
    const day = '2026-06-03';
    const rawPath = join(usageDir, usageRawShardName(day));
    writeFileSync(rawPath, '{"id":"x","rawUsage":"{}"}\n', 'utf8');
    const stats = await readUsageStoreStats(usageDir);
    expect(stats.rawBytes).toBe(statSync(rawPath).size);
    expect(stats.totalBytes).toBe(stats.rawBytes);
  });
});
