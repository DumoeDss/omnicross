import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
  maxBodyBytes: -1,
  retentionDays: 7,
  compactStreamingBodies: false,
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
    const oldStats = old1.replace(/\.jsonl$/, '.stats.json');
    writeFileSync(join(dir, oldStats), '{"requestCount":1}\n');

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
    expect(remaining).not.toContain(oldStats);
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

describe('AuditPruneSweeper — day directories and archiving (audit-store-sharding)', () => {
  const NOW = new Date(2026, 7, 20, 15, 0, 0).getTime();
  const dayAt = (offset: number): string => {
    const d = new Date(2026, 7, 20 + offset);
    const p = (n: number): string => String(n).padStart(2, '0');
    return `audit-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  /** Materialize a day directory with a metadata file and one body shard. */
  function seedDay(offset: number, sessionKey = 'a'.repeat(32)): string {
    const name = dayAt(offset);
    mkdirSync(join(dir, name, 'bodies'), { recursive: true });
    writeFileSync(join(dir, name, 'meta.jsonl'), '{"id":"x","ts":1,"method":"POST","path":"/","status":200}\n');
    writeFileSync(join(dir, name, 'bodies', `${sessionKey}.jsonl`), '{"id":"x","ts":1,"res":"body"}\n');
    return name;
  }

  it('removes an expired day directory whole, and keeps the ones inside retention', () => {
    const expired = seedDay(-10);
    const kept = seedDay(-1);
    const sweeper = new AuditPruneSweeper(dir, noopLogger, cfg({ retentionDays: 7 }), 60_000, () => NOW);

    return sweeper.sweep().then((removed) => {
      expect(removed).toBe(1);
      expect(existsSync(join(dir, expired))).toBe(false);
      expect(existsSync(join(dir, kept, 'meta.jsonl'))).toBe(true);
    });
  });

  it('gzips a closed day\u2019s shards but never today\u2019s, and never meta.jsonl', async () => {
    const yesterday = seedDay(-1);
    const today = seedDay(0);
    const sweeper = new AuditPruneSweeper(dir, noopLogger, cfg(), 60_000, () => NOW);

    const compressed = await sweeper.archive();
    expect(compressed).toBe(1);

    const shard = (day: string): string => join(dir, day, 'bodies', `${'a'.repeat(32)}.jsonl`);
    expect(existsSync(`${shard(yesterday)}.gz`)).toBe(true);
    expect(existsSync(shard(yesterday))).toBe(false);
    // Today stays plain text so it can still be tailed while debugging.
    expect(existsSync(shard(today))).toBe(true);
    // The query hot path is never compressed.
    expect(existsSync(join(dir, yesterday, 'meta.jsonl'))).toBe(true);
    expect(existsSync(join(dir, yesterday, 'meta.jsonl.gz'))).toBe(false);
  });

  it('is idempotent and finishes an interrupted archive', async () => {
    const yesterday = seedDay(-1);
    const sweeper = new AuditPruneSweeper(dir, noopLogger, cfg(), 60_000, () => NOW);
    await sweeper.archive();
    // A second pass has nothing left to do.
    expect(await sweeper.archive()).toBe(0);

    // Simulate a crash after the archive was written but before the source went.
    writeFileSync(join(dir, yesterday, 'bodies', `${'a'.repeat(32)}.jsonl`), 'partial\n');
    await sweeper.archive();
    expect(existsSync(join(dir, yesterday, 'bodies', `${'a'.repeat(32)}.jsonl`))).toBe(false);
  });

  it('does nothing at all when audit is disabled', async () => {
    const day = seedDay(-10);
    const sweeper = new AuditPruneSweeper(dir, noopLogger, cfg({ enabled: false }), 60_000, () => NOW);
    expect(await sweeper.sweep()).toBe(0);
    expect(await sweeper.archive()).toBe(0);
    expect(existsSync(join(dir, day))).toBe(true);
  });
});
