/**
 * subscription-messages-boot-smoke.test.ts — the proof for
 * `omnicross-messages-subscription` (RT2.1).
 *
 * Mirrors the RT2 `subscription-boot-smoke.test.ts` (which proves `/v1/responses`
 * → codex subscription) but for the native Anthropic `/v1/messages` endpoint,
 * over the built-in factory-LESS ingress (`anthropicMessagesByo` subscription
 * branch). Two variants:
 *
 *   claude pass-through (`profile.mode === 'pass-through'`):
 *     mock node:http upstream (records `authorization`, returns a canned Anthropic
 *     message) → temp config `messages` endpoint `useSubscription:true`,
 *     `defaultModel:"claude,claude-sonnet-4-5"`, NO BYO `claude` row (a filler BYO
 *     provider keeps `providers` non-empty) → temp tokens.json
 *     `{ claude: { authMethod:'oauth', status:'authorized', accessToken:'fake-claude-token' } }`
 *     → spread-override the claude profile `resolveUpstreamUrl` → mock (KEEP the
 *     REAL PassThroughAuthStrategy). Asserts authed POST /v1/messages → 200,
 *     upstream hit once, `lastAuthHeader === 'Bearer fake-claude-token'`, the named
 *     key NOT forwarded. Negatives: useSubscription:false → 503; unauth → 401.
 *
 *   opencodego-MiniMax (Anthropic-shape upstream, `/v1/messages` suffix):
 *     `defaultModel:"opencodego,minimax-m2.5"`, tokens.json
 *     `{ opencodego: { authMethod:'manual', status:'configured', apiKey:'fake-oc-key' } }`
 *     → override the opencodego profile `resolveUpstreamUrl` → mock-with-`/v1/messages`
 *     suffix (KEEP the REAL StaticBearerAuthStrategy). Asserts the upstream received
 *     `Authorization: Bearer fake-oc-key` AND `x-api-key: fake-oc-key`, body verbatim.
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

// ── Mock upstream (Anthropic `/v1/messages`) ─────────────────────────────────

/** A minimal valid Anthropic Messages payload the relay forwards verbatim. */
const CANNED_RESPONSE = {
  id: 'msg-mock',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-4-5',
  content: [{ type: 'text', text: 'pong' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 },
};

/** A minimal OpenAI chat-completion payload the endpoint transformer decodes
 *  back to the Anthropic wire (the OpenAI-shape transformer path). */
const CANNED_OPENAI_RESPONSE = {
  id: 'chatcmpl-mock',
  object: 'chat.completion',
  created: 1,
  model: 'mock-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

/** A minimal OpenAI Responses payload (zen `responses` shape). */
const CANNED_RESPONSES_PAYLOAD = {
  id: 'resp-mock',
  object: 'response',
  created_at: 1,
  status: 'completed',
  model: 'mock-model',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'pong' }] }],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
};

/** A minimal Gemini generateContent payload (zen `gemini` shape). */
const CANNED_GEMINI_PAYLOAD = {
  candidates: [{ content: { parts: [{ text: 'pong' }], role: 'model' }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
};

interface MockUpstream {
  server: Server;
  port: number;
  /** The `authorization` header value the upstream last received. */
  lastAuthHeader: string | undefined;
  /** The `x-api-key` header value the upstream last received. */
  lastApiKeyHeader: string | undefined;
  /** The verbatim request body the upstream last received. */
  lastBody: string | undefined;
  /** The path the upstream last received (proves the baseUrl override host). */
  lastPath: string | undefined;
  hits: number;
  /** When true, reply 401 unless a non-empty Bearer is present (native-401 proof). */
  requireBearer: boolean;
}

function startMockUpstream(): Promise<MockUpstream> {
  const state: MockUpstream = {
    server: undefined as unknown as Server,
    port: 0,
    lastAuthHeader: undefined,
    lastApiKeyHeader: undefined,
    lastBody: undefined,
    lastPath: undefined,
    hits: 0,
    requireBearer: false,
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      state.hits += 1;
      state.lastAuthHeader = req.headers['authorization'] as string | undefined;
      state.lastApiKeyHeader = req.headers['x-api-key'] as string | undefined;
      state.lastBody = body;
      state.lastPath = req.url;
      const bearer = state.lastAuthHeader ?? '';
      if (state.requireBearer && !/^Bearer\s+\S/.test(bearer)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'missing bearer' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // Branch on the path so EACH zen shape gets the right canned wire body the
      // endpoint transformer can decode back to the Anthropic wire:
      //   /v1/responses   → Responses payload (zen responses, openai-response chain)
      //   /v1/models/...  → Gemini payload   (zen gemini, gemini chain)
      //   /v1/chat/...    → OpenAI completion (chat, opencodego chain)
      //   /v1/messages    → Anthropic body   (anthropic verbatim relay)
      const url = req.url ?? '';
      const payload = url.includes('/v1/responses')
        ? CANNED_RESPONSES_PAYLOAD
        : url.includes('/v1/models/')
          ? CANNED_GEMINI_PAYLOAD
          : url.includes('/v1/chat/completions')
            ? CANNED_OPENAI_RESPONSE
            : CANNED_RESPONSE;
      res.end(JSON.stringify(payload));
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

const FAKE_CLAUDE_TOKEN = 'fake-claude-token';
const FAKE_OC_KEY = 'fake-oc-key';

let tmpDir: string;
let upstream: MockUpstream;
let daemon: Daemon;
let baseUrl: string;
let plaintextKey: string;

/**
 * Write the temp config.json with a `messages` endpoint. There is intentionally
 * NO BYO row whose id matches the subscription provider, so the route resolver
 * takes the subscription branch. A single filler BYO provider keeps `providers`
 * non-empty.
 */
function writeConfig(configPath: string, defaultModel: string, useSubscription: boolean): void {
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
              endpoint: 'messages',
              modelMap: { fable: defaultModel, opus: defaultModel, sonnet: defaultModel, haiku: defaultModel },
              useSubscription,
            },
            {
              // responses needs a complete kind map too (strict startup gate).
              endpoint: 'responses',
              modelMap: { codex: defaultModel, mini: defaultModel },
              useSubscription: false,
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

/** Write the temp tokens.json for the claude OR opencodego variant. */
function writeTokens(tokensPath: string, variant: 'claude' | 'opencodego' | 'none'): void {
  let config: Record<string, unknown>;
  if (variant === 'claude') {
    config = {
      claude: { authMethod: 'oauth', status: 'authorized', accessToken: FAKE_CLAUDE_TOKEN },
      updatedAt: '2026-06-03T00:00:00.000Z',
    };
  } else if (variant === 'opencodego') {
    config = {
      opencodego: { authMethod: 'manual', status: 'configured', apiKey: FAKE_OC_KEY },
      updatedAt: '2026-06-03T00:00:00.000Z',
    };
  } else {
    config = { updatedAt: '2026-06-03T00:00:00.000Z' };
  }
  writeFileSync(tokensPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

/**
 * Override ONE subscription profile's `resolveUpstreamUrl` with the mock,
 * KEEPING the daemon's REAL auth strategy (reads the token from tokens.json).
 * Wraps the daemon's real registry behind the narrow `SubscriptionRegistryLike`
 * core consumes, and feeds it into the outbound slot.
 */
function overrideUpstreamUrl(d: Daemon, providerId: string, mockUrl: string): void {
  const real = d.subscriptionRegistry;
  const wrapper: SubscriptionRegistryLike = {
    getProfile(id: string): SubscriptionDispatchProfile | null {
      const profile = real.getProfile(id);
      if (!profile || id !== providerId) return profile;
      return { ...profile, resolveUpstreamUrl: () => mockUrl };
    },
  };
  setSubscriptionRegistryForOutbound(wrapper);
}

async function boot(opts: {
  providerId: 'claude' | 'opencodego';
  model: string;
  useSubscription: boolean;
  tokens: 'claude' | 'opencodego' | 'none';
}): Promise<void> {
  const configPath = join(tmpDir, 'config.json');
  const keysPath = join(tmpDir, 'keys.json');
  const tokensPath = join(tmpDir, 'tokens.json');

  writeConfig(configPath, `${opts.providerId},${opts.model}`, opts.useSubscription);
  writeTokens(tokensPath, opts.tokens);

  const config = loadConfig(configPath);
  daemon = buildDaemon(config, { configPath, keysPath, tokensPath, masterKeyFilePath: join(tmpDir, 'master.key') });
  // Point the chosen profile's dispatch at the mock (mock URL ends in
  // `/v1/messages`, so the core same-format verbatim relay is taken). The REAL
  // store→strategy→bearer chain is exercised.
  overrideUpstreamUrl(daemon, opts.providerId, `http://127.0.0.1:${upstream.port}/v1/messages`);

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
  const created = await createNamedKey(daemon.keyDb, 'sub-msg-smoke');
  plaintextKey = created.plaintextOnce;
}

/**
 * Boot WITHOUT overriding `resolveUpstreamUrl` — the REAL config-aware registry
 * resolver runs, reading the per-account `baseUrl` (pointed at the mock) +
 * `modelMap` from tokens.json. Proves baseUrl + modelMap are LIVE end-to-end on
 * the daemon `/v1/messages` path (the route resolver reads `getOpenCodeGoConfig`
 * and stamps the opaque `route.subscriptionConfig`; the core plan builder passes
 * it back into the config-aware closures). Keeps the REAL StaticBearerAuthStrategy.
 */
async function bootConfigDriven(opts: {
  model: string;
  tokensConfig: Record<string, unknown>;
}): Promise<void> {
  const configPath = join(tmpDir, 'config.json');
  const keysPath = join(tmpDir, 'keys.json');
  const tokensPath = join(tmpDir, 'tokens.json');

  writeConfig(configPath, `opencodego,${opts.model}`, true);
  writeFileSync(
    tokensPath,
    JSON.stringify(
      { opencodego: opts.tokensConfig, updatedAt: '2026-06-03T00:00:00.000Z' },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  const config = loadConfig(configPath);
  daemon = buildDaemon(config, { configPath, keysPath, tokensPath, masterKeyFilePath: join(tmpDir, 'master.key') });
  // NO overrideUpstreamUrl — the real registry (config-aware resolver +
  // getOpenCodeGoConfig) stays in the outbound slot from buildDaemon.

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
  const created = await createNamedKey(daemon.keyDb, 'sub-msg-cfg-smoke');
  plaintextKey = created.plaintextOnce;
}

function post(body: unknown, auth: boolean): Promise<Response> {
  return fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: `Bearer ${plaintextKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  resetDaemonSingletonsForTests();
  upstream = await startMockUpstream();
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-daemon-msg-sub-'));
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

describe('omnicross daemon subscription messages boot smoke (standalone /v1/messages)', () => {
  // claude pass-through.
  it('claude → verbatim /v1/messages with the OAuth bearer (named key NOT forwarded)', async () => {
    await boot({
      providerId: 'claude',
      model: 'claude-sonnet-4-5',
      useSubscription: true,
      tokens: 'claude',
    });

    const sentBody = {
      model: 'claude-sonnet-4-5',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'ping' }],
      extra_server_tool: { type: 'server_tool_use', id: 'srv_1' },
    };
    const res = await post(sentBody, true);

    expect(res.status).toBe(200);
    expect(upstream.hits).toBe(1);
    // The upstream received the SUBSCRIPTION bearer (real PassThroughAuthStrategy
    // from tokens.json) — NOT the external named key.
    expect(upstream.lastAuthHeader).toBe(`Bearer ${FAKE_CLAUDE_TOKEN}`);
    expect(upstream.lastAuthHeader).not.toBe(`Bearer ${plaintextKey}`);
    // Body forwarded verbatim (server-tool `type` field intact).
    const received = JSON.parse(upstream.lastBody ?? '{}') as typeof sentBody;
    expect(received.extra_server_tool.type).toBe('server_tool_use');
  });

  it('claude → 503 when subscription is disabled on the endpoint', async () => {
    await boot({
      providerId: 'claude',
      model: 'claude-sonnet-4-5',
      useSubscription: false,
      tokens: 'claude',
    });

    const res = await post({ model: 'claude-sonnet-4-5', max_tokens: 16, messages: [] }, true);
    expect(res.status).toBe(503);
    expect(upstream.hits).toBe(0);
  });

  it('claude → 401 when unauthenticated, before any upstream call', async () => {
    await boot({
      providerId: 'claude',
      model: 'claude-sonnet-4-5',
      useSubscription: true,
      tokens: 'claude',
    });

    const res = await post({ model: 'claude-sonnet-4-5', max_tokens: 16, messages: [] }, false);
    expect(res.status).toBe(401);
    expect(upstream.hits).toBe(0);
  });

  // opencodego-MiniMax (Anthropic-shape).
  it('opencodego MiniMax → verbatim /v1/messages with Bearer AND x-api-key', async () => {
    await boot({
      providerId: 'opencodego',
      model: 'minimax-m2.5',
      useSubscription: true,
      tokens: 'opencodego',
    });

    const sentBody = {
      model: 'minimax-m2.5',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'ping' }],
    };
    const res = await post(sentBody, true);

    expect(res.status).toBe(200);
    expect(upstream.hits).toBe(1);
    // The real StaticBearerAuthStrategy injects BOTH headers (the mock URL ends
    // in `/v1/messages` → Anthropic-shape → x-api-key fallback).
    expect(upstream.lastAuthHeader).toBe(`Bearer ${FAKE_OC_KEY}`);
    expect(upstream.lastApiKeyHeader).toBe(FAKE_OC_KEY);
    // Body forwarded verbatim.
    const received = JSON.parse(upstream.lastBody ?? '{}') as typeof sentBody;
    expect(received.messages[0].content).toBe('ping');
  });

  // opencodego baseUrl LIVE on the daemon /v1/messages path (Anthropic-shape
  // verbatim) — the REAL config-aware resolver reads tokens.json's baseUrl.
  it('opencodego baseUrl override → upstream hit at the OVERRIDE host with Bearer + x-api-key', async () => {
    await bootConfigDriven({
      model: 'minimax-m2.5',
      tokensConfig: {
        authMethod: 'manual',
        status: 'configured',
        apiKey: FAKE_OC_KEY,
        baseUrl: `http://127.0.0.1:${upstream.port}`,
        // The modelMapper buckets by SCENARIO and resolves the scenario's model
        // (NOT the SDK-supplied model), so force the `default` scenario to an
        // Anthropic-shape (minimax) model → the verbatim /v1/messages path with
        // Bearer + x-api-key.
        modelMap: { default: { modelId: 'minimax-m2.5' } },
      },
    });

    const res = await post(
      { model: 'minimax-m2.5', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] },
      true,
    );

    expect(res.status).toBe(200);
    expect(upstream.hits).toBe(1);
    // baseUrl override LIVE: the request hit the override host's /v1/messages.
    expect(upstream.lastPath).toBe('/v1/messages');
    // Real StaticBearerAuthStrategy on the Anthropic-shape path → BOTH headers.
    expect(upstream.lastAuthHeader).toBe(`Bearer ${FAKE_OC_KEY}`);
    expect(upstream.lastApiKeyHeader).toBe(FAKE_OC_KEY);
  });

  // opencodego modelMap LIVE on the daemon /v1/messages path (OpenAI-shape
  // transformer) — the override model id reaches the upstream body.
  it('opencodego modelMap.default override → resolved override model sent to the OVERRIDE host', async () => {
    await bootConfigDriven({
      // The incoming body model is irrelevant — the modelMapper resolves the
      // user override. `kimi-marker` is OpenAI-shape (non-minimax) → transformer
      // path → the outbound body carries the resolved override model.
      model: 'kimi-k2.6',
      tokensConfig: {
        authMethod: 'manual',
        status: 'configured',
        apiKey: FAKE_OC_KEY,
        baseUrl: `http://127.0.0.1:${upstream.port}`,
        modelMap: { default: { modelId: 'kimi-marker' } },
      },
    });

    const res = await post(
      { model: 'cli', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] },
      true,
    );

    expect(res.status).toBe(200);
    expect(upstream.hits).toBe(1);
    // baseUrl + OpenAI-shape: hit the override host's /v1/chat/completions.
    expect(upstream.lastPath).toBe('/v1/chat/completions');
    // modelMap override LIVE: the resolved override model id is in the body.
    const received = JSON.parse(upstream.lastBody ?? '{}') as { model?: string };
    expect(received.model).toBe('kimi-marker');
    // Real StaticBearerAuthStrategy: Bearer present; x-api-key correctly ABSENT
    // on the OpenAI-shape path (matches the parity contract).
    expect(upstream.lastAuthHeader).toBe(`Bearer ${FAKE_OC_KEY}`);
    expect(upstream.lastApiKeyHeader).toBeUndefined();
  });

  // ── ZEN half — the STANDALONE daemon serves all four
  // zen shapes with zero host dependency. Drive zen via a user
  // `modelMap.default = { modelId, provider:'zen' }` + a `zenBaseUrl` pointed at
  // the mock; the REAL config-aware registry resolver + REAL StaticBearerAuthStrategy
  // run end-to-end. `// UNVERIFIED (no live zen key)` — byte-acceptance proven
  // in-process only; the wiring + the bytes the daemon controls are real.

  it('zen anthropic (claude) → verbatim /v1/messages with Bearer + x-api-key', async () => {
    await bootConfigDriven({
      model: 'claude-sonnet-4.5',
      tokensConfig: {
        authMethod: 'manual',
        status: 'configured',
        apiKey: FAKE_OC_KEY,
        zenBaseUrl: `http://127.0.0.1:${upstream.port}`,
        modelMap: { default: { modelId: 'claude-sonnet-4.5', provider: 'zen' } },
      },
    });

    const res = await post(
      { model: 'cli', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] },
      true,
    );

    expect(res.status).toBe(200);
    expect(upstream.hits).toBe(1);
    // zen anthropic ends in /v1/messages → verbatim relay + BOTH headers.
    expect(upstream.lastPath).toBe('/v1/messages');
    expect(upstream.lastAuthHeader).toBe(`Bearer ${FAKE_OC_KEY}`);
    expect(upstream.lastApiKeyHeader).toBe(FAKE_OC_KEY);
  });

  it('zen responses (gpt-5-codex) → /v1/responses with Bearer ONLY', async () => {
    await bootConfigDriven({
      model: 'gpt-5-codex',
      tokensConfig: {
        authMethod: 'manual',
        status: 'configured',
        apiKey: FAKE_OC_KEY,
        zenBaseUrl: `http://127.0.0.1:${upstream.port}`,
        modelMap: { default: { modelId: 'gpt-5-codex', provider: 'zen' } },
      },
    });

    const res = await post(
      { model: 'cli', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] },
      true,
    );

    expect(res.status).toBe(200);
    expect(upstream.hits).toBe(1);
    // The override host's /v1/responses (the /zen prefix is the path the override
    // appended; here the override host has no /zen segment → just /v1/responses).
    expect(upstream.lastPath).toBe('/v1/responses');
    // Responses shape → Bearer only (URL does not contain /v1/messages).
    expect(upstream.lastAuthHeader).toBe(`Bearer ${FAKE_OC_KEY}`);
    expect(upstream.lastApiKeyHeader).toBeUndefined();
  });

  it('zen gemini (non-stream) → /v1/models/{id}:generateContent with Bearer ONLY', async () => {
    await bootConfigDriven({
      model: 'gemini-3-flash',
      tokensConfig: {
        authMethod: 'manual',
        status: 'configured',
        apiKey: FAKE_OC_KEY,
        zenBaseUrl: `http://127.0.0.1:${upstream.port}`,
        modelMap: { default: { modelId: 'gemini-3-flash', provider: 'zen' } },
      },
    });

    const res = await post(
      { model: 'cli', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] },
      true,
    );

    expect(res.status).toBe(200);
    expect(upstream.hits).toBe(1);
    // The gemini transformer's per-model colon-method URL (non-stream).
    expect(upstream.lastPath).toBe('/v1/models/gemini-3-flash:generateContent');
    // Gemini shape → Bearer only (no /v1/messages).
    expect(upstream.lastAuthHeader).toBe(`Bearer ${FAKE_OC_KEY}`);
    expect(upstream.lastApiKeyHeader).toBeUndefined();
  });

  it('zen chat (qwen3.6-plus) → /v1/chat/completions with Bearer ONLY', async () => {
    await bootConfigDriven({
      model: 'qwen3.6-plus',
      tokensConfig: {
        authMethod: 'manual',
        status: 'configured',
        apiKey: FAKE_OC_KEY,
        zenBaseUrl: `http://127.0.0.1:${upstream.port}`,
        modelMap: { default: { modelId: 'qwen3.6-plus', provider: 'zen' } },
      },
    });

    const res = await post(
      { model: 'cli', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] },
      true,
    );

    expect(res.status).toBe(200);
    expect(upstream.hits).toBe(1);
    expect(upstream.lastPath).toBe('/v1/chat/completions');
    expect(upstream.lastAuthHeader).toBe(`Bearer ${FAKE_OC_KEY}`);
    expect(upstream.lastApiKeyHeader).toBeUndefined();
  });
});
