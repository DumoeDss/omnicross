/**
 * auditBodyReader — reconstruct captured bodies out of the per-session shards
 * (audit-store-sharding, design D4).
 *
 * Bodies no longer sit inline on the metadata line, so reading one is an explicit
 * second step: locate the session shard, replay its delta chain, hand back the
 * original text. Backs the AUTHED admin body query and the `omnicross audit` CLI
 * — never an unauthenticated surface (a body can hold prompts and PII).
 *
 * Shards are read whole. That is bounded on purpose: a shard holds ONE session's
 * deltas, which is exactly the thing the delta encoding keeps small.
 *
 * Both storage forms are handled transparently: today's plain `.jsonl` (kept
 * greppable on disk) and an archived `.jsonl.gz` from a rolled-over day.
 *
 * @module @omnicross/daemon/audit/auditBodyReader
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import type { AuditBodyResult } from '@omnicross/contracts/audit-types';

import { type AuditBodyEntry, applyBodyDelta, isAuditBodyEntry } from './auditBodyStore';
import { AUDIT_DICT_FILE, DICT_BASE_PREFIX } from './auditDictionary';
import {
  AUDIT_BODIES_DIR,
  AUDIT_FILE_RE,
  auditBodyFileName,
  auditDayDirName,
  isAuditDayDir,
  isSafeSessionKey,
} from './auditFiles';
import { forEachLineFromTail } from './auditJsonl';

/** Locate one record's bodies. `ts` narrows the search to a single day directory. */
export interface AuditBodyQuery {
  /** The audit record id whose bodies to reconstruct. */
  id: string;
  /** The record's session key (its shard). */
  sessionKey: string;
  /** The record's timestamp, if known — skips scanning every retained day. */
  ts?: number;
}

/** Day directories to search, newest first. */
function candidateDays(auditDir: string, ts: number | undefined): string[] {
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    const named = auditDayDirName(ts);
    if (existsSync(join(auditDir, named))) return [named];
  }
  try {
    return readdirSync(auditDir).filter(isAuditDayDir).sort().reverse();
  } catch {
    return [];
  }
}

/** Read a shard's raw text, transparently gunzipping an archived day. */
function readShard(auditDir: string, day: string, sessionKey: string): string | null {
  const base = join(auditDir, day, AUDIT_BODIES_DIR, auditBodyFileName(sessionKey));
  try {
    if (existsSync(base)) return readFileSync(base, 'utf8');
    const gz = `${base}.gz`;
    if (existsSync(gz)) return gunzipSync(readFileSync(gz)).toString('utf8');
  } catch {
    return null;
  }
  return null;
}

/** Parse a shard into id-keyed entries, skipping any torn or malformed line. */
function parseShard(raw: string): Map<string, AuditBodyEntry> {
  const entries = new Map<string, AuditBodyEntry>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (isAuditBodyEntry(parsed)) entries.set(parsed.id, parsed);
  }
  return entries;
}

/**
 * Merge the day's dictionary entries into a shard's map when any line resolves
 * there (audit-store-sharding design D8). Doing it as a MERGE keeps the chain
 * walk below unchanged: a `dict:` base is then just another entry to look up.
 * A missing dictionary is not an error here — the walk simply fails to anchor
 * and the caller reports an unreconstructable body rather than wrong bytes.
 */
function withDictionary(
  auditDir: string,
  day: string,
  entries: Map<string, AuditBodyEntry>,
): Map<string, AuditBodyEntry> {
  let needed = false;
  for (const entry of entries.values()) {
    if (entry.req?.base?.startsWith(DICT_BASE_PREFIX)) {
      needed = true;
      break;
    }
  }
  if (!needed) return entries;

  const base = join(auditDir, day, AUDIT_BODIES_DIR, AUDIT_DICT_FILE);
  let raw: string | null = null;
  try {
    if (existsSync(base)) raw = readFileSync(base, 'utf8');
    else if (existsSync(`${base}.gz`)) raw = gunzipSync(readFileSync(`${base}.gz`)).toString('utf8');
  } catch {
    return entries;
  }
  if (raw === null) return entries;
  for (const [id, entry] of parseShard(raw)) entries.set(id, entry);
  return entries;
}

/**
 * Replay one entry's request-body chain back to its anchor and forward again.
 * Returns `undefined` when the chain is broken (a missing base, or a cycle from a
 * corrupted shard) rather than guessing at partial content.
 */
function reconstructRequest(
  entries: Map<string, AuditBodyEntry>,
  entry: AuditBodyEntry,
): string | undefined {
  if (!entry.req) return undefined;

  const chain: AuditBodyEntry[] = [];
  const visited = new Set<string>();
  let cursor: AuditBodyEntry | undefined = entry;
  while (cursor?.req) {
    if (visited.has(cursor.id)) return undefined; // cycle — corrupted shard
    visited.add(cursor.id);
    chain.push(cursor);
    if (cursor.req.base === null) break;
    cursor = entries.get(cursor.req.base);
  }
  const anchor = chain[chain.length - 1];
  if (!anchor?.req || anchor.req.base !== null) return undefined; // chain never anchored

  let text = anchor.req.ins;
  for (let i = chain.length - 2; i >= 0; i -= 1) {
    const delta = chain[i]?.req;
    if (!delta) return undefined;
    if (delta.pre > text.length || delta.suf > text.length - delta.pre) return undefined;
    text = applyBodyDelta(text, delta);
  }
  return text;
}

/** One reconstructed turn of a session, in shard order. */
export interface AuditSessionTurn extends AuditBodyResult {
  /** The audit record id. */
  id: string;
  /** Epoch ms of the record. */
  ts: number;
  /**
   * True when this turn's body no longer resembled the previous one, so the
   * chain restarted here. Marks a real discontinuity inside one session — a
   * changed system prompt, or a restart that reused the session id.
   */
  diverged?: boolean;
  /**
   * Lineage group. Turns that chain to a common root share a stream, so a fork's
   * branches (and parallel sub-agent turns, which interleave on the wire) are
   * separable even though they share one shard.
   */
  stream: number;
}

/**
 * Group a shard's entries into streams. A turn belongs to its base's stream ONLY
 * when it CONTINUES it (`cont`); a divergent child starts its own.
 *
 * Chain roots are deliberately NOT used: a fork's second branch legitimately
 * deltas against the first branch's opening turn (they share real history, and
 * exploiting that is the whole point), so both branches share a chain root while
 * being distinct streams. Streams are numbered by their earliest turn, so stream
 * 0 is the one that started first.
 */
function assignStreams(entries: Map<string, AuditBodyEntry>): Map<string, number> {
  const rootOf = new Map<string, string>();
  for (const entry of entries.values()) {
    const seen = new Set<string>();
    let cursor: AuditBodyEntry | undefined = entry;
    while (cursor?.req?.cont === true && cursor.req.base !== null && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      const next = entries.get(cursor.req.base);
      if (!next) break; // a dictionary base, or a chain broken by pruning
      cursor = next;
    }
    rootOf.set(entry.id, cursor?.id ?? entry.id);
  }

  const firstTs = new Map<string, number>();
  for (const entry of entries.values()) {
    const root = rootOf.get(entry.id) as string;
    const known = firstTs.get(root);
    if (known === undefined || entry.ts < known) firstTs.set(root, entry.ts);
  }
  const order = [...firstTs.entries()].sort((a, b) => a[1] - b[1]).map(([root]) => root);
  const index = new Map(order.map((root, i) => [root, i]));

  const streams = new Map<string, number>();
  for (const entry of entries.values()) {
    streams.set(entry.id, index.get(rootOf.get(entry.id) as string) ?? 0);
  }
  return streams;
}

/**
 * Reconstruct the bodies for ONE audit record. Returns an empty object when the
 * shard, the record, or the chain cannot be resolved — a missing body is never
 * an error, it just means nothing was captured or the day has been pruned.
 */
export function readAuditBody(auditDir: string, query: AuditBodyQuery): AuditBodyResult {
  if (!isSafeSessionKey(query.sessionKey) || !query.id) return {};
  if (!existsSync(auditDir)) return {};

  for (const day of candidateDays(auditDir, query.ts)) {
    const raw = readShard(auditDir, day, query.sessionKey);
    if (raw === null) continue;
    const entries = withDictionary(auditDir, day, parseShard(raw));
    const entry = entries.get(query.id);
    if (!entry) continue;
    const result: AuditBodyResult = {};
    const requestBody = reconstructRequest(entries, entry);
    if (requestBody !== undefined) result.requestBody = requestBody;
    if (entry.res !== undefined) result.responseBody = entry.res;
    return result;
  }
  return readLegacyInlineBody(auditDir, query.id);
}

/**
 * Fall back to the LEGACY flat layout, where bodies sat inline on the record line.
 * Those files are never written again but stay queryable until TTL prunes them, so
 * a body captured before the re-layout is still reachable through the same API.
 */
function readLegacyInlineBody(auditDir: string, id: string): AuditBodyResult {
  let names: string[];
  try {
    names = readdirSync(auditDir).filter((name) => AUDIT_FILE_RE.test(name)).sort().reverse();
  } catch {
    return {};
  }
  const needle = JSON.stringify(id);
  let found: AuditBodyResult = {};
  for (const name of names) {
    forEachLineFromTail(join(auditDir, name), (line) => {
      // Cheap pre-filter: the id is on every line, so only parse a plausible one.
      if (!line.includes(needle)) return false;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return false;
      }
      const record = parsed as { id?: unknown; requestBody?: unknown; responseBody?: unknown };
      if (record.id !== id) return false;
      const result: AuditBodyResult = {};
      if (typeof record.requestBody === 'string') result.requestBody = record.requestBody;
      if (typeof record.responseBody === 'string') result.responseBody = record.responseBody;
      found = result;
      return true;
    });
    if (found.requestBody !== undefined || found.responseBody !== undefined) break;
  }
  return found;
}

/**
 * Reconstruct EVERY turn of one session shard, oldest first — the readable
 * transcript that replaces tailing the old flat audit file by hand.
 */
export function readAuditSessionTurns(
  auditDir: string,
  sessionKey: string,
  ts?: number,
): AuditSessionTurn[] {
  if (!isSafeSessionKey(sessionKey) || !existsSync(auditDir)) return [];

  for (const day of candidateDays(auditDir, ts)) {
    const raw = readShard(auditDir, day, sessionKey);
    if (raw === null) continue;
    const shardEntries = parseShard(raw);
    const streams = assignStreams(shardEntries);
    const entries = withDictionary(auditDir, day, shardEntries);
    const turns: AuditSessionTurn[] = [];
    for (const entry of entries.values()) {
      if (entry.id.startsWith(DICT_BASE_PREFIX)) continue; // dictionary, not a turn
      const turn: AuditSessionTurn = { id: entry.id, ts: entry.ts, stream: streams.get(entry.id) ?? 0 };
      if (entry.req?.anchor === 'diverged') turn.diverged = true;
      const requestBody = reconstructRequest(entries, entry);
      if (requestBody !== undefined) turn.requestBody = requestBody;
      if (entry.res !== undefined) turn.responseBody = entry.res;
      turns.push(turn);
    }
    // Grouped by lineage first, chronological within a stream: a forked branch or
    // a parallel sub-agent then reads as its own transcript instead of interleaving.
    turns.sort((a, b) => (a.stream === b.stream ? a.ts - b.ts : a.stream - b.stream));
    return turns;
  }
  return [];
}

/** A session shard as listed by `omnicross audit sessions`. */
export interface AuditSessionSummary {
  /** The derived session key (also the shard file name). */
  sessionKey: string;
  /** The day directory the shard lives in. */
  day: string;
  /** Number of recorded turns. */
  turns: number;
  /** On-disk size in bytes (compressed size when archived). */
  bytes: number;
  /** Whether the shard has been gzip-archived. */
  compressed: boolean;
}

/** List the session shards of one day (or of every retained day when `ts` is absent). */
export function listAuditSessions(auditDir: string, ts?: number): AuditSessionSummary[] {
  if (!existsSync(auditDir)) return [];
  const summaries: AuditSessionSummary[] = [];

  for (const day of candidateDays(auditDir, ts)) {
    const bodiesPath = join(auditDir, day, AUDIT_BODIES_DIR);
    let files: string[];
    try {
      files = readdirSync(bodiesPath);
    } catch {
      continue;
    }
    for (const file of files) {
      const compressed = file.endsWith('.jsonl.gz');
      const sessionKey = file.replace(/\.jsonl(\.gz)?$/, '');
      if (!isSafeSessionKey(sessionKey) || (!compressed && !file.endsWith('.jsonl'))) continue;
      let bytes = 0;
      try {
        bytes = statSync(join(bodiesPath, file)).size;
      } catch {
        continue;
      }
      const raw = readShard(auditDir, day, sessionKey);
      const turns = raw === null ? 0 : parseShard(raw).size;
      summaries.push({ sessionKey, day, turns, bytes, compressed });
    }
  }
  summaries.sort((a, b) => (a.day === b.day ? b.bytes - a.bytes : a.day < b.day ? 1 : -1));
  return summaries;
}
