/**
 * auditDictionary — the cross-session compaction pass (audit-store-sharding,
 * design D8).
 *
 * WHAT THE PER-SESSION DELTA CANNOT REACH: every shard opens with a full-body
 * ANCHOR, and every session's anchor embeds the SAME system prompt and tool
 * definitions. Measured on a realistic day, anchors are about half the stored
 * bytes, and gzip cannot recover them either — its 32 KiB window is far too
 * small to match a 20 KiB block repeated across separate files.
 *
 * THE PASS: pick one anchor body as a day-level dictionary, write it once to
 * `bodies/_dict.jsonl`, and re-encode every other anchor as a delta against it.
 * Measured ~1.9x on top of what the per-session delta plus gzip already achieve.
 *
 * WHEN: only on a CLOSED day directory, so it never races the writer, and always
 * BEFORE the gzip archive step. Idempotent and restart-safe — the dictionary is
 * written first and each shard is replaced by atomic rename, so an interruption
 * leaves every not-yet-rewritten shard self-contained and merely unused.
 *
 * THE TRADE: shards in a compacted day are no longer independent of each other.
 * Losing `_dict.jsonl` costs every anchor in THAT day (readers report an
 * unreconstructable body rather than returning wrong bytes). The dictionary lives
 * in the same day directory and is pruned with it, so the blast radius is one day.
 *
 * @module @omnicross/daemon/audit/auditDictionary
 */

import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { type AuditBodyEntry, computeBodyDelta, isAuditBodyEntry } from './auditBodyStore';
import { AUDIT_BODIES_DIR, auditDayDirName, isAuditDayDir, isSafeSessionKey } from './auditFiles';

/** The day-level dictionary file inside `bodies/`. Not a session shard. */
export const AUDIT_DICT_FILE = '_dict.jsonl';

/** Prefix marking a base that resolves in the dictionary rather than the shard. */
export const DICT_BASE_PREFIX = 'dict:';

/** Candidate dictionaries evaluated (the largest anchors), bounding the scan. */
const DICT_CANDIDATES = 3;

/** Only rewrite when the pass removes at least this share of the anchor bytes. */
const MIN_SAVING_RATIO = 0.2;

/** Parse a JSONL body file into entries, skipping torn or malformed lines. */
function parseEntries(raw: string): AuditBodyEntry[] {
  const entries: AuditBodyEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isAuditBodyEntry(parsed)) entries.push(parsed);
    } catch {
      // A torn line is skipped; the rewrite below drops it, exactly as a read would.
    }
  }
  return entries;
}

/** The plain (not yet archived) session shards of one day. */
function plainShards(bodiesPath: string): string[] {
  try {
    return readdirSync(bodiesPath).filter(
      (file) => file.endsWith('.jsonl') && isSafeSessionKey(file.slice(0, -'.jsonl'.length)),
    );
  } catch {
    return [];
  }
}

/**
 * Choose the anchor body that encodes the others most cheaply. Returns `null`
 * when there is nothing to gain — a single anchor, or savings below the floor.
 */
export function chooseDictionary(anchors: readonly string[]): string | null {
  if (anchors.length < 2) return null;
  const total = anchors.reduce((sum, body) => sum + body.length, 0);

  const candidates = [...anchors].sort((a, b) => b.length - a.length).slice(0, DICT_CANDIDATES);
  let best: { body: string; cost: number } | null = null;
  for (const candidate of candidates) {
    let cost = candidate.length;
    for (const body of anchors) {
      cost += body === candidate ? 0 : computeBodyDelta(candidate, body).ins.length;
    }
    if (best === null || cost < best.cost) best = { body: candidate, cost };
  }
  if (best === null) return null;
  return total - best.cost >= total * MIN_SAVING_RATIO ? best.body : null;
}

/** What one compaction pass did, for logging and the manual trigger's report. */
export interface AuditCompactionResult {
  /** Session shards rewritten against the dictionary. */
  shards: number;
  /** Anchors re-encoded. */
  anchors: number;
  /** Bytes the pass removed (negative is impossible; the floor prevents it). */
  savedBytes: number;
}

const EMPTY: AuditCompactionResult = { shards: 0, anchors: 0, savedBytes: 0 };

/**
 * Run the cross-session pass over ONE day directory. Safe to call repeatedly:
 * a day whose anchors already resolve in the dictionary yields a no-op.
 *
 * The caller must only pass a CLOSED day — rewriting shards of the day still
 * being appended to would race the writer.
 */
export function compactAuditDay(dayPath: string): AuditCompactionResult {
  const bodiesPath = join(dayPath, AUDIT_BODIES_DIR);
  if (!existsSync(bodiesPath)) return EMPTY;
  // A day gets ONE dictionary, ever. Building a second would rewrite the file the
  // already-compacted shards resolve against and strand every one of them.
  const dictPath = join(bodiesPath, AUDIT_DICT_FILE);
  if (existsSync(dictPath) || existsSync(`${dictPath}.gz`)) return EMPTY;
  const shardFiles = plainShards(bodiesPath);
  if (shardFiles.length < 2) return EMPTY;

  // Load every shard, and collect the anchor bodies that are still self-contained.
  const loaded = new Map<string, AuditBodyEntry[]>();
  const anchors: string[] = [];
  for (const file of shardFiles) {
    let entries: AuditBodyEntry[];
    try {
      entries = parseEntries(readFileSync(join(bodiesPath, file), 'utf8'));
    } catch {
      continue;
    }
    loaded.set(file, entries);
    for (const entry of entries) {
      if (entry.req && entry.req.base === null) anchors.push(entry.req.ins);
    }
  }
  if (anchors.length < 2) return EMPTY;

  const dictionary = chooseDictionary(anchors);
  if (dictionary === null) return EMPTY;

  // The dictionary lands FIRST. An interruption after this point leaves the
  // not-yet-rewritten shards self-contained, and an unused dictionary is inert.
  const dictEntry: AuditBodyEntry = {
    id: `${DICT_BASE_PREFIX}0`,
    ts: 0,
    req: { base: null, anchor: 'dict', pre: 0, suf: 0, ins: dictionary },
  };
  writeFileSync(dictPath, JSON.stringify(dictEntry) + '\n', 'utf8');

  const result: AuditCompactionResult = { shards: 0, anchors: 0, savedBytes: 0 };
  for (const [file, entries] of loaded) {
    let changed = false;
    let saved = 0;
    const rewritten = entries.map((entry) => {
      // The dictionary body itself must stay a real anchor somewhere, and an
      // anchor already pointing at the dictionary is left alone (idempotence).
      if (!entry.req || entry.req.base !== null || entry.req.ins === dictionary) return entry;
      const delta = computeBodyDelta(dictionary, entry.req.ins);
      if (delta.ins.length >= entry.req.ins.length) return entry;
      changed = true;
      saved += entry.req.ins.length - delta.ins.length;
      return {
        ...entry,
        req: { base: dictEntry.id, pre: delta.pre, suf: delta.suf, ins: delta.ins },
      } satisfies AuditBodyEntry;
    });
    if (!changed) continue;

    const target = join(bodiesPath, file);
    const temp = `${target}.compacting`;
    try {
      writeFileSync(temp, rewritten.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
      renameSync(temp, target); // atomic swap: a reader sees one version or the other
    } catch {
      try {
        if (existsSync(temp)) unlinkSync(temp);
      } catch {
        // Nothing further to do; the next pass retries from the intact shard.
      }
      continue;
    }
    result.shards += 1;
    result.anchors += rewritten.filter((e) => e.req?.base === dictEntry.id).length;
    result.savedBytes += saved;
  }

  // Nothing was rewritten, so the dictionary is dead weight.
  if (result.shards === 0) {
    try {
      unlinkSync(dictPath);
    } catch {
      // Harmless if it survives: an unreferenced dictionary is inert.
    }
  }
  return result;
}

/** Aggregate of a compaction run across a store's closed days. */
export interface AuditCompactionRun {
  /** Days that had at least one shard rewritten. */
  days: number;
  /** Session shards rewritten. */
  shards: number;
  /** Bytes removed. */
  savedBytes: number;
}

/**
 * Compact every CLOSED day in a store. Today is deliberately skipped: its shards
 * are still being appended to, and rewriting them would race the writer. Backs
 * both the manual admin trigger and the `omnicross audit compact` command.
 * Never throws; a day that fails is skipped and retried on the next run.
 */
export function compactAllClosedAuditDays(
  auditDir: string,
  now: () => number = Date.now,
): AuditCompactionRun {
  const run: AuditCompactionRun = { days: 0, shards: 0, savedBytes: 0 };
  if (!existsSync(auditDir)) return run;
  const today = auditDayDirName(now());
  let names: string[];
  try {
    names = readdirSync(auditDir).filter(isAuditDayDir).sort();
  } catch {
    return run;
  }
  for (const name of names) {
    if (name === today) continue;
    try {
      const result = compactAuditDay(join(auditDir, name));
      if (result.shards === 0) continue;
      run.days += 1;
      run.shards += result.shards;
      run.savedBytes += result.savedBytes;
    } catch {
      // A day that cannot be compacted is left intact for the next run.
    }
  }
  return run;
}
