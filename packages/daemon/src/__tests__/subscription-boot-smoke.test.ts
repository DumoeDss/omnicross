/**
 * subscription-boot-smoke.test.ts — the proof for `omnicross-daemon-subscriptions`.
 *
 * Mirrors the BYO `boot-smoke.test.ts` fixture, but proves the STANDALONE daemon
 * serves a `/v1/responses` request ROUTED TO A SUBSCRIPTION PROVIDER (codex):
 *
 *   mock node:http upstream (records its `authorization` header + returns a canned
 *   OpenAI-Responses payload)
 *   → temp config.json: `responses` endpoint `useSubscription:true`,
 *     `defaultModel:"codex,gpt-5-codex"`, NO BYO `codex` provider row
 *   → temp tokens.json: `{ codex: { accessToken:'fake-codex-token', ... } }`
 *   → buildDaemon (wires the REAL JsonSubscriptionCredentialStore + the REAL
 *     SubscriptionAccountService/Registry into core's outbound slot)
 *   → llmConfig.ready() → providerProxy.start() → applyConfig(enabled:true)
 *   → createNamedKey
 *
 * VARIANT B (LEAD decision): the REAL store → REAL OAuthBearerAuthStrategy →
 * bearer-injection chain is exercised end-to-end. The codex profile hard-codes
 * `chatgpt.com`, so we wrap the real registry in a thin `SubscriptionRegistryLike`
 * that delegates `getProfile('codex')` to the real registry but spread-overrides
 * ONLY `resolveUpstreamUrl` → the mock (the `authStrategy` stays the REAL one that
 * reads `fake-codex-token` from the temp `tokens.json`), and feed it into core's
 * outbound slot via `setSubscriptionRegistryForOutbound`.
 *
 * Asserts: authed POST /v1/responses → 200, mock hit once, the upstream received
 * `Bearer fake-codex-token` (the subscription bearer injected by the strategy —
 * the external named key NEVER reached upstream). Negatives: `useSubscription:false`
 * → 503; unauthenticated → 401 (upstream not hit); tokens.json with no codex entry
 * → the upstream's native 401 surfaced (honest-stub contract — no synthesized error).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildDaemon, type Daemon, resetDaemonSingletonsForTests } from '../bootstrap';
import { loadConfig } from '../config';
import { encryptTokens, resolveMasterKey, SecretBox } from '../secrets';

// ── Mock upstream (ChatGPT codex `/responses`) ───────────────────────────────

/** A minimal valid OpenAI-Responses payload the codex chain can round-trip. */
const CANNED_RESPONSE = {
  id: 'resp-mock',
  object: 'response',
  created_at: 1,
  status: 'completed',
  model: 'gpt-5-codex',
  output: [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'pong' }],
    },
  ],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
};

interface MockUpstream {
  server: Server;
  port: number;
  /** The `authorization` header value the upstream last received. */
  lastAuthHeader: string | undefined;
  hits: number;
  /** When true, reply 401 unless a non-empty Bearer is present (native-401 proof). */
  requireBearer: boolean;
}

function startMockUpstream(): Promise<MockUpstream> {
  const state: MockUpstream = {
    server: undefined as unknown as Server,
    port: 0,
    lastAuthHeader: undefined,
    hits: 0,
    requireBearer: false,
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      state.hits += 1;
      state.lastAuthHeader = req.headers['authorization'];
      const bearer = state.lastAuthHeader ?? '';
      if (state.requireBearer && !/^Bearer\s+\S/.test(bearer)) {
        // Surface a NATIVE upstream 401 (no synthesized credential error).
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'missing bearer' } }));
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

// ── Fixture wiring ────────────────────────────────────────────────────────────

const FAKE_CODEX_TOKEN = 'fake-codex-token';

let tmpDir: string;
let upstream: MockUpstream;
let daemon: Daemon;
let baseUrl: string;
let plaintextKey: string;

/**
 * Write the temp config.json. `useSubscription` toggles the per-endpoint gate;
 * there is intentionally NO BYO `codex` provider row, so the route resolver takes
 * the subscription branch. A single non-codex BYO provider row keeps the config
 * `providers` array non-empty (its presence is irrelevant to the codex route).
 */
function writeConfig(configPath: string, useSubscription: boolean): void {
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
            {
              endpoint: 'responses',
              defaultModel: 'codex,gpt-5-codex',
              backgroundModel: 'codex,gpt-5-codex',
              useSubscription,
            },
          ],
        },
      },
      null,
      2,
    ),
    'utf8',
  );
}

/** Write the temp tokens.json (omit `codex` to prove the native-401 path). When
 *  `encryptKeyFile` is set, the token material is ENCRYPTED at rest (secrets task
 *  5.5 — proving the subscription bearer path decrypts back to the plaintext). */
function writeTokens(tokensPath: string, withCodex: boolean, encryptKeyFile?: string): void {
  const config = withCodex
    ? {
        codex: {
          authMethod: 'oauth',
          status: 'authorized',
          accessToken: FAKE_CODEX_TOKEN,
        },
        updatedAt: '2026-06-03T00:00:00.000Z',
      }
    : { updatedAt: '2026-06-03T00:00:00.000Z' };
  const toWrite = encryptKeyFile
    ? encryptTokens(config as never, new SecretBox(resolveMasterKey({ keyFilePath: encryptKeyFile })))
    : config;
  writeFileSync(tokensPath, JSON.stringify(toWrite, null, 2) + '\n', 'utf8');
}

/**
 * Override the codex profile's hard-coded `chatgpt.com` URL with the mock,
 * KEEPING the daemon's REAL codex auth strategy (reads `fake-codex-token` from
 * the temp tokens.json). Wraps the daemon's real registry behind the narrow
 * `SubscriptionRegistryLike` core consumes, and feeds it into the outbound slot.
 */
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

async function boot(opts: {
  useSubscription: boolean;
  withCodexToken: boolean;
  encryptTokensAtRest?: boolean;
}): Promise<void> {
  const configPath = join(tmpDir, 'config.json');
  const keysPath = join(tmpDir, 'keys.json');
  const tokensPath = join(tmpDir, 'tokens.json');

  writeConfig(configPath, opts.useSubscription);
  writeTokens(tokensPath, opts.withCodexToken, opts.encryptTokensAtRest ? join(tmpDir, 'master.key') : undefined);

  const config = loadConfig(configPath);
  daemon = buildDaemon(config, { configPath, keysPath, tokensPath, masterKeyFilePath: join(tmpDir, 'master.key') });
  // Point codex dispatch at the mock (keeps the real store→strategy→bearer chain).
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
  const created = await createNamedKey(daemon.keyDb, 'sub-smoke');
  plaintextKey = created.plaintextOnce;
}

beforeEach(async () => {
  resetDaemonSingletonsForTests();
  upstream = await startMockUpstream();
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-daemon-sub-'));
});

afterEach(async () => {
  if (daemon) {
    await daemon.outboundApiServer.stop();
    await daemon.providerProxy.stop();
    daemon.apiKeyPool.dispose(); // stop the pool's cooldown-cleanup interval
  }
  await stopServer(upstream.server);
  resetDaemonSingletonsForTests();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Assertions ──────────────────────────────────────────────────────────────

describe('omnicross daemon subscription boot smoke (standalone /v1/responses)', () => {
  it('routes an AUTHED /v1/responses to the subscription upstream with the codex bearer', async () => {
    await boot({ useSubscription: true, withCodexToken: true });

    const res = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${plaintextKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-5-codex',
        input: [{ role: 'user', content: 'ping' }],
      }),
    });

    expect(res.status).toBe(200);
    // The upstream was hit exactly once, and received the SUBSCRIPTION bearer
    // injected by the real OAuthBearerAuthStrategy from the temp tokens.json —
    // NOT the external named key (which only authenticated the daemon request).
    expect(upstream.hits).toBe(1);
    expect(upstream.lastAuthHeader).toBe(`Bearer ${FAKE_CODEX_TOKEN}`);
    expect(upstream.lastAuthHeader).not.toBe(`Bearer ${plaintextKey}`);
  });

  it('decrypts an ENCRYPTED-at-rest codex token before injecting the bearer (secrets 5.5)', async () => {
    await boot({ useSubscription: true, withCodexToken: true, encryptTokensAtRest: true });

    const res = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${plaintextKey}` },
      body: JSON.stringify({ model: 'gpt-5-codex', input: [{ role: 'user', content: 'ping' }] }),
    });

    expect(res.status).toBe(200);
    expect(upstream.hits).toBe(1);
    // The store decrypted the at-rest envelope → the upstream got the PLAINTEXT bearer.
    expect(upstream.lastAuthHeader).toBe(`Bearer ${FAKE_CODEX_TOKEN}`);
  });

  it('returns 503 when subscription is disabled on the endpoint (Gate 1)', async () => {
    await boot({ useSubscription: false, withCodexToken: true });

    const res = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${plaintextKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-5-codex',
        input: [{ role: 'user', content: 'ping' }],
      }),
    });

    expect(res.status).toBe(503);
    expect(upstream.hits).toBe(0);
  });

  it('rejects an UNAUTHED /v1/responses with 401 before any upstream call', async () => {
    await boot({ useSubscription: true, withCodexToken: true });

    const res = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5-codex', input: [] }),
    });

    expect(res.status).toBe(401);
    expect(upstream.hits).toBe(0);
  });

  it('surfaces the upstream native 401 when tokens.json has no codex entry (honest stub)', async () => {
    upstream.requireBearer = true;
    await boot({ useSubscription: true, withCodexToken: false });

    const res = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${plaintextKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-5-codex',
        input: [{ role: 'user', content: 'ping' }],
      }),
    });

    // The strategy injected no bearer (no codex token, refresh is an honest-`false`
    // stub) → the upstream's NATIVE 401 is surfaced (no synthesized error).
    expect(res.status).toBe(401);
    expect(upstream.hits).toBe(1);
  });
});
