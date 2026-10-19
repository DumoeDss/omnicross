import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDaemon, type Daemon, resetDaemonSingletonsForTests } from '../bootstrap';
import { loadConfig } from '../config';
import { openPack } from '../migration/packCodec';

let directory: string;
let daemon: Daemon;
let base: string;
async function request(method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}/admin/api${path}`, {
    method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, any>, cache: response.headers.get('cache-control') };
}
beforeEach(async () => {
  resetDaemonSingletonsForTests();
  directory = mkdtempSync(join(tmpdir(), 'omnicross-admin-viewing-'));
  const configPath = join(directory, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    providers: [{ id: 'fixture', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture-main-secret',
      apiKeys: [{ id: 'pool', apiKey: 'fixture-pool-secret' }], codingPlan: { enabled: true, baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture-plan-secret' },
      apiModes: [{ id: 'mode', label: 'Mode', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture-mode-secret' }] }],
    server: { enabled: false, port: 0, endpoints: [] }, admin: { port: 0 },
  }), 'utf8');
  daemon = buildDaemon(loadConfig(configPath), {
    configPath, keysPath: join(directory, 'keys.json'), tokensPath: join(directory, 'tokens.json'), masterKeyFilePath: join(directory, 'master.key'),
  });
  await daemon.llmConfig.ready();
  await daemon.adminServer.start();
  base = daemon.adminServer.getStatus().url!;
});
afterEach(async () => {
  await daemon?.adminServer.stop();
  await daemon?.outboundApiServer.stop();
  daemon?.apiKeyPool.dispose();
  resetDaemonSingletonsForTests();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe('protected admin reads', () => {
  it('gates legacy/new provider reads, client reads and exports without changing ordinary writes', async () => {
    expect((await request('GET', '/providers/fixture/reveal-key')).status).toBe(200);
    const created = await request('POST', '/keys', { name: 'Fixture' });
    const keyId = created.body.id;
    expect((await request('PUT', '/key-viewing-password', { newPassword: 'viewing-password' })).status).toBe(200);
    for (const path of ['/providers/fixture/reveal-key', `/keys/${keyId}/reveal`]) {
      expect((await request('GET', path)).status).toBe(403);
      expect((await request('POST', path)).status).toBe(403);
      const revealed = await request('POST', path, { viewingPassword: 'viewing-password' });
      expect(revealed.status).toBe(200);
      expect(revealed.cache).toBe('no-store');
      expect((await request('POST', path)).status).toBe(403);
    }
    expect((await request('POST', '/export', { passphrase: 'migration-passphrase' })).status).toBe(403);
    const pack = await request('POST', '/export', { passphrase: 'migration-passphrase', viewingPassword: 'viewing-password' });
    expect(pack.status).toBe(200);
    expect(await openPack(pack.body.pack, 'migration-passphrase')).toContain('fixture-main-secret');
    const updated = await request('PUT', '/providers/fixture', { apiKey: 'fixture-replacement-secret', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:1/v1' });
    expect(updated.status).toBe(200);
    expect(JSON.stringify(updated.body)).not.toContain('fixture-replacement-secret');
    expect(JSON.stringify((await request('GET', '/providers')).body)).not.toContain('fixture-main-secret');
    expect(readFileSync(join(directory, 'config.json.key-viewing.json'), 'utf8')).not.toContain('viewing-password');
  });

  it('requires the current password for disable/rotation and clears old credentials before recovery', async () => {
    await request('PUT', '/key-viewing-password', { newPassword: 'viewing-password' });
    expect((await request('PUT', '/key-viewing-password', { newPassword: null })).status).toBe(403);
    expect((await request('PUT', '/key-viewing-password', { currentPassword: 'viewing-password', newPassword: 'replacement-password' })).status).toBe(200);
    expect((await request('POST', '/providers/fixture/reveal-key', { viewingPassword: 'viewing-password' })).status).toBe(403);
    const client = await request('POST', '/keys', { name: 'Recovery fixture' });
    expect((await request('PUT', '/accounts/opencodego', { authMethod: 'manual', status: 'configured', apiKey: 'fixture-subscription-secret' })).status).toBe(200);
    const before = loadConfig(join(directory, 'config.json'));
    expect(before.providers[0].apiModes?.[0].apiKey).toBe('fixture-mode-secret');
    expect(before.providers[0].codingPlan?.apiKey).toBe('fixture-plan-secret');
    expect((await request('POST', '/key-viewing-password/reset', { newPassword: 'recovered-password' })).status).toBe(400);
    expect((await request('POST', '/key-viewing-password/reset', { newPassword: 'recovered-password', confirmClearCredentials: true })).status).toBe(200);
    const config = loadConfig(join(directory, 'config.json'));
    expect(config.providers[0].apiKey).toBe('');
    expect(config.providers[0].apiKeys ?? []).toEqual([]);
    expect(config.providers[0].codingPlan?.apiKey).toBeFalsy();
    expect(config.providers[0].apiModes?.[0].apiKey).toBeFalsy();
    expect((await daemon.llmConfig.getProvider('fixture'))?.api_key).toBe('');
    expect((await request('POST', `/keys/${client.body.id}/reveal`, { viewingPassword: 'recovered-password' })).status).toBe(409);
    const pack = await request('POST', '/export', { passphrase: 'migration-passphrase', viewingPassword: 'recovered-password' });
    const plaintext = await openPack(pack.body.pack, 'migration-passphrase');
    expect(plaintext).not.toContain('fixture-main-secret');
    expect(plaintext).not.toContain('fixture-pool-secret');
    expect(plaintext).not.toContain('fixture-subscription-secret');
    expect(plaintext).not.toContain('fixture-mode-secret');
    expect(plaintext).not.toContain('fixture-plan-secret');
    expect((await request('PUT', '/key-viewing-password', { currentPassword: 'recovered-password', newPassword: null })).status).toBe(200);
  });
});
