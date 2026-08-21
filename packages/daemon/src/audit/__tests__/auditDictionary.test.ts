import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AuditRecord } from '@omnicross/contracts/audit-types';
import type { Logger } from '@omnicross/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditPruneSweeper } from '../AuditPruneSweeper';
import { AuditWriter } from '../AuditWriter';
import { readAuditSessionTurns } from '../auditBodyReader';
import {
  AUDIT_DICT_FILE,
  chooseDictionary,
  compactAllClosedAuditDays,
  compactAuditDay,
} from '../auditDictionary';
import { AUDIT_BODIES_DIR, auditDayDirName } from '../auditFiles';

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
const NOW = new Date(2026, 7, 21, 10, 0, 0).getTime();
const TS = new Date(2026, 7, 20, 9, 0, 0).getTime();

/** The head every session repeats verbatim: the thing per-session deltas cannot reach. */
const HEAD = `{"model":"claude-opus-5","system":"${'S'.repeat(6000)}","tools":[${'"T",'.repeat(2000)}"T"],"messages":[`;
const bodyFor = (session: number, turns: number): string =>
  HEAD + Array.from({ length: turns }, (_, i) => `{"role":"user","content":"s${session}-${'x'.repeat(400)}#${i}"}`).join(',') + ']}';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omni-dict-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const key = (n: number): string => String(n).repeat(32).slice(0, 32);

/** Write `sessions` conversations of `turns` turns each into one day. */
function seedDay(sessions: number, turns = 4): string[][] {
  const writer = new AuditWriter(dir, logger);
  const bodies: string[][] = [];
  for (let s = 0; s < sessions; s += 1) {
    const perSession: string[] = [];
    for (let t = 0; t < turns; t += 1) {
      const body = bodyFor(s, t + 1);
      perSession.push(body);
      const rec: AuditRecord = {
        id: `s${s}t${t}`, ts: TS + s * 1000 + t, method: 'POST', path: '/v1/messages',
        status: 200, latencyMs: 1, sessionKey: key(s), requestBody: body,
      };
      writer.appendNow(rec);
    }
    bodies.push(perSession);
  }
  return bodies;
}

const dayPath = (): string => join(dir, auditDayDirName(TS));
const bodiesSize = (): number => {
  const p = join(dayPath(), AUDIT_BODIES_DIR);
  return readdirSync(p).reduce((a, f) => a + statSync(join(p, f)).size, 0);
};

describe('chooseDictionary', () => {
  it('declines when there is nothing to share', () => {
    expect(chooseDictionary([])).toBeNull();
    expect(chooseDictionary(['only one'])).toBeNull();
    // Unrelated bodies: a dictionary would cost more than it saves.
    expect(chooseDictionary(['a'.repeat(500), 'b'.repeat(500), 'c'.repeat(500)])).toBeNull();
  });

  it('picks a body that subsumes the shared head', () => {
    const picked = chooseDictionary([HEAD + 'A]}', HEAD + 'B]}', HEAD + 'C]}']);
    expect(picked).not.toBeNull();
    expect(picked!.startsWith(HEAD)).toBe(true);
  });
});

describe('compactAuditDay', () => {
  it('shrinks the day and still replays every turn byte-for-byte', () => {
    const bodies = seedDay(8);
    const before = bodiesSize();

    const result = compactAuditDay(dayPath());
    expect(result.shards).toBeGreaterThan(0);
    expect(result.savedBytes).toBeGreaterThan(0);
    expect(existsSync(join(dayPath(), AUDIT_BODIES_DIR, AUDIT_DICT_FILE))).toBe(true);
    expect(bodiesSize()).toBeLessThan(before);

    for (let s = 0; s < bodies.length; s += 1) {
      const turns = readAuditSessionTurns(dir, key(s), TS);
      expect(turns.map((t) => t.requestBody)).toEqual(bodies[s]);
    }
  });

  it('is a no-op on a second run (a day gets one dictionary, ever)', () => {
    seedDay(8);
    expect(compactAuditDay(dayPath()).shards).toBeGreaterThan(0);
    const after = bodiesSize();
    expect(compactAuditDay(dayPath())).toEqual({ shards: 0, anchors: 0, savedBytes: 0 });
    expect(bodiesSize()).toBe(after);
  });

  it('declines a day with only one session', () => {
    seedDay(1);
    expect(compactAuditDay(dayPath()).shards).toBe(0);
    expect(existsSync(join(dayPath(), AUDIT_BODIES_DIR, AUDIT_DICT_FILE))).toBe(false);
  });

  it('reports an unreconstructable body rather than wrong bytes if the dictionary is lost', () => {
    const bodies = seedDay(8);
    compactAuditDay(dayPath());
    rmSync(join(dayPath(), AUDIT_BODIES_DIR, AUDIT_DICT_FILE));

    let lost = 0;
    for (let s = 0; s < bodies.length; s += 1) {
      for (const turn of readAuditSessionTurns(dir, key(s), TS)) {
        if (turn.requestBody === undefined) {
          lost += 1;
          continue;
        }
        // The one session that OWNS the dictionary body still anchors locally.
        // Whatever survives must be byte-exact; a wrong body is the real hazard.
        expect(bodies[s]).toContain(turn.requestBody);
      }
    }
    expect(lost).toBeGreaterThan(0);
  });

  it('leaves no temp file behind', () => {
    seedDay(8);
    compactAuditDay(dayPath());
    const files = readdirSync(join(dayPath(), AUDIT_BODIES_DIR));
    expect(files.some((f) => f.endsWith('.compacting'))).toBe(false);
  });
});

describe('compactAllClosedAuditDays', () => {
  it('skips the day still being written', () => {
    seedDay(8);
    // TS is 2026-08-20; pretending "now" is that same day makes it the open day.
    expect(compactAllClosedAuditDays(dir, () => TS)).toEqual({ days: 0, shards: 0, savedBytes: 0 });
    expect(existsSync(join(dayPath(), AUDIT_BODIES_DIR, AUDIT_DICT_FILE))).toBe(false);

    const run = compactAllClosedAuditDays(dir, () => NOW);
    expect(run.days).toBe(1);
    expect(run.shards).toBeGreaterThan(0);
  });
});

describe('AuditPruneSweeper.archive — compaction runs before gzip', () => {
  const cfg = {
    enabled: true, captureBodies: true, maxBodyBytes: -1,
    retentionDays: 30, compactStreamingBodies: false, trustForwardedFor: false,
  };

  it('compacts, then archives, and the result is still readable', async () => {
    const bodies = seedDay(8);
    const sweeper = new AuditPruneSweeper(dir, logger, cfg, 60_000, () => NOW);
    await sweeper.archive();

    const shardDir = join(dayPath(), AUDIT_BODIES_DIR);
    const files = readdirSync(shardDir);
    expect(files.every((f) => f.endsWith('.gz'))).toBe(true);
    expect(files).toContain(`${AUDIT_DICT_FILE}.gz`);

    // Reconstruction still works through a gzipped dictionary + gzipped shard.
    expect(readAuditSessionTurns(dir, key(3), TS).map((t) => t.requestBody)).toEqual(bodies[3]);
  });
});

describe('readAuditSessionTurns — lineage grouping', () => {
  it('groups a forked session into separate streams instead of interleaving', () => {
    const writer = new AuditWriter(dir, logger);
    const shared = `{"system":"${'S'.repeat(4000)}","messages":[{"role":"user","content":"${'m'.repeat(1200)}"}`;
    const branch = (tag: string, n: number): string =>
      shared + Array.from({ length: n }, (_, i) => `,{"role":"user","content":"${tag.repeat(1200)}#${i}"}`).join('') + ']}';

    const k = key(7);
    let t = 0;
    for (let i = 1; i <= 4; i += 1) {
      for (const tag of ['a', 'b']) {
        writer.appendNow({
          id: `${tag}${i}`, ts: TS + (t += 1), method: 'POST', path: '/v1/messages',
          status: 200, latencyMs: 1, sessionKey: k, requestBody: branch(tag, i),
        });
      }
    }

    const turns = readAuditSessionTurns(dir, k, TS);
    expect(turns).toHaveLength(8);
    // Grouped, not interleaved: one branch runs to completion before the other.
    const ids = turns.map((x) => x.id);
    expect(ids.slice(0, 4).every((id) => id.startsWith(ids[0]![0]!))).toBe(true);
    expect(new Set(turns.map((x) => x.stream)).size).toBe(2);
    // Chronological within each stream.
    for (const s of [0, 1]) {
      const inStream = turns.filter((x) => x.stream === s).map((x) => x.ts);
      expect([...inStream].sort((p, q) => p - q)).toEqual(inStream);
    }
  });
});
