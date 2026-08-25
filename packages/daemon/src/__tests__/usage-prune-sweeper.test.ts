/**
 * usage-prune-sweeper.test.ts — retention for RAW usage rows.
 *
 * Two invariants carry the whole feature:
 *  1. a ROLLUP is never deleted — it is what keeps lifetime per-key spend and
 *     every historical aggregate correct after the rows are gone;
 *  2. a shard is never deleted before its rollup exists — otherwise that day is
 *     destroyed rather than compacted.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Logger } from '@omnicross/core';
import type { UsageEventRecord } from '@omnicross/contracts/usage-stats-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usageRollupName, usageShardName } from '../usage/usageFiles';
import { UsageRollupStore } from '../usage/usageRollupStore';
import { UsagePruneSweeper } from '../usage/UsagePruneSweeper';

let tmpDir: string;
let usageDir: string;
let rollups: UsageRollupStore;
let logger: Logger;

/** "Now" for every sweep in this suite: 2026-06-20, local noon. */
const NOW = new Date(2026, 5, 20, 12).getTime();
const now = (): number => NOW;

const dayAt = (d: number, h = 3): number => new Date(2026, 5, d, h).getTime();

const row = (ts: number, over: Partial<UsageEventRecord> = {}): string =>
  JSON.stringify({
    id: `id-${ts}-${Math.random().toString(36).slice(2)}`,
    ts,
    messageId: null,
    parentMessageId: null,
    sessionId: null,
    providerId: 'prov-a',
    model: 'model-x',
    apiKeyId: 'k1',
    engineOrigin: 'completion',
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 5,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    costUsd: 1,
    costSavedByCacheUsd: 0,
    rawUsage: null,
    ...over,
  });

/** Lay down a shard for day-of-June `d` with one row. */
const seedDay = (d: number): string => {
  const key = `2026-06-${String(d).padStart(2, '0')}`;
  writeFileSync(join(usageDir, usageShardName(key)), row(dayAt(d)) + '\n', 'utf8');
  return key;
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-usage-prune-'));
  usageDir = join(tmpDir, 'usage');
  mkdirSync(usageDir, { recursive: true });
  rollups = new UsageRollupStore(usageDir);
  logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('UsagePruneSweeper', () => {
  it('is disabled (and sweeps nothing) when retentionDays is absent or 0', async () => {
    seedDay(1);
    const off = new UsagePruneSweeper(usageDir, rollups, logger, {}, 60_000, now);
    expect(off.enabled).toBe(false);
    expect(await off.sweep()).toBe(0);
    expect(existsSync(join(usageDir, usageShardName('2026-06-01')))).toBe(true);

    const zero = new UsagePruneSweeper(usageDir, rollups, logger, { retentionDays: 0 }, 60_000, now);
    expect(zero.enabled).toBe(false);
    expect(await zero.sweep()).toBe(0);
  });

  it('removes shards older than the window and KEEPS every rollup', async () => {
    const old1 = seedDay(1);
    const old2 = seedDay(5);
    const recent = seedDay(19);

    const sweeper = new UsagePruneSweeper(usageDir, rollups, logger, { retentionDays: 7 }, 60_000, now);
    expect(await sweeper.sweep()).toBe(2);

    expect(existsSync(join(usageDir, usageShardName(old1)))).toBe(false);
    expect(existsSync(join(usageDir, usageShardName(old2)))).toBe(false);
    expect(existsSync(join(usageDir, usageShardName(recent)))).toBe(true);

    // The aggregates for the pruned days survive — that is the point.
    expect(existsSync(join(usageDir, usageRollupName(old1)))).toBe(true);
    expect(existsSync(join(usageDir, usageRollupName(old2)))).toBe(true);
  });

  it('builds the rollup BEFORE deleting, so a pruned day still aggregates', async () => {
    const key = seedDay(1);
    expect(existsSync(join(usageDir, usageRollupName(key)))).toBe(false);

    const sweeper = new UsagePruneSweeper(usageDir, rollups, logger, { retentionDays: 7 }, 60_000, now);
    await sweeper.sweep();

    const rollup = await rollups.get(key);
    expect(rollup).not.toBeNull();
    expect(rollup?.totals.eventCount).toBe(1);
    expect(rollup?.totals.costUsd).toBe(1);
    expect(rollup?.byApiKey[0]?.apiKeyId).toBe('k1');
  });

  it('keeps the shard when no rollup can be produced for it', async () => {
    // An expired day whose shard holds nothing the guard accepts: there are no
    // rows to summarise, so deleting it would be a pure loss of the raw bytes.
    const key = '2026-06-01';
    writeFileSync(join(usageDir, usageShardName(key)), 'garbage, not jsonl\n', 'utf8');
    // Force the rollup build to fail outright.
    vi.spyOn(rollups, 'ensure').mockRejectedValueOnce(new Error('disk on fire'));

    const sweeper = new UsagePruneSweeper(usageDir, rollups, logger, { retentionDays: 7 }, 60_000, now);
    expect(await sweeper.sweep()).toBe(0);
    expect(existsSync(join(usageDir, usageShardName(key)))).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('retentionDays:1 keeps today and drops yesterday', async () => {
    seedDay(20); // today, relative to NOW
    const yesterday = seedDay(19);
    const sweeper = new UsagePruneSweeper(usageDir, rollups, logger, { retentionDays: 1 }, 60_000, now);
    expect(await sweeper.sweep()).toBe(1);
    expect(existsSync(join(usageDir, usageShardName('2026-06-20')))).toBe(true);
    expect(existsSync(join(usageDir, usageShardName(yesterday)))).toBe(false);
  });

  it('a second sweep is a no-op (already-pruned days have no shard)', async () => {
    seedDay(1);
    const sweeper = new UsagePruneSweeper(usageDir, rollups, logger, { retentionDays: 7 }, 60_000, now);
    expect(await sweeper.sweep()).toBe(1);
    expect(await sweeper.sweep()).toBe(0);
  });

  it('start() is inert when retention is off and disposable when on', () => {
    const off = new UsagePruneSweeper(usageDir, rollups, logger, {}, 60_000, now);
    off.start();
    off.dispose(); // must not throw

    const on = new UsagePruneSweeper(usageDir, rollups, logger, { retentionDays: 7 }, 60_000, now);
    on.start();
    on.start(); // idempotent
    on.dispose();
    on.dispose();
  });

  it('configure() re-arms the window on a live instance', async () => {
    seedDay(15);
    const sweeper = new UsagePruneSweeper(usageDir, rollups, logger, { retentionDays: 30 }, 60_000, now);
    expect(await sweeper.sweep()).toBe(0); // inside a 30-day window

    sweeper.configure({ retentionDays: 2 });
    expect(await sweeper.sweep()).toBe(1);
  });
});
