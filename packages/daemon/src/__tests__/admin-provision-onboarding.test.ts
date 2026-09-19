/**
 * admin-provision-onboarding.test.ts — the zero-config provisioning that runs
 * when a provider is created (`POST /admin/api/providers`):
 *
 *  - every new provider gets a `* -> <default model>` mapping row (curated
 *    target for aggregators like opencodego, else the FIRST advertised model —
 *    preset lists are curated newest-first) unless a table already exists;
 *  - the FIRST provider, when no live access key exists, also creates the
 *    `omnicross` onboarding key bound to every current upstream, so the
 *    onboarding "enable access" step and CLI installs have a key to use.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildDaemon, type Daemon, resetDaemonSingletonsForTests } from '../bootstrap';
import { loadConfig } from '../config';

let tmpDir: string;
let daemon: Daemon;
let adminBase: string;

async function adminFetch(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${adminBase}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

function createProviderBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'zhipu',
    apiFormat: 'openai',
    baseUrl: 'http://127.0.0.1:1/v1/chat/completions',
    apiKey: 'sk-test',
    models: ['glm-5.3', 'glm-4.7'],
    ...over,
  };
}

beforeEach(async () => {
  resetDaemonSingletonsForTests();
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-provision-'));
  const configPath = join(tmpDir, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    providers: [],
    server: { enabled: false, networkBinding: false, port: 0, endpoints: [] },
    admin: { port: 0 },
  }), 'utf8');
  daemon = buildDaemon(loadConfig(configPath), {
    configPath,
    keysPath: join(tmpDir, 'keys.json'),
    tokensPath: join(tmpDir, 'tokens.json'),
    masterKeyFilePath: join(tmpDir, 'master.key'),
  });
  await daemon.llmConfig.ready();
  await daemon.outboundApiServer.applyConfig({ enabled: false, networkBinding: false, endpoints: [], bindings: [], port: 0 });
  await daemon.adminServer.start();
  adminBase = daemon.adminServer.getStatus().url as string;
});

afterEach(async () => {
  resetDaemonSingletonsForTests();
  await daemon.adminServer.stop();
  await daemon.outboundApiServer.stop();
  daemon.apiKeyPool.dispose();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('provider-create provisioning (zero-config onboarding)', () => {
  it('the first provider gets a * mapping to its first model AND an onboarding key bound to everything', async () => {
    const created = await adminFetch('POST', '/admin/api/providers', createProviderBody());
    expect(created.status).toBe(201);

    const catalog = await adminFetch('GET', '/admin/api/upstreams');
    const entry = catalog.json.upstreams.find((u: any) => u.key === 'zhipu');
    expect(entry.mappings).toEqual([{ source: '*', target: 'glm-5.3' }]);

    const keys = await adminFetch('GET', '/admin/api/keys');
    expect(keys.json.keys).toHaveLength(1);
    const key = keys.json.keys[0];
    expect(key.name).toBe('omnicross');
    expect(key.revoked).toBe(false);
    // Bound to EVERY current upstream — the new provider included.
    expect(key.upstreamBinding).toEqual({
      mode: 'explicit',
      targets: [{ kind: 'provider', providerId: 'zhipu' }],
    });
  });

  it('later providers get their own mapping but never a second key', async () => {
    await adminFetch('POST', '/admin/api/providers', createProviderBody());
    const second = await adminFetch('POST', '/admin/api/providers', createProviderBody({
      id: 'deepseek', models: ['deepseek-flash', 'deepseek-v4-pro'],
    }));
    expect(second.status).toBe(201);

    const catalog = await adminFetch('GET', '/admin/api/upstreams');
    expect(catalog.json.upstreams.find((u: any) => u.key === 'deepseek').mappings)
      .toEqual([{ source: '*', target: 'deepseek-flash' }]);

    const keys = await adminFetch('GET', '/admin/api/keys');
    expect(keys.json.keys).toHaveLength(1);
  });

  it('aggregators use the curated default instead of their advertised list', async () => {
    const created = await adminFetch('POST', '/admin/api/providers', createProviderBody({
      id: 'opencodego', models: ['whatever-aggregate-id'],
    }));
    expect(created.status).toBe(201);
    const catalog = await adminFetch('GET', '/admin/api/upstreams');
    expect(catalog.json.upstreams.find((u: any) => u.key === 'opencodego').mappings)
      .toEqual([{ source: '*', target: 'deepseek-flash' }]);
  });

  it('a provider advertising no models gets no mapping row, and a surviving table (delete + recreate) is never overwritten', async () => {
    // Tables outlive their provider row — recreate-with-same-id is the real
    // path where a table already exists at create time.
    const first = await adminFetch('POST', '/admin/api/providers', createProviderBody({ id: 'tabled' }));
    expect(first.status).toBe(201);
    const overwritten = await adminFetch('PUT', '/admin/api/upstreams/tabled/mappings', {
      mappings: [{ source: 'claude-*', target: 'kept' }, { source: '*', target: 'kept-any' }],
    });
    expect(overwritten.status).toBe(200);
    expect((await adminFetch('DELETE', '/admin/api/providers/tabled')).status).toBe(200);

    const noModels = await adminFetch('POST', '/admin/api/providers', createProviderBody({ id: 'bare', models: [] }));
    expect(noModels.status).toBe(201);
    const recreated = await adminFetch('POST', '/admin/api/providers', createProviderBody({ id: 'tabled' }));
    expect(recreated.status).toBe(201);

    const catalog = await adminFetch('GET', '/admin/api/upstreams');
    // bare: nothing advertised and nothing curated → no table written.
    expect(catalog.json.upstreams.find((u: any) => u.key === 'bare').mappings).toEqual([]);
    // tabled: the table that SURVIVED the delete is kept, not reset to the default.
    expect(catalog.json.upstreams.find((u: any) => u.key === 'tabled').mappings)
      .toEqual([{ source: 'claude-*', target: 'kept' }, { source: '*', target: 'kept-any' }]);
  });

  it('no onboarding key when an access key already exists', async () => {
    const made = await adminFetch('POST', '/admin/api/keys', { name: 'mine' });
    expect(made.status).toBe(201);
    const created = await adminFetch('POST', '/admin/api/providers', createProviderBody());
    expect(created.status).toBe(201);

    const keys = await adminFetch('GET', '/admin/api/keys');
    const names = keys.json.keys.map((k: any) => k.name);
    expect(names).toEqual(['mine']);
  });
});
