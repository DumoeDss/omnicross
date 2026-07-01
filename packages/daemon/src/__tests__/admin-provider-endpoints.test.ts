/**
 * admin-provider-endpoints.test.ts — the app-foundation D8 additions.
 *
 * Covers the three additive, back-compat admin-API changes the omnicross desktop
 * app's reused Provider UI needs to function (not degrade):
 *  - `enabled` field: default-true on GET (absent in config), toggle via PUT,
 *    and an omitted `enabled` on a later edit keeps the stored value.
 *  - `POST /admin/api/providers/reorder`: reorders + persists + hot-reloads, and
 *    tolerates unknown/omitted ids.
 *  - `POST /admin/api/providers/:id/discover-models`: OpenAI-format upstream
 *    `GET {baseUrl}/models` parse, non-OpenAI `unsupportedFormat`, upstream-fail
 *    inline error, and the secret-never-leaks assertion (the resolved key never
 *    appears in the response).
 *
 * Boots the FULL daemon in-process (mirrors admin-dashboard.test.ts) so the
 * persistence + hot-reload + masking spine are exercised end-to-end. A second
 * mock upstream serves the `/models` discovery payload.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveProviderEndpoint } from '@omnicross/contracts/endpoint-resolver';
import { loadServerConfig } from '@omnicross/core/outbound-api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildDaemon, type Daemon, resetDaemonSingletonsForTests } from '../bootstrap';
import { loadConfig } from '../config';

// ── Mock upstreams ─────────────────────────────────────────────────────────────

/** The provider's REAL key — must never appear in a discover-models response. */
const PROVIDER_SENTINEL_KEY = 'sk-provider-SENTINEL-discover-9999';

interface MockUpstream {
  server: Server;
  port: number;
  lastAuthHeader: string | undefined;
  lastApiKeyHeader: string | undefined;
  /** When set, the `/models` handler replies with this canned body + status. */
  modelsStatus: number;
  modelsBody: string;
}

function startMockUpstream(): Promise<MockUpstream> {
  const state: MockUpstream = {
    server: undefined as unknown as Server,
    port: 0,
    lastAuthHeader: undefined,
    lastApiKeyHeader: undefined,
    modelsStatus: 200,
    modelsBody: JSON.stringify({ data: [{ id: 'gpt-x' }, { id: 'gpt-y' }] }),
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url && req.url.endsWith('/models')) {
        state.lastAuthHeader = req.headers['authorization'];
        res.writeHead(state.modelsStatus, { 'Content-Type': 'application/json' });
        res.end(state.modelsBody);
        return;
      }
      // Any other path → a canned completion (keeps the outbound boot happy AND
      // serves the model-test endpoint, which POSTs to the provider's baseUrl).
      // Capture the auth headers so the test can assert the key was forwarded.
      state.lastAuthHeader = req.headers['authorization'];
      state.lastApiKeyHeader =
        typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : undefined;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'cmpl',
          object: 'chat.completion',
          created: 1,
          model: 'mock-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
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
  return new Promise((resolve) => server.close(() => resolve()));
}

// ── Admin fetch helper ────────────────────────────────────────────────────────

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

// ── Fixture ───────────────────────────────────────────────────────────────────

let tmpDir: string;
let upstream: MockUpstream;
let daemon: Daemon;

interface ProviderRow {
  id: string;
  name?: string;
  apiFormat: string;
  baseUrl: string;
  apiKey: string;
  models?: string[];
  modelConfigs?: Array<Record<string, unknown>>;
  enabled?: boolean;
  isOfficial?: boolean;
  apiVersion?: string;
  maxConcurrency?: number;
  modelsEndpoint?: string;
  transformer?: Record<string, unknown>;
  codingPlan?: Record<string, unknown>;
}

function writeConfig(configPath: string, providers: ProviderRow[]): void {
  const cfg = {
    providers,
    server: {
      enabled: true,
      networkBinding: false,
      port: 0,
      endpoints: [
        { endpoint: 'chat', defaultModel: 'a,mock-model', backgroundModel: 'a,mock-model', useSubscription: false },
        // messages/responses need complete kind maps or the startup gate refuses to bind.
        { endpoint: 'responses', modelMap: { codex: 'a,mock-model', mini: 'a,mock-model' }, useSubscription: false },
        {
          endpoint: 'messages',
          modelMap: { fable: 'a,mock-model', opus: 'a,mock-model', sonnet: 'a,mock-model', haiku: 'a,mock-model' },
          useSubscription: false,
        },
      ],
    },
    admin: { port: 0 },
  };
  writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
}

/**
 * Boot the daemon. The mock upstream is started FIRST, then the provider rows are
 * built from its base URL via `buildProviders(base)` so `baseUrl` points at the
 * live mock (the `upstream` singleton isn't readable until after it listens).
 */
async function bootDaemon(buildProviders: (base: string) => ProviderRow[]): Promise<void> {
  resetDaemonSingletonsForTests();
  upstream = await startMockUpstream();
  const providers = buildProviders(`http://127.0.0.1:${upstream.port}/v1`);
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-provendp-'));
  const configPath = join(tmpDir, 'config.json');
  const keysPath = join(tmpDir, 'keys.json');
  const tokensPath = join(tmpDir, 'tokens.json');
  writeConfig(configPath, providers);

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
}

/** The live mock upstream base URL (valid only after `bootDaemon`). */
function base(): string {
  return `http://127.0.0.1:${upstream.port}/v1`;
}

afterEach(async () => {
  if (daemon) {
    await daemon.adminServer.stop();
    await daemon.outboundApiServer.stop();
    await daemon.providerProxy.stop();
    daemon.apiKeyPool.dispose();
  }
  if (upstream) await stopServer(upstream.server);
  resetDaemonSingletonsForTests();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

// ── enabled field (back-compat) ─────────────────────────────────────────────────

describe('provider enabled field (app-foundation D8)', () => {
  it('absent enabled reads as enabled: true on GET', async () => {
    await bootDaemon((b) => [{ id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-a' }]);
    const r = await adminFetch('GET', '/admin/api/providers');
    const p = (r.json as { providers: Array<Record<string, unknown>> }).providers.find((x) => x['id'] === 'a')!;
    expect(p['enabled']).toBe(true);
  });

  it('toggles enabled:false via PUT and reflects on the next GET', async () => {
    await bootDaemon((b) => [{ id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-a' }]);
    const put = await adminFetch('PUT', '/admin/api/providers/a', {
      apiFormat: 'openai',
      baseUrl: base(),
      enabled: false,
    });
    expect(put.status).toBe(200);

    const list = await adminFetch('GET', '/admin/api/providers');
    const p = (list.json as { providers: Array<Record<string, unknown>> }).providers.find((x) => x['id'] === 'a')!;
    expect(p['enabled']).toBe(false);
  });

  it('an omitted enabled on a later edit keeps the stored value (no re-enable)', async () => {
    await bootDaemon((b) => [{ id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-a' }]);
    // Disable first.
    await adminFetch('PUT', '/admin/api/providers/a', {
      apiFormat: 'openai',
      baseUrl: base(),
      enabled: false,
    });
    // Edit WITHOUT enabled (e.g. just change models) → must stay disabled.
    await adminFetch('PUT', '/admin/api/providers/a', {
      apiFormat: 'openai',
      baseUrl: base(),
      models: ['m1'],
    });
    const list = await adminFetch('GET', '/admin/api/providers');
    const p = (list.json as { providers: Array<Record<string, unknown>> }).providers.find((x) => x['id'] === 'a')!;
    expect(p['enabled']).toBe(false);
    expect(p['models']).toEqual(['m1']);
  });
});

// ── reorder ─────────────────────────────────────────────────────────────────────

describe('POST /admin/api/providers/reorder (app-foundation D8)', () => {
  it('reorders, persists, and hot-reloads', async () => {
    await bootDaemon((b) => [
      { id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-a' },
      { id: 'b', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-b' },
    ]);
    const r = await adminFetch('POST', '/admin/api/providers/reorder', { order: ['b', 'a'] });
    expect(r.status).toBe(200);
    const ids = (r.json as { providers: Array<{ id: string }> }).providers.map((p) => p.id);
    expect(ids).toEqual(['b', 'a']);

    // Persisted to disk (re-read the config).
    const persisted = loadConfig(join(tmpDir, 'config.json')).providers.map((p) => p.id);
    expect(persisted).toEqual(['b', 'a']);

    // Hot-reloaded into the live catalog.
    const list = await adminFetch('GET', '/admin/api/providers');
    const liveIds = (list.json as { providers: Array<{ id: string }> }).providers.map((p) => p.id);
    expect(liveIds).toEqual(['b', 'a']);
  });

  it('ignores unknown ids and appends omitted ids preserving prior order', async () => {
    await bootDaemon((b) => [
      { id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-a' },
      { id: 'b', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-b' },
      { id: 'c', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-c' },
    ]);
    // Order only mentions c (+ an unknown id); a and b are omitted.
    const r = await adminFetch('POST', '/admin/api/providers/reorder', { order: ['c', 'zzz-unknown'] });
    const ids = (r.json as { providers: Array<{ id: string }> }).providers.map((p) => p.id);
    expect(ids).toEqual(['c', 'a', 'b']);
  });

  it('rejects a non-array order with 400', async () => {
    await bootDaemon((b) => [{ id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-a' }]);
    const r = await adminFetch('POST', '/admin/api/providers/reorder', { order: 'nope' });
    expect(r.status).toBe(400);
  });
});

// ── discover-models ──────────────────────────────────────────────────────────────

describe('POST /admin/api/providers/:id/discover-models (app-foundation D8)', () => {
  it('OpenAI-format returns models parsed from upstream { data: [{ id }] }', async () => {
    await bootDaemon((b) => [{ id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: PROVIDER_SENTINEL_KEY }]);
    const r = await adminFetch('POST', '/admin/api/providers/a/discover-models');
    expect(r.status).toBe(200);
    const body = r.json as { models: string[] };
    expect(body.models).toEqual(['gpt-x', 'gpt-y']);
    // The upstream saw the resolved key as the bearer...
    expect(upstream.lastAuthHeader).toBe(`Bearer ${PROVIDER_SENTINEL_KEY}`);
    // ...but the response NEVER serialized it (secret spine).
    expect(r.text).not.toContain(PROVIDER_SENTINEL_KEY);
  });

  it('resolves a $ENV key for the upstream auth, never leaking the var name', async () => {
    process.env['OMNI_DISCOVER_TEST_KEY'] = PROVIDER_SENTINEL_KEY;
    try {
      await bootDaemon((b) => [{ id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: '$OMNI_DISCOVER_TEST_KEY' }]);
      const r = await adminFetch('POST', '/admin/api/providers/a/discover-models');
      expect(r.status).toBe(200);
      expect((r.json as { models: string[] }).models).toEqual(['gpt-x', 'gpt-y']);
      expect(upstream.lastAuthHeader).toBe(`Bearer ${PROVIDER_SENTINEL_KEY}`);
      expect(r.text).not.toContain(PROVIDER_SENTINEL_KEY);
      expect(r.text).not.toContain('OMNI_DISCOVER_TEST_KEY');
    } finally {
      delete process.env['OMNI_DISCOVER_TEST_KEY'];
    }
  });

  it('anthropic/gemini formats return unsupportedFormat with no upstream call', async () => {
    await bootDaemon((b) => [
      { id: 'ant', apiFormat: 'anthropic', baseUrl: b, apiKey: 'sk-ant' },
      { id: 'gem', apiFormat: 'gemini', baseUrl: b, apiKey: 'sk-gem' },
    ]);
    const before = upstream.lastAuthHeader;
    const a = await adminFetch('POST', '/admin/api/providers/ant/discover-models');
    expect(a.status).toBe(200);
    expect(a.json).toEqual({ models: [], unsupportedFormat: true });
    const g = await adminFetch('POST', '/admin/api/providers/gem/discover-models');
    expect(g.json).toEqual({ models: [], unsupportedFormat: true });
    // No upstream /models call happened for either.
    expect(upstream.lastAuthHeader).toBe(before);
  });

  it('upstream failure is reported inline (HTTP 200, { error }) without leaking the key', async () => {
    await bootDaemon((b) => [{ id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: PROVIDER_SENTINEL_KEY }]);
    upstream.modelsStatus = 500;
    upstream.modelsBody = JSON.stringify({ error: { message: 'upstream boom' } });
    const r = await adminFetch('POST', '/admin/api/providers/a/discover-models');
    expect(r.status).toBe(200);
    const body = r.json as { models: string[]; error?: string };
    expect(body.models).toEqual([]);
    expect(body.error).toContain('500');
    expect(r.text).not.toContain(PROVIDER_SENTINEL_KEY);
  });

  it('returns 404 for an unknown provider id', async () => {
    await bootDaemon((b) => [{ id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-a' }]);
    const r = await adminFetch('POST', '/admin/api/providers/nope/discover-models');
    expect(r.status).toBe(404);
  });
});

// ── test-model ────────────────────────────────────────────────────────────────

describe('POST /admin/api/providers/:id/test', () => {
  it('openai: issues a completion with the provider key as Bearer, never leaking it', async () => {
    await bootDaemon((b) => [{ id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: PROVIDER_SENTINEL_KEY }]);
    const r = await adminFetch('POST', '/admin/api/providers/a/test', { model: 'gpt-x' });
    expect(r.status).toBe(200);
    const body = r.json as { ok: boolean; sample?: string; latencyMs?: number };
    expect(body.ok).toBe(true);
    expect(body.sample).toBe('pong'); // from the mock upstream's canned completion
    expect(typeof body.latencyMs).toBe('number');
    // The upstream saw the resolved key as the bearer...
    expect(upstream.lastAuthHeader).toBe(`Bearer ${PROVIDER_SENTINEL_KEY}`);
    // ...but the response NEVER serialized it (secret spine).
    expect(r.text).not.toContain(PROVIDER_SENTINEL_KEY);
  });

  it('resolves a $ENV key for the upstream auth, never leaking the key or var name', async () => {
    process.env['OMNI_TEST_MODEL_KEY'] = PROVIDER_SENTINEL_KEY;
    try {
      await bootDaemon((b) => [{ id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: '$OMNI_TEST_MODEL_KEY' }]);
      const r = await adminFetch('POST', '/admin/api/providers/a/test', { model: 'gpt-x' });
      expect((r.json as { ok: boolean }).ok).toBe(true);
      expect(upstream.lastAuthHeader).toBe(`Bearer ${PROVIDER_SENTINEL_KEY}`);
      expect(r.text).not.toContain(PROVIDER_SENTINEL_KEY);
      expect(r.text).not.toContain('OMNI_TEST_MODEL_KEY');
    } finally {
      delete process.env['OMNI_TEST_MODEL_KEY'];
    }
  });

  it('anthropic: sends the key via x-api-key (not the response), returns ok', async () => {
    await bootDaemon((b) => [{ id: 'ant', apiFormat: 'anthropic', baseUrl: b, apiKey: PROVIDER_SENTINEL_KEY }]);
    const r = await adminFetch('POST', '/admin/api/providers/ant/test', { model: 'claude-x' });
    expect((r.json as { ok: boolean }).ok).toBe(true);
    expect(upstream.lastApiKeyHeader).toBe(PROVIDER_SENTINEL_KEY);
    expect(r.text).not.toContain(PROVIDER_SENTINEL_KEY);
  });

  it('gemini: reports unsupportedFormat with no upstream call', async () => {
    await bootDaemon((b) => [{ id: 'gem', apiFormat: 'gemini', baseUrl: b, apiKey: 'sk-gem' }]);
    const before = upstream.lastAuthHeader;
    const r = await adminFetch('POST', '/admin/api/providers/gem/test', { model: 'gemini-x' });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: false, unsupportedFormat: true });
    expect(upstream.lastAuthHeader).toBe(before);
  });

  it('reports ok:false when the provider has no key (no upstream call)', async () => {
    await bootDaemon((b) => [{ id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: '' }]);
    const before = upstream.lastAuthHeader;
    const r = await adminFetch('POST', '/admin/api/providers/a/test', { model: 'gpt-x' });
    expect(r.status).toBe(200);
    expect((r.json as { ok: boolean }).ok).toBe(false);
    expect(upstream.lastAuthHeader).toBe(before);
  });

  it('requires a { model } string (400) and 404s an unknown provider', async () => {
    await bootDaemon((b) => [{ id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-a' }]);
    expect((await adminFetch('POST', '/admin/api/providers/a/test', {})).status).toBe(400);
    expect((await adminFetch('POST', '/admin/api/providers/nope/test', { model: 'm' })).status).toBe(404);
  });
});

// ── provider scalar fields (app-parity child 1) ─────────────────────────────────

describe('provider scalar fields (app-parity child 1)', () => {
  /** Locate provider `id` in a `GET /admin/api/providers` response. */
  function findProvider(json: unknown, id: string): Record<string, unknown> {
    return (json as { providers: Array<Record<string, unknown>> }).providers.find(
      (x) => x['id'] === id,
    )!;
  }

  it('PUT all four fields → GET returns them intact AND re-loadConfig from disk returns them', async () => {
    await bootDaemon((b) => [{ id: 'a', apiFormat: 'anthropic', baseUrl: b, apiKey: 'sk-a' }]);
    const put = await adminFetch('PUT', '/admin/api/providers/a', {
      apiFormat: 'anthropic',
      baseUrl: base(),
      isOfficial: true,
      apiVersion: '2024-08-01-preview',
      maxConcurrency: 8,
      modelsEndpoint: 'https://host/v1/models',
    });
    expect(put.status).toBe(200);

    // GET round-trip (through toProviderView).
    const list = await adminFetch('GET', '/admin/api/providers');
    const p = findProvider(list.json, 'a');
    expect(p['isOfficial']).toBe(true);
    expect(p['apiVersion']).toBe('2024-08-01-preview');
    expect(p['maxConcurrency']).toBe(8);
    expect(p['modelsEndpoint']).toBe('https://host/v1/models');

    // Disk round-trip (through validateProvider in loadConfig).
    const persisted = loadConfig(join(tmpDir, 'config.json')).providers.find((x) => x.id === 'a')!;
    expect(persisted.isOfficial).toBe(true);
    expect(persisted.apiVersion).toBe('2024-08-01-preview');
    expect(persisted.maxConcurrency).toBe(8);
    expect(persisted.modelsEndpoint).toBe('https://host/v1/models');
  });

  it('a row with none of the four fields → GET returns them absent (back-compat)', async () => {
    await bootDaemon((b) => [{ id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-a' }]);
    const r = await adminFetch('GET', '/admin/api/providers');
    const p = findProvider(r.json, 'a');
    expect(p['isOfficial']).toBeUndefined();
    expect(p['apiVersion']).toBeUndefined();
    expect(p['maxConcurrency']).toBeUndefined();
    expect(p['modelsEndpoint']).toBeUndefined();
    // The load guard tolerated the absent fields without error.
    const persisted = loadConfig(join(tmpDir, 'config.json')).providers.find((x) => x.id === 'a')!;
    expect(persisted.maxConcurrency).toBeUndefined();
  });

  it('an omitted maxConcurrency on a later edit keeps the stored value; explicit null clears it', async () => {
    await bootDaemon((b) => [
      { id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-a', maxConcurrency: 8 },
    ]);
    // Sanity: the seed value loaded.
    {
      const r = await adminFetch('GET', '/admin/api/providers');
      expect(findProvider(r.json, 'a')['maxConcurrency']).toBe(8);
    }
    // Edit WITHOUT maxConcurrency (just change models) → keeps 8.
    await adminFetch('PUT', '/admin/api/providers/a', {
      apiFormat: 'openai',
      baseUrl: base(),
      models: ['m1'],
    });
    {
      const r = await adminFetch('GET', '/admin/api/providers');
      const p = findProvider(r.json, 'a');
      expect(p['maxConcurrency']).toBe(8);
      expect(p['models']).toEqual(['m1']);
    }
    // Explicit null → clears (OQ2 / D4).
    await adminFetch('PUT', '/admin/api/providers/a', {
      apiFormat: 'openai',
      baseUrl: base(),
      maxConcurrency: null,
    });
    {
      const r = await adminFetch('GET', '/admin/api/providers');
      expect(findProvider(r.json, 'a')['maxConcurrency']).toBeUndefined();
    }
    // And it cleared on disk too.
    const persisted = loadConfig(join(tmpDir, 'config.json')).providers.find((x) => x.id === 'a')!;
    expect(persisted.maxConcurrency).toBeUndefined();
  });

  it('string fields: omit keeps, explicit null clears (round-trips from disk)', async () => {
    await bootDaemon((b) => [{ id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-a' }]);
    // Seed apiVersion + modelsEndpoint via a PUT.
    await adminFetch('PUT', '/admin/api/providers/a', {
      apiFormat: 'openai',
      baseUrl: base(),
      apiVersion: '2024-08-01-preview',
      modelsEndpoint: 'https://host/v1/models',
    });
    // An unrelated edit (only models) OMITS both → keeps them.
    await adminFetch('PUT', '/admin/api/providers/a', {
      apiFormat: 'openai',
      baseUrl: base(),
      models: ['m1'],
    });
    {
      const r = await adminFetch('GET', '/admin/api/providers');
      const p = findProvider(r.json, 'a');
      expect(p['apiVersion']).toBe('2024-08-01-preview');
      expect(p['modelsEndpoint']).toBe('https://host/v1/models');
    }
    // Explicit null → clears BOTH (the Minor #1 fix: clear must persist, not revert).
    await adminFetch('PUT', '/admin/api/providers/a', {
      apiFormat: 'openai',
      baseUrl: base(),
      apiVersion: null,
      modelsEndpoint: null,
    });
    {
      const r = await adminFetch('GET', '/admin/api/providers');
      const p = findProvider(r.json, 'a');
      expect(p['apiVersion']).toBeUndefined();
      expect(p['modelsEndpoint']).toBeUndefined();
    }
    // Round-trips from disk: a re-loadConfig shows both fields absent.
    const persisted = loadConfig(join(tmpDir, 'config.json')).providers.find((x) => x.id === 'a')!;
    expect(persisted.apiVersion).toBeUndefined();
    expect(persisted.modelsEndpoint).toBeUndefined();
  });

  it('deny-by-default: a PUT with an unknown field persists only allowlisted fields', async () => {
    await bootDaemon((b) => [{ id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-a' }]);
    const put = await adminFetch('PUT', '/admin/api/providers/a', {
      apiFormat: 'openai',
      baseUrl: base(),
      isOfficial: true,
      bogusField: 'should-never-persist',
    });
    expect(put.status).toBe(200);
    // Allowlisted field persisted...
    const persisted = loadConfig(join(tmpDir, 'config.json')).providers.find((x) => x.id === 'a')!;
    expect(persisted.isOfficial).toBe(true);
    // ...but the unknown field was never copied into the stored row.
    expect((persisted as Record<string, unknown>)['bogusField']).toBeUndefined();
    // And it never appears anywhere on disk.
    const onDisk = readFileSync(join(tmpDir, 'config.json'), 'utf8');
    expect(onDisk).not.toContain('bogusField');
    expect(onDisk).not.toContain('should-never-persist');
  });

  it('no-secret-leak: carrying the four fields still never serializes the literal key or $ENV name', async () => {
    process.env['OMNI_SCALAR_TEST_KEY'] = PROVIDER_SENTINEL_KEY;
    try {
      await bootDaemon((b) => [
        { id: 'lit', apiFormat: 'openai', baseUrl: b, apiKey: PROVIDER_SENTINEL_KEY },
        { id: 'env', apiFormat: 'openai', baseUrl: b, apiKey: '$OMNI_SCALAR_TEST_KEY' },
      ]);
      // PUT the scalar fields onto both providers.
      const putLit = await adminFetch('PUT', '/admin/api/providers/lit', {
        apiFormat: 'openai',
        baseUrl: base(),
        isOfficial: true,
        apiVersion: '2024-08-01-preview',
        maxConcurrency: 4,
        modelsEndpoint: 'https://host/v1/models',
      });
      const putEnv = await adminFetch('PUT', '/admin/api/providers/env', {
        apiFormat: 'openai',
        baseUrl: base(),
        maxConcurrency: 2,
      });
      const get = await adminFetch('GET', '/admin/api/providers');
      // Neither the literal key nor the env-var NAME ever crosses the wire.
      for (const r of [putLit, putEnv, get]) {
        expect(r.text).not.toContain(PROVIDER_SENTINEL_KEY);
        expect(r.text).not.toContain('OMNI_SCALAR_TEST_KEY');
      }
      // But the non-secret scalar field DID round-trip (proves the assertion isn't vacuous).
      expect(findProvider(get.json, 'lit')['apiVersion']).toBe('2024-08-01-preview');
    } finally {
      delete process.env['OMNI_SCALAR_TEST_KEY'];
    }
  });
});

// ── provider per-model metadata (app-parity child 2) ────────────────────────────

describe('provider per-model metadata (app-parity child 2)', () => {
  /** Locate provider `id` in a `GET /admin/api/providers` response. */
  function findProvider(json: unknown, id: string): Record<string, unknown> {
    return (json as { providers: Array<Record<string, unknown>> }).providers.find(
      (x) => x['id'] === id,
    )!;
  }

  it('PUT models + modelConfigs → GET returns the metadata intact AND re-loadConfig from disk returns it', async () => {
    await bootDaemon((b) => [{ id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-a' }]);
    const put = await adminFetch('PUT', '/admin/api/providers/a', {
      apiFormat: 'openai',
      baseUrl: base(),
      models: ['m1'],
      modelConfigs: [
        { id: 'm1', name: 'Model One', enabled: false, group: 'g1', vision: true, reasoning: false },
      ],
    });
    expect(put.status).toBe(200);

    // GET round-trip (through toProviderView).
    const list = await adminFetch('GET', '/admin/api/providers');
    const p = findProvider(list.json, 'a');
    expect(p['models']).toEqual(['m1']);
    const mc = p['modelConfigs'] as Array<Record<string, unknown>>;
    expect(mc).toEqual([
      { id: 'm1', name: 'Model One', enabled: false, group: 'g1', vision: true, reasoning: false },
    ]);

    // Disk round-trip (through validateModelConfigs in loadConfig).
    const persisted = loadConfig(join(tmpDir, 'config.json')).providers.find((x) => x.id === 'a')!;
    expect(persisted.modelConfigs).toEqual([
      { id: 'm1', name: 'Model One', enabled: false, group: 'g1', vision: true, reasoning: false },
    ]);
    expect(persisted.models).toEqual(['m1']);
  });

  it('back-compat: a flat models-only row loads and GET returns models with no modelConfigs', async () => {
    await bootDaemon((b) => [
      { id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-a', models: ['m1', 'm2'] },
    ]);
    const r = await adminFetch('GET', '/admin/api/providers');
    const p = findProvider(r.json, 'a');
    expect(p['models']).toEqual(['m1', 'm2']);
    expect(p['modelConfigs']).toBeUndefined();
    // The load guard tolerated the absent metadata without error.
    const persisted = loadConfig(join(tmpDir, 'config.json')).providers.find((x) => x.id === 'a')!;
    expect(persisted.modelConfigs).toBeUndefined();
    expect(persisted.models).toEqual(['m1', 'm2']);
  });

  it('an omitted modelConfigs on a later edit keeps the stored metadata; explicit null clears it', async () => {
    await bootDaemon((b) => [{ id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-a' }]);
    // Seed metadata via a PUT.
    await adminFetch('PUT', '/admin/api/providers/a', {
      apiFormat: 'openai',
      baseUrl: base(),
      models: ['m1'],
      modelConfigs: [{ id: 'm1', name: 'Model One', enabled: true, vision: true }],
    });
    // An unrelated edit (only baseUrl) OMITS modelConfigs → keeps the stored metadata.
    await adminFetch('PUT', '/admin/api/providers/a', {
      apiFormat: 'openai',
      baseUrl: base(),
    });
    {
      const r = await adminFetch('GET', '/admin/api/providers');
      const mc = findProvider(r.json, 'a')['modelConfigs'] as Array<Record<string, unknown>>;
      expect(mc).toEqual([{ id: 'm1', name: 'Model One', enabled: true, vision: true }]);
    }
    // Explicit null → clears (D3 / OQ3).
    await adminFetch('PUT', '/admin/api/providers/a', {
      apiFormat: 'openai',
      baseUrl: base(),
      modelConfigs: null,
    });
    {
      const r = await adminFetch('GET', '/admin/api/providers');
      expect(findProvider(r.json, 'a')['modelConfigs']).toBeUndefined();
    }
    // And it cleared on disk too.
    const persisted = loadConfig(join(tmpDir, 'config.json')).providers.find((x) => x.id === 'a')!;
    expect(persisted.modelConfigs).toBeUndefined();
  });

  it('deny-by-default: an unknown per-model field is never persisted (only the named-five)', async () => {
    await bootDaemon((b) => [{ id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-a' }]);
    const put = await adminFetch('PUT', '/admin/api/providers/a', {
      apiFormat: 'openai',
      baseUrl: base(),
      models: ['m1'],
      modelConfigs: [
        {
          id: 'm1',
          name: 'Model One',
          enabled: true,
          // Non-allowlisted per-model fields the discovery flow may send.
          completionSettings: { temperature: 0.5 },
          contextLength: 128000,
          bogusField: 'should-never-persist',
        },
      ],
    });
    expect(put.status).toBe(200);
    // The named-five persisted...
    const persisted = loadConfig(join(tmpDir, 'config.json')).providers.find((x) => x.id === 'a')!;
    expect(persisted.modelConfigs).toEqual([{ id: 'm1', name: 'Model One', enabled: true }]);
    // ...but the unknown per-model fields never reached disk.
    const onDisk = readFileSync(join(tmpDir, 'config.json'), 'utf8');
    expect(onDisk).not.toContain('bogusField');
    expect(onDisk).not.toContain('should-never-persist');
    expect(onDisk).not.toContain('completionSettings');
    expect(onDisk).not.toContain('contextLength');
  });

  it('no-secret-leak: carrying modelConfigs still never serializes the literal key or $ENV name', async () => {
    process.env['OMNI_MODELMETA_TEST_KEY'] = PROVIDER_SENTINEL_KEY;
    try {
      await bootDaemon((b) => [
        { id: 'lit', apiFormat: 'openai', baseUrl: b, apiKey: PROVIDER_SENTINEL_KEY },
        { id: 'env', apiFormat: 'openai', baseUrl: b, apiKey: '$OMNI_MODELMETA_TEST_KEY' },
      ]);
      const putLit = await adminFetch('PUT', '/admin/api/providers/lit', {
        apiFormat: 'openai',
        baseUrl: base(),
        models: ['m1'],
        modelConfigs: [{ id: 'm1', name: 'Model One', enabled: true, vision: true }],
      });
      const putEnv = await adminFetch('PUT', '/admin/api/providers/env', {
        apiFormat: 'openai',
        baseUrl: base(),
        models: ['m2'],
        modelConfigs: [{ id: 'm2', name: 'Model Two', reasoning: true }],
      });
      const get = await adminFetch('GET', '/admin/api/providers');
      // Neither the literal key nor the env-var NAME ever crosses the wire.
      for (const r of [putLit, putEnv, get]) {
        expect(r.text).not.toContain(PROVIDER_SENTINEL_KEY);
        expect(r.text).not.toContain('OMNI_MODELMETA_TEST_KEY');
      }
      // But the non-secret per-model metadata DID round-trip (proves it isn't vacuous).
      const mc = findProvider(get.json, 'lit')['modelConfigs'] as Array<Record<string, unknown>>;
      expect(mc[0]?.['name']).toBe('Model One');
    } finally {
      delete process.env['OMNI_MODELMETA_TEST_KEY'];
    }
  });
});

// ── provider transformer slot (app-parity child 5) ──────────────────────────────

describe('provider transformer slot (app-parity child 5)', () => {
  /** Locate provider `id` in a `GET /admin/api/providers` response. */
  function findProvider(json: unknown, id: string): Record<string, unknown> {
    return (json as { providers: Array<Record<string, unknown>> }).providers.find(
      (x) => x['id'] === id,
    )!;
  }

  it('PUT transformer.use → GET returns it intact AND re-loadConfig from disk returns it', async () => {
    await bootDaemon((b) => [{ id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-a' }]);
    const put = await adminFetch('PUT', '/admin/api/providers/a', {
      apiFormat: 'openai',
      baseUrl: base(),
      transformer: { use: ['gemini', ['maxtoken', { max_tokens: 4096 }]] },
    });
    expect(put.status).toBe(200);

    // GET round-trip (through toProviderView) — verbatim, including the tuple entry.
    const list = await adminFetch('GET', '/admin/api/providers');
    const p = findProvider(list.json, 'a');
    expect(p['transformer']).toEqual({ use: ['gemini', ['maxtoken', { max_tokens: 4096 }]] });

    // Disk round-trip (through validateTransformer in loadConfig).
    const persisted = loadConfig(join(tmpDir, 'config.json')).providers.find((x) => x.id === 'a')!;
    expect(persisted.transformer).toEqual({ use: ['gemini', ['maxtoken', { max_tokens: 4096 }]] });
  });

  it('back-compat: a row with no transformer loads and GET returns no transformer', async () => {
    await bootDaemon((b) => [
      { id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-a', models: ['m1'] },
    ]);
    const r = await adminFetch('GET', '/admin/api/providers');
    const p = findProvider(r.json, 'a');
    expect(p['transformer']).toBeUndefined();
    // The load guard tolerated the absent transformer without error.
    const persisted = loadConfig(join(tmpDir, 'config.json')).providers.find((x) => x.id === 'a')!;
    expect(persisted.transformer).toBeUndefined();
    expect(persisted.models).toEqual(['m1']);
  });

  it('an omitted transformer on a later edit keeps the stored value; explicit null clears it', async () => {
    await bootDaemon((b) => [{ id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-a' }]);
    // Seed a transformer via a PUT.
    await adminFetch('PUT', '/admin/api/providers/a', {
      apiFormat: 'openai',
      baseUrl: base(),
      transformer: { use: ['anthropic'] },
    });
    // An unrelated edit (only models) OMITS transformer → keeps the stored value.
    await adminFetch('PUT', '/admin/api/providers/a', {
      apiFormat: 'openai',
      baseUrl: base(),
      models: ['m1'],
    });
    {
      const r = await adminFetch('GET', '/admin/api/providers');
      const p = findProvider(r.json, 'a');
      expect(p['transformer']).toEqual({ use: ['anthropic'] });
      expect(p['models']).toEqual(['m1']);
    }
    // Explicit null → clears (D3).
    await adminFetch('PUT', '/admin/api/providers/a', {
      apiFormat: 'openai',
      baseUrl: base(),
      transformer: null,
    });
    {
      const r = await adminFetch('GET', '/admin/api/providers');
      expect(findProvider(r.json, 'a')['transformer']).toBeUndefined();
    }
    // And it cleared on disk too.
    const persisted = loadConfig(join(tmpDir, 'config.json')).providers.find((x) => x.id === 'a')!;
    expect(persisted.transformer).toBeUndefined();
  });

  it('deny-by-default: a malformed use entry or a garbage unknown key is dropped; a well-formed per-model key is preserved', async () => {
    await bootDaemon((b) => [{ id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-a' }]);
    const put = await adminFetch('PUT', '/admin/api/providers/a', {
      apiFormat: 'openai',
      baseUrl: base(),
      transformer: {
        // Mixed good/bad entries: a number (bad), `[123]` (bad tuple), a bad
        // 2-tuple with a non-object option, and two well-formed entries.
        use: ['gemini', 123, [123], ['maxtoken', 'not-an-object'], ['openrouter', { provider: 'x' }]],
        // A well-formed per-model key (object-shaped) → preserved verbatim.
        'gpt-4o': { use: ['tooluse'] },
        // Garbage at an unknown key (scalar) → dropped (deny-by-default).
        bogusKey: 'should-never-persist',
      },
    });
    expect(put.status).toBe(200);

    // Re-loadConfig from disk: only the well-formed entries + the object per-model key survive.
    const persisted = loadConfig(join(tmpDir, 'config.json')).providers.find((x) => x.id === 'a')!;
    expect(persisted.transformer).toEqual({
      use: ['gemini', ['openrouter', { provider: 'x' }]],
      'gpt-4o': { use: ['tooluse'] },
    });
    // The malformed values never reach disk.
    const onDisk = readFileSync(join(tmpDir, 'config.json'), 'utf8');
    expect(onDisk).not.toContain('bogusKey');
    expect(onDisk).not.toContain('should-never-persist');
    expect(onDisk).not.toContain('not-an-object');
  });

  it('no-secret-leak: carrying transformer still never serializes the literal key or $ENV name', async () => {
    process.env['OMNI_TRANSFORMER_TEST_KEY'] = PROVIDER_SENTINEL_KEY;
    try {
      await bootDaemon((b) => [
        { id: 'lit', apiFormat: 'openai', baseUrl: b, apiKey: PROVIDER_SENTINEL_KEY },
        { id: 'env', apiFormat: 'openai', baseUrl: b, apiKey: '$OMNI_TRANSFORMER_TEST_KEY' },
      ]);
      const putLit = await adminFetch('PUT', '/admin/api/providers/lit', {
        apiFormat: 'openai',
        baseUrl: base(),
        transformer: { use: ['gemini', ['maxtoken', { max_tokens: 4096 }]] },
      });
      const putEnv = await adminFetch('PUT', '/admin/api/providers/env', {
        apiFormat: 'openai',
        baseUrl: base(),
        transformer: { use: ['anthropic'] },
      });
      const get = await adminFetch('GET', '/admin/api/providers');
      // Neither the literal key nor the env-var NAME ever crosses the wire.
      for (const r of [putLit, putEnv, get]) {
        expect(r.text).not.toContain(PROVIDER_SENTINEL_KEY);
        expect(r.text).not.toContain('OMNI_TRANSFORMER_TEST_KEY');
      }
      // But the non-secret transformer DID round-trip (proves the assertion isn't vacuous).
      expect(findProvider(get.json, 'lit')['transformer']).toEqual({
        use: ['gemini', ['maxtoken', { max_tokens: 4096 }]],
      });
    } finally {
      delete process.env['OMNI_TRANSFORMER_TEST_KEY'];
    }
  });

  // app-parity-2 child 2: the transformer slot is now ENFORCED (was store-only).
  type ChainPort = {
    resolveTransformerChain: (
      providerId: string,
      model?: string,
    ) => Promise<{ providerTransformers: Array<{ name: string }>; modelTransformers: unknown[] }>;
    getMainTransformer: (providerId: string) => Promise<{ name: string } | null>;
  };

  it('ENFORCED: a stored transformer.use[] resolves into the provider chain, FORMAT-FIRST', async () => {
    await bootDaemon((b) => [
      { id: 'a', apiFormat: 'anthropic', baseUrl: b, apiKey: 'sk-a', transformer: { use: ['reasoning'] } },
    ]);
    const source = daemon.llmConfig as unknown as ChainPort;
    const chain = await source.resolveTransformerChain('a');
    const main = await source.getMainTransformer('a');
    // The custom transformer is now enforced in the provider chain...
    expect(chain.providerTransformers.map((t) => t.name)).toContain('reasoning');
    // ...and the FORMAT transformer (anthropic) is still supplied by getMainTransformer.
    expect(main?.name).toBe('anthropic');
    // Compose exactly as core's resolveProviderChain does (unshift main if absent)
    // to assert FORMAT-FIRST — the load-bearing wire conversion runs before custom.
    const composed = [...chain.providerTransformers];
    if (main && !composed.some((t) => t.name === main.name)) composed.unshift(main);
    expect(composed.map((t) => t.name)).toEqual(['anthropic', 'reasoning']);
  });

  it('format-first INVARIANT holds even if the user lists their own format name in use[]', async () => {
    // A user checks 'anthropic' AFTER 'reasoning' in the UI. The daemon drops the
    // self-format entry from resolveTransformerChain so getMainTransformer's
    // front-unshift is never suppressed by core's dedup-by-name.
    await bootDaemon((b) => [
      { id: 'a', apiFormat: 'anthropic', baseUrl: b, apiKey: 'sk-a', transformer: { use: ['reasoning', 'anthropic'] } },
    ]);
    const source = daemon.llmConfig as unknown as ChainPort;
    const chain = await source.resolveTransformerChain('a');
    const main = await source.getMainTransformer('a');
    // The self-format 'anthropic' is filtered out of the custom chain...
    expect(chain.providerTransformers.map((t) => t.name)).toEqual(['reasoning']);
    // ...so the composed chain still puts the format transformer FIRST (no dup, no reorder).
    const composed = [...chain.providerTransformers];
    if (main && !composed.some((t) => t.name === main.name)) composed.unshift(main);
    expect(composed.map((t) => t.name)).toEqual(['anthropic', 'reasoning']);
  });

  it('ENFORCED on openai: custom transformers apply with no format transformer', async () => {
    await bootDaemon((b) => [
      { id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-a', transformer: { use: ['reasoning'] } },
    ]);
    const source = daemon.llmConfig as unknown as ChainPort;
    const chain = await source.resolveTransformerChain('a');
    expect(chain.providerTransformers.map((t) => t.name)).toEqual(['reasoning']);
    // openai has no format transformer (its wire ≡ the unified IR pivot).
    expect(await source.getMainTransformer('a')).toBeNull();
  });

  it('back-compat: a row with no transformer.use → EMPTY chain (format alone via getMainTransformer)', async () => {
    await bootDaemon((b) => [{ id: 'a', apiFormat: 'anthropic', baseUrl: b, apiKey: 'sk-a' }]);
    const source = daemon.llmConfig as unknown as ChainPort;
    const chain = await source.resolveTransformerChain('a');
    expect(chain.providerTransformers).toEqual([]);
    expect(chain.modelTransformers).toEqual([]);
    expect((await source.getMainTransformer('a'))?.name).toBe('anthropic');
  });

  it('lenient: an unknown transformer name is skipped (no crash); known ones still resolve', async () => {
    await bootDaemon((b) => [
      { id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-a', transformer: { use: ['reasoning', 'definitely-not-a-real-transformer'] } },
    ]);
    const source = daemon.llmConfig as unknown as ChainPort;
    const chain = await source.resolveTransformerChain('a');
    expect(chain.providerTransformers.map((t) => t.name)).toEqual(['reasoning']);
  });

  it('the stored transformer is still persisted verbatim (enforcement does not mutate config)', async () => {
    await bootDaemon((b) => [
      { id: 'a', apiFormat: 'anthropic', baseUrl: b, apiKey: 'sk-a', transformer: { use: ['reasoning'] } },
    ]);
    const persisted = loadConfig(join(tmpDir, 'config.json')).providers.find((x) => x.id === 'a')!;
    expect(persisted.transformer).toEqual({ use: ['reasoning'] });
  });

  it('ENFORCED: a model with enabled:false is dropped from the routed models[] (discovery gate)', async () => {
    await bootDaemon((b) => [
      {
        id: 'a',
        apiFormat: 'openai',
        baseUrl: b,
        apiKey: 'sk-a',
        models: ['m1', 'm2', 'm3'],
        modelConfigs: [{ id: 'm2', enabled: false }],
      },
    ]);
    const source = daemon.llmConfig as unknown as {
      getProvider: (id: string) => Promise<{ models: string[] } | null>;
    };
    const provider = await source.getProvider('a');
    // m2 (enabled:false) is gone from the ROUTED catalog; m1/m3 stay (no config = enabled).
    expect(provider?.models).toEqual(['m1', 'm3']);
    // The admin management VIEW still shows ALL models (toProviderView is unchanged —
    // disabling is a routing/discovery gate, not a deletion).
    const view = await adminFetch('GET', '/admin/api/providers');
    const p = (view.json as { providers: Array<{ id: string; models: string[] }> }).providers.find((x) => x.id === 'a')!;
    expect(p.models).toEqual(['m1', 'm2', 'm3']);
  });
});

// ── provider display name (app-parity-2 child 1) ────────────────────────────────

describe('provider display name (app-parity-2 child 1)', () => {
  it('absent name reads as undefined on GET (app falls back to id)', async () => {
    await bootDaemon((b) => [{ id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-a' }]);
    const r = await adminFetch('GET', '/admin/api/providers');
    const p = (r.json as { providers: Array<Record<string, unknown>> }).providers.find((x) => x['id'] === 'a')!;
    expect(p['name']).toBeUndefined();
  });

  it('round-trips a name written in config (back-compat load)', async () => {
    await bootDaemon((b) => [{ id: 'a', name: 'My OpenAI', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-a' }]);
    const r = await adminFetch('GET', '/admin/api/providers');
    const p = (r.json as { providers: Array<Record<string, unknown>> }).providers.find((x) => x['id'] === 'a')!;
    expect(p['name']).toBe('My OpenAI');
  });

  it('sets a name via PUT and reflects it on the next GET', async () => {
    await bootDaemon((b) => [{ id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-a' }]);
    const put = await adminFetch('PUT', '/admin/api/providers/a', {
      apiFormat: 'openai',
      baseUrl: base(),
      name: 'Renamed',
    });
    expect(put.status).toBe(200);
    const list = await adminFetch('GET', '/admin/api/providers');
    const p = (list.json as { providers: Array<Record<string, unknown>> }).providers.find((x) => x['id'] === 'a')!;
    expect(p['name']).toBe('Renamed');
    // Persisted to disk too.
    const persisted = loadConfig(join(tmpDir, 'config.json')).providers.find((x) => x.id === 'a')!;
    expect(persisted.name).toBe('Renamed');
  });

  it('an omitted name on a later edit keeps the stored value', async () => {
    await bootDaemon((b) => [{ id: 'a', name: 'Keep Me', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-a' }]);
    await adminFetch('PUT', '/admin/api/providers/a', {
      apiFormat: 'openai',
      baseUrl: base(),
      models: ['m1'], // unrelated edit, no `name` key
    });
    const persisted = loadConfig(join(tmpDir, 'config.json')).providers.find((x) => x.id === 'a')!;
    expect(persisted.name).toBe('Keep Me');
  });

  it('an explicit null clears the stored name', async () => {
    await bootDaemon((b) => [{ id: 'a', name: 'Clear Me', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-a' }]);
    await adminFetch('PUT', '/admin/api/providers/a', {
      apiFormat: 'openai',
      baseUrl: base(),
      name: null,
    });
    const persisted = loadConfig(join(tmpDir, 'config.json')).providers.find((x) => x.id === 'a')!;
    expect(persisted.name).toBeUndefined();
  });

  it('the id is IMMUTABLE on PUT — a body id is ignored (no silent rename/orphan)', async () => {
    await bootDaemon((b) => [{ id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-a' }]);
    // Attempt to rename via a forged body id on the `/a` slot.
    const put = await adminFetch('PUT', '/admin/api/providers/a', {
      id: 'evil',
      apiFormat: 'openai',
      baseUrl: base(),
      name: 'still-a',
    });
    expect(put.status).toBe(200);
    // The returned + persisted provider is STILL `a` — no `evil` row was created.
    expect((put.json as { provider: { id: string } }).provider.id).toBe('a');
    const cfg = loadConfig(join(tmpDir, 'config.json'));
    expect(cfg.providers.map((p) => p.id).sort()).toEqual(['a']);
    expect(cfg.providers.find((p) => p.id === 'a')!.name).toBe('still-a');
  });
});

// ── coding-plan endpoint (app-parity-2 child 3, SECRETS) ────────────────────────

describe('coding-plan endpoint (app-parity-2 child 3)', () => {
  /** The coding-plan endpoint's REAL key — must never appear in any GET / on disk plaintext. */
  const CODING_PLAN_SENTINEL = 'sk-codingplan-SENTINEL-secret-4242';

  it('NO LEAK + masked view: PUT a coding-plan key, GET returns only hasApiKey (never the key)', async () => {
    await bootDaemon((b) => [{ id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-a' }]);
    const put = await adminFetch('PUT', '/admin/api/providers/a', {
      apiFormat: 'openai',
      baseUrl: base(),
      codingPlan: { enabled: true, baseUrl: 'https://coding.example/v1', apiKey: CODING_PLAN_SENTINEL, note: 'Pro' },
    });
    expect(put.status).toBe(200);
    // The PUT response (masked DTO) must not echo the key.
    expect(put.text).not.toContain(CODING_PLAN_SENTINEL);
    const list = await adminFetch('GET', '/admin/api/providers');
    expect(list.text).not.toContain(CODING_PLAN_SENTINEL);
    const p = (list.json as { providers: Array<{ id: string; codingPlan?: Record<string, unknown> }> }).providers.find((x) => x.id === 'a')!;
    expect(p.codingPlan).toEqual({ enabled: true, baseUrl: 'https://coding.example/v1', hasApiKey: true, note: 'Pro' });
    // No `apiKey` key on the view at all.
    expect(Object.keys(p.codingPlan!)).not.toContain('apiKey');
  });

  it('AT-REST: the coding-plan key is encrypted on disk (enc:), never plaintext', async () => {
    await bootDaemon((b) => [{ id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-a' }]);
    await adminFetch('PUT', '/admin/api/providers/a', {
      apiFormat: 'openai',
      baseUrl: base(),
      codingPlan: { enabled: true, baseUrl: 'https://coding.example/v1', apiKey: CODING_PLAN_SENTINEL },
    });
    const raw = readFileSync(join(tmpDir, 'config.json'), 'utf8');
    // Plaintext sentinel is NEVER on disk; the codingPlan key is an `enc:` envelope.
    expect(raw).not.toContain(CODING_PLAN_SENTINEL);
    expect(raw).toContain('enc:');
    // …and loadConfig (with the box set) decrypts it back to the literal (round-trip).
    const cfg = loadConfig(join(tmpDir, 'config.json'));
    expect(cfg.providers.find((x) => x.id === 'a')!.codingPlan?.apiKey).toBe(CODING_PLAN_SENTINEL);
  });

  it('blank-keeps: an empty apiKey on a later edit keeps the stored coding-plan key', async () => {
    await bootDaemon((b) => [{ id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-a' }]);
    await adminFetch('PUT', '/admin/api/providers/a', {
      apiFormat: 'openai',
      baseUrl: base(),
      codingPlan: { enabled: true, baseUrl: 'https://coding.example/v1', apiKey: CODING_PLAN_SENTINEL },
    });
    // Edit again, toggling note but leaving the coding-plan key blank.
    await adminFetch('PUT', '/admin/api/providers/a', {
      apiFormat: 'openai',
      baseUrl: base(),
      codingPlan: { enabled: true, baseUrl: 'https://coding.example/v1', apiKey: '', note: 'Lite' },
    });
    const cfg = loadConfig(join(tmpDir, 'config.json'));
    const cp = cfg.providers.find((x) => x.id === 'a')!.codingPlan!;
    expect(cp.apiKey).toBe(CODING_PLAN_SENTINEL); // kept
    expect(cp.note).toBe('Lite'); // updated
  });

  it('ENFORCED by core: getProvider populates codingPlan; resolveProviderEndpoint routes via it', async () => {
    await bootDaemon((b) => [{ id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-main' }]);
    await adminFetch('PUT', '/admin/api/providers/a', {
      apiFormat: 'openai',
      baseUrl: base(),
      codingPlan: { enabled: true, baseUrl: 'https://coding.example/v1', apiKey: CODING_PLAN_SENTINEL },
    });
    const source = daemon.llmConfig as unknown as {
      getProvider: (id: string) => Promise<import('@omnicross/contracts/llm-config').LLMProvider | null>;
    };
    const provider = await source.getProvider('a');
    expect(provider).not.toBeNull();
    // The daemon populated LLMProvider.codingPlan; core's shared resolver enforces it.
    const resolved = resolveProviderEndpoint(provider!);
    expect(resolved.source).toBe('legacy-coding-plan');
    expect(resolved.baseUrl).toBe('https://coding.example/v1');
    expect(resolved.apiKey).toBe(CODING_PLAN_SENTINEL);
  });

  it('coding-plan key empty → resolver falls back to the provider main key', async () => {
    await bootDaemon((b) => [{ id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-main' }]);
    await adminFetch('PUT', '/admin/api/providers/a', {
      apiFormat: 'openai',
      baseUrl: base(),
      codingPlan: { enabled: true, baseUrl: 'https://coding.example/v1' }, // no key
    });
    const source = daemon.llmConfig as unknown as {
      getProvider: (id: string) => Promise<import('@omnicross/contracts/llm-config').LLMProvider | null>;
    };
    const resolved = resolveProviderEndpoint((await source.getProvider('a'))!);
    expect(resolved.baseUrl).toBe('https://coding.example/v1'); // coding-plan URL
    expect(resolved.apiKey).toBe('sk-main'); // fell back to the main key
  });

  it('back-compat: no coding-plan → GET omits it, resolver uses the plain endpoint', async () => {
    await bootDaemon((b) => [{ id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-main' }]);
    const list = await adminFetch('GET', '/admin/api/providers');
    const p = (list.json as { providers: Array<{ id: string; codingPlan?: unknown }> }).providers.find((x) => x.id === 'a')!;
    expect(p.codingPlan).toBeUndefined();
    const source = daemon.llmConfig as unknown as {
      getProvider: (id: string) => Promise<import('@omnicross/contracts/llm-config').LLMProvider | null>;
    };
    const resolved = resolveProviderEndpoint((await source.getProvider('a'))!);
    expect(resolved.source).toBe('plain');
  });

  it('explicit null clears the coding-plan', async () => {
    await bootDaemon((b) => [{ id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-a', codingPlan: { enabled: true, baseUrl: 'https://coding.example/v1', apiKey: CODING_PLAN_SENTINEL } }]);
    await adminFetch('PUT', '/admin/api/providers/a', { apiFormat: 'openai', baseUrl: base(), codingPlan: null });
    const cfg = loadConfig(join(tmpDir, 'config.json'));
    expect(cfg.providers.find((x) => x.id === 'a')!.codingPlan).toBeUndefined();
  });
});

// ── API modes (app-parity-2 child 4, SECRETS) ───────────────────────────────────

describe('API modes (app-parity-2 child 4)', () => {
  /** A mode's REAL key — must never leak on GET / disk plaintext. */
  const MODE_KEY = 'sk-apimode-SENTINEL-secret-7777';
  type GetProviderPort = {
    getProvider: (id: string) => Promise<import('@omnicross/contracts/llm-config').LLMProvider | null>;
  };

  it('NO LEAK + masked view: per-mode keys return only hasApiKey (never the key)', async () => {
    await bootDaemon((b) => [
      {
        id: 'a',
        apiFormat: 'openai',
        baseUrl: b,
        apiKey: 'sk-main',
        apiModes: [
          { id: 'standard', label: 'Standard', baseUrl: b },
          { id: 'coding', label: 'Coding Plan', baseUrl: 'https://coding.example/v1', apiKey: MODE_KEY, apiKeyPrefix: 'sk-cp-' },
        ],
        selectedApiModeId: 'standard',
      },
    ]);
    const list = await adminFetch('GET', '/admin/api/providers');
    expect(list.text).not.toContain(MODE_KEY);
    const p = (list.json as { providers: Array<{ id: string; apiModes?: Array<Record<string, unknown>>; selectedApiModeId?: string }> }).providers.find((x) => x.id === 'a')!;
    expect(p.selectedApiModeId).toBe('standard');
    const coding = p.apiModes!.find((m) => m['id'] === 'coding')!;
    expect(coding).toEqual({ id: 'coding', label: 'Coding Plan', baseUrl: 'https://coding.example/v1', hasApiKey: true, apiKeyPrefix: 'sk-cp-', note: undefined });
    expect(Object.keys(coding)).not.toContain('apiKey');
  });

  it('AT-REST: per-mode keys are encrypted on disk (enc:), never plaintext', async () => {
    await bootDaemon((b) => [{ id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-a' }]);
    await adminFetch('PUT', '/admin/api/providers/a', {
      apiFormat: 'openai',
      baseUrl: base(),
      apiModes: [{ id: 'coding', label: 'Coding', baseUrl: 'https://coding.example/v1', apiKey: MODE_KEY }],
      selectedApiModeId: 'coding',
    });
    const raw = readFileSync(join(tmpDir, 'config.json'), 'utf8');
    expect(raw).not.toContain(MODE_KEY);
    expect(raw).toContain('enc:');
    const cfg = loadConfig(join(tmpDir, 'config.json'));
    expect(cfg.providers.find((x) => x.id === 'a')!.apiModes!.find((m) => m.id === 'coding')!.apiKey).toBe(MODE_KEY);
  });

  it('ENFORCED by core: selected api-mode wins (source api-mode, over codingPlan)', async () => {
    await bootDaemon((b) => [
      {
        id: 'a',
        apiFormat: 'openai',
        baseUrl: 'https://coding.example/v1',
        apiKey: 'sk-main',
        apiModes: [{ id: 'coding', label: 'Coding', baseUrl: 'https://coding.example/v1', apiKey: MODE_KEY }],
        selectedApiModeId: 'coding',
        // a legacy codingPlan ALSO present — apiModes (layer 1) must win over it (layer 2).
        codingPlan: { enabled: true, baseUrl: 'https://legacy.example/v1', apiKey: 'sk-legacy' },
      },
    ]);
    const source = daemon.llmConfig as unknown as GetProviderPort;
    const provider = await source.getProvider('a');
    const resolved = resolveProviderEndpoint(provider!);
    expect(resolved.source).toBe('api-mode');
    expect(resolved.resolvedModeId).toBe('coding');
  });

  it('server-side key-sync on a normal switch (masked key synced from the mode)', async () => {
    await bootDaemon((b) => [
      {
        id: 'a',
        apiFormat: 'openai',
        baseUrl: b,
        apiKey: 'sk-main',
        apiModes: [
          { id: 'standard', label: 'Standard', baseUrl: b },
          { id: 'coding', label: 'Coding', baseUrl: 'https://coding.example/v1', apiKey: MODE_KEY },
        ],
        selectedApiModeId: 'standard',
      },
    ]);
    // App's normal switch: sends the mode's baseUrl (non-secret) + selectedApiModeId,
    // NO apiKey (masked). The daemon syncs the mode's stored key server-side.
    await adminFetch('PUT', '/admin/api/providers/a', {
      apiFormat: 'openai',
      baseUrl: 'https://coding.example/v1',
      selectedApiModeId: 'coding',
    });
    const cfg = loadConfig(join(tmpDir, 'config.json'));
    const row = cfg.providers.find((x) => x.id === 'a')!;
    expect(row.selectedApiModeId).toBe('coding');
    expect(row.baseUrl).toBe('https://coding.example/v1'); // synced app-side
    expect(row.apiKey).toBe(MODE_KEY); // synced server-side from the mode (was 'sk-main')
  });

  it('keepCustomizations: switching WITHOUT a baseUrl keeps the existing key', async () => {
    await bootDaemon((b) => [
      {
        id: 'a',
        apiFormat: 'openai',
        baseUrl: b,
        apiKey: 'sk-main',
        apiModes: [
          { id: 'standard', label: 'Standard', baseUrl: b },
          { id: 'coding', label: 'Coding', baseUrl: 'https://coding.example/v1', apiKey: MODE_KEY },
        ],
        selectedApiModeId: 'standard',
      },
    ]);
    // keepCustomizations: only selectedApiModeId (no baseUrl) → key untouched.
    await adminFetch('PUT', '/admin/api/providers/a', {
      apiFormat: 'openai',
      baseUrl: base(),
      selectedApiModeId: 'coding',
    });
    // base() === the boot baseUrl `b`, i.e. NOT the coding mode's URL → this models
    // "kept the standard URL"; the daemon must NOT sync the coding key.
    const row = loadConfig(join(tmpDir, 'config.json')).providers.find((x) => x.id === 'a')!;
    expect(row.selectedApiModeId).toBe('coding');
    expect(row.apiKey).toBe('sk-main'); // NOT synced (baseUrl != a switch to the mode's URL is irrelevant; the guard is "key untouched unless mode has its own + this is a switch")
  });

  it('back-compat: no apiModes → GET omits them, resolver uses plain', async () => {
    await bootDaemon((b) => [{ id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-main' }]);
    const list = await adminFetch('GET', '/admin/api/providers');
    const p = (list.json as { providers: Array<{ id: string; apiModes?: unknown; selectedApiModeId?: unknown }> }).providers.find((x) => x.id === 'a')!;
    expect(p.apiModes).toBeUndefined();
    expect(p.selectedApiModeId).toBeUndefined();
    const source = daemon.llmConfig as unknown as GetProviderPort;
    expect(resolveProviderEndpoint((await source.getProvider('a'))!).source).toBe('plain');
  });

  it('explicit null clears selectedApiModeId', async () => {
    await bootDaemon((b) => [{ id: 'a', apiFormat: 'openai', baseUrl: b, apiKey: 'sk-a', apiModes: [{ id: 'm1', label: 'M1', baseUrl: b }], selectedApiModeId: 'm1' }]);
    await adminFetch('PUT', '/admin/api/providers/a', { apiFormat: 'openai', baseUrl: base(), selectedApiModeId: null });
    expect(loadConfig(join(tmpDir, 'config.json')).providers.find((x) => x.id === 'a')!.selectedApiModeId).toBeUndefined();
  });
});
