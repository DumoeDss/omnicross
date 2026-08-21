import { gzipSync } from 'node:zlib';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AuditRecord } from '@omnicross/contracts/audit-types';
import type { Logger } from '@omnicross/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditWriter } from '../AuditWriter';
import { listAuditSessions, readAuditBody, readAuditSessionTurns } from '../auditBodyReader';
import { AUDIT_BODIES_DIR, auditDayDirName, auditFileName } from '../auditFiles';

const logger: Logger = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
} as unknown as Logger;

const SESSION = 'a'.repeat(32);
const TS = new Date(2026, 7, 20, 9, 0, 0).getTime();

const rec = (over: Partial<AuditRecord> = {}): AuditRecord => ({
  id: 'r1',
  ts: TS,
  method: 'POST',
  path: '/v1/messages',
  status: 200,
  latencyMs: 3,
  sessionKey: SESSION,
  ...over,
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omni-audit-body-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a three-turn conversation whose bodies grow the way a real one does. */
function writeConversation(): string[] {
  const writer = new AuditWriter(dir, logger);
  const bodies = [
    '{"sys":"' + 'S'.repeat(2000) + '","messages":[{"a":1}]}',
    '{"sys":"' + 'S'.repeat(2000) + '","messages":[{"a":1},{"b":2}]}',
    '{"sys":"' + 'S'.repeat(2000) + '","messages":[{"a":1},{"b":2},{"c":3}]}',
  ];
  bodies.forEach((body, i) => {
    writer.appendNow(rec({ id: `t${i}`, ts: TS + i, requestBody: body, responseBody: `res${i}` }));
  });
  return bodies;
}

describe('readAuditBody', () => {
  it('replays a delta chain back to the exact original body', () => {
    const bodies = writeConversation();
    bodies.forEach((body, i) => {
      expect(readAuditBody(dir, { id: `t${i}`, sessionKey: SESSION, ts: TS })).toEqual({
        requestBody: body,
        responseBody: `res${i}`,
      });
    });
  });

  it('reads an archived shard transparently after gzip', () => {
    const bodies = writeConversation();
    const shard = join(dir, auditDayDirName(TS), AUDIT_BODIES_DIR, `${SESSION}.jsonl`);
    const raw = readFileSync(shard, 'utf8');
    writeFileSync(`${shard}.gz`, gzipSync(raw));
    rmSync(shard);

    expect(readAuditBody(dir, { id: 't2', sessionKey: SESSION, ts: TS }).requestBody).toBe(bodies[2]);
  });

  it('finds the record without a ts hint by scanning day directories', () => {
    const bodies = writeConversation();
    expect(readAuditBody(dir, { id: 't1', sessionKey: SESSION }).requestBody).toBe(bodies[1]);
  });

  it('returns nothing for an unknown record, session, or unsafe key', () => {
    writeConversation();
    expect(readAuditBody(dir, { id: 'nope', sessionKey: SESSION, ts: TS })).toEqual({});
    expect(readAuditBody(dir, { id: 't0', sessionKey: 'b'.repeat(32), ts: TS })).toEqual({});
    expect(readAuditBody(dir, { id: 't0', sessionKey: '../../etc/passwd', ts: TS })).toEqual({});
  });

  it('refuses to guess when the chain is broken rather than returning partial text', () => {
    const day = join(dir, auditDayDirName(TS), AUDIT_BODIES_DIR);
    mkdirSync(day, { recursive: true });
    // A delta whose base line is absent (its anchor day was pruned).
    writeFileSync(
      join(day, `${SESSION}.jsonl`),
      JSON.stringify({ id: 'orphan', ts: TS, req: { base: 'gone', pre: 3, suf: 0, ins: 'x' } }) + '\n',
    );
    expect(readAuditBody(dir, { id: 'orphan', sessionKey: SESSION, ts: TS }).requestBody).toBeUndefined();
  });

  it('falls back to a legacy flat file that still inlines its bodies', () => {
    writeFileSync(
      join(dir, auditFileName(TS)),
      JSON.stringify(rec({ id: 'old', requestBody: 'legacy-req', responseBody: 'legacy-res' })) + '\n',
    );
    expect(readAuditBody(dir, { id: 'old', sessionKey: SESSION, ts: TS })).toEqual({
      requestBody: 'legacy-req',
      responseBody: 'legacy-res',
    });
  });
});

describe('readAuditSessionTurns / listAuditSessions', () => {
  it('returns every turn oldest-first, fully reconstructed', () => {
    const bodies = writeConversation();
    const turns = readAuditSessionTurns(dir, SESSION, TS);
    expect(turns.map((t) => t.id)).toEqual(['t0', 't1', 't2']);
    expect(turns.map((t) => t.requestBody)).toEqual(bodies);
  });

  it('summarises the shards on disk', () => {
    writeConversation();
    const sessions = listAuditSessions(dir, TS);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ sessionKey: SESSION, turns: 3, compressed: false });
    expect(sessions[0]!.bytes).toBeGreaterThan(0);
  });
});

describe('discontinuity inside one session (same key, changed prefix)', () => {
  /** A body with a swappable system prompt and a growing message list. */
  const mk = (sys: string, turns: number): string =>
    `{"system":"${sys}","messages":[${Array.from({ length: turns }, (_, i) => `{"role":"user","content":"${'m'.repeat(1500)}#${i}"}`).join(',')}],"stream":true}`;

  function writeAll(bodies: string[]): AuditWriter {
    const writer = new AuditWriter(dir, logger);
    bodies.forEach((body, i) => writer.appendNow(rec({ id: `t${i}`, ts: TS + i, requestBody: body })));
    return writer;
  }

  it('appends rather than overwriting, and every turn still replays exactly', () => {
    const bodies = [mk('A'.repeat(9000), 1), mk('A'.repeat(9000), 2), mk('B'.repeat(9000), 3), mk('B'.repeat(9000), 4)];
    writeAll(bodies);
    const shard = join(dir, auditDayDirName(TS), AUDIT_BODIES_DIR, `${SESSION}.jsonl`);
    // One line per turn: nothing was replaced when the prefix changed.
    expect(readFileSync(shard, 'utf8').trim().split('\n')).toHaveLength(4);
    expect(readAuditSessionTurns(dir, SESSION, TS).map((t) => t.requestBody)).toEqual(bodies);
  });

  it('marks the turn where the prefix diverged, and only that turn', () => {
    writeAll([mk('A'.repeat(9000), 1), mk('A'.repeat(9000), 2), mk('B'.repeat(9000), 3)]);
    const turns = readAuditSessionTurns(dir, SESSION, TS);
    // Turn 0 is the session's own opening anchor, not a divergence.
    expect(turns.map((t) => t.diverged ?? false)).toEqual([false, false, true]);
  });

  it('does not mark an auto-compaction as a divergence', () => {
    const sys = 'S'.repeat(9000);
    writeAll([mk(sys, 1), mk(sys, 8), `{"system":"${sys}","messages":[{"role":"user","content":"SUMMARY"}],"stream":true}`]);
    expect(readAuditSessionTurns(dir, SESSION, TS).every((t) => !t.diverged)).toBe(true);
  });
});
