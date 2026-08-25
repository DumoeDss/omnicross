/**
 * usageMigrate — the ONE-SHOT fold of the legacy flat `usage-events.jsonl` into
 * per-LOCAL-day shards plus their immutable rollups.
 *
 * Runs at bootstrap, BEFORE any listener is bound, so no request can be served
 * against a half-migrated store. It streams: the legacy file is never held in
 * memory as one string (that is the exact shape that put the old store on course
 * for V8's ~512 MB string ceiling), and each day's rollup is accumulated during
 * the same pass that writes its shard, so the whole migration is a single read.
 *
 * Writes are BATCHED per day (see {@link FLUSH_BYTES}). Awaiting a write per row
 * turned 199k rows into ~17 s of boot on a real 157 MB store, which the desktop
 * shell — waiting on the admin port — is right to find suspicious; batching cuts
 * it to a few seconds without changing what lands on disk.
 *
 * CRASH SAFETY. Everything is built inside `usage/.migrating/` and only moved
 * into place once the row count reconciles. A crash before the commit leaves the
 * legacy file untouched and the scratch directory to be wiped and rebuilt on the
 * next attempt. A crash DURING the commit leaves some shards in place and the
 * legacy file still present; the next attempt refuses to run (a target shard
 * already exists) and says so, rather than overwriting or double-counting rows.
 *
 * RECONCILIATION is the point of the exercise: `linesRead` must equal
 * `rowsWritten + skipped`, where `skipped` is lines the shared row guard rejects.
 * If it does not, nothing is committed and the legacy file stays exactly where it
 * was. Silently losing usage rows would corrupt lifetime key spend, which is the
 * one number in this store that can never be reconstructed.
 *
 * @module @omnicross/daemon/usage/usageMigrate
 */

import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import type { Logger } from '@omnicross/core';

import {
  usageDayKey,
  usageRollupName,
  usageShardName,
  USAGE_MIGRATING_DIR,
} from './usageFiles';
import { DayRollupAccumulator } from './usageRollup';
import { parseUsageLine } from './usageRow';

export interface UsageMigrationResult {
  /** True only when the legacy file was folded in and removed. */
  migrated: boolean;
  /** Non-empty lines read from the legacy file. */
  linesRead: number;
  /** Rows that passed the guard and were written to a shard. */
  rowsWritten: number;
  /** Lines the guard rejected (torn tail, hand-edited, foreign writer). */
  skipped: number;
  /** Distinct LOCAL days produced. */
  days: number;
  /** Present when the migration declined or aborted; nothing was committed. */
  reason?: string;
}

/** Buffered bytes per day before a write is issued. */
const FLUSH_BYTES = 4 * 1024 * 1024;

/** One day's open shard plus its pending write buffer. */
interface DayWriter {
  handle: Awaited<ReturnType<typeof open>>;
  buffer: string[];
  bytes: number;
}

/** Push a line, flushing once the day's buffer is large enough to be worth a write. */
async function writeLine(writer: DayWriter, line: string): Promise<void> {
  writer.buffer.push(line);
  writer.bytes += line.length;
  if (writer.bytes >= FLUSH_BYTES) await flush(writer);
}

/** Drain one day's buffer to its handle. */
async function flush(writer: DayWriter): Promise<void> {
  if (writer.buffer.length === 0) return;
  const payload = writer.buffer.join('');
  writer.buffer = [];
  writer.bytes = 0;
  await writer.handle.write(payload);
}

const IDLE: UsageMigrationResult = {
  migrated: false,
  linesRead: 0,
  rowsWritten: 0,
  skipped: 0,
  days: 0,
};

/**
 * Fold `eventsPath` into `usageDir`. A no-op (and NOT an error) when the legacy
 * file is absent, which is the steady state after the first successful run.
 */
export async function migrateLegacyUsageEvents(opts: {
  eventsPath: string;
  usageDir: string;
  /** Local day that must stay open — its shard keeps receiving appends. */
  now?: number;
  logger?: Pick<Logger, 'info' | 'warn' | 'error'>;
}): Promise<UsageMigrationResult> {
  const { eventsPath, usageDir, logger } = opts;
  const legacy = await stat(eventsPath).catch(() => null);
  if (!legacy || !legacy.isFile()) return IDLE;
  if (legacy.size === 0) {
    // An empty legacy file carries nothing; drop it so this check stops firing.
    await unlink(eventsPath).catch(() => {});
    return { ...IDLE, migrated: true };
  }

  const scratch = join(usageDir, USAGE_MIGRATING_DIR);
  logger?.info('[usage] migrating legacy usage-events.jsonl into day shards', {
    bytes: legacy.size,
  });

  // A scratch directory left by a previous crashed attempt is rebuilt, never
  // resumed — partial day files would double-count on append.
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
  await mkdir(scratch, { recursive: true });

  const writers = new Map<string, DayWriter>();
  const rollups = new Map<string, DayRollupAccumulator>();
  let linesRead = 0;
  let rowsWritten = 0;
  let skipped = 0;

  try {
    const reader = createInterface({
      input: createReadStream(eventsPath, { encoding: 'utf8' }),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of reader) {
      if (!line.trim()) continue;
      linesRead += 1;
      const row = parseUsageLine(line);
      if (!row) {
        skipped += 1;
        continue;
      }
      const dayKey = usageDayKey(row.ts);
      let writer = writers.get(dayKey);
      if (!writer) {
        writer = {
          handle: await open(join(scratch, usageShardName(dayKey)), 'a'),
          buffer: [],
          bytes: 0,
        };
        writers.set(dayKey, writer);
        rollups.set(dayKey, new DayRollupAccumulator());
      }
      // Re-serialise rather than echoing the source line: what lands in the
      // shard is then exactly what the guard accepted, so a query can never see
      // a row the reconciliation counted differently.
      await writeLine(writer, JSON.stringify(row) + '\n');
      rollups.get(dayKey)?.add(row);
      rowsWritten += 1;
    }
  } catch (error) {
    await closeAll(writers);
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
    const reason = `read failed: ${error instanceof Error ? error.message : String(error)}`;
    logger?.error('[usage] migration aborted; legacy file left untouched', error, { reason });
    return { ...IDLE, reason };
  }
  await closeAll(writers);

  if (rowsWritten + skipped !== linesRead) {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
    const reason = `row count mismatch (read ${linesRead}, wrote ${rowsWritten}, skipped ${skipped})`;
    logger?.error('[usage] migration aborted; legacy file left untouched', undefined, { reason });
    return { ...IDLE, linesRead, rowsWritten, skipped, reason };
  }

  // Rollups for every CLOSED day. Today's shard is still open for appends, so it
  // deliberately gets none — a rollup of a day still receiving rows would be
  // wrong the moment it was written.
  const today = usageDayKey(opts.now ?? Date.now());
  for (const [dayKey, acc] of rollups) {
    if (dayKey === today) continue;
    const size = await stat(join(scratch, usageShardName(dayKey)))
      .then((s) => s.size)
      .catch(() => null);
    if (size === null) continue;
    await writeFile(
      join(scratch, usageRollupName(dayKey)),
      JSON.stringify(acc.finish(dayKey, size)),
      'utf8',
    );
  }

  // COMMIT. Refuse if anything is already in place — see the crash-safety note.
  await mkdir(usageDir, { recursive: true });
  const staged = await readdir(scratch);
  const existing = new Set(await readdir(usageDir).catch(() => [] as string[]));
  const collisions = staged.filter((name) => existing.has(name));
  if (collisions.length > 0) {
    const reason =
      `refusing to overwrite existing shards in ${usageDir} ` +
      `(${collisions.slice(0, 3).join(', ')}${collisions.length > 3 ? ', …' : ''}); ` +
      'a previous migration may have partially committed — move or remove them and restart';
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
    logger?.error('[usage] migration aborted; legacy file left untouched', undefined, { reason });
    return { ...IDLE, linesRead, rowsWritten, skipped, reason };
  }
  for (const name of staged) {
    await rename(join(scratch, name), join(usageDir, name));
  }
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
  await unlink(eventsPath);

  const days = rollups.size;
  logger?.info('[usage] migration complete; legacy usage-events.jsonl removed', {
    linesRead,
    rowsWritten,
    skipped,
    days,
  });
  return { migrated: true, linesRead, rowsWritten, skipped, days };
}

/** Flush every pending buffer, then close every handle. Best-effort throughout:
 *  a close that fails must not strand the others still open. */
async function closeAll(writers: Map<string, DayWriter>): Promise<void> {
  for (const writer of writers.values()) {
    await flush(writer).catch(() => {});
    await writer.handle.close().catch(() => {});
  }
  writers.clear();
}
