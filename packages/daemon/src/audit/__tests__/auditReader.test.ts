import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AuditRecord } from '@omnicross/contracts/audit-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auditFileName } from '../auditFiles';
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
