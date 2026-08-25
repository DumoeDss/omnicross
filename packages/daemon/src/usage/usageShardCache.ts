/**
 * usageShardCache — a bounded, incrementally-tailed cache of raw day shards.
 *
 * Shards are append-only, so re-reading one from byte 0 to answer a query is
 * pure waste: everything before the last known offset is guaranteed unchanged.
 * This cache reads ONLY the bytes appended since it last looked, which turns a
 * repeated dashboard poll from "re-parse the file" into "parse the handful of
 * rows that arrived since the last poll".
 *
 * Reads are async and chunked. That is not a style preference — the store's
 * query methods were already `async` while doing `readFileSync` inside, so a
 * stats poll blocked the same event loop that relays gateway traffic for as long
 * as the read took (1.4 s at 156 MB). Nothing on a query path may block.
 *
 * RESIDENCY is capped at a few days (LRU). In practice at most two shards are
 * ever hot — today's, plus a range's partially-covered edge day — because every
 * closed, fully-covered day is answered from its rollup and never touches rows.
 *
 * TORN TAIL: bytes after the final newline are NOT consumed. A crash can only
 * tear the last line, and leaving it unconsumed both skips it now (the existing
 * crash-tolerance contract) and picks it up later if a writer completes it.
 *
 * ONE CATCH-UP AT A TIME per day. Two concurrent readers that both saw
 * `consumed < size` would each append the same parsed rows to the same array and
 * silently double every aggregate built from it — which is exactly how a $5
 * seeded spend row first showed up as $10. Callers are deduped onto a single
 * in-flight catch-up.
 *
 * @module @omnicross/daemon/usage/usageShardCache
 */

import { open } from 'node:fs/promises';
import { join } from 'node:path';

import type { UsageEventRecord } from '@omnicross/contracts/usage-stats-types';

import { usageShardName } from './usageFiles';
import { parseUsageLine } from './usageRow';

/** Newline byte. UTF-8 never emits 0x0A inside a multi-byte sequence, so
 *  splitting the raw buffer on it can never bisect a character. */
const NEWLINE = 0x0a;

/** Largest single read issued while catching up on a shard (8 MB). */
const READ_CHUNK_BYTES = 8 * 1024 * 1024;

/** Shards kept resident. Two is the working set; three leaves slack. */
const DEFAULT_MAX_RESIDENT_DAYS = 3;

interface ShardEntry {
  rows: UsageEventRecord[];
  /** Bytes consumed up to and including the last complete line. */
  consumed: number;
}

/**
 * Stream one shard's rows WITHOUT touching the residency cache.
 *
 * Used by the rollup builder and the session drilldown — both walk days that are
 * not the hot working set, and caching them would evict today's shard to hold a
 * day nobody is about to ask for again. Reads in bounded chunks so a large shard
 * never materialises as one giant string (the exact failure mode that put the
 * flat file on course for V8's ~512 MB string ceiling).
 *
 * `onRow` is called in file order. A missing shard yields no calls.
 */
export async function streamShardRows(
  usageDir: string,
  dayKey: string,
  onRow: (row: UsageEventRecord) => void,
): Promise<void> {
  const path = join(usageDir, usageShardName(dayKey));
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return;
  }
  try {
    const { size } = await handle.stat();
    let offset = 0;
    while (offset < size) {
      const want = Math.min(READ_CHUNK_BYTES, size - offset);
      const buf = Buffer.allocUnsafe(want);
      const { bytesRead } = await handle.read(buf, 0, want, offset);
      if (bytesRead <= 0) break;
      const chunk = buf.subarray(0, bytesRead);
      const lastNewline = chunk.lastIndexOf(NEWLINE);
      if (lastNewline < 0) break; // torn tail (or an over-long single line)
      const text = chunk.subarray(0, lastNewline + 1).toString('utf8');
      for (const line of text.split('\n')) {
        const row = parseUsageLine(line);
        if (row) onRow(row);
      }
      offset += lastNewline + 1;
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Byte size of a day's shard; `null` when it does not exist (never written or
 *  pruned). The staleness input for a rollup. */
export async function shardSize(usageDir: string, dayKey: string): Promise<number | null> {
  let handle;
  try {
    handle = await open(join(usageDir, usageShardName(dayKey)), 'r');
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    return size;
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

export class UsageShardCache {
  private readonly entries = new Map<string, ShardEntry>();
  /** In-flight catch-ups, so concurrent readers never double-append rows. */
  private readonly loading = new Map<string, Promise<ShardEntry>>();

  constructor(
    private readonly usageDir: string,
    private readonly maxResidentDays: number = DEFAULT_MAX_RESIDENT_DAYS,
  ) {}

  /**
   * Every parsed row of `dayKey`'s shard, ascending by file order. A missing
   * shard yields `[]` (a day that was never written, or was pruned). The array
   * is the cache's own — callers must not mutate it.
   */
  async rows(dayKey: string): Promise<readonly UsageEventRecord[]> {
    const pending = this.loading.get(dayKey);
    if (pending) return (await pending).rows;
    const load = this.load(dayKey).finally(() => this.loading.delete(dayKey));
    this.loading.set(dayKey, load);
    return (await load).rows;
  }

  /** Drop one day (or everything) from residency. */
  invalidate(dayKey?: string): void {
    if (dayKey === undefined) {
      this.entries.clear();
      this.loading.clear();
      return;
    }
    this.entries.delete(dayKey);
    this.loading.delete(dayKey);
  }

  /** Load-or-catch-up `dayKey`, reading only what is new since the last look. */
  private async load(dayKey: string): Promise<ShardEntry> {
    let entry = this.entries.get(dayKey);
    if (!entry) {
      entry = { rows: [], consumed: 0 };
      this.entries.set(dayKey, entry);
      this.evictBeyondCap();
    } else {
      this.touch(dayKey);
    }

    const path = join(this.usageDir, usageShardName(dayKey));
    let handle;
    try {
      handle = await open(path, 'r');
    } catch {
      // Missing shard: never written, or pruned past retention. Both are "no
      // rows", not an error — the rollup (if any) is what covers a pruned day.
      return entry;
    }
    try {
      const { size } = await handle.stat();
      if (size === entry.consumed) return entry;
      if (size < entry.consumed) {
        // Truncated or replaced underneath us — the append-only assumption no
        // longer holds for this file, so re-read it from scratch.
        entry.rows = [];
        entry.consumed = 0;
      }
      while (entry.consumed < size) {
        const want = Math.min(READ_CHUNK_BYTES, size - entry.consumed);
        const buf = Buffer.allocUnsafe(want);
        const { bytesRead } = await handle.read(buf, 0, want, entry.consumed);
        if (bytesRead <= 0) break;
        const chunk = buf.subarray(0, bytesRead);
        const lastNewline = chunk.lastIndexOf(NEWLINE);
        if (lastNewline < 0) {
          // No complete line in this chunk. Either a torn tail (stop and leave
          // it unconsumed) or a single line longer than the chunk — in which
          // case stopping is still right: the next call reads a fresh chunk from
          // the same offset once more bytes exist. Guard against spinning.
          break;
        }
        const text = chunk.subarray(0, lastNewline + 1).toString('utf8');
        for (const line of text.split('\n')) {
          const row = parseUsageLine(line);
          if (row) entry.rows.push(row);
        }
        entry.consumed += lastNewline + 1;
      }
      return entry;
    } finally {
      await handle.close().catch(() => {});
    }
  }

  /** Move `dayKey` to the most-recently-used end of the Map's insertion order. */
  private touch(dayKey: string): void {
    const entry = this.entries.get(dayKey);
    if (!entry) return;
    this.entries.delete(dayKey);
    this.entries.set(dayKey, entry);
  }

  /** Evict least-recently-used days until the cap is respected. */
  private evictBeyondCap(): void {
    while (this.entries.size > this.maxResidentDays) {
      const oldest = this.entries.keys().next();
      if (oldest.done) return;
      this.entries.delete(oldest.value);
    }
  }
}
