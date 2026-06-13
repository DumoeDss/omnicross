/**
 * refresh-boot-smoke.test.ts — the full 401 → refresh → retry → 200 loop
 * (omnicross-daemon-parity-oauth task 5.1/5.2).
 *
 * Builds the STANDALONE daemon (real JsonSubscriptionCredentialStore → real
 * OAuthBearerAuthStrategy → real SubscriptionProviderRegistry wired into core's
 * outbound slot, exactly like `subscription-boot-smoke.test.ts`), seeds a codex
 * token whose access token the mock upstream will REJECT (401), and a working
 * refresh_token. Then:
 *
 *   POST /v1/responses with the named key
 *   → dispatcher applies `Bearer stale-codex-token` → mock upstream 401
 *   → `maybeRetryAfterError` → strategy.onUnauthorized → store.refreshCodexToken
 *     → (default global fetch, STUBBED here) hits the codex token endpoint → new token
 *   → store persists the new token (encrypted) → retry re-applies `Bearer fresh-codex-token`
 *   → mock upstream 200.
 *
 * Asserts: 200, the upstream's LAST bearer is the fresh one, the stale bearer was
 * seen first, the refresh endpoint was hit exactly once, and tokens.json now holds
 * the fresh token as an `enc:` envelope. 5.2: two concurrent 401s collapse to ONE
 * upstream refresh via the shared RefreshMutex.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNamedKey, loadServerConfig } from '@omnicross/core/outbound-api';
import {
  setSubscriptionRegistryForOutbound,
  type SubscriptionRegistryLike,
} from '@omnicross/core/outbound-api/subscriptionRegistryPort';
import type { SubscriptionDispatchProfile } from '@omnicross/core/provider-proxy/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildDaemon, type Daemon, resetDaemonSingletonsForTests } from '../bootstrap';
import { loadConfig } from '../config';
import { encryptTokens, isEnvelope, resolveMasterKey, SecretBox } from '../secrets';

const STALE_TOKEN = 'stale-codex-token';
const FRESH_TOKEN = 'fresh-codex-token';
const CODEX_TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';

const CANNED_RESPONSE = {
  id: 'resp-mock',
  object: 'response',
  created_at: 1,
  status: 'completed',
  model: 'gpt-5-codex',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'pong' }] }],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
};

interface MockUpstream {
  server: Server;
  port: number;
  authHeaders: string[];
  hits: number;
}

/** Upstream that 401s any bearer != FRESH_TOKEN; 200s the fresh one. */
function startMockUpstream(): Promise<MockUpstream> {
  const state: MockUpstream = { server: undefined as unknown as Server, port: 0, authHeaders: [], hits: 0 };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      state.hits += 1;
      const auth = req.headers['authorization'] ?? '';
      state.authHeaders.push(auth);
      if (auth !== `Bearer ${FRESH_TOKEN}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'token expired' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(CANNED_RESPONSE));
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

let tmpDir: string;
let upstream: MockUpstream;
let daemon: Daemon;
let baseUrl: string;
let plaintextKey: string;
let refreshHits: number;

function writeConfig(configPath: string): void {
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        providers: [
          {
            id: 'mock-openai',
            apiFormat: 'openai',
            baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
            apiKey: 'sk-unused-byo-key',
            models: ['mock-model'],
          },
        ],
        server: {
          enabled: true,
          networkBinding: false,
          port: 0,
          endpoints: [
            { endpoint: 'responses', defaultModel: 'codex,gpt-5-codex', backgroundModel: 'codex,gpt-5-codex', useSubscription: true },
          ],
        },
      },
      null,
      2,
    ),
    'utf8',
  );
}

/** Seed an ENCRYPTED tokens.json with a codex block: stale access + valid refresh,
 *  expiresAt far in the future (so the 401 path — not the lead-window — drives refresh). */
function writeTokens(tokensPath: string, keyFile: string): void {
  const config = {
    codex: {
      authMethod: 'oauth',
      status: 'authorized',
      accessToken: STALE_TOKEN,
      refreshToken: 'codex-refresh-token',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
    updatedAt: '2026-06-04T00:00:00.000Z',
  };
  const enc = encryptTokens(config as never, new SecretBox(resolveMasterKey({ keyFilePath: keyFile })));
  writeFileSync(tokensPath, JSON.stringify(enc, null, 2) + '\n', 'utf8');
}

function overrideCodexUpstreamUrl(d: Daemon, mockUrl: string): void {
  const real = d.subscriptionRegistry;
  const wrapper: SubscriptionRegistryLike = {
    getProfile(providerId: string): SubscriptionDispatchProfile | null {
      const profile = real.getProfile(providerId);
      if (!profile || providerId !== 'codex') return profile;
      return { ...profile, resolveUpstreamUrl: () => mockUrl };
    },
  };
  setSubscriptionRegistryForOutbound(wrapper);
}

async function boot(): Promise<void> {
  const configPath = join(tmpDir, 'config.json');
  const keysPath = join(tmpDir, 'keys.json');
  const tokensPath = join(tmpDir, 'tokens.json');
  const keyFile = join(tmpDir, 'master.key');

  writeConfig(configPath);
  writeTokens(tokensPath, keyFile);

  // Stub global fetch: the codex token endpoint (the store's DEFAULT refresh
  // fetch) mints FRESH_TOKEN; everything else (the mock upstream) passes through
  // to the real fetch so the daemon's own request path is unchanged.
  const realFetch = globalThis.fetch;
  refreshHits = 0;
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === CODEX_TOKEN_ENDPOINT) {
      refreshHits += 1;
      // Hold the refresh briefly so concurrent 401s land WHILE this is in-flight
      // and fold through the shared RefreshMutex into a single round-trip (5.2).
      await new Promise((r) => {
        setTimeout(r, 50);
      });
      return new Response(
        JSON.stringify({ access_token: FRESH_TOKEN, refresh_token: 'codex-refresh-token-2', id_token: 'idt', expires_in: 3600 }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }
    return realFetch(input, init);
  }) as typeof fetch);

  const config = loadConfig(configPath);
  daemon = buildDaemon(config, { configPath, keysPath, tokensPath, masterKeyFilePath: keyFile });
  overrideCodexUpstreamUrl(daemon, `http://127.0.0.1:${upstream.port}/v1/responses`);

  await daemon.llmConfig.ready();
  await daemon.providerProxy.start();
  const serverConfig = await loadServerConfig(daemon.settingsStore);
  await daemon.outboundApiServer.applyConfig({
    enabled: true,
    networkBinding: serverConfig.networkBinding,
    endpoints: serverConfig.endpoints,
    port: serverConfig.port,
  });
  baseUrl = daemon.outboundApiServer.getStatus().loopbackUrl as string;
  const created = await createNamedKey(daemon.keyDb, 'refresh-smoke');
  plaintextKey = created.plaintextOnce;
}

beforeEach(async () => {
  resetDaemonSingletonsForTests();
  upstream = await startMockUpstream();
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-refresh-boot-'));
});

afterEach(async () => {
  if (daemon) {
    await daemon.outboundApiServer.stop();
    await daemon.providerProxy.stop();
    daemon.apiKeyPool.dispose();
  }
  await stopServer(upstream.server);
  resetDaemonSingletonsForTests();
  vi.unstubAllGlobals();
  rmSync(tmpDir, { recursive: true, force: true });
});

function postResponses(): Promise<Response> {
  return fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${plaintextKey}` },
    body: JSON.stringify({ model: 'gpt-5-codex', input: [{ role: 'user', content: 'ping' }] }),
  });
}

describe('omnicross daemon refresh boot smoke (401 → refresh → retry → 200)', () => {
  it('refreshes the codex token on a 401 and retries with the fresh bearer', async () => {
    await boot();
    const res = await postResponses();

    expect(res.status).toBe(200);
    // The upstream saw the stale bearer first (401), then the fresh bearer (200).
    expect(upstream.authHeaders[0]).toBe(`Bearer ${STALE_TOKEN}`);
    expect(upstream.authHeaders.at(-1)).toBe(`Bearer ${FRESH_TOKEN}`);
    expect(refreshHits).toBe(1);

    // The fresh token was persisted ENCRYPTED at rest.
    const tokensPath = join(tmpDir, 'tokens.json');
    const raw = readFileSync(tokensPath, 'utf8');
    expect(raw).not.toContain(FRESH_TOKEN);
    const onDisk = JSON.parse(raw) as { codex: { accessToken: string } };
    expect(isEnvelope(onDisk.codex.accessToken)).toBe(true);
    const fresh = await daemon.credentialStore.getFullConfig();
    expect(fresh.codex?.accessToken).toBe(FRESH_TOKEN);
  });

  it('collapses concurrent 401s into ONE upstream refresh (shared RefreshMutex)', async () => {
    await boot();
    const [a, b, c] = await Promise.all([postResponses(), postResponses(), postResponses()]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(c.status).toBe(200);
    // Despite 3 concurrent 401s, the shared RefreshMutex folds them into 1 refresh.
    expect(refreshHits).toBe(1);
  });
});
