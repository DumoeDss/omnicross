/**
 * usage-shard-cache.test.ts — the incremental tail reader behind every usage
 * query: only new bytes are parsed, a torn final line is left unconsumed until
 * it is complete, a truncated file forces a full re-read, and concurrent readers
 * never double-append.
 *
 * The last one is not hypothetical — before the in-flight guard, two parallel
 * queries over the same day each appended the same parsed rows to the same
 * array, and a seeded $5 spend row read back as $10.
 */

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { UsageEventRecord } from '@omnicross/contracts/usage-stats-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { usageShardName } from '../usage/usageFiles';
import { UsageShardCache } from '../usage/usageShardCache';

let tmpDir: string;
let usageDir: string;
let cache: UsageShardCache;

const DAY = '2026-06-12';

const row = (id: string, ts: number): UsageEventRecord => ({
  id,
  ts,
  messageId: null,
  parentMessageId: null,
  sessionId: null,
  providerId: 'prov-a',
  model: 'model-x',
  apiKeyId: null,
  engineOrigin: 'completion',
  inputTokens: 1,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  reasoningTokens: 0,
  costUsd: 0.5,
  costSavedByCacheUsd: 0,
  rawUsage: null,
});

const shard = (): string => join(usageDir, usageShardName(DAY));
const appendRow = (id: string, ts: number): void => {
  appendFileSync(shard(), JSON.stringify(row(id, ts)) + '\n', 'utf8');
};
const ids = (rows: readonly UsageEventRecord[]): string[] => rows.map((r) => r.id);

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-shard-cache-'));
  usageDir = join(tmpDir, 'usage');
  mkdirSync(usageDir, { recursive: true });
  cache = new UsageShardCache(usageDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('UsageShardCache', () => {
  it('a missing shard reads as no rows (never an error)', async () => {
    expect(await cache.rows(DAY)).toEqual([]);
  });

  it('picks up only the rows appended since the last read', async () => {
    appendRow('a', 1);
    appendRow('b', 2);
    expect(ids(await cache.rows(DAY))).toEqual(['a', 'b']);

    appendRow('c', 3);
    expect(ids(await cache.rows(DAY))).toEqual(['a', 'b', 'c']);
  });

  it('repeated reads with no appends return the same rows exactly once', async () => {
    appendRow('a', 1);
    await cache.rows(DAY);
    await cache.rows(DAY);
    expect(ids(await cache.rows(DAY))).toEqual(['a']);
  });

  it('leaves a torn final line unconsumed, then picks it up once completed', async () => {
    appendRow('a', 1);
    const line = JSON.stringify(row('torn', 3));
    const split = Math.floor(line.length / 2);
    appendFileSync(shard(), line.slice(0, split), 'utf8'); // torn write, no newline
    expect(ids(await cache.rows(DAY))).toEqual(['a']);

    // A writer finishing that line makes it readable — and 'a' is not re-read.
    appendFileSync(shard(), line.slice(split) + '\n', 'utf8');
    expect(ids(await cache.rows(DAY))).toEqual(['a', 'torn']);
  });

  it('skips a parseable-but-partial row without poisoning the set', async () => {
    appendRow('a', 1);
    appendFileSync(shard(), JSON.stringify({ id: 'partial', ts: 5 }) + '\n', 'utf8');
    appendRow('b', 2);
    expect(ids(await cache.rows(DAY))).toEqual(['a', 'b']);
  });

  it('re-reads from scratch when the file shrinks (truncated/replaced)', async () => {
    appendRow('a', 1);
    appendRow('b', 2);
    expect(await cache.rows(DAY)).toHaveLength(2);

    writeFileSync(shard(), JSON.stringify(row('z', 9)) + '\n', 'utf8'); // smaller file
    expect(ids(await cache.rows(DAY))).toEqual(['z']);
  });

  it('concurrent readers see each row exactly once', async () => {
    for (let i = 0; i < 200; i++) appendRow(`r${i}`, i);
    const [a, b, c] = await Promise.all([cache.rows(DAY), cache.rows(DAY), cache.rows(DAY)]);
    expect(a).toHaveLength(200);
    expect(b).toHaveLength(200);
    expect(c).toHaveLength(200);
    expect(new Set(ids(a)).size).toBe(200);
  });

  it('invalidate drops residency and the next read reloads', async () => {
    appendRow('a', 1);
    expect(await cache.rows(DAY)).toHaveLength(1);
    cache.invalidate(DAY);
    expect(await cache.rows(DAY)).toHaveLength(1);
  });

  it('a warm read of a LARGE shard re-parses nothing', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 50_000; i++) lines.push(JSON.stringify(row(`r${i}`, i)));
    writeFileSync(shard(), lines.join('\n') + '\n', 'utf8');

    const cold = await cache.rows(DAY);
    expect(cold).toHaveLength(50_000);

    // Asserted as WORK, not wall-clock: a re-parse would mint new row objects
    // (identity fails) or append them again (length doubles). A timing bound
    // here measured the machine, not the cache, and went flaky under load.
    const warm = await cache.rows(DAY);
    expect(warm).toHaveLength(50_000);
    expect(warm[0]).toBe(cold[0]);
    expect(warm[49_999]).toBe(cold[49_999]);

    // An append is picked up incrementally: the existing objects are untouched.
    appendRow('extra', 50_000);
    const grown = await cache.rows(DAY);
    expect(grown).toHaveLength(50_001);
    expect(grown[0]).toBe(cold[0]);
    expect(grown[50_000]?.id).toBe('extra');
  });
});
