/**
 * admin-oauth.test.ts — the app-parity child 4 INTERACTIVE OAuth login over admin
 * HTTP (`POST /admin/api/accounts/:providerId/oauth/{start,complete}`).
 *
 * Proves the two-phase flow end-to-end IN PROCESS, reusing the existing
 * `@omnicross/subscriptions/oauth` flow (no PKCE / token-exchange rebuild) and the
 * encrypted credential store. The token-exchange HTTP is the ONLY thing mocked:
 * `globalThis.fetch` is wrapped so the claude/gemini token endpoints return a
 * SENTINEL token body, while every other request (admin API, upstream provider)
 * passes through to the real fetch. This mirrors the `oauthExchangeFetch` injection
 * point (`bootstrap.ts` wires it from global `fetch`).
 *
 * SECRET SPINE asserted on BOTH endpoints:
 *  - `start` returns ONLY { authUrl, sessionId } (no codeVerifier / token),
 *  - `complete` returns ONLY the sanitized status; the sentinel token NEVER
 *    appears in the response body OR any later GET (no-leak scan),
 *  - the minted token is `enc:` at rest in tokens.json (with a SecretBox),
 *  - unknown/expired/used session + state-mismatch are rejected (no write),
 *  - codex (DEFERRED) + opencodego (manual-only) are rejected as oauth-unsupported.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadServerConfig } from '@omnicross/core/outbound-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type CodexLoopbackFn } from '../admin/accountsCodexOAuth';
import { buildDaemon, type Daemon, resetDaemonSingletonsForTests } from '../bootstrap';
import { loadConfig } from '../config';
import { isEnvelope } from '../secrets';

/** Sentinel tokens the mocked exchange mints — must NEVER leave the daemon. */
const SENTINEL_AT = 'SENTINEL-OAUTH-ACCESS-TOKEN';
const SENTINEL_RT = 'SENTINEL-OAUTH-REFRESH-TOKEN';

/** Codex sentinels (app-parity-2 child 5) — must NEVER leave the daemon. */
const CODEX_AT = 'SENTINEL-CODEX-ACCESS-TOKEN';
const CODEX_RT = 'SENTINEL-CODEX-REFRESH-TOKEN';
const CODEX_ID = 'SENTINEL-CODEX-ID-TOKEN';
const CODEX_CODE = 'codex-loopback-auth-code';

/**
 * A controllable mock for the codex loopback (so tests need NOT bind 127.0.0.1:1455).
 * `start` arms it; the test resolves/rejects the deferred to drive the async flow.
 */
let codexLoopback: { promise: Promise<string>; resolve: (c: string) => void; reject: (e: Error) => void } | null = null;
function armCodexLoopback(): NonNullable<typeof codexLoopback> {
  let resolve!: (c: string) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  codexLoopback = { promise, resolve, reject };
  return codexLoopback;
}
const mockCodexAwaitLoopback: CodexLoopbackFn = () =>
  codexLoopback ? codexLoopback.promise : Promise.reject(new Error('no codex loopback armed'));

// ── Mocked token-exchange fetch (claude/gemini token endpoints only) ────────────

const CLAUDE_TOKEN_ENDPOINT = 'https://console.anthropic.com/v1/oauth/token';
const GEMINI_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const CODEX_TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';

let realFetch: typeof globalThis.fetch;

/** Wrap global fetch so the OAuth token endpoints return a sentinel body. */
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
    if (url === CODEX_TOKEN_ENDPOINT) {
      return new Response(
        JSON.stringify({
          access_token: CODEX_AT,
          refresh_token: CODEX_RT,
          id_token: CODEX_ID,
          expires_in: 3600,
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

// ── Mock upstream provider (boot needs a reachable provider base) ──────────────

const CANNED_COMPLETION = {
  id: 'chatcmpl-oauth-mock',
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
  return new Promise((resolve) => server.close(() => resolve()));
}

// ── Admin fetch helper (uses the REAL fetch under the mock wrapper) ─────────────

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

// ── Fixture ───────────────────────────────────────────────────────────────────

let tmpDir: string;
let upstream: MockUpstream;
let daemon: Daemon;

function writeConfig(configPath: string, providerBase: string): void {
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
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-oauth-'));
  const configPath = join(tmpDir, 'config.json');
  const keysPath = join(tmpDir, 'keys.json');
  const tokensPath = join(tmpDir, 'tokens.json');
  writeConfig(configPath, `http://127.0.0.1:${upstream.port}/v1`);

  const config = loadConfig(configPath);
  daemon = buildDaemon(config, {
    configPath,
    keysPath,
    tokensPath,
    masterKeyFilePath: join(tmpDir, 'master.key'),
    // app-parity-2 child 5: inject the mock codex loopback so tests don't bind 1455.
    codexAwaitLoopback: mockCodexAwaitLoopback,
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
  codexLoopback = null;
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

/** Drive a full claude login and return the minted sessionId + complete response. */
async function startClaude(): Promise<{ authUrl: string; sessionId: string }> {
  const r = await adminFetch('POST', '/admin/api/accounts/claude/oauth/start');
  expect(r.status).toBe(200);
  return r.json as { authUrl: string; sessionId: string };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('OAuth over HTTP', () => {
  beforeEach(async () => {
    await bootDaemon();
  });

  it('start (claude) returns a secret-free authUrl + opaque sessionId', async () => {
    const r = await adminFetch('POST', '/admin/api/accounts/claude/oauth/start');
    expect(r.status).toBe(200);
    const { authUrl, sessionId } = r.json as { authUrl: string; sessionId: string };
    // authUrl carries only public material.
    expect(authUrl).toContain('claude.ai/oauth/authorize');
    expect(authUrl).toContain('client_id=');
    expect(authUrl).toContain('code_challenge=');
    expect(authUrl).toContain('state=');
    // NO secret (codeVerifier / token) crosses the wire.
    expect(authUrl).not.toContain('code_verifier');
    expect(r.text).not.toContain('codeVerifier');
    expect(r.text).not.toContain(SENTINEL_AT);
    expect(r.text).not.toContain(SENTINEL_RT);
    // sessionId is opaque + non-empty.
    expect(typeof sessionId).toBe('string');
    expect(sessionId.length).toBeGreaterThan(16);
  });

  it('start (gemini) returns a secret-free authUrl + opaque sessionId', async () => {
    const r = await adminFetch('POST', '/admin/api/accounts/gemini/oauth/start');
    expect(r.status).toBe(200);
    const { authUrl, sessionId } = r.json as { authUrl: string; sessionId: string };
    expect(authUrl).toContain('client_id=');
    expect(authUrl).toContain('code_challenge=');
    expect(authUrl).toContain('state=');
    expect(authUrl).not.toContain('code_verifier');
    expect(typeof sessionId).toBe('string');
    expect(sessionId.length).toBeGreaterThan(16);
  });

  it('complete (claude) persists + activates and returns ONLY sanitized status — sentinel token never in the body', async () => {
    const { sessionId } = await startClaude();
    const r = await adminFetch('POST', '/admin/api/accounts/claude/oauth/complete', {
      sessionId,
      code: 'AUTH-CODE-123',
    });
    expect(r.status).toBe(200);
    // STATUS-ONLY — the minted token NEVER appears in the response body.
    expect(r.text).not.toContain(SENTINEL_AT);
    expect(r.text).not.toContain(SENTINEL_RT);
    expect(r.text).not.toContain('accessToken');
    const account = (r.json as { account?: { providerId: string; credentialStatus: { ok: boolean } } }).account;
    expect(account?.providerId).toBe('claude');
    expect(account?.credentialStatus.ok).toBe(true);
    // Persisted + active (read-after-write through the store).
    const cfg = await daemon.credentialStore.getFullConfig();
    expect(cfg.claude?.accessToken).toBe(SENTINEL_AT);
    expect(cfg.claude?.refreshToken).toBe(SENTINEL_RT);
    expect(cfg.claude?.status).toBe('authorized');
    const sanitized = await daemon.credentialStore.listSanitizedAccounts();
    expect(sanitized.claude.filter((a) => a.isActive)).toHaveLength(1);
  });

  it('complete (gemini) persists the minted token + returns sanitized status only', async () => {
    const start = await adminFetch('POST', '/admin/api/accounts/gemini/oauth/start');
    const { sessionId } = start.json as { sessionId: string };
    const r = await adminFetch('POST', '/admin/api/accounts/gemini/oauth/complete', {
      sessionId,
      code: 'GEMINI-CODE-456',
    });
    expect(r.status).toBe(200);
    expect(r.text).not.toContain(SENTINEL_AT);
    expect(r.text).not.toContain(SENTINEL_RT);
    const cfg = await daemon.credentialStore.getFullConfig();
    expect(cfg.gemini?.accessToken).toBe(SENTINEL_AT);
    expect(cfg.gemini?.status).toBe('authorized');
  });

  it('the minted OAuth token is encrypted at rest (enc: envelope on disk)', async () => {
    const { sessionId } = await startClaude();
    await adminFetch('POST', '/admin/api/accounts/claude/oauth/complete', {
      sessionId,
      code: 'AUTH-CODE-789',
    });
    // On-disk tokens.json holds an enc: envelope, NOT the plaintext sentinel.
    const onDisk = JSON.parse(readFileSync(join(tmpDir, 'tokens.json'), 'utf8')) as {
      claude: { accessToken: string; refreshToken: string };
      claudeAccounts?: Array<{ tokens: { accessToken: string } }>;
    };
    expect(isEnvelope(onDisk.claude.accessToken)).toBe(true);
    expect(isEnvelope(onDisk.claude.refreshToken)).toBe(true);
    expect(onDisk.claude.accessToken).not.toContain(SENTINEL_AT);
    // Whole-file scan — the plaintext token appears nowhere on disk.
    const wholeFile = readFileSync(join(tmpDir, 'tokens.json'), 'utf8');
    expect(wholeFile).not.toContain(SENTINEL_AT);
    expect(wholeFile).not.toContain(SENTINEL_RT);
  });

  it('NO-LEAK: after a completed login, no admin GET (incl. GET /) leaks the sentinel token', async () => {
    const { sessionId } = await startClaude();
    await adminFetch('POST', '/admin/api/accounts/claude/oauth/complete', {
      sessionId,
      code: 'AUTH-CODE-NOLEAK',
    });
    for (const path of [
      '/admin/api/providers',
      '/admin/api/keys',
      '/admin/api/server',
      '/admin/api/accounts',
      '/admin/api/status',
    ]) {
      const r = await adminFetch('GET', path);
      expect(r.text, `${path} must not leak the access token`).not.toContain(SENTINEL_AT);
      expect(r.text, `${path} must not leak the refresh token`).not.toContain(SENTINEL_RT);
      expect(r.text, `${path} must not leak an enc:v1: envelope`).not.toContain('enc:v1:');
    }
    const html = await (await globalThis.fetch(`${adminBase}/`)).text();
    expect(html).not.toContain(SENTINEL_AT);
    expect(html).not.toContain(SENTINEL_RT);
  });

  it('rejects an unknown sessionId (no exchange, no write)', async () => {
    const r = await adminFetch('POST', '/admin/api/accounts/claude/oauth/complete', {
      sessionId: 'never-minted',
      code: 'AUTH-CODE',
    });
    expect(r.status).toBe(410);
    expect((await daemon.credentialStore.getFullConfig()).claude).toBeUndefined();
  });

  it('rejects a single-use (already-consumed) sessionId on a second complete', async () => {
    const { sessionId } = await startClaude();
    const first = await adminFetch('POST', '/admin/api/accounts/claude/oauth/complete', {
      sessionId,
      code: 'AUTH-CODE-ONCE',
    });
    expect(first.status).toBe(200);
    const second = await adminFetch('POST', '/admin/api/accounts/claude/oauth/complete', {
      sessionId,
      code: 'AUTH-CODE-AGAIN',
    });
    expect(second.status).toBe(410);
  });

  it('rejects a claude state mismatch (code#wrongstate) as a CSRF guard (no write)', async () => {
    const { sessionId } = await startClaude();
    const r = await adminFetch('POST', '/admin/api/accounts/claude/oauth/complete', {
      sessionId,
      code: 'AUTH-CODE#deadbeefwrongstate',
    });
    expect(r.status).toBe(400);
    expect(r.text).toMatch(/state did not match|CSRF/i);
    // No token minted / written.
    expect((await daemon.credentialStore.getFullConfig()).claude).toBeUndefined();
  });

  it('rejects opencodego oauth start as unsupported (manual-only); manual PUT still works', async () => {
    const start = await adminFetch('POST', '/admin/api/accounts/opencodego/oauth/start');
    expect(start.status).toBe(400);
    expect(start.text).toMatch(/oauth not available/i);
    // Regression: the manual token-write path is unaffected.
    const put = await adminFetch('PUT', '/admin/api/accounts/opencodego', {
      authMethod: 'manual',
      status: 'configured',
      apiKey: 'OCG-manual-key',
    });
    expect(put.status).toBe(200);
    expect((await daemon.credentialStore.getFullConfig()).opencodego?.apiKey).toBe('OCG-manual-key');
  });

  // ── codex loopback OAuth (app-parity-2 child 5) ──────────────────────────────

  /** Poll the codex status until it leaves 'pending' (bounded). */
  async function waitCodexSettled(
    sessionId: string,
  ): Promise<{ status: number; text: string; json: unknown }> {
    for (let i = 0; i < 100; i++) {
      const r = await adminFetch('GET', `/admin/api/accounts/codex/oauth/${sessionId}/status`);
      if ((r.json as { state?: string }).state !== 'pending') return r;
      await new Promise((res) => setTimeout(res, 10));
    }
    throw new Error('codex flow did not settle');
  }

  it('codex loopback: start arms, poll pending→done, token never leaks + enc: at rest', async () => {
    const def = armCodexLoopback();
    const start = await adminFetch('POST', '/admin/api/accounts/codex/oauth/start');
    expect(start.status).toBe(200);
    const { authUrl, sessionId } = start.json as { authUrl: string; sessionId: string };
    expect(authUrl).toContain('auth.openai.com');
    expect(start.text).not.toContain(CODEX_AT); // no token on start
    // Pending while the loopback hasn't fired.
    const pending = await adminFetch('GET', `/admin/api/accounts/codex/oauth/${sessionId}/status`);
    expect((pending.json as { state: string }).state).toBe('pending');
    // Fire the loopback → daemon exchanges (mock fetch) + persists.
    def.resolve(CODEX_CODE);
    const done = await waitCodexSettled(sessionId);
    expect((done.json as { state: string }).state).toBe('done');
    expect(done.text).not.toContain(CODEX_AT); // token NEVER in the poll body
    // The codex account now exists (sanitized) and the token never leaks on GET.
    const list = await adminFetch('GET', '/admin/api/accounts');
    expect(list.text).not.toContain(CODEX_AT);
    expect(list.text).not.toContain(CODEX_RT);
    expect(list.text).not.toContain(CODEX_ID);
    // At-rest: tokens.json carries the codex token as `enc:`, never plaintext.
    const tokensRaw = readFileSync(join(tmpDir, 'tokens.json'), 'utf8');
    expect(tokensRaw).not.toContain(CODEX_AT);
    const persisted = JSON.parse(tokensRaw) as { codex?: { accessToken?: string } };
    expect(isEnvelope(persisted.codex?.accessToken ?? '')).toBe(true);
  });

  it('codex loopback failure → status error (no token in the message)', async () => {
    const def = armCodexLoopback();
    const start = await adminFetch('POST', '/admin/api/accounts/codex/oauth/start');
    const { sessionId } = start.json as { sessionId: string };
    def.reject(new Error('login: callback state did not match (possible CSRF) — aborting'));
    const settled = await waitCodexSettled(sessionId);
    expect((settled.json as { state: string }).state).toBe('error');
    expect((settled.json as { message?: string }).message).toMatch(/state did not match/i);
    expect(settled.text).not.toContain(CODEX_AT);
    // No codex account written on failure.
    expect((await daemon.credentialStore.getFullConfig()).codex).toBeUndefined();
  });

  it('a second codex start is 409 while one is already in flight (port 1455 held)', async () => {
    armCodexLoopback(); // arm but don't resolve → stays in flight
    const first = await adminFetch('POST', '/admin/api/accounts/codex/oauth/start');
    expect(first.status).toBe(200);
    const second = await adminFetch('POST', '/admin/api/accounts/codex/oauth/start');
    expect(second.status).toBe(409);
    expect(second.text).toMatch(/already in progress/i);
    // Free the slot so the dangling flow settles before teardown.
    codexLoopback?.resolve(CODEX_CODE);
    await waitCodexSettled((first.json as { sessionId: string }).sessionId);
  });

  it('codex status is 404 for an unknown session', async () => {
    const r = await adminFetch('GET', '/admin/api/accounts/codex/oauth/no-such-session/status');
    expect(r.status).toBe(404);
  });

  it('codex code-paste complete is rejected — codex uses loopback+poll, not paste', async () => {
    const complete = await adminFetch('POST', '/admin/api/accounts/codex/oauth/complete', {
      sessionId: 'anything',
      code: 'anything',
    });
    expect(complete.status).toBe(400);
    expect(complete.text).toMatch(/oauth not available/i);
  });
});
