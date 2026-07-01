/**
 * admin-pool-health.test.ts — `GET /admin/api/providers/:id/keys` read-only pool
 * health (key-pool design D7) + the hot-reload×keyCache invalidation (D4) +
 * the secret-scan net extended to pool keys (spec "池健康视图无机密泄漏").
 *
 * Boots the full daemon in process (mirrors `admin-presets.test.ts`) with a
 * multi-key provider whose keys carry SENTINEL secrets (a literal + a `$ENV`
 * ref). Asserts: the health view masks every key (no literal, no `$VAR` name),
 * an apiKeys PUT hot-reloads + the next health view reflects it, and a broad
 * GET sweep never leaks the seeded pool secrets.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadServerConfig } from '@omnicross/core/outbound-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildDaemon, type Daemon, resetDaemonSingletonsForTests } from '../bootstrap';
import { loadConfig } from '../config';

const CANNED = {
  id: 'chatcmpl-pool-mock',
  object: 'chat.completion',
  created: 1,
  model: 'mock-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

// Pool-key sentinels (the secret-scan net asserts none of these leak).
const POOL_KEY_1 = 'sk-poolkey-SENTINEL-aaaa1111';
const POOL_ENV_VAR = 'OMNI_POOL_SENTINEL_VAR';

interface MockUpstream {
  server: Server;
  port: number;
  lastAuthHeader: string | undefined;
}

function startMockUpstream(): Promise<MockUpstream> {
  const state: MockUpstream = { server: undefined as unknown as Server, port: 0, lastAuthHeader: undefined };
  const server = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      state.lastAuthHeader = req.headers['authorization'];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(CANNED));
    });
  });
  state.server = server;
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      state.port = (server.address() as AddressInfo).port;
      resolve(state);
    });
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

let adminBase: string;

async function adminFetch(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string; json: unknown }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${adminBase}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

let tmpDir: string;
let upstream: MockUpstream;
let daemon: Daemon;
let configPath: string;

function writeConfig(path: string, providerBase: string): void {
  const cfg = {
    providers: [
      {
        id: 'mock',
        apiFormat: 'openai',
        baseUrl: providerBase,
        // No single apiKey — the pool's first enabled key becomes the preferred
        // outbound key (design D3) so the outbound smoke still works.
        apiKey: '',
        apiKeys: [
          { id: 'k1', apiKey: POOL_KEY_1, label: 'primary', weight: 2 },
          { id: 'k2', apiKey: `$${POOL_ENV_VAR}`, weight: 1 },
        ],
        models: ['mock-model'],
      },
    ],
    server: {
      enabled: true,
      networkBinding: false,
      port: 0,
      endpoints: [
        { endpoint: 'chat', defaultModel: 'mock,mock-model', backgroundModel: 'mock,mock-model', useSubscription: false },
        // messages/responses need complete kind maps or the startup gate refuses to bind.
        { endpoint: 'responses', modelMap: { codex: 'mock,mock-model', mini: 'mock,mock-model' }, useSubscription: false },
        {
          endpoint: 'messages',
          modelMap: { fable: 'mock,mock-model', opus: 'mock,mock-model', sonnet: 'mock,mock-model', haiku: 'mock,mock-model' },
          useSubscription: false,
        },
      ],
    },
    admin: { port: 0 },
  };
  writeFileSync(path, JSON.stringify(cfg, null, 2), 'utf8');
}

beforeEach(async () => {
  resetDaemonSingletonsForTests();
  process.env[POOL_ENV_VAR] = 'sk-poolenv-SENTINEL-bbbb2222';
  upstream = await startMockUpstream();
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-pool-health-'));
  configPath = join(tmpDir, 'config.json');
  const keysPath = join(tmpDir, 'keys.json');
  const tokensPath = join(tmpDir, 'tokens.json');
  writeConfig(configPath, `http://127.0.0.1:${upstream.port}/v1`);

  const config = loadConfig(configPath);
  daemon = buildDaemon(config, { configPath, keysPath, tokensPath, masterKeyFilePath: join(tmpDir, 'master.key') });
  await daemon.llmConfig.ready();
  await daemon.providerProxy.start();
  const serverConfig = await loadServerConfig(daemon.settingsStore);
  await daemon.outboundApiServer.applyConfig({
    enabled: true,
    networkBinding: serverConfig.networkBinding,
    endpoints: serverConfig.endpoints,
    port: serverConfig.port,
  });
  await daemon.adminServer.start();
  adminBase = daemon.adminServer.getStatus().url as string;
});

afterEach(async () => {
  if (daemon) {
    await daemon.adminServer.stop();
    await daemon.outboundApiServer.stop();
    await daemon.providerProxy.stop();
    daemon.apiKeyPool.dispose();
  }
  if (upstream) await stopServer(upstream.server);
  resetDaemonSingletonsForTests();
  Reflect.deleteProperty(process.env, POOL_ENV_VAR);
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('GET /admin/api/providers/:id/keys', () => {
  it('returns masked pool keys (literal last4; $ENV var name masked)', async () => {
    const r = await adminFetch('GET', '/admin/api/providers/mock/keys');
    expect(r.status).toBe(200);
    const keys = (r.json as { keys: Array<Record<string, unknown>> }).keys;
    expect(keys).toHaveLength(2);
    const k1 = keys.find((k) => k['id'] === 'k1')!;
    const k2 = keys.find((k) => k['id'] === 'k2')!;
    expect(k1['label']).toBe('primary');
    expect(k1['weight']).toBe(2);
    expect(k1['enabled']).toBe(true);
    expect(String(k1['apiKeyMasked'])).toBe('sk-…1111');
    expect(String(k2['apiKeyMasked'])).toBe('$ENV(•••)');
    // The literal nor the $ENV var name leaks.
    expect(r.text).not.toContain(POOL_KEY_1);
    expect(r.text).not.toContain(POOL_ENV_VAR);
  });

  it('404s an unknown provider', async () => {
    const r = await adminFetch('GET', '/admin/api/providers/nope/keys');
    expect(r.status).toBe(404);
  });

  it('hot-reloads a PUT apiKeys change (D4 keyCache invalidation)', async () => {
    // Prime the pool's keyCache: hasKeys → getAllKeys caches the OLD [k1,k2].
    expect(await daemon.apiKeyPool.hasKeys('mock')).toBe(true);
    // Spy on the pool's invalidateCache so we can assert the reloadHook fired it.
    const invalidateSpy = vi.spyOn(daemon.apiKeyPool, 'invalidateCache');

    // PUT replaces the pool with a single new key (fresh id + key).
    const put = await adminFetch('PUT', '/admin/api/providers/mock', {
      apiFormat: 'openai',
      baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
      apiKeys: [{ id: 'k3', apiKey: 'sk-rotated-3333', weight: 5 }],
    });
    expect(put.status).toBe(200);
    // D4: the reload-hook flushed the keyCache.
    expect(invalidateSpy).toHaveBeenCalled();

    // The health view reflects the new pool, and the live catalog Map (the
    // loader's source) swapped to the new row — so the next loadKeys reads it.
    const r = await adminFetch('GET', '/admin/api/providers/mock/keys');
    const keys = (r.json as { keys: Array<{ id: string; weight: number }> }).keys;
    expect(keys.map((k) => k.id)).toEqual(['k3']);
    expect(keys[0].weight).toBe(5);
    expect(daemon.llmConfig.getProviderRow('mock')?.apiKeys?.[0]?.id).toBe('k3');

    invalidateSpy.mockRestore();
  });

  it('keeps a pool key on a blank-key PUT (re-entry not required)', async () => {
    const put = await adminFetch('PUT', '/admin/api/providers/mock', {
      apiFormat: 'openai',
      baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
      // k1 submitted with a blank key + a new label → keep the stored key.
      apiKeys: [{ id: 'k1', apiKey: '', label: 'renamed' }],
    });
    expect(put.status).toBe(200);
    const r = await adminFetch('GET', '/admin/api/providers/mock/keys');
    const keys = (r.json as { keys: Array<Record<string, unknown>> }).keys;
    const k1 = keys.find((k) => k['id'] === 'k1')!;
    expect(k1['label']).toBe('renamed');
    expect(String(k1['apiKeyMasked'])).toBe('sk-…1111'); // stored key kept
    expect(r.text).not.toContain(POOL_KEY_1);
  });
});

describe('SECRET SCAN — pool keys never leak across GET responses', () => {
  it('no GET response contains a seeded pool secret or env-var name', async () => {
    const envValue = process.env[POOL_ENV_VAR]!;
    for (const path of [
      '/admin/api/providers',
      '/admin/api/providers/mock/keys',
      '/admin/api/keys',
      '/admin/api/server',
      '/admin/api/status',
    ]) {
      const r = await adminFetch('GET', path);
      expect(r.text, `${path} must not leak the literal pool key`).not.toContain(POOL_KEY_1);
      expect(r.text, `${path} must not leak the $ENV var name`).not.toContain(POOL_ENV_VAR);
      expect(r.text, `${path} must not leak the resolved $ENV value`).not.toContain(envValue);
    }
  });
});

describe('outbound non-regression with a pool (D3 preferred key)', () => {
  it('serves a chat request 200; upstream gets the pool first (literal) key', async () => {
    const { createNamedKey } = await import('@omnicross/core/outbound-api');
    const created = await createNamedKey(daemon.keyDb, 'pool-smoke');
    const base = daemon.outboundApiServer.getStatus().loopbackUrl as string;
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${created.plaintextOnce}` },
      body: JSON.stringify({ model: 'mock-model', messages: [{ role: 'user', content: 'ping' }] }),
    });
    expect(res.status).toBe(200);
    // D3: with no single `apiKey`, the preferred outbound key = the pool's first
    // enabled key (`k1`, the literal). The upstream receives it (the named key
    // never reaches upstream).
    expect(upstream.lastAuthHeader).toBe(`Bearer ${POOL_KEY_1}`);
  });

  it('resolves a $ENV preferred pool key end-to-end to the real upstream key', async () => {
    // Rotate the pool so the FIRST enabled key is the $ENV ref, then prove the
    // resolved env value (not the literal `$VAR`) reaches the mock upstream.
    const put = await adminFetch('PUT', '/admin/api/providers/mock', {
      apiFormat: 'openai',
      baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
      apiKeys: [{ id: 'kenv', apiKey: `$${POOL_ENV_VAR}`, weight: 1 }],
    });
    expect(put.status).toBe(200);

    const { createNamedKey } = await import('@omnicross/core/outbound-api');
    const created = await createNamedKey(daemon.keyDb, 'pool-env-smoke');
    const base = daemon.outboundApiServer.getStatus().loopbackUrl as string;
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${created.plaintextOnce}` },
      body: JSON.stringify({ model: 'mock-model', messages: [{ role: 'user', content: 'ping' }] }),
    });
    expect(res.status).toBe(200);
    expect(upstream.lastAuthHeader).toBe(`Bearer ${process.env[POOL_ENV_VAR]}`);
  });
});
