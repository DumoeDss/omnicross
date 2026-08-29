/**
 * count_tokens + resident-face routing/error tests
 * (`claude-api-routing-errors`, capabilities anthropic-count-tokens and the
 * resident half of anthropic-endpoint-routing / anthropic-local-errors).
 *
 * Constructs a `ProviderProxy` WITHOUT an `anthropicIngressHandlerFactory` (the
 * daemon shape) + a real `node:http` mock upstream that records every request
 * path, then drives `/v1/messages/count_tokens` end-to-end over the SAME
 * same-format fetches the generation path uses (NO mocked fetch):
 *
 *   - BYO passthrough: upstream hit exactly once at a URL ending
 *     `/count_tokens`, body stripped of `stream`/`max_tokens`, `model` rewritten
 *     to the resolved upstream model, `{"input_tokens":N}` relayed verbatim, and
 *     ZERO hits on the generation endpoint `/v1/messages`.
 *   - Subscription passthrough (claude pass-through profile): OAuth bearer +
 *     modelMapper-remapped model on the count_tokens URL.
 *   - reject (translation upstream / explicit config / passthrough degraded on
 *     non-wire): Anthropic-shaped 404 `not_found_error`, zero upstream calls.
 *   - upstream failure → real status + byte-identical body (no local envelope).
 *   - invalid JSON → 400 `invalid_request_error`; unsupported subpath → 404;
 *     invalid route token → 401 `authentication_error`; zero usage events.
 *   - generation-path pin: an upstream 400 on `/v1/messages` relays verbatim.
 *
 * @module provider-proxy/__tests__/anthropicCountTokens.test
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderConfigSource } from '../../ports';
import { setSubscriptionRegistryForOutbound } from '../../outbound-api/subscriptionRegistryPort';
import type { AuthStrategy } from '../../pipeline/SubscriptionAuthStrategy';
import { GeminiTransformer } from '../../transformer/transformers/GeminiTransformer';
import { OpenAITransformer } from '../../transformer/transformers/OpenAITransformer';
import type { Transformer } from '../../transformer/types';
import { ProviderProxy } from '../ProviderProxy';
import type {
  ProviderProxyDeps,
  RouteContext,
  SubscriptionDispatchProfile,
  UsageRecorderImport,
} from '../types';

// ── Mock upstream ─────────────────────────────────────────────────────────────

const ANTHROPIC_RESPONSE = {
  id: 'msg_mock',
  type: 'message',
  role: 'assistant',
  model: 'mock-model',
  content: [{ type: 'text', text: 'pong' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 7, output_tokens: 4 },
};

const COUNT_TOKENS_OK = JSON.stringify({ input_tokens: 42 });
const COUNT_TOKENS_UPSTREAM_ERROR = JSON.stringify({
  type: 'error',
  error: { type: 'invalid_request_error', message: 'upstream says no' },
});
const GENERATION_UPSTREAM_ERROR = JSON.stringify({
  type: 'error',
  error: { type: 'invalid_request_error', message: 'generation bad request' },
});

interface MockUpstream {
  server: Server;
  port: number;
  hits: number;
  /** Every request path, in order (asserts the exact endpoint + zero generation). */
  paths: string[];
  lastBody: string | undefined;
  lastAuthHeader: string | undefined;
  lastApiKeyHeader: string | undefined;
  /** When set, count_tokens hits reply with this status + body. */
  countTokensFailure: { status: number; body: string } | undefined;
  /** When set, generation (`/v1/messages` exact) hits reply with this. */
  messagesFailure: { status: number; body: string } | undefined;
}

function startMockUpstream(): Promise<MockUpstream> {
  const state: MockUpstream = {
    server: undefined as unknown as Server,
    port: 0,
    hits: 0,
    paths: [],
    lastBody: undefined,
    lastAuthHeader: undefined,
    lastApiKeyHeader: undefined,
    countTokensFailure: undefined,
    messagesFailure: undefined,
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      state.hits += 1;
      state.paths.push(req.url ?? '');
      state.lastBody = body;
      state.lastAuthHeader = req.headers['authorization'] as string | undefined;
      state.lastApiKeyHeader = req.headers['x-api-key'] as string | undefined;
      const url = req.url ?? '';
      if (url.endsWith('/count_tokens')) {
        const fail = state.countTokensFailure;
        if (fail) {
          res.writeHead(fail.status, { 'Content-Type': 'application/json' });
          res.end(fail.body);
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(COUNT_TOKENS_OK);
        }
        return;
      }
      if (url.includes('/v1/messages')) {
        const fail = state.messagesFailure;
        if (fail) {
          res.writeHead(fail.status, { 'Content-Type': 'application/json' });
          res.end(fail.body);
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(ANTHROPIC_RESPONSE));
        }
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ANTHROPIC_RESPONSE));
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

// ── LLM-config stub ───────────────────────────────────────────────────────────

const PROVIDER_KEY = 'sk-byo-real-key';

function makeProvider(base: string, format: string) {
  return {
    id: `${format}-prov`,
    name: format,
    apiFormat: format,
    api_base_url: base,
    api_key: PROVIDER_KEY,
    models: ['mock-model'],
    enabled: true,
  };
}

function makeLlmConfig(upstreamBase: string): ProviderConfigSource {
  const providers: Record<string, ReturnType<typeof makeProvider>> = {
    'openai-prov': makeProvider(`${upstreamBase}/v1`, 'openai'),
    'gemini-prov': makeProvider(upstreamBase, 'gemini'),
    'anthropic-prov': makeProvider(upstreamBase, 'anthropic'),
  };
  const gemini: Transformer = new GeminiTransformer();
  const openai: Transformer = new OpenAITransformer();
  return {
    getProvider: vi.fn(async (id: string) => providers[id] ?? null),
    resolveTransformerChain: vi.fn(async () => ({ providerTransformers: [], modelTransformers: [] })),
    getMainTransformer: vi.fn(async (id: string) =>
      id === 'gemini-prov' ? gemini : id === 'openai-prov' ? openai : null),
    getTransformerService: () => ({ getTransformer: () => undefined }),
  } as unknown as ProviderConfigSource;
}

// ── Fake claude pass-through strategy (mirrors the real header contract) ──────

const CLAUDE_OAUTH = 'fake-claude-oauth';

function claudeProfile(upstreamUrl: string): SubscriptionDispatchProfile {
  const strategy: AuthStrategy = {
    kind: 'pass-through',
    providerId: 'claude',
    async applyHeaders(headers) {
      headers['Authorization'] = `Bearer ${CLAUDE_OAUTH}`;
    },
    async onUnauthorized() {
      return false;
    },
    async describeStatus() {
      return { providerId: 'claude', ok: true };
    },
  };
  return {
    providerId: 'claude',
    displayName: 'Claude',
    authStrategy: strategy,
    mode: 'pass-through',
    resolveUpstreamUrl: () => upstreamUrl,
    providerTransformerNames: ['anthropic'],
    modelTransformerNames: [],
  };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('Anthropic /v1/messages/count_tokens + resident routing/errors', () => {
  let proxy: ProviderProxy;
  let baseUrl: string;
  let upstream: MockUpstream;
  let usageEvents: unknown[];

  async function startProxy(extra: Partial<ProviderProxyDeps> = {}): Promise<void> {
    usageEvents = [];
    proxy = new ProviderProxy({
      llmConfig: makeLlmConfig(`http://127.0.0.1:${upstream.port}`),
      usageRecorder: { record: (input) => usageEvents.push(input) } as UsageRecorderImport,
      ...extra,
    });
    const port = await proxy.start();
    baseUrl = `http://127.0.0.1:${port}`;
  }

  beforeEach(async () => {
    setSubscriptionRegistryForOutbound(null);
    upstream = await startMockUpstream();
  });

  afterEach(async () => {
    await proxy.stop();
    await stopServer(upstream.server);
    setSubscriptionRegistryForOutbound(null);
  });

  function bearer(token: string): Record<string, string> {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  }

  function byoRoute(over: Partial<RouteContext> = {}): RouteContext {
    return {
      sessionId: 'sess-ct',
      targetProviderFormat: 'anthropic',
      model: 'mock-model',
      ingressFormat: 'anthropic-messages',
      authMode: 'byo',
      providerId: 'anthropic-prov',
      ...over,
    };
  }

  function countTokensBody(over: Record<string, unknown> = {}): string {
    return JSON.stringify({
      model: 'claude-sonnet-4-5',
      stream: true,
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'ping' }],
      ...over,
    });
  }

  async function post(url: string, token: string, body: string): Promise<Response> {
    return fetch(`${baseUrl}${url}`, { method: 'POST', headers: bearer(token), body });
  }

  // ── passthrough (BYO, Anthropic-wire) ─────────────────────────────────────

  it('BYO wire upstream → ONE count_tokens hit, stream/max_tokens stripped, model rewritten, response verbatim, zero generation hits', async () => {
    await startProxy();
    const token = proxy.addRoute(byoRoute());
    const res = await post('/v1/messages/count_tokens', token, countTokensBody());

    expect(res.status).toBe(200);
    // Exactly one upstream POST, at the count_tokens endpoint.
    expect(upstream.hits).toBe(1);
    expect(upstream.paths[0]).toBe('/v1/messages/count_tokens');
    expect(upstream.paths).not.toContain('/v1/messages');
    // The generation-only fields are gone; the model is the resolved upstream
    // model; unknown fields survive the round-trip.
    const sent = JSON.parse(upstream.lastBody ?? '{}') as Record<string, unknown>;
    expect(sent).not.toHaveProperty('stream');
    expect(sent).not.toHaveProperty('max_tokens');
    expect(sent.model).toBe('mock-model');
    expect(sent.messages).toEqual([{ role: 'user', content: 'ping' }]);
    // Verbatim `{"input_tokens":N}` — no envelope, no rewrite.
    expect(await res.text()).toBe(COUNT_TOKENS_OK);
    // A free endpoint: zero usage events.
    expect(usageEvents).toHaveLength(0);
  });

  it('count_tokens variants (trailing slash / query) take the same path', async () => {
    await startProxy();
    const token = proxy.addRoute(byoRoute());
    const res = await post('/v1/messages/count_tokens?beta=true', token, countTokensBody());
    expect(res.status).toBe(200);
    expect(upstream.paths[0]).toBe('/v1/messages/count_tokens');
  });

  it('upstream count_tokens failure → real status + byte-identical body (no local envelope)', async () => {
    upstream.countTokensFailure = { status: 400, body: COUNT_TOKENS_UPSTREAM_ERROR };
    await startProxy();
    const token = proxy.addRoute(byoRoute());
    const res = await post('/v1/messages/count_tokens', token, countTokensBody());

    expect(res.status).toBe(400);
    expect(await res.text()).toBe(COUNT_TOKENS_UPSTREAM_ERROR);
    expect(upstream.hits).toBe(1);
  });

  it('invalid JSON body → 400 invalid_request_error, zero upstream calls', async () => {
    await startProxy();
    const token = proxy.addRoute(byoRoute());
    const res = await post('/v1/messages/count_tokens', token, 'not-json{');

    expect(res.status).toBe(400);
    const json = (await res.json()) as { type: string; error: { type: string } };
    expect(json.type).toBe('error');
    expect(json.error.type).toBe('invalid_request_error');
    expect(upstream.hits).toBe(0);
  });

  // ── reject ────────────────────────────────────────────────────────────────

  it('translation upstream (auto) → 404 not_found_error, zero upstream calls', async () => {
    await startProxy();
    const token = proxy.addRoute(
      byoRoute({ providerId: 'openai-prov', targetProviderFormat: 'transform' }),
    );
    const res = await post('/v1/messages/count_tokens', token, countTokensBody());

    expect(res.status).toBe(404);
    const json = (await res.json()) as { type: string; error: { type: string } };
    expect(json.type).toBe('error');
    expect(json.error.type).toBe('not_found_error');
    expect(upstream.hits).toBe(0);
  });

  it("explicit mode 'reject' on a wire upstream → 404, zero upstream calls", async () => {
    await startProxy();
    const token = proxy.addRoute(byoRoute({ anthropicCountTokensMode: 'reject' }));
    const res = await post('/v1/messages/count_tokens', token, countTokensBody());

    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: { type: string } };
    expect(json.error.type).toBe('not_found_error');
    expect(upstream.hits).toBe(0);
  });

  it("explicit mode 'passthrough' on a translation upstream → degrades to reject with a warning", async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await startProxy();
      const token = proxy.addRoute(
        byoRoute({
          providerId: 'openai-prov',
          targetProviderFormat: 'transform',
          anthropicCountTokensMode: 'passthrough',
        }),
      );
      const res = await post('/v1/messages/count_tokens', token, countTokensBody());

      expect(res.status).toBe(404);
      const json = (await res.json()) as { error: { type: string } };
      expect(json.error.type).toBe('not_found_error');
      expect(upstream.hits).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('degrading to reject'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  // ── passthrough (subscription, claude pass-through) ────────────────────────

  it('subscription pass-through → count_tokens URL + OAuth bearer + modelMapper model', async () => {
    await startProxy();
    const profile = claudeProfile(`http://127.0.0.1:${upstream.port}/v1/messages`);
    profile.modelMapper = () => ({ resolvedModel: 'minimax-m2.5', scenario: 'long_context' });
    const token = proxy.addRoute({
      sessionId: 'sess-sub',
      targetProviderFormat: 'transform',
      model: 'claude-sonnet-4-5',
      ingressFormat: 'anthropic-messages',
      authMode: 'subscription',
      providerId: 'claude',
      subscriptionProfile: profile,
    });
    const res = await post('/v1/messages/count_tokens', token, countTokensBody());

    expect(res.status).toBe(200);
    expect(upstream.paths).toEqual(['/v1/messages/count_tokens']);
    expect(upstream.lastAuthHeader).toBe(`Bearer ${CLAUDE_OAUTH}`);
    const sent = JSON.parse(upstream.lastBody ?? '{}') as Record<string, unknown>;
    expect(sent.model).toBe('minimax-m2.5');
    expect(sent).not.toHaveProperty('stream');
    expect(await res.text()).toBe(COUNT_TOKENS_OK);
    expect(usageEvents).toHaveLength(0);
  });

  it('subscription translation profile (non-wire upstream) → reject 404, zero calls', async () => {
    await startProxy();
    const profile: SubscriptionDispatchProfile = {
      providerId: 'opencodego',
      displayName: 'OpenCodeGo',
      authStrategy: {
        kind: 'static-bearer',
        providerId: 'opencodego',
        async applyHeaders(headers) {
          headers['Authorization'] = 'Bearer oc-key';
        },
        async onUnauthorized() {
          return false;
        },
        async describeStatus() {
          return { providerId: 'opencodego', ok: true };
        },
      },
      mode: 'transformer',
      // Zen-responses shape: NOT a `/v1/messages` terminal → non-wire.
      resolveUpstreamUrl: () => `http://127.0.0.1:${upstream.port}/v1/responses`,
      providerTransformerNames: ['openai-response'],
    };
    const token = proxy.addRoute({
      sessionId: 'sess-sub2',
      targetProviderFormat: 'transform',
      model: 'qwen3.7-max',
      ingressFormat: 'anthropic-messages',
      authMode: 'subscription',
      providerId: 'opencodego',
      subscriptionProfile: profile,
    });
    const res = await post('/v1/messages/count_tokens', token, countTokensBody());

    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: { type: string } };
    expect(json.error.type).toBe('not_found_error');
    expect(upstream.hits).toBe(0);
  });

  // ── resident-face routing + local errors ──────────────────────────────────

  it('unsupported subpath /v1/messages/batches → 404 not_found_error, zero upstream calls', async () => {
    await startProxy();
    const token = proxy.addRoute(byoRoute());
    const res = await post('/v1/messages/batches', token, countTokensBody());

    expect(res.status).toBe(404);
    const json = (await res.json()) as { type: string; error: { type: string } };
    expect(json.type).toBe('error');
    expect(json.error.type).toBe('not_found_error');
    expect(upstream.hits).toBe(0);
  });

  it('nested subpath /v1/messages/batches/msg_123 → same 404', async () => {
    await startProxy();
    const token = proxy.addRoute(byoRoute());
    const res = await post('/v1/messages/batches/msg_123', token, '{}');
    expect(res.status).toBe(404);
    expect(upstream.hits).toBe(0);
  });

  it('invalid route token on /v1/messages → 401 authentication_error (mark before auth)', async () => {
    await startProxy();
    const res = await post('/v1/messages', 'not-a-real-token', '{}');

    expect(res.status).toBe(401);
    const json = (await res.json()) as { type: string; error: { type: string } };
    expect(json.type).toBe('error');
    expect(json.error.type).toBe('authentication_error');
  });

  it('lookalike /v1/messagesfoo → generic legacy 404 (not Anthropic sub-resource semantics)', async () => {
    await startProxy();
    const token = proxy.addRoute(byoRoute());
    const res = await post('/v1/messagesfoo', token, '{}');

    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: { type: string } };
    expect(json.error.type).toBe('provider_proxy_error');
  });

  // ── generation-path moat pins ─────────────────────────────────────────────

  it('upstream 400 on generation /v1/messages relays verbatim (moat pin)', async () => {
    upstream.messagesFailure = { status: 400, body: GENERATION_UPSTREAM_ERROR };
    await startProxy();
    const token = proxy.addRoute(byoRoute());
    const res = await post('/v1/messages', token, countTokensBody());

    expect(res.status).toBe(400);
    expect(await res.text()).toBe(GENERATION_UPSTREAM_ERROR);
  });

  it('doubled tail /v1/messages/v1/messages still routes as generation (regression pin)', async () => {
    await startProxy();
    const token = proxy.addRoute(byoRoute());
    const res = await post('/v1/messages/v1/messages?beta=true', token, countTokensBody());

    expect(res.status).toBe(200);
    expect(upstream.paths).toEqual(['/v1/messages']);
    const json = (await res.json()) as { type: string };
    expect(json.type).toBe('message');
  });
});
