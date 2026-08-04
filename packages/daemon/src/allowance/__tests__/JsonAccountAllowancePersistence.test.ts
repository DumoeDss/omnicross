import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AccountAllowanceStore } from '@omnicross/core/pipeline/AccountAllowanceStore';
import { afterEach, describe, expect, it } from 'vitest';

import {
  JsonAccountAllowancePersistence,
  MAX_PERSISTED_ALLOWANCE_SNAPSHOTS,
} from '../JsonAccountAllowancePersistence';

const NOW = Date.parse('2026-08-03T00:00:00.000Z');
const dirs: string[] = [];

function cachePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omni-allowance-cache-'));
  dirs.push(dir);
  return join(dir, 'nested', 'allowance-cache.json');
}

function snapshot(accountId: string, expiresAt = new Date(NOW + 300_000).toISOString()) {
  return {
    providerId: 'codex' as const,
    accountId,
    source: 'response-headers' as const,
    observedAt: new Date(NOW).toISOString(),
    expiresAt,
    windows: [{
      id: 'primary',
      label: 'Primary',
      scope: 'all' as const,
      usedPercent: 42,
      windowMinutes: 300,
      resetsAt: new Date(NOW + 600_000).toISOString(),
      state: 'fresh' as const,
    }],
  };
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('JsonAccountAllowancePersistence', () => {
  it('survives a store restart and projects an expired snapshot as stale', () => {
    const path = cachePath();
    const first = new AccountAllowanceStore(
      () => NOW,
      undefined,
      new JsonAccountAllowancePersistence(path),
    );
    first.set(snapshot('account-a'));

    const restarted = new AccountAllowanceStore(
      () => NOW + 300_001,
      undefined,
      new JsonAccountAllowancePersistence(path),
    );
    expect(restarted.get('codex', 'account-a')).toMatchObject({
      accountId: 'account-a',
      windows: [{ usedPercent: 42, state: 'stale' }],
    });
    expect(readFileSync(path, 'utf8')).not.toContain('authorization');
    expect(readFileSync(path, 'utf8')).not.toContain('token');
  });

  it('recovers from missing, empty, and corrupt cache files without throwing', () => {
    const path = cachePath();
    const persistence = new JsonAccountAllowancePersistence(path);
    expect(new AccountAllowanceStore(Date.now, undefined, persistence).list()).toEqual([]);

    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '', 'utf8');
    expect(new AccountAllowanceStore(Date.now, undefined, persistence).list()).toEqual([]);

    writeFileSync(path, '{not-json', 'utf8');
    expect(new AccountAllowanceStore(Date.now, undefined, persistence).list()).toEqual([]);
  });

  it('removes deleted-account rows and keeps the persisted cache bounded', () => {
    const path = cachePath();
    const store = new AccountAllowanceStore(
      () => NOW,
      undefined,
      new JsonAccountAllowancePersistence(path),
    );
    store.set(snapshot('keep'));
    store.set(snapshot('delete'));
    expect(store.pruneToKnownAccounts([{ providerId: 'codex', accountId: 'keep' }])).toBe(1);

    const restarted = new AccountAllowanceStore(
      () => NOW,
      undefined,
      new JsonAccountAllowancePersistence(path),
    );
    expect(restarted.list().map((row) => row.accountId)).toEqual(['keep']);

    const boundedRows = Array.from(
      { length: MAX_PERSISTED_ALLOWANCE_SNAPSHOTS + 20 },
      (_, i) => snapshot(`bounded-${i}`),
    );
    new JsonAccountAllowancePersistence(path).save(boundedRows);
    const bounded = new AccountAllowanceStore(
      () => NOW,
      undefined,
      new JsonAccountAllowancePersistence(path),
    );
    expect(bounded.list()).toHaveLength(MAX_PERSISTED_ALLOWANCE_SNAPSHOTS);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { snapshots: unknown[] };
    expect(parsed.snapshots).toHaveLength(MAX_PERSISTED_ALLOWANCE_SNAPSHOTS);
  });

  it('strips unknown raw fields before durable writing', () => {
    const path = cachePath();
    const store = new AccountAllowanceStore(
      () => NOW,
      undefined,
      new JsonAccountAllowancePersistence(path),
    );
    store.set({
      ...snapshot('safe'),
      authorization: 'Bearer should-never-persist',
      rawHeaders: { 'x-codex-primary-used-percent': '42' },
    } as never);
    const text = readFileSync(path, 'utf8');
    expect(text).not.toContain('should-never-persist');
    expect(text).not.toContain('rawHeaders');
    expect(text).toContain('accountId');
  });
});
