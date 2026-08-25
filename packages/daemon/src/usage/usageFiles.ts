/**
 * usageFiles — shared date naming + parsing for the sharded usage-event store.
 * One SSOT for the on-disk convention shared by the writer (which shard to
 * append to), the rollup builder, the prune sweeper (what is past retention) and
 * the readers (which days a range spans).
 *
 * TWO layouts coexist, exactly as the audit store's sharding did:
 *
 *  - LEGACY (pre-sharding): a single flat `usage-events.jsonl` holding every
 *    event ever recorded. Read ONCE, by the one-shot migration, then removed.
 *  - CURRENT: a `usage/` directory holding, per LOCAL calendar day,
 *      `usage-YYYY-MM-DD.jsonl`        the raw event rows (pruned past retention)
 *      `usage-YYYY-MM-DD.rollup.json`  the immutable day aggregate (kept FOREVER)
 *
 * The flat file is what made every stats query re-read and re-parse the whole
 * history synchronously — 1.4 s of blocked event loop per query at 156 MB, on a
 * file that grew ~5 MB a day toward V8's ~512 MB string ceiling. Sharding by day
 * is what lets a range query touch only the days it actually spans, and lets a
 * closed day be answered from a pre-computed aggregate instead of its rows.
 *
 * The date is the LOCAL calendar date of the row's timestamp (parity with the
 * audit store and with `getTimeSeries`' LOCAL bucket boundaries) so a day
 * boundary matches the operator's day.
 *
 * @module @omnicross/daemon/usage/usageFiles
 */

import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** The shard directory name, a sibling of `config.json`. */
export const USAGE_DIR_NAME = 'usage';

/** Matches a raw day shard, capturing Y/M/D. */
export const USAGE_SHARD_RE = /^usage-(\d{4})-(\d{2})-(\d{2})\.jsonl$/;

/** Matches a day rollup sidecar, capturing Y/M/D. */
export const USAGE_ROLLUP_RE = /^usage-(\d{4})-(\d{2})-(\d{2})\.rollup\.json$/;

/** Scratch directory the one-shot migration builds into before committing. */
export const USAGE_MIGRATING_DIR = '.migrating';

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** `YYYY-MM-DD` for a timestamp, in LOCAL time. The shard identity. */
export function usageDayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** The raw shard file name for a day key. */
export function usageShardName(dayKey: string): string {
  return `usage-${dayKey}.jsonl`;
}

/** The rollup sidecar file name for a day key. */
export function usageRollupName(dayKey: string): string {
  return `usage-${dayKey}.rollup.json`;
}

/** The `usage/` shard directory that sits beside a legacy events-file path. */
export function usageDirFor(eventsPath: string): string {
  return join(dirname(eventsPath), USAGE_DIR_NAME);
}

/**
 * LOCAL midnight of a `YYYY-MM-DD` key. Built from Date PARTS (never millis
 * arithmetic) so DST-shifted days land on the real local boundary. Returns NaN
 * for a malformed or impossible key (e.g. `2026-13-40`), which every caller
 * treats as "not a day" rather than silently rolling over into another month.
 */
export function dayKeyStartTs(dayKey: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!m) return Number.NaN;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const at = new Date(y, mo - 1, d);
  // Reject a rolled-over date: `new Date(2026, 12, 40)` is a valid Date, just
  // not the day that was asked for.
  if (at.getFullYear() !== y || at.getMonth() !== mo - 1 || at.getDate() !== d) return Number.NaN;
  return at.getTime();
}

/** LOCAL midnight of the day AFTER `dayKey` (the shard's exclusive upper bound). */
export function dayKeyEndTs(dayKey: string): number {
  const start = dayKeyStartTs(dayKey);
  if (Number.isNaN(start)) return Number.NaN;
  const d = new Date(start);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

/**
 * Every LOCAL day key whose span overlaps `[startTs, endTs)`, ascending. An
 * empty or inverted range yields `[]`. Advances by Date PARTS so month lengths
 * and DST transitions cannot drift the enumeration.
 */
export function dayKeysInRange(startTs: number, endTs: number): string[] {
  if (!(startTs < endTs)) return [];
  const keys: string[] = [];
  const first = new Date(startTs);
  let cursor = new Date(first.getFullYear(), first.getMonth(), first.getDate()).getTime();
  // A pathological range (e.g. epoch 0 → now) would enumerate ~20k days; that is
  // still cheap (string building only) and correct, so it is not capped here —
  // the callers that could hit it consult the on-disk day list instead.
  while (cursor < endTs) {
    keys.push(usageDayKey(cursor));
    const d = new Date(cursor);
    cursor = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  }
  return keys;
}

/** What a day has on disk. A pruned day keeps its rollup and loses its shard. */
export interface UsageDayEntry {
  dayKey: string;
  hasShard: boolean;
  hasRollup: boolean;
}

/**
 * Every day the shard directory knows about, ascending by day key. Missing or
 * unreadable directory ⇒ `[]` (a store that has never been written to is not an
 * error). Unrecognised file names are ignored rather than guessed at.
 */
export async function listUsageDays(usageDir: string): Promise<UsageDayEntry[]> {
  let names: string[];
  try {
    names = await readdir(usageDir);
  } catch {
    return [];
  }
  const byKey = new Map<string, UsageDayEntry>();
  const entry = (dayKey: string): UsageDayEntry => {
    let e = byKey.get(dayKey);
    if (!e) {
      e = { dayKey, hasShard: false, hasRollup: false };
      byKey.set(dayKey, e);
    }
    return e;
  };
  for (const name of names) {
    const shard = USAGE_SHARD_RE.exec(name);
    if (shard) {
      const key = `${shard[1]}-${shard[2]}-${shard[3]}`;
      if (!Number.isNaN(dayKeyStartTs(key))) entry(key).hasShard = true;
      continue;
    }
    const rollup = USAGE_ROLLUP_RE.exec(name);
    if (rollup) {
      const key = `${rollup[1]}-${rollup[2]}-${rollup[3]}`;
      if (!Number.isNaN(dayKeyStartTs(key))) entry(key).hasRollup = true;
    }
  }
  return Array.from(byKey.values()).sort((a, b) => (a.dayKey < b.dayKey ? -1 : 1));
}
