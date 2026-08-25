/**
 * usage-migrate.test.ts — the one-shot fold of the legacy flat
 * `usage-events.jsonl` into day shards.
 *
 * The assertions that matter are about NOT LOSING ROWS. Usage rows carry the
 * lifetime per-key spend the outbound key policy seeds from, and that figure
 * cannot be reconstructed once the source file is gone — so the migration either
 * reconciles exactly and commits, or changes nothing at all and says why.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { UsageEventRecord } from '@omnicross/contracts/usage-stats-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JsonlUsageEventStore } from '../ports/JsonlUsageEventStore';
import { usageRollupName, usageShardName } from '../usage/usageFiles';
import { migrateLegacyUsageEvents } from '../usage/usageMigrate';

let tmpDir: string;
let eventsPath: string;
let usageDir: string;

/** Local wall-clock → unix millis. */
const local = (y: number, mo1: number, d: number, h = 0): number =>
  new Date(y, mo1 - 1, d, h).getTime();

const row = (over: Partial<UsageEventRecord> = {}): UsageEventRecord => ({
  id: `id-${Math.random().toString(36).slice(2)}`,
  ts: local(2026, 6, 12, 3),
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

/** Write a legacy flat file made of the given lines (already serialised). */
const writeLegacy = (lines: string[]): void =>
  writeFileSync(eventsPath, lines.join('\n') + '\n', 'utf8');

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-usage-migrate-'));
  eventsPath = join(tmpDir, 'usage-events.jsonl');
  usageDir = join(tmpDir, 'usage');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('migrateLegacyUsageEvents', () => {
  it('is a no-op when there is no legacy file', async () => {
    const result = await migrateLegacyUsageEvents({ eventsPath, usageDir });
    expect(result.migrated).toBe(false);
    expect(existsSync(usageDir)).toBe(false);
  });

  it('splits rows into LOCAL-day shards, writes rollups, and removes the legacy file', async () => {
    writeLegacy([
      JSON.stringify(row({ ts: local(2026, 6, 12, 3) })),
      JSON.stringify(row({ ts: local(2026, 6, 12, 20) })),
      JSON.stringify(row({ ts: local(2026, 6, 13, 9) })),
    ]);

    const result = await migrateLegacyUsageEvents({ eventsPath, usageDir });
    expect(result).toMatchObject({ migrated: true, linesRead: 3, rowsWritten: 3, skipped: 0, days: 2 });
    expect(existsSync(eventsPath)).toBe(false);
    expect(existsSync(join(usageDir, '.migrating'))).toBe(false);

    const day12 = readFileSync(join(usageDir, usageShardName('2026-06-12')), 'utf8')
      .split('\n')
      .filter(Boolean);
    expect(day12).toHaveLength(2);
    expect(existsSync(join(usageDir, usageShardName('2026-06-13')))).toBe(true);
    // Both days are closed, so both get an immutable rollup.
    expect(existsSync(join(usageDir, usageRollupName('2026-06-12')))).toBe(true);
    expect(existsSync(join(usageDir, usageRollupName('2026-06-13')))).toBe(true);
  });

  it('counts guard-rejected lines as skipped and still reconciles', async () => {
    writeLegacy([
      JSON.stringify(row()),
      JSON.stringify({ id: 'partial', ts: local(2026, 6, 12, 4) }), // rejected by the guard
      'not json at all',
      JSON.stringify(row()),
    ]);

    const result = await migrateLegacyUsageEvents({ eventsPath, usageDir });
    expect(result.migrated).toBe(true);
    expect(result.linesRead).toBe(4);
    expect(result.rowsWritten).toBe(2);
    expect(result.skipped).toBe(2);
    expect(existsSync(eventsPath)).toBe(false);
  });

  it('does NOT roll up the still-open current day', async () => {
    const now = local(2026, 6, 14, 10);
    writeLegacy([
      JSON.stringify(row({ ts: local(2026, 6, 13, 8) })),
      JSON.stringify(row({ ts: now })),
    ]);

    await migrateLegacyUsageEvents({ eventsPath, usageDir, now });
    expect(existsSync(join(usageDir, usageRollupName('2026-06-13')))).toBe(true);
    expect(existsSync(join(usageDir, usageShardName('2026-06-14')))).toBe(true);
    expect(existsSync(join(usageDir, usageRollupName('2026-06-14')))).toBe(false);
  });

  it('refuses to overwrite an existing shard and leaves the legacy file in place', async () => {
    writeLegacy([JSON.stringify(row({ ts: local(2026, 6, 12, 3) }))]);
    mkdirSync(usageDir, { recursive: true });
    writeFileSync(join(usageDir, usageShardName('2026-06-12')), 'pre-existing\n', 'utf8');

    const result = await migrateLegacyUsageEvents({ eventsPath, usageDir });
    expect(result.migrated).toBe(false);
    expect(result.reason).toContain('refusing to overwrite');
    // Nothing lost: the legacy file and the pre-existing shard are both intact.
    expect(existsSync(eventsPath)).toBe(true);
    expect(readFileSync(join(usageDir, usageShardName('2026-06-12')), 'utf8')).toBe('pre-existing\n');
    expect(existsSync(join(usageDir, '.migrating'))).toBe(false);
  });

  it('rebuilds a scratch directory left by a crashed attempt rather than resuming it', async () => {
    writeLegacy([JSON.stringify(row({ ts: local(2026, 6, 12, 3) }))]);
    // A crashed run left a half-written day file behind.
    mkdirSync(join(usageDir, '.migrating'), { recursive: true });
    writeFileSync(
      join(usageDir, '.migrating', usageShardName('2026-06-12')),
      JSON.stringify(row({ ts: local(2026, 6, 12, 3) })) + '\n',
      'utf8',
    );

    const result = await migrateLegacyUsageEvents({ eventsPath, usageDir });
    expect(result).toMatchObject({ migrated: true, rowsWritten: 1 });
    // Exactly one row — the stale scratch was discarded, not appended to.
    const lines = readFileSync(join(usageDir, usageShardName('2026-06-12')), 'utf8')
      .split('\n')
      .filter(Boolean);
    expect(lines).toHaveLength(1);
  });

  it('an empty legacy file is simply dropped', async () => {
    writeFileSync(eventsPath, '', 'utf8');
    const result = await migrateLegacyUsageEvents({ eventsPath, usageDir });
    expect(result.migrated).toBe(true);
    expect(existsSync(eventsPath)).toBe(false);
  });

  it('the migrated store answers the same totals the legacy rows described', async () => {
    const rows = [
      row({ ts: local(2026, 6, 12, 3), costUsd: 1, inputTokens: 10 }),
      row({ ts: local(2026, 6, 12, 20), costUsd: 2, inputTokens: 20 }),
      row({ ts: local(2026, 6, 13, 9), costUsd: 4, inputTokens: 40, apiKeyId: 'k2' }),
    ];
    writeLegacy(rows.map((r) => JSON.stringify(r)));
    await migrateLegacyUsageEvents({ eventsPath, usageDir });

    const store = new JsonlUsageEventStore(eventsPath, async () => true);
    const totals = await store.getTotals({
      startTs: local(2026, 6, 12),
      endTs: local(2026, 6, 14),
    });
    expect(totals.eventCount).toBe(3);
    expect(totals.costUsd).toBeCloseTo(7);
    expect(totals.inputTokens).toBe(70);

    // Lifetime spend survives the fold — the number retention depends on.
    const spend = await store.getSpendByKey({
      apiKeyId: 'k1',
      dayStartTs: local(2026, 6, 13),
      weekStartTs: local(2026, 6, 12),
      endTs: local(2026, 6, 14),
    });
    expect(spend.totalUsd).toBeCloseTo(3);
    expect(spend.weeklyUsd).toBeCloseTo(3);
    expect(spend.dailyUsd).toBeCloseTo(0);
  });
});
