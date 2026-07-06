import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AuditRecord } from '@omnicross/contracts/audit-types';
import type { Logger } from '@omnicross/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditFileName } from '../auditFiles';
import { AuditWriter } from '../AuditWriter';

const noopLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const rec = (over: Partial<AuditRecord> = {}): AuditRecord => ({
  id: 'r1',
  ts: Date.now(),
  method: 'POST',
  path: '/v1/messages',
  status: 200,
  latencyMs: 3,
  ...over,
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omni-audit-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('AuditWriter', () => {
  it('record() is FIRE-AND-FORGET — returns before the append runs', () => {
    const deferred: Array<() => void> = [];
    const writer = new AuditWriter(dir, noopLogger, (fn) => deferred.push(fn));
    const r = rec();
    writer.record(r);
    // The append has NOT happened yet (it is deferred).
    const file = join(dir, auditFileName(r.ts));
    expect(existsSync(file)).toBe(false);
    expect(deferred).toHaveLength(1);
    // Draining the deferred queue performs the append.
    deferred[0]();
    expect(existsSync(file)).toBe(true);
  });

  it('appendNow writes one JSON line to the record date file', () => {
    const writer = new AuditWriter(dir, noopLogger);
    const ts = new Date(2026, 6, 7, 12, 0, 0).getTime(); // local 2026-07-07
    writer.appendNow(rec({ id: 'a', ts }));
    writer.appendNow(rec({ id: 'b', ts }));
    const file = join(dir, 'audit-2026-07-07.jsonl');
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).id).toBe('a');
    expect(JSON.parse(lines[1]).id).toBe('b');
  });

  it('a deferred append failure is swallowed (never throws to the caller)', () => {
    // `blocker` is a FILE, so mkdir of `blocker/sub` fails — the append throws,
    // and the writer must swallow it (run the defer synchronously to observe).
    writeFileSync(join(dir, 'blocker'), 'x');
    const badWriter = new AuditWriter(join(dir, 'blocker', 'sub'), noopLogger, (fn) => fn());
    expect(() => badWriter.record(rec())).not.toThrow();
    expect(noopLogger.warn).toHaveBeenCalled();
  });
});
