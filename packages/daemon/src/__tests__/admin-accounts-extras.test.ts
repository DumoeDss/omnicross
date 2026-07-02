/**
 * admin-accounts-extras.test.ts — the daemon-side account capabilities added so
 * the dashboard's Accounts page works end-to-end (gaps G1–G4):
 *
 *  - G1: the sanitized account view projects the non-secret metadata
 *        (`authMethod` / `subscriptionLevel` / `lastRefreshedAt`).
 *  - G2: `POST /accounts/:providerId/accounts` APPENDS a new account (vs the
 *        generic write which REPLACES the active one) — the only multi-account
 *        path for the OAuth-less opencodego provider.
 *  - G3: `POST /accounts/:providerId/refresh` refreshes the active OAuth token
 *        (status-only `{ ok }`); opencodego is not refreshable.
 *  - G4: an optional `label` on append / OAuth-complete, and
 *        `POST /accounts/:providerId/:accountId/label` renames one account.
 *
 * SECRET SPINE re-asserted: every new route is status-only — the submitted /
 * minted token NEVER appears in a response body. The token-exchange + refresh
 * HTTP is the ONLY thing mocked (sentinel bodies on the claude/gemini endpoints).
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

const SENTINEL_AT = 'SENTINEL-OAUTH-ACCESS-TOKEN';
const SENTINEL_RT = 'SENTINEL-OAUTH-REFRESH-TOKEN';
const CLAUDE_TOKEN_ENDPOINT = 'https://console.anthropic.com/v1/oauth/token';
const GEMINI_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

let realFetch: typeof globalThis.fetch;
function installFetchMock(): void {
  realFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === CLAUDE_TOKEN_ENDPOINT || url === GEMINI_TOKEN_ENDPOINT) {
      return new Response(
        JSON.stringify({
          access_token: SENTINEL_AT,
          refresh_token: SENTINEL_RT,
          expires_in: 3600,
          scope: 'user:inference',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return realFetch(input, init);
  }) as typeof globalThis.fetch;
}
function restoreFetchMock(): void {
  if (realFetch) globalThis.fetch = realFetch;
}

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
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [] }));
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

let adminBase: string;
async function adminFetch(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string; json: unknown }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await globalThis.fetch(`${adminBase}${path}`, {
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

function writeConfig(configPath: string, providerBase: string): void {
  const cfg = {
    providers: [
      { id: 'mock', apiFormat: 'openai', baseUrl: providerBase, apiKey: 'sk-mock-zzz', models: ['mock-model'] },
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
    admin: { port: 0 },
  };
  writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
}

async function bootDaemon(): Promise<void> {
  resetDaemonSingletonsForTests();
  installFetchMock();
  upstream = await startMockUpstream();
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-acct-extras-'));
  const configPath = join(tmpDir, 'config.json');
  writeConfig(configPath, `http://127.0.0.1:${upstream.port}/v1`);
  const config = loadConfig(configPath);
  daemon = buildDaemon(config, {
    configPath,
    keysPath: join(tmpDir, 'keys.json'),
    tokensPath: join(tmpDir, 'tokens.json'),
    masterKeyFilePath: join(tmpDir, 'master.key'),
  });
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

/** The sanitized accounts for one provider (read-after-write through the store). */
async function sanitized(provider: string) {
  const all = await daemon.credentialStore.listSanitizedAccounts();
  return all[provider] ?? [];
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
  restoreFetchMock();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('account extras (G1–G4)', () => {
  beforeEach(async () => {
    await bootDaemon();
  });

  it('G2: append creates a SECOND opencodego account (vs the replacing PUT)', async () => {
    const a = await adminFetch('POST', '/admin/api/accounts/opencodego/accounts', {
      authMethod: 'manual',
      status: 'configured',
      apiKey: 'OCG-key-1',
      label: 'first',
    });
    expect(a.status).toBe(200);
    expect(a.text).not.toContain('OCG-key-1'); // status-only — key never echoed
    const b = await adminFetch('POST', '/admin/api/accounts/opencodego/accounts', {
      authMethod: 'manual',
      status: 'configured',
      apiKey: 'OCG-key-2',
      label: 'second',
    });
    expect(b.status).toBe(200);
    const accts = await sanitized('opencodego');
    expect(accts).toHaveLength(2);
    expect(accts.map((x) => x.label).sort()).toEqual(['first', 'second']);
    // The most-recent append is active.
    expect(accts.filter((x) => x.isActive)).toHaveLength(1);
    expect(accts.find((x) => x.isActive)?.label).toBe('second');
  });

  it('G1+G4: a manual append projects authMethod/subscriptionLevel + label in the sanitized view', async () => {
    await adminFetch('POST', '/admin/api/accounts/claude/accounts', {
      authMethod: 'manual',
      status: 'configured',
      accessToken: 'SENTINEL-MANUAL-AT',
      subscriptionLevel: 'Pro',
      label: 'work',
    });
    const [acct] = await sanitized('claude');
    expect(acct.label).toBe('work');
    expect(acct.authMethod).toBe('manual');
    expect(acct.subscriptionLevel).toBe('Pro');
    expect(acct.hasAccessToken).toBe(true);
  });

  it('G4: rename updates the label; an unknown id is 404', async () => {
    await adminFetch('POST', '/admin/api/accounts/opencodego/accounts', {
      authMethod: 'manual',
      status: 'configured',
      apiKey: 'OCG-rename',
    });
    const [acct] = await sanitized('opencodego');
    const ok = await adminFetch(
      'POST',
      `/admin/api/accounts/opencodego/${acct.id}/label`,
      { label: 'renamed-account' },
    );
    expect(ok.status).toBe(200);
    expect((await sanitized('opencodego'))[0].label).toBe('renamed-account');

    const missing = await adminFetch('POST', '/admin/api/accounts/opencodego/no-such-id/label', {
      label: 'x',
    });
    expect(missing.status).toBe(404);
  });

  it('G3: refresh the active claude OAuth token → status-only { ok: true }, token never leaks', async () => {
    // Seed an active claude account that HAS a refresh token (manual append).
    await adminFetch('POST', '/admin/api/accounts/claude/accounts', {
      authMethod: 'oauth',
      status: 'authorized',
      accessToken: 'OLD-AT',
      refreshToken: 'OLD-RT',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const r = await adminFetch('POST', '/admin/api/accounts/claude/refresh');
    expect(r.status).toBe(200);
    expect((r.json as { ok: boolean }).ok).toBe(true);
    // Status-only: neither the old nor the freshly-minted sentinel token leaks.
    expect(r.text).not.toContain('OLD-RT');
    expect(r.text).not.toContain(SENTINEL_AT);
    expect(r.text).not.toContain(SENTINEL_RT);
    // The active account was refreshed (sentinel AT) + stamped lastRefreshedAt.
    const cfg = await daemon.credentialStore.getFullConfig();
    expect(cfg.claude?.accessToken).toBe(SENTINEL_AT);
    expect((await sanitized('claude'))[0].lastRefreshedAt).toBeTruthy();
  });

  it('G3: refresh with no refresh token returns honest { ok: false }', async () => {
    await adminFetch('POST', '/admin/api/accounts/claude/accounts', {
      authMethod: 'manual',
      status: 'configured',
      accessToken: 'NO-RT-AT',
    });
    const r = await adminFetch('POST', '/admin/api/accounts/claude/refresh');
    expect(r.status).toBe(200);
    expect((r.json as { ok: boolean }).ok).toBe(false);
  });

  it('G3: opencodego is not refreshable (400)', async () => {
    const r = await adminFetch('POST', '/admin/api/accounts/opencodego/refresh');
    expect(r.status).toBe(400);
    expect(r.text).toMatch(/not refreshable/i);
  });

  it('G4: an OAuth-complete label names the appended account', async () => {
    const start = await adminFetch('POST', '/admin/api/accounts/claude/oauth/start');
    const { sessionId } = start.json as { sessionId: string };
    const done = await adminFetch('POST', '/admin/api/accounts/claude/oauth/complete', {
      sessionId,
      code: 'AUTH-CODE-LABELED',
      label: 'browser-acct',
    });
    expect(done.status).toBe(200);
    expect(done.text).not.toContain(SENTINEL_AT);
    const accts = await sanitized('claude');
    expect(accts.find((x) => x.isActive)?.label).toBe('browser-acct');
    expect(accts.find((x) => x.isActive)?.authMethod).toBe('oauth');
  });
});
