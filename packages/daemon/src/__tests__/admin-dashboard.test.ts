/**
 * admin-dashboard.test.ts — the RT3 dashboard boot-smoke (design D9).
 *
 * Proves the admin server + management API end-to-end IN PROCESS (mirrors
 * `boot-smoke.test.ts`): a mock node:http upstream (canned completion, records
 * its auth header), a temp config.json with one seeded provider whose apiKey is
 * a known SENTINEL string, the outbound + admin servers started on ephemeral
 * ports. The load-bearing assertion is the SECRET-SCAN: no GET response ever
 * contains a known secret string.
 *
 * Covers: dashboard HTML, provider masking, key one-time plaintext + DTO
 * discipline, status, accounts (token-free), provider hot-reload, the token
 * auth gate, the LAN fail-closed gate, and the playground proxy.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadServerConfig } from '@omnicross/core/outbound-api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AdminServer } from '../admin/AdminServer';
import { buildDaemon, type Daemon, resetDaemonSingletonsForTests } from '../bootstrap';
import { loadConfig, saveConfig, setSecretBox } from '../config';
import { encryptTokens, resolveMasterKey, SecretBox } from '../secrets';

// ── Mock upstream provider ────────────────────────────────────────────────────

const CANNED_COMPLETION = {
  id: 'chatcmpl-admin-mock',
  object: 'chat.completion',
  created: 1,
  model: 'mock-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

/** The provider's REAL key — the cardinal secret the masking spine must hide. */
const PROVIDER_SENTINEL_KEY = 'sk-provider-SENTINEL-zzz9';
/** Sentinel subscription tokens seeded into tokens.json (must never appear in a GET). */
const SENTINEL_SUB_ACCESS_TOKEN = 'SENTINEL-SUB-ACCESS-TOKEN';
const SENTINEL_SUB_REFRESH_TOKEN = 'SENTINEL-SUB-REFRESH-TOKEN';

interface MockUpstream {
  server: Server;
  port: number;
  lastAuthHeader: string | undefined;
  hits: number;
}

function startMockUpstream(): Promise<MockUpstream> {
  const state: MockUpstream = { server: undefined as unknown as Server, port: 0, lastAuthHeader: undefined, hits: 0 };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      state.hits += 1;
      state.lastAuthHeader = req.headers['authorization'];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(CANNED_COMPLETION));
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

// ── Admin fetch helper ────────────────────────────────────────────────────────

let adminBase: string;
let adminToken: string | undefined;

async function adminFetch(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; text: string; json: unknown }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const tok = token ?? adminToken;
  if (tok) headers['Authorization'] = `Bearer ${tok}`;
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

interface BootOpts {
  /** When set, configures `admin.token` (the bearer gate). */
  adminToken?: string;
  /** When true, seed tokens.json with sentinel subscription access/refresh tokens. */
  seedSubTokens?: boolean;
  /** When true, ENCRYPT the seeded config.json + tokens.json at rest before boot
   *  (secrets at-rest scan net — proves the mask shows the DECRYPTED last4 and no
   *  `enc:v1:` envelope leaks into any GET). */
  preEncrypt?: boolean;
}

/** Encrypt the seeded config.json + tokens.json in place with a box keyed to the
 *  temp master.key (mirrors `secrets encrypt`). */
function preEncryptFiles(configPath: string, tokensPath: string, keyFile: string, seedSub: boolean): void {
  const box = new SecretBox(resolveMasterKey({ keyFilePath: keyFile }));
  setSecretBox(box);
  try {
    saveConfig(configPath, loadConfig(configPath)); // encrypt-on-write
  } finally {
    setSecretBox(null);
  }
  if (seedSub) {
    const raw = JSON.parse(readFileSync(tokensPath, 'utf8')) as Parameters<typeof encryptTokens>[0];
    writeFileSync(tokensPath, JSON.stringify(encryptTokens(raw, box), null, 2) + '\n', 'utf8');
  }
}

function writeConfig(configPath: string, providerBase: string, opts: BootOpts = {}): void {
  const cfg: Record<string, unknown> = {
    providers: [
      { id: 'mock', apiFormat: 'openai', baseUrl: providerBase, apiKey: PROVIDER_SENTINEL_KEY, models: ['mock-model'] },
    ],
    server: {
      enabled: true,
      networkBinding: false,
      port: 0,
      endpoints: [
        { endpoint: 'chat', models: ['mock,mock-model'], useSubscription: false },

        // messages/responses need complete kind maps or the startup gate refuses to bind.

        { endpoint: 'responses', modelMap: { codex: 'mock,mock-model', mini: 'mock,mock-model' }, useSubscription: false },

        {

          endpoint: 'messages',

          modelMap: { fable: 'mock,mock-model', opus: 'mock,mock-model', sonnet: 'mock,mock-model', haiku: 'mock,mock-model' },

          useSubscription: false,

        },
      ],
    },
  };
  // Ephemeral admin port (0) so parallel test runs never collide on 8766
  // (resolveAdminConfig honors an explicit 0 as "bind an ephemeral port").
  cfg['admin'] = opts.adminToken ? { port: 0, token: opts.adminToken } : { port: 0 };
  writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
}

/** Seed tokens.json with sentinel subscription tokens (M2 secret-scan net). */
function writeTokens(tokensPath: string): void {
  writeFileSync(
    tokensPath,
    JSON.stringify(
      {
        codex: {
          authMethod: 'oauth',
          status: 'authorized',
          accessToken: SENTINEL_SUB_ACCESS_TOKEN,
          refreshToken: SENTINEL_SUB_REFRESH_TOKEN,
        },
        updatedAt: '2026-06-03T00:00:00.000Z',
      },
      null,
      2,
    ),
    'utf8',
  );
}

async function bootDaemon(opts: BootOpts = {}): Promise<void> {
  resetDaemonSingletonsForTests();
  upstream = await startMockUpstream();
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-admin-'));
  const configPath = join(tmpDir, 'config.json');
  const keysPath = join(tmpDir, 'keys.json');
  const tokensPath = join(tmpDir, 'tokens.json');
  writeConfig(configPath, `http://127.0.0.1:${upstream.port}/v1`, opts);
  if (opts.seedSubTokens) writeTokens(tokensPath);
  if (opts.preEncrypt) {
    preEncryptFiles(configPath, tokensPath, join(tmpDir, 'master.key'), opts.seedSubTokens === true);
  }

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

  adminToken = opts.adminToken;
  await daemon.adminServer.start();
  const adminStatus = daemon.adminServer.getStatus();
  adminBase = adminStatus.url as string;
}

afterEach(async () => {
  if (daemon) {
    await daemon.adminServer.stop();
    await daemon.outboundApiServer.stop();
    await daemon.providerProxy.stop();
    daemon.apiKeyPool.dispose(); // stop the pool's cooldown-cleanup interval
  }
  if (upstream) await stopServer(upstream.server);
  resetDaemonSingletonsForTests();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  adminToken = undefined;
});

// ── Default (no-token) fixture ─────────────────────────────────────────────────

describe('omnicross admin dashboard (localhost, no token)', () => {
  beforeEach(async () => {
    await bootDaemon();
  });

  it('redirects GET / to the Control Panel at /ui/ (legacy dashboard removed)', async () => {
    const res = await fetch(`${adminBase}/`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/ui/');
  });

  it('masks the provider apiKey (SENTINEL absent, last4 shown, hasApiKey true)', async () => {
    const r = await adminFetch('GET', '/admin/api/providers');
    expect(r.status).toBe(200);
    expect(r.text).not.toContain(PROVIDER_SENTINEL_KEY);
    const providers = (r.json as { providers: Array<Record<string, unknown>> }).providers;
    const p = providers.find((x) => x['id'] === 'mock')!;
    expect(p['hasApiKey']).toBe(true);
    expect(String(p['apiKeyMasked'])).toContain('zzz9'); // last4
    expect(String(p['apiKeyMasked'])).not.toContain(PROVIDER_SENTINEL_KEY);
  });

  it('masks a $ENV apiKey without disclosing the var name', async () => {
    await adminFetch('PUT', '/admin/api/providers/mock', {
      apiFormat: 'openai',
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: '$MY_SECRET_ENV_VAR',
    });
    const r = await adminFetch('GET', '/admin/api/providers');
    expect(r.text).not.toContain('MY_SECRET_ENV_VAR');
    const p = (r.json as { providers: Array<Record<string, unknown>> }).providers.find((x) => x['id'] === 'mock')!;
    expect(p['hasApiKey']).toBe(true);
    expect(String(p['apiKeyMasked'])).not.toContain('MY_SECRET');
  });

  it('creates a key returning plaintextOnce, then list hides plaintext + keyHash', async () => {
    const created = await adminFetch('POST', '/admin/api/keys', { name: 'dash-key' });
    expect(created.status).toBe(201);
    const plaintext = (created.json as { plaintextOnce: string }).plaintextOnce;
    expect(plaintext).toMatch(/^sk-omnicross-/);

    const list = await adminFetch('GET', '/admin/api/keys');
    expect(list.text).not.toContain(plaintext);
    expect(list.text).not.toContain('keyHash');
    const keys = (list.json as { keys: Array<Record<string, unknown>> }).keys;
    const k = keys.find((x) => x['name'] === 'dash-key')!;
    expect(k).toBeTruthy();
    expect(k['keyHash']).toBeUndefined();
    expect('plaintextOnce' in k).toBe(false);
  });

  it('reports running status with the four format URLs', async () => {
    const r = await adminFetch('GET', '/admin/api/status');
    const s = r.json as { running: boolean; port: number; formats: Record<string, string> | null };
    expect(s.running).toBe(true);
    expect(s.port).toBeGreaterThan(0);
    expect(s.formats).toBeTruthy();
    expect(s.formats!.chat).toMatch(/\/v1\/chat\/completions$/);
    expect(s.formats!.responses).toMatch(/\/v1\/responses$/);
    expect(s.formats!.messages).toMatch(/\/v1\/messages$/);
    expect(s.formats!.gemini).toMatch(/generateContent$/);
  });

  it('lists accounts with NO token substrings', async () => {
    const r = await adminFetch('GET', '/admin/api/accounts');
    expect(r.status).toBe(200);
    const accounts = (r.json as { accounts: unknown[] }).accounts;
    expect(Array.isArray(accounts)).toBe(true);
    expect(accounts.length).toBeGreaterThan(0);
    expect(r.text).not.toContain('accessToken');
    expect(r.text).not.toContain('refreshToken');
    expect(r.text).not.toMatch(/sk-[A-Za-z0-9]{20,}/); // no long bearer shapes
  });

  it('hot-reloads a newly POSTed provider into the live catalog', async () => {
    const created = await adminFetch('POST', '/admin/api/providers', {
      id: 'newp',
      apiFormat: 'openai',
      baseUrl: 'http://127.0.0.1:2/v1',
      apiKey: 'sk-newp-secret',
    });
    expect(created.status).toBe(201);

    const list = await adminFetch('GET', '/admin/api/providers');
    const ids = (list.json as { providers: Array<{ id: string }> }).providers.map((p) => p.id);
    expect(ids).toContain('newp');

    // LIVE: the catalog resolves the new provider without a restart.
    const live = await daemon.llmConfig.getProvider('newp');
    expect(live).toBeTruthy();
    expect(live!.id).toBe('newp');
    // And the live secret never leaked via the GET.
    expect(list.text).not.toContain('sk-newp-secret');
  });

  it('PUT /admin/api/server round-trips a config change and applies it live', async () => {
    const before = await adminFetch('GET', '/admin/api/server');
    const beforeServer = (before.json as { server: { endpoints: Array<{ endpoint: string; useSubscription: boolean }> } }).server;
    const chatBefore = beforeServer.endpoints.find((e) => e.endpoint === 'chat')!;
    expect(chatBefore.useSubscription).toBe(false);

    // Flip the chat endpoint's useSubscription via a full endpoints patch.
    const patchedEndpoints = beforeServer.endpoints.map((e) =>
      e.endpoint === 'chat' ? { ...e, useSubscription: true } : e,
    );
    const put = await adminFetch('PUT', '/admin/api/server', { endpoints: patchedEndpoints });
    expect(put.status).toBe(200);
    const putServer = (put.json as { server: { endpoints: Array<{ endpoint: string; useSubscription: boolean }> } }).server;
    expect(putServer.endpoints.find((e) => e.endpoint === 'chat')!.useSubscription).toBe(true);

    // Persisted + reflected on the next GET (the live applyConfig ran).
    const after = await adminFetch('GET', '/admin/api/server');
    const afterServer = (after.json as { server: { endpoints: Array<{ endpoint: string; useSubscription: boolean }> } }).server;
    expect(afterServer.endpoints.find((e) => e.endpoint === 'chat')!.useSubscription).toBe(true);

    // applyConfig was invoked live — the outbound server is still running on its
    // ephemeral port (no bind/port change, so it stays up).
    const status = daemon.outboundApiServer.getStatus();
    expect(status.running).toBe(true);
    expect(status.port).toBeGreaterThan(0);
  });

  it('POST /admin/api/keys/:id/revoke revokes a key', async () => {
    const created = await adminFetch('POST', '/admin/api/keys', { name: 'to-revoke' });
    const { id, plaintextOnce } = created.json as { id: string; plaintextOnce: string };

    const revoke = await adminFetch('POST', `/admin/api/keys/${id}/revoke`);
    expect(revoke.status).toBe(200);

    const list = await adminFetch('GET', '/admin/api/keys');
    const k = (list.json as { keys: Array<{ id: string; revoked: boolean }> }).keys.find((x) => x.id === id)!;
    expect(k.revoked).toBe(true);

    // The revoked key no longer authenticates against the outbound server.
    const denied = await fetch(`${(daemon.outboundApiServer.getStatus().loopbackUrl as string)}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${plaintextOnce}` },
      body: JSON.stringify({ model: 'mock-model', messages: [] }),
    });
    expect(denied.status).toBe(401);
  });

  it('POST /admin/api/keys/:id/enabled {enabled:false} disables a key', async () => {
    const created = await adminFetch('POST', '/admin/api/keys', { name: 'to-disable' });
    const { id } = created.json as { id: string };

    const toggle = await adminFetch('POST', `/admin/api/keys/${id}/enabled`, { enabled: false });
    expect(toggle.status).toBe(200);

    const list = await adminFetch('GET', '/admin/api/keys');
    const k = (list.json as { keys: Array<{ id: string; enabled: boolean }> }).keys.find((x) => x.id === id)!;
    expect(k.enabled).toBe(false);
  });

  it('forwards a playground request to the outbound /v1/chat/completions', async () => {
    const created = await adminFetch('POST', '/admin/api/keys', { name: 'pg' });
    const key = (created.json as { plaintextOnce: string }).plaintextOnce;
    const hitsBefore = upstream.hits;

    const r = await adminFetch('POST', '/admin/api/playground', {
      endpoint: 'chat',
      key,
      body: { model: 'mock-model', messages: [{ role: 'user', content: 'ping' }] },
    });
    expect(r.status).toBe(200);
    expect(r.text).toContain('pong');
    // The mock upstream was hit once more, with the PROVIDER's real key (the
    // named key reached the outbound server; the provider key reached upstream).
    expect(upstream.hits).toBe(hitsBefore + 1);
    expect(upstream.lastAuthHeader).toBe(`Bearer ${PROVIDER_SENTINEL_KEY}`);
  });

  it('SECRET SCAN — no GET response contains any seeded secret', async () => {
    const created = await adminFetch('POST', '/admin/api/keys', { name: 'scan' });
    const plaintext = (created.json as { plaintextOnce: string }).plaintextOnce;
    for (const path of ['/admin/api/providers', '/admin/api/keys', '/admin/api/server', '/admin/api/accounts', '/admin/api/status']) {
      const r = await adminFetch('GET', path);
      expect(r.text, `${path} must not leak the provider key`).not.toContain(PROVIDER_SENTINEL_KEY);
      expect(r.text, `${path} must not leak the named-key plaintext`).not.toContain(plaintext);
      expect(r.text, `${path} must not leak keyHash`).not.toContain('keyHash');
    }
  });
});

// ── Full-spine secret scan (sub tokens + admin token seeded) ─────────────────────

describe('omnicross admin dashboard (full secret-scan net)', () => {
  const ADMIN_TOKEN = 'SENTINEL-ADMIN-TOKEN';

  beforeEach(async () => {
    await bootDaemon({ adminToken: ADMIN_TOKEN, seedSubTokens: true });
  });

  it('accounts GET carries status but neither sentinel subscription token', async () => {
    const r = await adminFetch('GET', '/admin/api/accounts', undefined, ADMIN_TOKEN);
    expect(r.status).toBe(200);
    const accounts = (r.json as { accounts: unknown[] }).accounts;
    expect(Array.isArray(accounts)).toBe(true);
    expect(accounts.length).toBeGreaterThan(0);
    expect(r.text).not.toContain(SENTINEL_SUB_ACCESS_TOKEN);
    expect(r.text).not.toContain(SENTINEL_SUB_REFRESH_TOKEN);
  });

  it('NO GET (incl. GET /) leaks the sub tokens OR the admin.token; bearer still works', async () => {
    // The bearer-gated requests still succeed with the matching token.
    const status = await adminFetch('GET', '/admin/api/status', undefined, ADMIN_TOKEN);
    expect(status.status).toBe(200);

    for (const path of ['/admin/api/providers', '/admin/api/keys', '/admin/api/server', '/admin/api/accounts', '/admin/api/status']) {
      const r = await adminFetch('GET', path, undefined, ADMIN_TOKEN);
      expect(r.status).toBe(200);
      expect(r.text, `${path} must not leak the sub access token`).not.toContain(SENTINEL_SUB_ACCESS_TOKEN);
      expect(r.text, `${path} must not leak the sub refresh token`).not.toContain(SENTINEL_SUB_REFRESH_TOKEN);
      expect(r.text, `${path} must not leak the admin.token`).not.toContain(ADMIN_TOKEN);
    }

    // GET / (the dashboard HTML) likewise carries no secret.
    const html = await fetch(`${adminBase}/`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
    const htmlText = await html.text();
    expect(htmlText).not.toContain(SENTINEL_SUB_ACCESS_TOKEN);
    expect(htmlText).not.toContain(SENTINEL_SUB_REFRESH_TOKEN);
    expect(htmlText).not.toContain(ADMIN_TOKEN);
  });
});

// ── Token-gated fixture ─────────────────────────────────────────────────────────

describe('omnicross admin dashboard (token gate)', () => {
  const TOKEN = 'admin-secret-TOKEN-123';

  beforeEach(async () => {
    await bootDaemon({ adminToken: TOKEN });
  });

  it('returns 401 without the bearer and 200 with it', async () => {
    const without = await fetch(`${adminBase}/admin/api/status`);
    expect(without.status).toBe(401);

    const withToken = await adminFetch('GET', '/admin/api/status', undefined, TOKEN);
    expect(withToken.status).toBe(200);
  });

  it('never echoes the admin.token in any response', async () => {
    for (const path of ['/admin/api/providers', '/admin/api/keys', '/admin/api/server', '/admin/api/accounts', '/admin/api/status']) {
      const r = await adminFetch('GET', path, undefined, TOKEN);
      expect(r.text).not.toContain(TOKEN);
    }
    const html = await fetch(`${adminBase}/`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(await html.text()).not.toContain(TOKEN);
  });
});

// ── LAN fail-closed gate (no full daemon needed) ─────────────────────────────────

describe('AdminServer LAN fail-closed gate', () => {
  const minimalDeps = {
    configPath: '',
    llmConfig: {} as never,
    keyDb: {} as never,
    settingsStore: {} as never,
    outboundApiServer: {} as never,
    subscriptionAccounts: { listAll: async () => [] },
    subscriptionTokenWriter: { writeProviderTokens: async () => {}, clearProvider: async () => {} },
    apiKeyPool: { getKeyHealth: async () => ({}) },
    autoDisableStore: {} as never,
  };

  it('refuses to bind 0.0.0.0 without an admin.token (fail closed)', async () => {
    const server = new AdminServer({
      ...minimalDeps,
      getAdminConfig: () => ({ enabled: true, port: 0, networkBinding: true, token: undefined }),
    });
    const port = await server.start();
    expect(port).toBe(0);
    expect(server.getStatus().running).toBe(false);
    await server.stop();
  });

  it('binds with a token when networkBinding is requested', async () => {
    const server = new AdminServer({
      ...minimalDeps,
      getAdminConfig: () => ({ enabled: true, port: 0, networkBinding: true, token: 'lan-token' }),
    });
    const port = await server.start();
    expect(port).toBeGreaterThan(0);
    expect(server.getStatus().running).toBe(true);
    await server.stop();
  });
});

// ── At-rest encrypted config/tokens (secrets tasks 5.5 + 5.8) ────────────────────
//
// The seeded config.json + tokens.json are ENCRYPTED on disk before boot. The
// load-bearing assertions: (1) the provider mask shows the DECRYPTED last4 (not
// envelope garbage); (2) NO admin GET (incl. GET /) leaks the plaintext secret
// OR an `enc:v1:` envelope; (3) the playground reaches the upstream with the
// DECRYPTED provider key (the encrypted-at-rest key round-trips through the
// outbound pool path to a real upstream request).

describe('omnicross admin dashboard (at-rest ENCRYPTED config + tokens)', () => {
  beforeEach(async () => {
    await bootDaemon({ preEncrypt: true, seedSubTokens: true });
  });

  it('masks the DECRYPTED provider key (real last4 shown, no envelope)', async () => {
    const r = await adminFetch('GET', '/admin/api/providers');
    expect(r.status).toBe(200);
    const p = (r.json as { providers: Array<Record<string, unknown>> }).providers.find((x) => x['id'] === 'mock')!;
    expect(p['hasApiKey']).toBe(true);
    // The mask is the DECRYPTED plaintext's last4 — NOT base64 envelope bytes.
    expect(String(p['apiKeyMasked'])).toContain('zzz9');
    expect(String(p['apiKeyMasked'])).not.toContain('enc:');
  });

  it('NO admin GET (incl. GET /) leaks plaintext OR an enc:v1: envelope', async () => {
    const created = await adminFetch('POST', '/admin/api/keys', { name: 'scan-enc' });
    const plaintext = (created.json as { plaintextOnce: string }).plaintextOnce;
    for (const path of [
      '/admin/api/providers',
      '/admin/api/providers/mock/keys',
      '/admin/api/keys',
      '/admin/api/server',
      '/admin/api/accounts',
      '/admin/api/status',
    ]) {
      const r = await adminFetch('GET', path);
      expect(r.text, `${path} must not leak the provider key`).not.toContain(PROVIDER_SENTINEL_KEY);
      expect(r.text, `${path} must not leak the named-key plaintext`).not.toContain(plaintext);
      expect(r.text, `${path} must not leak the sub access token`).not.toContain(SENTINEL_SUB_ACCESS_TOKEN);
      expect(r.text, `${path} must not leak the sub refresh token`).not.toContain(SENTINEL_SUB_REFRESH_TOKEN);
      expect(r.text, `${path} must not leak an enc:v1: envelope`).not.toContain('enc:v1:');
    }
    const html = await (await fetch(`${adminBase}/`)).text();
    expect(html).not.toContain('enc:v1:');
    expect(html).not.toContain(PROVIDER_SENTINEL_KEY);
  });

  it('playground reaches the upstream with the DECRYPTED provider key', async () => {
    const created = await adminFetch('POST', '/admin/api/keys', { name: 'pg-enc' });
    const key = (created.json as { plaintextOnce: string }).plaintextOnce;
    const hitsBefore = upstream.hits;
    const r = await adminFetch('POST', '/admin/api/playground', {
      endpoint: 'chat',
      key,
      body: { model: 'mock-model', messages: [{ role: 'user', content: 'ping' }] },
    });
    expect(r.status).toBe(200);
    expect(upstream.hits).toBe(hitsBefore + 1);
    // The encrypted-at-rest key decrypted back to the original plaintext upstream.
    expect(upstream.lastAuthHeader).toBe(`Bearer ${PROVIDER_SENTINEL_KEY}`);
  });
});
