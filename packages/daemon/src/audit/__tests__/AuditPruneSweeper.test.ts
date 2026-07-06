import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AuditConfig } from '@omnicross/contracts/audit-types';
import type { Logger } from '@omnicross/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditPruneSweeper } from '../AuditPruneSweeper';

const noopLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const cfg = (over: Partial<AuditConfig> = {}): AuditConfig => ({
  enabled: true,
  captureBodies: false,
  maxBodyBytes: 8192,
  retentionDays: 7,
  trustForwardedFor: false,
  ...over,
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omni-audit-prune-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a date file `audit-YYYY-MM-DD.jsonl` for a day offset from a base. */
function writeDateFile(base: Date, dayOffset: number): string {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const name = `audit-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.jsonl`;
  writeFileSync(join(dir, name), '{"id":"x","ts":1,"method":"GET","path":"/","status":200}\n');
  return name;
}

describe('AuditPruneSweeper', () => {
  it('unlinks date files older than retentionDays, keeps recent ones', async () => {
    const now = new Date(2026, 6, 10, 12, 0, 0); // 2026-07-10 local
    const today = writeDateFile(now, 0); // 07-10  keep
    const yesterday = writeDateFile(now, -1); // 07-09 keep (retention 3 ⇒ 08,09,10)
    const old1 = writeDateFile(now, -5); // 07-05 prune
    const old2 = writeDateFile(now, -30); // 06-10 prune

    const sweeper = new AuditPruneSweeper(dir, noopLogger, cfg({ retentionDays: 3 }), 3600_000, () =>
      now.getTime(),
    );
    const removed = await sweeper.sweep();
    expect(removed).toBe(2);
    const remaining = readdirSync(dir);
    expect(remaining).toContain(today);
    expect(remaining).toContain(yesterday);
    expect(remaining).not.toContain(old1);
    expect(remaining).not.toContain(old2);
  });

  it('retentionDays:1 keeps only today', async () => {
    const now = new Date(2026, 6, 10, 6, 0, 0);
    const today = writeDateFile(now, 0);
    const yesterday = writeDateFile(now, -1);
    const sweeper = new AuditPruneSweeper(dir, noopLogger, cfg({ retentionDays: 1 }), 3600_000, () =>
      now.getTime(),
    );
    await sweeper.sweep();
    const remaining = readdirSync(dir);
    expect(remaining).toContain(today);
    expect(remaining).not.toContain(yesterday);
  });

  it('is a no-op when disabled (zero regression) — deletes nothing', async () => {
    const now = new Date(2026, 6, 10, 6, 0, 0);
    const old = writeDateFile(now, -100);
    const sweeper = new AuditPruneSweeper(dir, noopLogger, cfg({ enabled: false }), 3600_000, () =>
      now.getTime(),
    );
    const removed = await sweeper.sweep();
    expect(removed).toBe(0);
    expect(existsSync(join(dir, old))).toBe(true);
  });

  it('ignores non-audit files', async () => {
    writeFileSync(join(dir, 'usage-events.jsonl'), 'x\n');
    writeFileSync(join(dir, 'readme.txt'), 'x\n');
    const now = new Date(2026, 6, 10, 6, 0, 0);
    const sweeper = new AuditPruneSweeper(dir, noopLogger, cfg({ retentionDays: 1 }), 3600_000, () =>
      now.getTime(),
    );
    await sweeper.sweep();
    expect(existsSync(join(dir, 'usage-events.jsonl'))).toBe(true);
    expect(existsSync(join(dir, 'readme.txt'))).toBe(true);
  });

  it('start() runs one prune immediately (boot cleanup) and arms an unref timer', () => {
    const now = new Date(2026, 6, 10, 6, 0, 0);
    const old = writeDateFile(now, -100);
    const sweeper = new AuditPruneSweeper(dir, noopLogger, cfg({ retentionDays: 1 }), 3600_000, () =>
      now.getTime(),
    );
    sweeper.start();
    // The boot prune is async (microtask); allow it to settle.
    return Promise.resolve().then(() => {
      expect(existsSync(join(dir, old))).toBe(false);
      sweeper.dispose();
    });
  });
});
