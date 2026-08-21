import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { AuditRecord } from '@omnicross/contracts/audit-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AUDIT_META_FILE, auditDayDirName, auditFileName } from '../auditFiles';
import { readAuditRecords } from '../auditReader';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omni-audit-read-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(records: AuditRecord[]): void {
  // Group by date file (matching the writer's convention).
  const byFile = new Map<string, string[]>();
  for (const r of records) {
    const name = auditFileName(r.ts);
    const lines = byFile.get(name) ?? [];
    lines.push(JSON.stringify(r));
    byFile.set(name, lines);
  }
  for (const [name, lines] of byFile) {
    writeFileSync(join(dir, name), lines.join('\n') + '\n');
  }
}

const rec = (over: Partial<AuditRecord>): AuditRecord => ({
  id: over.id ?? 'r',
  ts: over.ts ?? Date.now(),
  method: 'POST',
  path: '/v1/messages',
  status: 200,
  latencyMs: 1,
  ...over,
});

describe('readAuditRecords', () => {
  it('returns [] for a missing dir', () => {
    expect(readAuditRecords(join(dir, 'nope'))).toEqual([]);
  });

  it('returns records newest-first', () => {
    const base = new Date(2026, 6, 7, 10, 0, 0).getTime();
    write([
      rec({ id: 'a', ts: base }),
      rec({ id: 'b', ts: base + 1000 }),
      rec({ id: 'c', ts: base + 2000 }),
    ]);
    const rows = readAuditRecords(dir);
    expect(rows.map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });

  it('filters by key id', () => {
    const base = new Date(2026, 6, 7, 10, 0, 0).getTime();
    write([
      rec({ id: 'a', ts: base, keyId: 'k1' }),
      rec({ id: 'b', ts: base + 1, keyId: 'k2' }),
      rec({ id: 'c', ts: base + 2, keyId: 'k1' }),
    ]);
    const rows = readAuditRecords(dir, { keyId: 'k1' });
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'c']);
  });

  it('filters by time window (inclusive)', () => {
    const base = new Date(2026, 6, 7, 10, 0, 0).getTime();
    write([
      rec({ id: 'a', ts: base }),
      rec({ id: 'b', ts: base + 1000 }),
      rec({ id: 'c', ts: base + 2000 }),
    ]);
    const rows = readAuditRecords(dir, { from: base + 500, to: base + 1500 });
    expect(rows.map((r) => r.id)).toEqual(['b']);
  });

  it('respects the limit', () => {
    const base = new Date(2026, 6, 7, 10, 0, 0).getTime();
    write(Array.from({ length: 10 }, (_, i) => rec({ id: `r${i}`, ts: base + i })));
    expect(readAuditRecords(dir, { limit: 3 })).toHaveLength(3);
  });

  it('skips torn/garbage lines defensively', () => {
    const base = new Date(2026, 6, 7, 10, 0, 0).getTime();
    const name = auditFileName(base);
    writeFileSync(
      join(dir, name),
      `${JSON.stringify(rec({ id: 'good', ts: base }))}\nnot json\n{"partial":true}\n`,
    );
    const rows = readAuditRecords(dir);
    expect(rows.map((r) => r.id)).toEqual(['good']);
  });
});

describe('readAuditRecords — day-directory layout (audit-store-sharding)', () => {
  const day = (ts: number): string => join(dir, auditDayDirName(ts), AUDIT_META_FILE);

  function writeDay(records: AuditRecord[]): void {
    const byDir = new Map<string, string[]>();
    for (const r of records) {
      const path = day(r.ts);
      const lines = byDir.get(path) ?? [];
      lines.push(JSON.stringify(r));
      byDir.set(path, lines);
    }
    for (const [path, lines] of byDir) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, lines.join('\n') + '\n');
    }
  }

  const at = (ts: number, over: Partial<AuditRecord> = {}): AuditRecord => ({
    id: `r${ts}`, ts, method: 'POST', path: '/v1/messages', status: 200, latencyMs: 1, ...over,
  });

  it('reads the new layout newest-first', () => {
    const base = new Date(2026, 7, 20, 9, 0, 0).getTime();
    writeDay([at(base), at(base + 1000), at(base + 2000)]);
    expect(readAuditRecords(dir).map((r) => r.ts)).toEqual([base + 2000, base + 1000, base]);
  });

  it('merges legacy flat files and day directories in one query', () => {
    const newer = new Date(2026, 7, 20, 9, 0, 0).getTime();
    const older = new Date(2026, 7, 18, 9, 0, 0).getTime();
    writeDay([at(newer, { id: 'sharded' })]);
    writeFileSync(join(dir, auditFileName(older)), JSON.stringify(at(older, { id: 'legacy' })) + '\n');
    expect(readAuditRecords(dir).map((r) => r.id)).toEqual(['sharded', 'legacy']);
  });

  it('strips an inline legacy body but reports that one exists', () => {
    const ts = new Date(2026, 7, 18, 9, 0, 0).getTime();
    writeFileSync(
      join(dir, auditFileName(ts)),
      JSON.stringify(at(ts, { id: 'legacy', requestBody: 'x'.repeat(5000) })) + '\n',
    );
    const [row] = readAuditRecords(dir);
    expect(row?.requestBody).toBeUndefined();
    expect(row?.hasBody).toBe(true);
  });

  it('filters by sessionKey', () => {
    const base = new Date(2026, 7, 20, 9, 0, 0).getTime();
    const mine = 'c'.repeat(32);
    writeDay([at(base, { sessionKey: mine }), at(base + 1, { sessionKey: 'd'.repeat(32) })]);
    expect(readAuditRecords(dir, { sessionKey: mine }).map((r) => r.ts)).toEqual([base]);
  });

  it('stops opening older days once the limit is satisfied', () => {
    const day1 = new Date(2026, 7, 20, 9, 0, 0).getTime();
    const day0 = new Date(2026, 7, 19, 9, 0, 0).getTime();
    writeDay([at(day1), at(day1 + 1), at(day1 + 2)]);
    writeDay([at(day0)]);
    const rows = readAuditRecords(dir, { limit: 2 });
    expect(rows).toHaveLength(2);
    // Both rows come from the newest day; the older day was never needed.
    expect(rows.every((r) => r.ts >= day1)).toBe(true);
  });

  it('survives a torn final line in the new layout', () => {
    const ts = new Date(2026, 7, 20, 9, 0, 0).getTime();
    const path = day(ts);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(at(ts, { id: 'good' })) + '\n{"id":"torn"');
    expect(readAuditRecords(dir).map((r) => r.id)).toEqual(['good']);
  });
});
