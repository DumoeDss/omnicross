import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { KeyViewingPassword } from '../secrets/KeyViewingPassword';
import { clearConfigCredentials } from '../secrets/clearConfigCredentials';
import type { DaemonConfig } from '../config';

const directories: string[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'omnicross-viewing-'));
  directories.push(directory);
  return new KeyViewingPassword(join(directory, 'config.json'));
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('viewing password', () => {
  it('sets a 4–8 character password on the first protected read and continues it', async () => {
    const service = fixture();
    const read = vi.fn(async () => 'fixture-secret');
    await expect(service.read(undefined, read)).rejects.toThrow('view-password-not-set');
    expect(read).not.toHaveBeenCalled();
    await expect(service.read('abc', read)).rejects.toThrow('view-password-length');
    await expect(service.read('123456789', read)).rejects.toThrow('view-password-length');
    expect(await service.read('view', read)).toBe('fixture-secret');
    expect(read).toHaveBeenCalledOnce();
    expect(await service.status()).toEqual({ enabled: true });
    await expect(service.read(undefined, read)).rejects.toThrow('view-password-required');
    expect(await service.read('view', read)).toBe('fixture-secret');
  });

  it('clears all portable server credentials without mutating the original config', () => {
    const original = { providers: [{ id: 'fixture', apiKey: 'fixture-main', apiKeys: [{ apiKey: 'fixture-pool' }],
      extraHeaders: { 'X-Custom-Token': 'fixture-header' }, codingPlan: { apiKey: 'fixture-plan' }, apiModes: [{ apiKey: 'fixture-mode' }] }],
      server: { port: 8765, proxy: { global: { host: 'localhost', password: 'fixture-proxy' }, byProvider: { byo: { password: 'fixture-provider-proxy' } } },
        webhook: { destinations: [{ id: 'notice', secret: 'fixture-webhook' }] }, billing: { secret: 'fixture-billing' },
        search: { providers: { tavily: { apiKey: 'fixture-search' } } } },
    } as unknown as DaemonConfig;
    const cleared = clearConfigCredentials(original);
    expect(JSON.stringify(cleared)).not.toMatch(/fixture-(main|pool|header|plan|mode|proxy|provider-proxy|webhook|billing|search)/);
    expect(cleared.server?.port).toBe(8765);
    expect(cleared.server?.webhook?.destinations[0].id).toBe('notice');
    expect(original.providers[0].apiKey).toBe('fixture-main');
  });
  it('persists only a salted verifier and verifies every read/change/disable', async () => {
    const service = fixture();
    expect(await service.status()).toEqual({ enabled: false });
    await expect(service.change(undefined, 'abc')).rejects.toThrow('view-password-length');
    await service.change(undefined, 'view');
    expect(readFileSync(service.path, 'utf8')).not.toContain('view');
    const reloaded = new KeyViewingPassword(service.path.replace('.key-viewing.json', ''));
    const read = vi.fn(async () => 'fixture-secret');
    await expect(reloaded.read(undefined, read)).rejects.toThrow('view-password-required');
    await expect(reloaded.read('wrong', read)).rejects.toThrow('view-password-invalid');
    expect(read).not.toHaveBeenCalled();
    expect(await reloaded.read('view', read)).toBe('fixture-secret');
    await expect(service.read(undefined, read)).rejects.toThrow('view-password-required');
    await expect(service.change('wrong', null)).rejects.toThrow('view-password-invalid');
    await service.change('view', 'repl');
    await expect(service.read('view', read)).rejects.toThrow('view-password-invalid');
    await service.change('repl', null);
    expect(await reloaded.status()).toEqual({ enabled: false });
  });

  it('persists cooldown across instances and fails closed on corrupt storage', async () => {
    const service = fixture();
    await service.change(undefined, 'view');
    for (let count = 0; count < 4; count++) await expect(service.read('bad', async () => true)).rejects.toThrow('view-password-invalid');
    await expect(service.read('bad', async () => true)).rejects.toThrow('view-password-locked');
    const second = new KeyViewingPassword(service.path.replace('.key-viewing.json', ''));
    await expect(second.read('view', async () => true)).rejects.toThrow('view-password-locked');
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    expect(await second.read('view', async () => true)).toBe(true);
    writeFileSync(service.path, '{broken', 'utf8');
    await expect(second.status()).rejects.toThrow('view-password-unavailable');
    await expect(second.change(undefined, null)).rejects.toThrow('view-password-unavailable');
    await expect(second.read(undefined, async () => true)).rejects.toThrow('view-password-unavailable');
    writeFileSync(service.path, JSON.stringify({ version: 1, salt: ['a'.repeat(32)], hash: 'b'.repeat(64), failures: 0, lockedUntil: 0 }), 'utf8');
    await expect(second.status()).rejects.toThrow('view-password-unavailable');
  });

  it('serializes verification and read against rotation and preserves the verifier if recovery fails', async () => {
    const service = fixture();
    await service.change(undefined, 'view');
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const read = service.read('view', async () => { entered(); await held; return true; });
    await started;
    let rotated = false;
    const rotation = service.change('view', 'repl').then(() => { rotated = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(rotated).toBe(false);
    release(); await read; await rotation;
    const before = readFileSync(service.path, 'utf8');
    await expect(service.reset('thrd', async () => { throw new Error('fixture failure'); })).rejects.toThrow('fixture failure');
    expect(readFileSync(service.path, 'utf8')).toBe(before);
    expect(await service.read('repl', async () => true)).toBe(true);
  });
});
