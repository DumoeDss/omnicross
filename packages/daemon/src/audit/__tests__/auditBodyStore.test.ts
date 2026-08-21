import type { AuditRecord } from '@omnicross/contracts/audit-types';
import { describe, expect, it } from 'vitest';

import {
  ANCHOR_EVERY,
  applyBodyDelta,
  computeBodyDelta,
  encodeBodyEntry,
  isAuditBodyEntry,
  SessionBaseCache,
  type AuditBodyEntry,
} from '../auditBodyStore';

const rec = (over: Partial<AuditRecord> = {}): AuditRecord => ({
  id: 'r1',
  ts: 1,
  method: 'POST',
  path: '/v1/messages',
  status: 200,
  latencyMs: 3,
  ...over,
});

const decode = (line: string): AuditBodyEntry => JSON.parse(line) as AuditBodyEntry;

describe('computeBodyDelta / applyBodyDelta', () => {
  const roundTrips = (prev: string, next: string): boolean =>
    applyBodyDelta(prev, computeBodyDelta(prev, next)) === next;

  it('round-trips a mid-body insert (the shape a growing messages array makes)', () => {
    const prev = '{"model":"x","messages":[{"a":1}],"stream":true}';
    const next = '{"model":"x","messages":[{"a":1},{"b":2}],"stream":true}';
    const delta = computeBodyDelta(prev, next);
    expect(applyBodyDelta(prev, delta)).toBe(next);
    // The whole point: only the inserted span is stored, not the surrounding body.
    expect(delta.ins.length).toBeLessThan(next.length / 3);
    expect(delta.suf).toBeGreaterThan(0);
  });

  it('round-trips append, shrink, empty, and identical bodies', () => {
    expect(roundTrips('abc', 'abcdef')).toBe(true);
    expect(roundTrips('abcdef', 'abc')).toBe(true);
    expect(roundTrips('', 'xyz')).toBe(true);
    expect(roundTrips('same', 'same')).toBe(true);
  });

  it('never splits a surrogate pair at either boundary', () => {
    // Same leading surrogate, different trailing one.
    expect(roundTrips('ab\u{1F600}', 'ab\u{1F601}')).toBe(true);
    expect(roundTrips('\u{1F600}ab', '\u{1F601}ab')).toBe(true);
    // Different leading surrogate, IDENTICAL trailing one — the suffix would
    // otherwise start halfway through a pair.
    expect(roundTrips('\u{1F600}', '\u{1F921}')).toBe(true);
    const delta = computeBodyDelta('\u{1F600}', '\u{1F921}');
    expect(delta.suf).toBe(0);
  });

  it('keeps prefix + suffix from overlapping when one body contains the other', () => {
    const delta = computeBodyDelta('aaaa', 'aa');
    expect(delta.pre + delta.suf).toBeLessThanOrEqual(2);
    expect(applyBodyDelta('aaaa', delta)).toBe('aa');
  });
});

describe('SessionBaseCache', () => {
  const head = (lastId: string, text: string, dayDir = 'audit-2026-08-20') => ({
    dayDir, lastId, text, chainLen: 0,
  });

  it('evicts least-recently-used beyond the session cap', () => {
    const cache = new SessionBaseCache(2, 1_000_000, 1_000_000);
    cache.remember('a', head('x', '1'));
    cache.remember('b', head('x', '2'));
    cache.get('a'); // refresh 'a' so 'b' becomes the eviction candidate
    cache.remember('c', head('x', '3'));
    expect(cache.get('a')).toHaveLength(1);
    expect(cache.get('b')).toHaveLength(0);
    expect(cache.get('c')).toHaveLength(1);
  });

  it('refuses to retain a base larger than the per-entry cap', () => {
    const cache = new SessionBaseCache(8, 1_000_000, 10);
    cache.remember('a', head('x', 'x'.repeat(50)));
    expect(cache.get('a')).toHaveLength(0);
    expect(cache.size).toBe(0);
  });

  it('replaces the continued head but keeps a distinct stream alongside', () => {
    const cache = new SessionBaseCache();
    cache.remember('s', head('a1', 'A'));
    cache.remember('s', head('a2', 'AA'), 'a1');       // continues a1
    expect(cache.get('s').map((h) => h.lastId)).toEqual(['a2']);
    cache.remember('s', head('b1', 'B'));              // a distinct stream
    expect(cache.get('s').map((h) => h.lastId)).toEqual(['b1', 'a2']);
  });

  it('caps the heads it keeps per session', () => {
    const cache = new SessionBaseCache(8, 1_000_000, 1_000_000, 2);
    cache.remember('s', head('h1', '1'));
    cache.remember('s', head('h2', '2'));
    cache.remember('s', head('h3', '3'));
    expect(cache.get('s').map((h) => h.lastId)).toEqual(['h3', 'h2']);
  });

  it('stays inside the total character budget', () => {
    const cache = new SessionBaseCache(8, 100, 100);
    for (let i = 0; i < 5; i += 1) {
      cache.remember(`s${i}`, { dayDir: 'd', lastId: 'x', text: 'x'.repeat(40), chainLen: 0 });
    }
    expect(cache.size).toBeLessThanOrEqual(3);
  });
});

describe('encodeBodyEntry', () => {
  const DAY = 'audit-2026-08-20';

  it('anchors the first turn, then chains deltas onto it', () => {
    const cache = new SessionBaseCache();
    const first = decode(
      encodeBodyEntry(rec({ id: 'a', requestBody: 'HEADER' + 'x'.repeat(500) }), 's', DAY, cache)!,
    );
    expect(first.req?.base).toBeNull();
    expect(first.req?.ins).toHaveLength(506);

    const second = decode(
      encodeBodyEntry(rec({ id: 'b', requestBody: 'HEADER' + 'x'.repeat(500) + 'NEW' }), 's', DAY, cache)!,
    );
    expect(second.req?.base).toBe('a');
    expect(second.req?.ins).toBe('NEW');
  });

  it('re-anchors when the day directory rolls over', () => {
    const cache = new SessionBaseCache();
    encodeBodyEntry(rec({ id: 'a', requestBody: 'x'.repeat(100) }), 's', DAY, cache);
    const next = decode(
      encodeBodyEntry(rec({ id: 'b', requestBody: 'x'.repeat(101) }), 's', 'audit-2026-08-21', cache)!,
    );
    // A shard must be self-contained so its day can be pruned independently.
    expect(next.req?.base).toBeNull();
    expect(next.req?.ins).toHaveLength(101);
  });

  it('re-anchors once the chain reaches the depth cap', () => {
    const cache = new SessionBaseCache();
    let anchors = 0;
    for (let i = 0; i <= ANCHOR_EVERY + 1; i += 1) {
      const line = encodeBodyEntry(
        rec({ id: `r${i}`, requestBody: 'base'.repeat(200) + 'x'.repeat(i) }),
        's',
        DAY,
        cache,
      );
      if (decode(line!).req?.base === null) anchors += 1;
    }
    expect(anchors).toBe(2); // the first turn, then one re-anchor at the cap
  });

  it('re-anchors when the delta stops paying for itself', () => {
    const cache = new SessionBaseCache();
    encodeBodyEntry(rec({ id: 'a', requestBody: 'a'.repeat(100) }), 's', DAY, cache);
    // A completely unrelated body reusing the same shard: the delta would be as
    // large as a snapshot, so store the snapshot instead.
    const next = decode(encodeBodyEntry(rec({ id: 'b', requestBody: 'z'.repeat(100) }), 's', DAY, cache)!);
    expect(next.req?.base).toBeNull();
    expect(next.req?.anchor).toBe('diverged');
  });

  it('anchors a SHORTER unrelated body too (the ratio is against the new body)', () => {
    // Regression: comparing the delta against the BASE let a 20KB unrelated body
    // chain onto a 50KB base, paying a dependency for no space saving at all.
    const cache = new SessionBaseCache();
    encodeBodyEntry(rec({ id: 'a', requestBody: 'a'.repeat(50_000) }), 's', DAY, cache);
    const next = decode(encodeBodyEntry(rec({ id: 'b', requestBody: 'z'.repeat(20_000) }), 's', DAY, cache)!);
    expect(next.req?.base).toBeNull();
    expect(next.req?.anchor).toBe('diverged');
  });

  it('still deltas across an auto-compaction, which keeps its system/tools prefix', () => {
    const cache = new SessionBaseCache();
    const sys = '{"system":"' + 'S'.repeat(30_000) + '","messages":[';
    const long = sys + Array.from({ length: 40 }, (_, i) => `{"m":"${'x'.repeat(2000)}${i}"}`).join(',') + ']}';
    const compacted = sys + '{"m":"SUMMARY of the prior conversation"}]}';
    encodeBodyEntry(rec({ id: 'a', requestBody: long }), 's', DAY, cache);
    const next = decode(encodeBodyEntry(rec({ id: 'b', requestBody: compacted }), 's', DAY, cache)!);
    // Compaction is NOT a divergence: the shared prefix survives, so the delta
    // stays far cheaper than re-storing the 30KB system prompt.
    expect(next.req?.base).toBe('a');
    expect(next.req!.ins.length).toBeLessThan(compacted.length / 10);
  });

  it('anchors on a cache miss so the write path never reads a shard back', () => {
    const cache = new SessionBaseCache();
    encodeBodyEntry(rec({ id: 'a', requestBody: 'x'.repeat(100) }), 's', DAY, cache);
    cache.forget('s'); // simulates eviction, or a failed write invalidating the base
    const next = decode(encodeBodyEntry(rec({ id: 'b', requestBody: 'x'.repeat(101) }), 's', DAY, cache)!);
    expect(next.req?.base).toBeNull();
  });

  it('stores a response body whole and returns null when nothing was captured', () => {
    const cache = new SessionBaseCache();
    const entry = decode(encodeBodyEntry(rec({ id: 'a', responseBody: 'sse' }), 's', DAY, cache)!);
    expect(entry.res).toBe('sse');
    expect(entry.req).toBeUndefined();
    expect(encodeBodyEntry(rec({ id: 'b' }), 's', DAY, cache)).toBeNull();
  });

  it('reconstructs a 50-turn conversation exactly, at a fraction of the naive size', () => {
    const cache = new SessionBaseCache();
    const prefix = `{"system":"${'S'.repeat(30_000)}","messages":[`;
    const bodies: string[] = [];
    const lines: string[] = [];
    for (let turn = 0; turn < 50; turn += 1) {
      const msgs = Array.from({ length: turn + 1 }, (_, i) => `{"role":"user","content":"${'m'.repeat(2000)}${i}"}`);
      const body = `${prefix}${msgs.join(',')}],"stream":true}`;
      bodies.push(body);
      lines.push(encodeBodyEntry(rec({ id: `t${turn}`, requestBody: body }), 's', DAY, cache)!);
    }

    // Every turn replays byte-for-byte.
    const byId = new Map(lines.map((line) => [decode(line).id, decode(line)]));
    for (let turn = 0; turn < 50; turn += 1) {
      let text = '';
      const chain: AuditBodyEntry[] = [];
      let cursor: AuditBodyEntry | undefined = byId.get(`t${turn}`);
      while (cursor?.req) {
        chain.push(cursor);
        if (cursor.req.base === null) break;
        cursor = byId.get(cursor.req.base);
      }
      text = chain[chain.length - 1]!.req!.ins;
      for (let i = chain.length - 2; i >= 0; i -= 1) text = applyBodyDelta(text, chain[i]!.req!);
      expect(text).toBe(bodies[turn]);
    }

    const stored = lines.reduce((sum, line) => sum + line.length, 0);
    const naive = bodies.reduce((sum, body) => sum + body.length, 0);
    expect(stored).toBeLessThan(naive * 0.2);
  });
});

describe('isAuditBodyEntry', () => {
  it('rejects malformed lines so a torn shard never poisons a read', () => {
    expect(isAuditBodyEntry({ id: 'a', ts: 1 })).toBe(true);
    expect(isAuditBodyEntry({ id: 'a', ts: 1, req: { base: null, pre: 0, suf: 0, ins: 'x' } })).toBe(true);
    expect(isAuditBodyEntry({ id: 'a' })).toBe(false);
    expect(isAuditBodyEntry({ id: 'a', ts: 1, req: { base: null, pre: -1, suf: 0, ins: '' } })).toBe(false);
    expect(isAuditBodyEntry({ id: 'a', ts: 1, res: 5 })).toBe(false);
    expect(isAuditBodyEntry(null)).toBe(false);
    expect(isAuditBodyEntry([])).toBe(false);
  });
});

describe('encodeBodyEntry — forked / interleaved streams sharing one session key', () => {
  const DAY2 = 'audit-2026-08-20';
  const SYS = '{"system":"' + 'S'.repeat(20_000) + '","messages":[';
  const turn = (tag: string, n: number): string =>
    SYS + Array.from({ length: n }, (_, i) => `{"role":"user","content":"${tag.repeat(1200)}#${i}"}`).join(',') + ']}';

  /** Two branches of a fork, used alternately, both under one session key. */
  const interleaved = (): Array<{ id: string; body: string }> => {
    const seq: Array<{ id: string; body: string }> = [];
    for (let i = 1; i <= 5; i += 1) {
      seq.push({ id: `a${i}`, body: turn('a', i) });
      seq.push({ id: `b${i}`, body: turn('b', i) });
    }
    return seq;
  };

  it('chains each branch to ITSELF rather than to the other branch', () => {
    const cache = new SessionBaseCache();
    const bases = new Map<string, string | null>();
    for (const { id, body: text } of interleaved()) {
      const entry = decode(encodeBodyEntry(rec({ id, requestBody: text }), 's', DAY2, cache)!);
      bases.set(id, entry.req!.base);
    }
    // a2..a5 chain onto the previous 'a' turn; likewise for 'b'.
    expect(bases.get('a3')).toBe('a2');
    expect(bases.get('a5')).toBe('a4');
    expect(bases.get('b3')).toBe('b2');
    expect(bases.get('b5')).toBe('b4');
  });

  it('keeps interleaved compression on par with a linear session', () => {
    const size = (seq: Array<{ id: string; body: string }>): number => {
      const cache = new SessionBaseCache();
      return seq.reduce(
        (sum, s) => sum + encodeBodyEntry(rec({ id: s.id, requestBody: s.body }), 's', DAY2, cache)!.length,
        0,
      );
    };
    const linear = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, body: turn('a', i + 1) }));
    // Before multi-head this was ~2x worse; the branches must not tax each other.
    expect(size(interleaved())).toBeLessThan(size(linear) * 1.5);
  });

  it('still replays every turn of both branches exactly', () => {
    const cache = new SessionBaseCache();
    const seq = interleaved();
    const byId = new Map<string, AuditBodyEntry>();
    for (const { id, body: text } of seq) {
      byId.set(id, decode(encodeBodyEntry(rec({ id, requestBody: text }), 's', DAY2, cache)!));
    }
    for (const { id, body: expected } of seq) {
      const chain: AuditBodyEntry[] = [];
      let cursor: AuditBodyEntry | undefined = byId.get(id);
      while (cursor?.req) {
        chain.push(cursor);
        if (cursor.req.base === null) break;
        cursor = byId.get(cursor.req.base);
      }
      let text = chain[chain.length - 1]!.req!.ins;
      for (let i = chain.length - 2; i >= 0; i -= 1) text = applyBodyDelta(text, chain[i]!.req!);
      expect(text).toBe(expected);
    }
  });
});
