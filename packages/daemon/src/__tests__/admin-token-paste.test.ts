/**
 * admin-token-paste.test.ts — the RT3 dashboard's subscription-token WRITE gate
 * (the `omnicross-daemon-token-paste` change, design D5).
 *
 * Proves the secret-IN-never-OUT invariant for the NEW write path
 * (`PUT|POST|DELETE /admin/api/accounts/:providerId`) end-to-end IN PROCESS:
 *  - a sentinel token is POSTed (secret flows IN),
 *  - read-after-write: `daemon.credentialStore.getFullConfig()` reflects it with no
 *    restart (the no-cache store),
 *  - the EXTENDED SECRET-SCAN: after the write, EVERY GET (incl. `GET /`) is scanned
 *    and the sentinel token is ABSENT (secret never flows OUT),
 *  - negative cases (unknown provider / malformed body / no-bearer-when-gated),
 *  - DELETE clears the block (subsequent read no longer returns the credential).
 *
 * The existing `admin-dashboard.test.ts` covers the READ path + the seeded-token
 * scan; this file adds the WRITE axis (POST a sentinel → scan).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadServerConfig } from '@omnicross/core/outbound-api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildDaemon, type Daemon, resetDaemonSingletonsForTests } from '../bootstrap';
import { loadConfig } from '../config';

/** The token the write path persists — must NEVER appear in any GET response. */
const SENTINEL_WRITE_TOKEN = 'SENTINEL-PASTE-TOKEN';
const SENTINEL_REFRESH_TOKEN = 'SENTINEL-PASTE-REFRESH';

// ── Mock upstream provider (inline — boot needs a reachable provider base) ──────

const CANNED_COMPLETION = {
  id: 'chatcmpl-paste-mock',
  object: 'chat.completion',
  created: 1,
  model: 'mock-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

interface MockUpstream {
  server: Server;
  port: number;
}

function startMockUpstream(): Promise<MockUpstream> {
  const state: MockUpstream = { server: undefined as unknown as Server, port: 0 };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
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

function writeConfig(configPath: string, providerBase: string, tok?: string): void {
  const cfg: Record<string, unknown> = {
    providers: [
      { id: 'mock', apiFormat: 'openai', baseUrl: providerBase, apiKey: 'sk-mock-zzz', models: ['mock-model'] },
    ],
    server: {
      enabled: true,
      networkBinding: false,
      port: 0,
      endpoints: [
        { endpoint: 'chat', defaultModel: 'mock,mock-model', backgroundModel: 'mock,mock-model', useSubscription: false },
      ],
    },
    admin: tok ? { port: 0, token: tok } : { port: 0 },
  };
  writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
}

async function bootDaemon(tok?: string): Promise<void> {
  resetDaemonSingletonsForTests();
  upstream = await startMockUpstream();
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-paste-'));
  const configPath = join(tmpDir, 'config.json');
  const keysPath = join(tmpDir, 'keys.json');
  const tokensPath = join(tmpDir, 'tokens.json');
  writeConfig(configPath, `http://127.0.0.1:${upstream.port}/v1`, tok);

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

  adminToken = tok;
  await daemon.adminServer.start();
  adminBase = daemon.adminServer.getStatus().url as string;
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

// ── Write path (no token gate) ─────────────────────────────────────────────────

describe('omnicross admin token-paste (write path, no gate)', () => {
  beforeEach(async () => {
    await bootDaemon();
  });

  it('PUT /admin/api/accounts/codex writes a token and returns token-free status', async () => {
    const r = await adminFetch('PUT', '/admin/api/accounts/codex', {
      authMethod: 'oauth',
      status: 'authorized',
      accessToken: SENTINEL_WRITE_TOKEN,
      refreshToken: SENTINEL_REFRESH_TOKEN,
    });
    expect(r.status).toBe(200);
    // STATUS-ONLY response — never the body / token.
    expect(r.text).not.toContain(SENTINEL_WRITE_TOKEN);
    expect(r.text).not.toContain(SENTINEL_REFRESH_TOKEN);
    expect(r.text).not.toContain('accessToken');
  });

  it('read-after-write: getFullConfig() reflects the written token (no restart, no cache)', async () => {
    await adminFetch('PUT', '/admin/api/accounts/codex', {
      authMethod: 'oauth',
      status: 'authorized',
      accessToken: SENTINEL_WRITE_TOKEN,
    });
    const cfg = await daemon.credentialStore.getFullConfig();
    expect(cfg.codex?.accessToken).toBe(SENTINEL_WRITE_TOKEN);
    expect(cfg.codex?.status).toBe('authorized');
    expect(cfg.updatedAt).toBeTruthy();
  });

  it('writing one provider preserves the others', async () => {
    await adminFetch('PUT', '/admin/api/accounts/claude', {
      authMethod: 'oauth',
      status: 'authorized',
      accessToken: 'CLAUDE-' + SENTINEL_WRITE_TOKEN,
    });
    await adminFetch('PUT', '/admin/api/accounts/opencodego', {
      authMethod: 'manual',
      status: 'configured',
      apiKey: 'OCG-' + SENTINEL_WRITE_TOKEN,
    });
    const cfg = await daemon.credentialStore.getFullConfig();
    expect(cfg.claude?.accessToken).toBe('CLAUDE-' + SENTINEL_WRITE_TOKEN);
    expect(cfg.opencodego?.apiKey).toBe('OCG-' + SENTINEL_WRITE_TOKEN);
  });

  it('opencodego write round-trips zenBaseUrl (+ baseUrl) into tokens.json, status DTO token-free', async () => {
    const r = await adminFetch('PUT', '/admin/api/accounts/opencodego', {
      authMethod: 'manual',
      status: 'configured',
      apiKey: 'OCG-' + SENTINEL_WRITE_TOKEN,
      baseUrl: 'https://my-go.example.com',
      zenBaseUrl: 'https://my-zen.example.com',
    });
    expect(r.status).toBe(200);
    // STATUS-ONLY response — never the apiKey / hosts leaked back.
    expect(r.text).not.toContain(SENTINEL_WRITE_TOKEN);
    expect(r.text).not.toContain('apiKey');
    expect(r.text).not.toContain('zenBaseUrl');
    // read-after-write: BOTH per-half host overrides persisted (zenBaseUrl is no
    // longer silently dropped by the validateOpenCodeGo allowlist).
    const cfg = await daemon.credentialStore.getFullConfig();
    expect(cfg.opencodego?.apiKey).toBe('OCG-' + SENTINEL_WRITE_TOKEN);
    expect(cfg.opencodego?.baseUrl).toBe('https://my-go.example.com');
    expect(cfg.opencodego?.zenBaseUrl).toBe('https://my-zen.example.com');
  });

  it('GET /admin/api/accounts reflects authorized status but carries NO token', async () => {
    await adminFetch('PUT', '/admin/api/accounts/codex', {
      authMethod: 'oauth',
      status: 'authorized',
      accessToken: SENTINEL_WRITE_TOKEN,
    });
    const r = await adminFetch('GET', '/admin/api/accounts');
    expect(r.status).toBe(200);
    const accounts = (r.json as { accounts: Array<{ providerId: string; credentialStatus: { ok: boolean } }> }).accounts;
    const codex = accounts.find((a) => a.providerId === 'codex')!;
    expect(codex).toBeTruthy();
    expect(codex.credentialStatus.ok).toBe(true); // authorized
    expect(r.text).not.toContain(SENTINEL_WRITE_TOKEN);
  });

  it('EXTENDED SECRET-SCAN — after the write, NO GET (incl. GET /) leaks the sentinel', async () => {
    await adminFetch('PUT', '/admin/api/accounts/codex', {
      authMethod: 'oauth',
      status: 'authorized',
      accessToken: SENTINEL_WRITE_TOKEN,
      refreshToken: SENTINEL_REFRESH_TOKEN,
    });

    for (const path of [
      '/admin/api/providers',
      '/admin/api/keys',
      '/admin/api/server',
      '/admin/api/accounts',
      '/admin/api/status',
    ]) {
      const r = await adminFetch('GET', path);
      expect(r.text, `${path} must not leak the pasted access token`).not.toContain(SENTINEL_WRITE_TOKEN);
      expect(r.text, `${path} must not leak the pasted refresh token`).not.toContain(SENTINEL_REFRESH_TOKEN);
    }

    // GET / (the dashboard HTML) likewise carries no token.
    const html = await fetch(`${adminBase}/`);
    const htmlText = await html.text();
    expect(htmlText).not.toContain(SENTINEL_WRITE_TOKEN);
    expect(htmlText).not.toContain(SENTINEL_REFRESH_TOKEN);
  });

  it('rejects an unknown providerId with 400 (no write)', async () => {
    const r = await adminFetch('PUT', '/admin/api/accounts/unknownprov', {
      authMethod: 'oauth',
      status: 'authorized',
      accessToken: SENTINEL_WRITE_TOKEN,
    });
    expect(r.status).toBe(400);
    const cfg = await daemon.credentialStore.getFullConfig();
    // No block written for the unknown id (and codex untouched).
    expect((cfg as Record<string, unknown>)['unknownprov']).toBeUndefined();
  });

  it('rejects a malformed body with 400 (no write)', async () => {
    // Missing required `status`.
    const r = await adminFetch('PUT', '/admin/api/accounts/claude', { authMethod: 'oauth' });
    expect(r.status).toBe(400);
    const cfg = await daemon.credentialStore.getFullConfig();
    expect(cfg.claude).toBeUndefined();
  });

  it('rejects opencodego with a non-manual authMethod (narrower shape) with 400', async () => {
    const r = await adminFetch('PUT', '/admin/api/accounts/opencodego', {
      authMethod: 'oauth', // opencodego is manual-only
      status: 'configured',
      apiKey: SENTINEL_WRITE_TOKEN,
    });
    expect(r.status).toBe(400);
  });

  it('DELETE /admin/api/accounts/codex clears the block (read no longer returns it)', async () => {
    await adminFetch('PUT', '/admin/api/accounts/codex', {
      authMethod: 'oauth',
      status: 'authorized',
      accessToken: SENTINEL_WRITE_TOKEN,
    });
    expect((await daemon.credentialStore.getFullConfig()).codex?.accessToken).toBe(SENTINEL_WRITE_TOKEN);

    const del = await adminFetch('DELETE', '/admin/api/accounts/codex');
    expect(del.status).toBe(200);
    expect((del.json as { ok: boolean }).ok).toBe(true);

    const after = await daemon.credentialStore.getFullConfig();
    expect(after.codex).toBeUndefined();
  });

  it('POST is accepted as a PUT alias', async () => {
    const r = await adminFetch('POST', '/admin/api/accounts/gemini', {
      authMethod: 'oauth',
      status: 'authorized',
      accessToken: SENTINEL_WRITE_TOKEN,
    });
    expect(r.status).toBe(200);
    expect((await daemon.credentialStore.getFullConfig()).gemini?.accessToken).toBe(SENTINEL_WRITE_TOKEN);
  });
});

// ── Multi-account secret-IN-never-OUT scan + switch/delete (subscription-multi-account 11.3) ──

describe('omnicross admin multi-account (secret scan + switch/delete)', () => {
  const SENTINEL_ACC1 = 'SENTINEL-ACCOUNT-ONE-AT';
  const SENTINEL_ACC2 = 'SENTINEL-ACCOUNT-TWO-AT';
  const SENTINEL_RT1 = 'SENTINEL-ACCOUNT-ONE-RT';
  const SENTINEL_RT2 = 'SENTINEL-ACCOUNT-TWO-RT';

  beforeEach(async () => {
    await bootDaemon();
    // Seed two claude accounts with UNIQUE sentinel tokens (login-append path).
    await daemon.credentialStore.appendProviderAccount(
      'claude',
      { authMethod: 'oauth', status: 'authorized', accessToken: SENTINEL_ACC1, refreshToken: SENTINEL_RT1 },
      'Personal',
    );
    await daemon.credentialStore.appendProviderAccount(
      'claude',
      { authMethod: 'oauth', status: 'authorized', accessToken: SENTINEL_ACC2, refreshToken: SENTINEL_RT2 },
      'Work',
    );
  });

  it('NO admin GET (incl. /admin/api/accounts + dashboard HTML) leaks any sentinel or enc:v1: envelope', async () => {
    for (const path of [
      '/admin/api/providers',
      '/admin/api/keys',
      '/admin/api/server',
      '/admin/api/accounts',
      '/admin/api/status',
    ]) {
      const r = await adminFetch('GET', path);
      for (const sentinel of [SENTINEL_ACC1, SENTINEL_ACC2, SENTINEL_RT1, SENTINEL_RT2]) {
        expect(r.text, `${path} must not leak ${sentinel}`).not.toContain(sentinel);
      }
      expect(r.text, `${path} must not leak an enc:v1: envelope`).not.toContain('enc:v1:');
    }
    const html = await (await fetch(`${adminBase}/`)).text();
    for (const sentinel of [SENTINEL_ACC1, SENTINEL_ACC2, SENTINEL_RT1, SENTINEL_RT2]) {
      expect(html).not.toContain(sentinel);
    }
    expect(html).not.toContain('enc:v1:');
  });

  it('GET /admin/api/accounts returns sanitized per-provider accounts (id/label/status/isActive, no token)', async () => {
    const r = await adminFetch('GET', '/admin/api/accounts');
    expect(r.status).toBe(200);
    const body = r.json as { providerAccounts: Record<string, Array<{ id: string; label?: string; status: string; isActive: boolean; hasAccessToken: boolean }>> };
    const claude = body.providerAccounts.claude;
    expect(claude).toHaveLength(2);
    expect(claude.filter((a) => a.isActive)).toHaveLength(1);
    for (const acc of claude) {
      expect(acc).not.toHaveProperty('accessToken');
      expect(acc).not.toHaveProperty('tokens');
      expect(acc.hasAccessToken).toBe(true);
    }
  });

  it('PUT /admin/api/accounts/claude/active switches the active account (STATUS-ONLY)', async () => {
    const list = await daemon.credentialStore.listSanitizedAccounts();
    const personal = list.claude.find((a) => a.label === 'Personal')!;
    const r = await adminFetch('PUT', '/admin/api/accounts/claude/active', { id: personal.id });
    expect(r.status).toBe(200);
    expect(r.text).not.toContain(SENTINEL_ACC1);
    const cfg = await daemon.credentialStore.getFullConfig();
    expect(cfg.activeClaudeAccountId).toBe(personal.id);
    expect(cfg.claude?.accessToken).toBe(SENTINEL_ACC1); // mirror followed the switch
  });

  it('PUT active with an unknown id → 404 (no change)', async () => {
    const r = await adminFetch('PUT', '/admin/api/accounts/claude/active', { id: 'nope' });
    expect(r.status).toBe(404);
  });

  it('DELETE /admin/api/accounts/claude/:accountId removes one account (STATUS-ONLY)', async () => {
    const list = await daemon.credentialStore.listSanitizedAccounts();
    const work = list.claude.find((a) => a.label === 'Work')!;
    const r = await adminFetch('DELETE', `/admin/api/accounts/claude/${work.id}`);
    expect(r.status).toBe(200);
    const after = await daemon.credentialStore.listSanitizedAccounts();
    expect(after.claude).toHaveLength(1);
    expect(after.claude[0].label).toBe('Personal');
  });
});

// ── Write path is auth-gated ────────────────────────────────────────────────────

describe('omnicross admin token-paste (auth gate)', () => {
  const TOKEN = 'paste-admin-TOKEN-xyz';

  beforeEach(async () => {
    await bootDaemon(TOKEN);
  });

  it('rejects a write with no bearer (401, no write)', async () => {
    const res = await fetch(`${adminBase}/admin/api/accounts/codex`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authMethod: 'oauth', status: 'authorized', accessToken: SENTINEL_WRITE_TOKEN }),
    });
    expect(res.status).toBe(401);
    const cfg = await daemon.credentialStore.getFullConfig();
    expect(cfg.codex).toBeUndefined();
  });

  it('rejects a write with a wrong bearer (401)', async () => {
    const r = await adminFetch('PUT', '/admin/api/accounts/codex', {
      authMethod: 'oauth',
      status: 'authorized',
      accessToken: SENTINEL_WRITE_TOKEN,
    }, 'WRONG-TOKEN');
    expect(r.status).toBe(401);
  });

  it('accepts a write with the matching bearer (200, token-free)', async () => {
    const r = await adminFetch('PUT', '/admin/api/accounts/codex', {
      authMethod: 'oauth',
      status: 'authorized',
      accessToken: SENTINEL_WRITE_TOKEN,
    }, TOKEN);
    expect(r.status).toBe(200);
    expect(r.text).not.toContain(SENTINEL_WRITE_TOKEN);
    expect((await daemon.credentialStore.getFullConfig()).codex?.accessToken).toBe(SENTINEL_WRITE_TOKEN);
  });
});
