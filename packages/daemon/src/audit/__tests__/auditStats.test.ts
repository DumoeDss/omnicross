import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AuditRecord } from '@omnicross/contracts/audit-types';
import type { Logger } from '@omnicross/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AUDIT_META_FILE, auditDayDirName, auditFileName } from '../auditFiles';
import { auditStatsFileName, readAuditStats } from '../auditStats';
import { AuditWriter } from '../AuditWriter';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const rec = (over: Partial<AuditRecord>): AuditRecord => ({
  id: over.id ?? 'r',
  ts: over.ts ?? Date.now(),
  method: 'POST',
  path: '/v1/messages',
  status: 200,
  latencyMs: 1,
  ...over,
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omni-audit-stats-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readAuditStats', () => {
  it('uses the writer sidecar for exact request and error counts', async () => {
    const writer = new AuditWriter(dir, logger);
    const ts = new Date(2026, 7, 10, 10, 0, 0).getTime();
    writer.appendNow(rec({ id: 'ok', ts }));
    writer.appendNow(rec({ id: 'http-error', ts: ts + 1, status: 502 }));
    writer.appendNow(rec({ id: 'relay-error', ts: ts + 2, error: 'failed' }));

    const stats = await readAuditStats(dir, { from: ts, to: ts + 2 });
    expect(stats).toEqual({ requestCount: 3, errorCount: 2, complete: true });
    expect(
      existsSync(join(dir, auditDayDirName(ts), auditStatsFileName(AUDIT_META_FILE))),
    ).toBe(true);
  });

  it('backfills a compact sidecar from legacy files without materializing bodies', async () => {
    const ts = new Date(2026, 7, 10, 10, 0, 0).getTime();
    const file = auditFileName(ts);
    const records = [
      rec({ id: 'ok', ts, responseBody: 'x'.repeat(128 * 1024) }),
      rec({ id: 'bad', ts: ts + 1, status: 500, responseBody: 'y'.repeat(128 * 1024) }),
    ];
    writeFileSync(join(dir, file), records.map((row) => JSON.stringify(row)).join('\n') + '\n');

    expect(existsSync(join(dir, auditStatsFileName(file)))).toBe(false);
    await expect(readAuditStats(dir, { from: ts, to: ts + 1 })).resolves.toEqual({
      requestCount: 2,
      errorCount: 1,
      complete: true,
    });
    expect(existsSync(join(dir, auditStatsFileName(file)))).toBe(true);
  });

  it('filters a partial time window and marks torn rows incomplete', async () => {
    const ts = new Date(2026, 7, 10, 10, 0, 0).getTime();
    const file = auditFileName(ts);
    writeFileSync(
      join(dir, file),
      `${JSON.stringify(rec({ id: 'a', ts }))}\n${JSON.stringify(rec({ id: 'b', ts: ts + 10, status: 400 }))}\n{"id":"torn"`,
    );
    await expect(readAuditStats(dir, { from: ts + 5, to: ts + 20 })).resolves.toEqual({
      requestCount: 1,
      errorCount: 1,
      complete: false,
    });
  });

  it('increments a stale legacy sidecar from its last indexed byte', async () => {
    const ts = new Date(2026, 7, 10, 10, 0, 0).getTime();
    const file = auditFileName(ts);
    const auditPath = join(dir, file);
    writeFileSync(auditPath, `${JSON.stringify(rec({ id: 'first', ts }))}\n`);
    await readAuditStats(dir, { from: ts, to: ts + 10 });

    writeFileSync(
      auditPath,
      `${JSON.stringify(rec({ id: 'second', ts: ts + 1, status: 503 }))}\n`,
      { flag: 'a' },
    );

    await expect(readAuditStats(dir, { from: ts, to: ts + 10 })).resolves.toEqual({
      requestCount: 2,
      errorCount: 1,
      complete: true,
    });
    const sidecar = JSON.parse(
      readFileSync(join(dir, auditStatsFileName(file)), 'utf8'),
    ) as { auditBytes: number; requestCount: number };
    expect(sidecar.auditBytes).toBe(statSync(auditPath).size);
    expect(sidecar.requestCount).toBe(2);
  });
});
