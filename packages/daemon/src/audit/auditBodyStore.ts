/**
 * auditBodyStore — the delta-encoding engine behind the per-session audit body
 * shards (audit-store-sharding, design D3).
 *
 * WHY: an agent conversation re-sends its whole history every turn. Turn k's
 * request body contains turns 1..k-1 verbatim, so storing each turn whole costs
 * O(n^2) per session — a 50-turn Claude Code session writes megabytes of which
 * only kilobytes are new. Encoding each turn against the previous one collapses
 * that back to O(n).
 *
 * HOW: a LONGEST-COMMON-PREFIX + LONGEST-COMMON-SUFFIX delta. Pure string work,
 * no JSON parsing, so it is format-agnostic across all four ingress shapes. The
 * bidirectional form matters because `messages` is rarely the LAST key in the
 * body: appending a turn shifts everything after it, which a prefix-only delta
 * would miss entirely.
 *
 *     next === prev.slice(0, pre) + ins + prev.slice(prev.length - suf)
 *
 * ANCHORS bound both replay cost and blast radius. A full snapshot (`base: null`)
 * is written whenever the chain would otherwise get long, wide, or unverifiable;
 * see {@link anchorReason}. Crucially a cache MISS anchors, which is what lets the
 * write path stay pure memory — it NEVER reads a shard back to encode.
 *
 * @module @omnicross/daemon/audit/auditBodyStore
 */

import type { AuditRecord } from '@omnicross/contracts/audit-types';

/** Re-anchor after this many chained deltas, bounding replay depth. */
export const ANCHOR_EVERY = 64;

/**
 * Re-anchor when the delta saves less than this share of the NEW body. A delta
 * that costs nearly as much as a snapshot buys nothing yet takes on a dependency
 * on its predecessor, so the self-contained snapshot is strictly better.
 * Compared against the new body, never the base: a shrinking body (compaction)
 * must not be judged against the large history it replaced.
 */
export const ANCHOR_DELTA_RATIO = 0.75;

/**
 * A turn counts as DIVERGED when it keeps less than this share of the previous
 * body as a common prefix — the shared head collapsed, so this is a genuine
 * discontinuity (an edited system prompt, or a restart that reused the session
 * id) rather than the conversation simply growing.
 *
 * Deliberately measured on the PREFIX, not on the delta size: an early turn that
 * adds several messages at once produces a large delta while its prefix is fully
 * intact, and flagging that as a discontinuity would make the marker noise.
 */
export const DIVERGED_PREFIX_RATIO = 0.25;

/** A single base longer than this is not retained (bounds one entry's footprint). */
export const MAX_BASE_CHARS = 4_000_000;

/** Total retained base text across all sessions. */
export const CACHE_BUDGET_CHARS = 16_000_000;

/** Maximum number of sessions held open for delta encoding. */
export const CACHE_MAX_SESSIONS = 32;

/**
 * Encoding heads retained per session. More than one because a forked
 * conversation and parallel sub-agent turns both share a session key while
 * carrying different bodies; each needs its own chain.
 */
export const MAX_BASES_PER_SESSION = 4;

/**
 * Why a turn was stored as a full snapshot instead of a delta. Recorded on the
 * line so a discontinuity is legible on disk: `diverged` means the shared prefix
 * collapsed (a changed system prompt, or a restart that reused the session id),
 * which is the one an operator wants to see. `costly` means the delta simply was
 * not worth its dependency, and `new`/`day`/`chain` are routine bookkeeping.
 */
export type AnchorReason = 'new' | 'day' | 'chain' | 'diverged' | 'costly' | 'dict';

/** The request-body delta stored on one shard line. */
export interface BodyDelta {
  /** Record id this delta is encoded against, or `null` for a full snapshot. */
  base: string | null;
  /** Present only on a snapshot (`base: null`): why the chain restarted here. */
  anchor?: AnchorReason;
  /**
   * True when the base's body survived WHOLE inside this one, i.e. this turn
   * CONTINUES that stream. A delta without it is a divergent child: a forked
   * branch or a parallel sub-agent turn that merely reused the base's shared
   * history. Readers group transcripts along `cont` links, which is the only
   * thing that separates a fork's branches — both legitimately delta against
   * the same ancestor.
   */
  cont?: boolean;
  /** Characters of the base kept as a prefix. */
  pre: number;
  /** Characters of the base kept as a suffix. */
  suf: number;
  /** The differing middle — the whole body when `base` is `null`. */
  ins: string;
}

/** One line of a `bodies/<sessionKey>.jsonl` shard. */
export interface AuditBodyEntry {
  /** The audit record this body belongs to. */
  id: string;
  /** Epoch ms, mirrored from the record so a shard is self-describing. */
  ts: number;
  /** Request body, delta-encoded. Absent when none was captured. */
  req?: BodyDelta;
  /** Response body, stored whole — streams do not accumulate, so a delta buys nothing. */
  res?: string;
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/**
 * Compute the prefix/suffix delta taking `prev` to `next`. Boundaries back off a
 * split surrogate pair so neither side ever ends on half a code point.
 */
export function computeBodyDelta(prev: string, next: string): Omit<BodyDelta, 'base'> {
  const shortest = Math.min(prev.length, next.length);

  let pre = 0;
  while (pre < shortest && prev.charCodeAt(pre) === next.charCodeAt(pre)) pre += 1;
  if (pre > 0 && isHighSurrogate(prev.charCodeAt(pre - 1))) pre -= 1;

  const maxSuf = shortest - pre;
  let suf = 0;
  while (
    suf < maxSuf &&
    prev.charCodeAt(prev.length - 1 - suf) === next.charCodeAt(next.length - 1 - suf)
  ) {
    suf += 1;
  }
  if (suf > 0 && isLowSurrogate(prev.charCodeAt(prev.length - suf))) suf -= 1;

  return { pre, suf, ins: next.slice(pre, next.length - suf) };
}

/** Reconstruct the encoded body from its base. Inverse of {@link computeBodyDelta}. */
export function applyBodyDelta(prev: string, delta: Omit<BodyDelta, 'base'>): string {
  const head = delta.pre > 0 ? prev.slice(0, delta.pre) : '';
  const tail = delta.suf > 0 ? prev.slice(prev.length - delta.suf) : '';
  return head + delta.ins + tail;
}

/** The retained encoding base for one session shard. */
export interface SessionBase {
  /** Day directory the base line lives in — a rollover forces a re-anchor. */
  dayDir: string;
  /** Record id of the base line. */
  lastId: string;
  /** The reconstructed request body of the base line. */
  text: string;
  /** How many deltas have chained since the last full snapshot. */
  chainLen: number;
}

/**
 * Bounded LRU of per-session encoding bases, holding SEVERAL heads per session.
 *
 * One head per session is not enough. Two request streams routinely share a
 * session key while carrying different bodies:
 *  - a FORKED conversation, whose branches share the system prompt and first
 *    user message that the content fingerprint is built from;
 *  - PARALLEL sub-agent turns inside one session, which interleave on the wire.
 * With a single head each turn would encode against the other stream's body, so
 * the delta never shrinks to that stream's own increment %s measured at roughly
 * half the compression of a linear session. Keeping a few heads and encoding
 * against the BEST match restores per-stream chains.
 *
 * Deliberately memory-only: a miss anchors instead of reading a shard back, so
 * the deferred write path never touches disk to encode and can never stall.
 */
export class SessionBaseCache {
  /** Session key to its retained heads, most-recent first. */
  private readonly entries = new Map<string, SessionBase[]>();
  private chars = 0;

  constructor(
    private readonly maxSessions: number = CACHE_MAX_SESSIONS,
    private readonly budgetChars: number = CACHE_BUDGET_CHARS,
    private readonly maxBaseChars: number = MAX_BASE_CHARS,
    private readonly maxHeads: number = MAX_BASES_PER_SESSION,
  ) {}

  /** Retained sessions (tests + diagnostics). */
  get size(): number {
    return this.entries.size;
  }

  /** A session's retained heads, most-recent first. Refreshes LRU recency. */
  get(sessionKey: string): readonly SessionBase[] {
    const found = this.entries.get(sessionKey);
    if (!found) return [];
    this.entries.delete(sessionKey);
    this.entries.set(sessionKey, found);
    return found;
  }

  /**
   * Retain `base` as a head of `sessionKey`.
   *
   * `replacesId` is the head this turn CONTINUES (its body was preserved whole
   * inside the new one), which is swapped out so a linear conversation keeps
   * exactly one head. Omit it when the turn started a distinct stream %s that
   * head is added alongside, which is what keeps a fork's branches apart.
   *
   * A body larger than `maxBaseChars` is not retained: the next turn anchors
   * rather than letting one oversized session monopolize the budget.
   */
  remember(sessionKey: string, base: SessionBase, replacesId?: string): void {
    const heads = this.entries.get(sessionKey) ?? [];
    if (replacesId !== undefined) {
      const at = heads.findIndex((head) => head.lastId === replacesId);
      if (at >= 0) {
        this.chars -= heads[at]!.text.length;
        heads.splice(at, 1);
      }
    }
    if (base.text.length <= this.maxBaseChars) {
      heads.unshift(base);
      this.chars += base.text.length;
    }
    while (heads.length > this.maxHeads) {
      const dropped = heads.pop();
      if (dropped) this.chars -= dropped.text.length;
    }

    this.entries.delete(sessionKey);
    if (heads.length > 0) this.entries.set(sessionKey, heads);
    this.evict();
  }

  /** Drop a session's heads (eviction, or a write failure invalidating them). */
  forget(sessionKey: string): void {
    const heads = this.entries.get(sessionKey);
    if (!heads) return;
    for (const head of heads) this.chars -= head.text.length;
    this.entries.delete(sessionKey);
  }

  /** Drop everything (writer disposal / test teardown). */
  clear(): void {
    this.entries.clear();
    this.chars = 0;
  }

  /** Evict least-recently-used sessions until both bounds hold. */
  private evict(): void {
    while (
      this.entries.size > this.maxSessions ||
      (this.chars > this.budgetChars && this.entries.size > 1)
    ) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.forget(oldest.value);
    }
  }
}


/**
 * Why this turn must be a full snapshot, or `null` to encode it as a delta.
 * Any single reason is enough; each bounds a different failure mode.
 */
export function anchorReason(
  base: SessionBase | undefined,
  dayDir: string,
  delta: Omit<BodyDelta, 'base'> | null,
  nextLength: number,
): AnchorReason | null {
  // No usable head (new session, evicted, or oversized) — nothing to chain to.
  if (!base || !delta) return 'new';
  // The head lives in yesterday's directory; a shard must be self-contained so
  // its day can be pruned or archived independently.
  if (base.dayDir !== dayDir) return 'day';
  // Bound replay depth and the blast radius of a single torn line.
  if (base.chainLen >= ANCHOR_EVERY) return 'chain';
  // The shared head collapsed: a real discontinuity, worth surfacing. Compaction
  // does NOT land here — a compacted turn keeps its system/tools prefix intact.
  if (delta.pre < base.text.length * DIVERGED_PREFIX_RATIO) return 'diverged';
  // Otherwise still prefer a snapshot when the delta saves almost nothing.
  if (delta.ins.length > nextLength * ANCHOR_DELTA_RATIO) return 'costly';
  return null;
}

/** The head chosen to encode against, with the delta it produces. */
export interface ChosenBase {
  base: SessionBase;
  delta: Omit<BodyDelta, 'base'>;
  /**
   * True when the head's body survived WHOLE inside the new one (prefix plus
   * suffix cover it entirely), i.e. this turn continues that stream rather than
   * starting a new one. Drives whether the head is replaced or kept alongside.
   */
  continues: boolean;
}

/**
 * Pick the head that encodes `next` most cheaply. Comparing every head is what
 * lets a fork's branches (and parallel sub-agent turns) keep separate chains
 * instead of each encoding against the other stream's body.
 */
export function pickBase(heads: readonly SessionBase[], next: string): ChosenBase | null {
  let best: ChosenBase | null = null;
  for (const base of heads) {
    const delta = computeBodyDelta(base.text, next);
    if (best !== null && delta.ins.length >= best.delta.ins.length) continue;
    best = { base, delta, continues: delta.pre + delta.suf >= base.text.length };
  }
  return best;
}

/**
 * Encode one record's bodies into a shard line, updating the cache so the NEXT
 * turn of the same stream can chain onto it. Returns `null` when the record
 * carries no body at all (nothing to shard).
 *
 * The caller is responsible for only calling this once per record and for
 * invalidating the session (via {@link SessionBaseCache.forget}) if the returned
 * line fails to reach disk — otherwise the next delta would chain onto a base
 * that no reader can find.
 */
export function encodeBodyEntry(
  record: AuditRecord,
  sessionKey: string,
  dayDir: string,
  cache: SessionBaseCache,
): string | null {
  const requestBody = record.requestBody;
  const responseBody = record.responseBody;
  if (requestBody === undefined && responseBody === undefined) return null;

  const entry: AuditBodyEntry = { id: record.id, ts: record.ts };

  if (requestBody !== undefined) {
    const heads = cache.get(sessionKey);
    // A head from another day cannot be chained to: shards must stay per-day
    // self-contained so a day can be archived or pruned on its own.
    const sameDay = heads.filter((head) => head.dayDir === dayDir);
    const chosen = pickBase(sameDay, requestBody);
    const reason = heads.length > 0 && sameDay.length === 0
      ? 'day'
      : anchorReason(chosen?.base, dayDir, chosen?.delta ?? null, requestBody.length);

    if (reason !== null) {
      entry.req = { base: null, anchor: reason, pre: 0, suf: 0, ins: requestBody };
      // A snapshot starts a fresh stream, so it is added as a new head unless it
      // clearly continues the one it was compared against.
      cache.remember(
        sessionKey,
        { dayDir, lastId: record.id, text: requestBody, chainLen: 0 },
        chosen?.continues === true ? chosen.base.lastId : undefined,
      );
    } else {
      const picked = chosen as ChosenBase;
      entry.req = {
        base: picked.base.lastId,
        ...(picked.continues ? { cont: true } : {}),
        pre: picked.delta.pre,
        suf: picked.delta.suf,
        ins: picked.delta.ins,
      };
      cache.remember(
        sessionKey,
        { dayDir, lastId: record.id, text: requestBody, chainLen: picked.base.chainLen + 1 },
        picked.continues ? picked.base.lastId : undefined,
      );
    }
  }

  if (responseBody !== undefined) entry.res = responseBody;

  return JSON.stringify(entry);
}

/** Structural guard for a parsed shard line (a torn tail must never poison a read). */
export function isAuditBodyEntry(value: unknown): value is AuditBodyEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry['id'] !== 'string' || typeof entry['ts'] !== 'number') return false;
  if (entry['res'] !== undefined && typeof entry['res'] !== 'string') return false;
  const req = entry['req'];
  if (req === undefined) return true;
  if (!req || typeof req !== 'object' || Array.isArray(req)) return false;
  const delta = req as Record<string, unknown>;
  if (delta['anchor'] !== undefined && typeof delta['anchor'] !== 'string') return false;
  if (delta['cont'] !== undefined && typeof delta['cont'] !== 'boolean') return false;
  return (
    (delta['base'] === null || typeof delta['base'] === 'string') &&
    Number.isSafeInteger(delta['pre']) &&
    (delta['pre'] as number) >= 0 &&
    Number.isSafeInteger(delta['suf']) &&
    (delta['suf'] as number) >= 0 &&
    typeof delta['ins'] === 'string'
  );
}
