/**
 * Built-in factory-less Anthropic `/v1/messages` SUBSCRIPTION ingress tests
 * (`omnicross-anthropic-subscription-ingress`, RT2.1, Gate 2).
 *
 * Constructs a `ProviderProxy` WITHOUT an `anthropicIngressHandlerFactory` (the
 * `@omnicross/daemon` shape) + a real `node:http` mock upstream, then drives
 * `/v1/messages` SUBSCRIPTION routes end-to-end through the built-in
 * `anthropicMessagesByo` subscription branch (NO mocked fetch), asserting:
 *
 *   3.1 claude pass-through (`profile.mode === 'pass-through'`) → verbatim relay,
 *       upstream receives the body byte-for-byte + `Authorization: Bearer <oauth>`,
 *       no transformer chain run.
 *   3.2 opencodego-MiniMax (resolved upstream ends in `/v1/messages`) → verbatim
 *       relay, upstream receives `Authorization: Bearer <key>` AND `x-api-key: <key>`.
 *   3.3 opencodego OpenAI-shape (upstream ends in `/v1/chat/completions`) →
 *       transformer chain path → Anthropic-shaped response.
 *   3.4 401-retry: claude `onUnauthorized` true → re-run once (two upstream hits +
 *       refreshed bearer); opencodego `onUnauthorized` false → surfaced, single hit.
 *   3.5 subscription-profile-absent → deterministic 502, no upstream call.
 *
 * The fake profiles + auth strategies mirror the REAL `PassThroughAuthStrategy` /
 * `StaticBearerAuthStrategy` header contracts WITHOUT importing
 * `@omnicross/subscriptions` (the litmus keeps core + its tests free of that
 * edge; the REAL-strategy proof lives in the daemon boot-smoke test). The
 * same-format decision under test is core-local (`profile.mode` +
 * `upstreamUrl.endsWith('/v1/messages')`).
 *
 * @module provider-proxy/__tests__/ProviderProxy.anthropicSubscription.test
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderConfigSource } from '../../ports';
import { setSubscriptionRegistryForOutbound } from '../../outbound-api/subscriptionRegistryPort';
import type { AuthStrategy } from '../../pipeline/SubscriptionAuthStrategy';
import { GeminiTransformer } from '../../transformer/transformers/GeminiTransformer';
import { OpenAIResponseTransformer } from '../../transformer/transformers/OpenAIResponseTransformer';
import { OpenCodeGoTransformer } from '../../transformer/transformers/OpenCodeGoTransformer';
import type { Transformer } from '../../transformer/types';
import { ProviderProxy } from '../ProviderProxy';
import type {
  ProviderProxyDeps,
  RouteContext,
  SubscriptionDispatchProfile,
} from '../types';

// ── Format-aware mock upstream ────────────────────────────────────────────────

const OPENAI_COMPLETION = {
  id: 'chatcmpl-mock',
  object: 'chat.completion',
  created: 1,
  model: 'mock-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
};

const ANTHROPIC_RESPONSE = {
  id: 'msg_mock',
  type: 'message',
  role: 'assistant',
  model: 'mock-model',
  content: [{ type: 'text', text: 'pong' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 7, output_tokens: 4 },
};

// zen `responses` shape — the endpoint transformer (AnthropicTransformer) decodes
// the openai-response chain's Unified output back to the Anthropic wire.
const RESPONSES_PAYLOAD = {
  id: 'resp_mock',
  object: 'response',
  created_at: 1,
  status: 'completed',
  model: 'mock-model',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'pong' }] }],
  usage: { input_tokens: 7, output_tokens: 4, total_tokens: 11 },
};

// zen `gemini` shape — the gemini chain decodes this back through Unified.
const GEMINI_PAYLOAD = {
  candidates: [{ content: { parts: [{ text: 'pong' }], role: 'model' }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 4, totalTokenCount: 11 },
};

interface MockUpstream {
  server: Server;
  port: number;
  hits: number;
  lastAuthHeader: string | undefined;
  lastApiKeyHeader: string | undefined;
  lastBody: string | undefined;
  /** The request path of each hit, in order (proves the zen per-shape endpoint). */
  paths: string[];
  /** When > 0, the first N hits reply 401 (then the request succeeds). */
  failFirstN: number;
  /** When > 0, the first N hits reply 503 (an unrecoverable 5xx — drives the
   *  opencodego fallback loop). Independent of `failFirstN`. */
  failFirstN5xx: number;
  /** When set, EVERY hit replies this 5xx status (exhausted-fallback proof). */
  alwaysStatus: number | undefined;
  /** Per-model status override (keyed by the request body's `model`): when a hit's
   *  body model is a key, reply that status. Drives the narrow-criterion tests
   *  (429 advances; 400 surfaces). Takes precedence over the `failFirst*` knobs. */
  statusByModel: Map<string, number>;
  /** Models for which the upstream DESTROYS the socket (no response) → the core's
   *  `fetch` REJECTS, exercising the per-iteration catch-and-advance path. */
  throwForModels: Set<string>;
  /** The resolved `model` field of each received body, in hit order. */
  models: string[];
}

function startMockUpstream(): Promise<MockUpstream> {
  const state: MockUpstream = {
    server: undefined as unknown as Server,
    port: 0,
    hits: 0,
    lastAuthHeader: undefined,
    lastApiKeyHeader: undefined,
    lastBody: undefined,
    paths: [],
    failFirstN: 0,
    failFirstN5xx: 0,
    alwaysStatus: undefined,
    statusByModel: new Map(),
    throwForModels: new Set(),
    models: [],
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      state.hits += 1;
      state.lastAuthHeader = req.headers['authorization'] as string | undefined;
      state.lastApiKeyHeader = req.headers['x-api-key'] as string | undefined;
      state.lastBody = body;
      state.paths.push(req.url ?? '');
      let bodyModel: string | undefined;
      try {
        const parsed = JSON.parse(body) as { model?: unknown };
        if (typeof parsed.model === 'string') {
          bodyModel = parsed.model;
          state.models.push(parsed.model);
        }
      } catch {
        /* ignore non-JSON bodies */
      }
      // Network-throw simulation: reset the underlying TCP socket with no response
      // → the core's `fetch` REJECTS (ECONNRESET / TypeError) promptly. Exercises
      // the per-iteration catch-and-advance.
      if (bodyModel !== undefined && state.throwForModels.has(bodyModel)) {
        req.socket.destroy();
        return;
      }
      // Per-model status override (429 advances; 400 surfaces).
      if (bodyModel !== undefined && state.statusByModel.has(bodyModel)) {
        res.writeHead(state.statusByModel.get(bodyModel)!, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `status-for-${bodyModel}` } }));
        return;
      }
      if (state.alwaysStatus !== undefined) {
        res.writeHead(state.alwaysStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'always-fail' } }));
        return;
      }
      if (state.failFirstN5xx > 0) {
        state.failFirstN5xx -= 1;
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'service unavailable' } }));
        return;
      }
      if (state.failFirstN > 0) {
        state.failFirstN -= 1;
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'unauthorized' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const url = req.url ?? '';
      if (url.includes('/v1/responses')) {
        res.end(JSON.stringify(RESPONSES_PAYLOAD));
      } else if (url.includes('/v1/models/')) {
        res.end(JSON.stringify(GEMINI_PAYLOAD));
      } else if (url.includes('/v1/messages')) {
        res.end(JSON.stringify(ANTHROPIC_RESPONSE));
      } else {
        res.end(JSON.stringify(OPENAI_COMPLETION));
      }
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

// ── Fake subscription strategies (mirror the real header contracts) ───────────

const CLAUDE_OAUTH = 'fake-claude-oauth';
const CLAUDE_OAUTH_REFRESHED = 'fake-claude-oauth-2';
const OC_KEY = 'fake-oc-key';

/** Mirrors `PassThroughAuthStrategy`: injects `Authorization: Bearer <oauth>`;
 *  `onUnauthorized` refreshes the token (one-shot) and returns true. */
function makeClaudeStrategy(): { strategy: AuthStrategy; refreshed: { value: boolean } } {
  const refreshed = { value: false };
  const strategy: AuthStrategy = {
    kind: 'pass-through',
    providerId: 'claude',
    async applyHeaders(headers) {
      headers['Authorization'] = `Bearer ${refreshed.value ? CLAUDE_OAUTH_REFRESHED : CLAUDE_OAUTH}`;
    },
    async onUnauthorized() {
      refreshed.value = true;
      return true;
    },
    async describeStatus() {
      return { providerId: 'claude', ok: true };
    },
  };
  return { strategy, refreshed };
}

/** Mirrors `StaticBearerAuthStrategy`: `Authorization: Bearer <key>` + (when the
 *  upstream is Anthropic-shape `/v1/messages`) `x-api-key: <key>`. No refresh. */
function makeOpenCodeGoStrategy(): AuthStrategy {
  return {
    kind: 'static-bearer',
    providerId: 'opencodego',
    async applyHeaders(headers, hints) {
      headers['Authorization'] = `Bearer ${OC_KEY}`;
      if (hints?.upstreamUrl?.includes('/v1/messages')) headers['x-api-key'] = OC_KEY;
    },
    async onUnauthorized() {
      return false;
    },
    async describeStatus() {
      return { providerId: 'opencodego', ok: true };
    },
  };
}

function claudeProfile(upstreamUrl: string): SubscriptionDispatchProfile {
  return {
    providerId: 'claude',
    displayName: 'Claude',
    authStrategy: makeClaudeStrategy().strategy,
    mode: 'pass-through',
    resolveUpstreamUrl: () => upstreamUrl,
    providerTransformerNames: ['anthropic'],
    modelTransformerNames: [],
  };
}

// ── LLM-config stub ───────────────────────────────────────────────────────────

function makeLlmConfig(): ProviderConfigSource {
  // The REAL provider transformers, resolved by name (the SAME ones the production
  // profile / zen seam declare): `opencodego` (chat), `openai-response` (zen
  // responses), `gemini` (zen gemini). The Anthropic endpoint transformer
  // re-encodes the upstream's wire → the Anthropic wire for the caller.
  const transformers: Record<string, Transformer> = {
    opencodego: new OpenCodeGoTransformer(),
    'openai-response': new OpenAIResponseTransformer(),
    gemini: new GeminiTransformer(),
  };
  return {
    getProvider: vi.fn(async () => null),
    resolveTransformerChain: vi.fn(async () => ({ providerTransformers: [], modelTransformers: [] })),
    getMainTransformer: vi.fn(async () => null),
    getTransformerService: () => ({
      getTransformer: (name: string) => transformers[name],
    }),
  } as unknown as ProviderConfigSource;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('ProviderProxy built-in Anthropic /v1/messages SUBSCRIPTION (no factory)', () => {
  let proxy: ProviderProxy;
  let baseUrl: string;
  let upstream: MockUpstream;

  async function startProxy(extra: Partial<ProviderProxyDeps> = {}): Promise<void> {
    proxy = new ProviderProxy({ llmConfig: makeLlmConfig(), ...extra });
    const port = await proxy.start();
    baseUrl = `http://127.0.0.1:${port}`;
  }

  beforeEach(async () => {
    // QA flake fix: the module-global outbound-registry slot
    // (`subscriptionRegistryPort`) is set by the daemon boot-smoke
    // (`setSubscriptionRegistryForOutbound` via `buildDaemon`) and read by
    // `routeResolver` for opencodego routes. When vitest interleaves that suite
    // with THIS one in a single worker, a leaked daemon registry could feed a
    // foreign `subscriptionConfig` into core opencodego routes (→ fallback
    // exhaustion → intermittent `expected 502 to be 200`). Defensively NULL the
    // slot so this matrix can never observe a sibling suite's registry.
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

  function subRoute(profile: SubscriptionDispatchProfile, over: Partial<RouteContext> = {}): RouteContext {
    return {
      sessionId: 'sess-sub',
      targetProviderFormat: 'transform',
      model: 'claude-sonnet-4-5',
      ingressFormat: 'anthropic-messages',
      authMode: 'subscription',
      providerId: profile.providerId,
      subscriptionProfile: profile,
      ...over,
    };
  }

  function upstreamUrl(path: string): string {
    return `http://127.0.0.1:${upstream.port}${path}`;
  }

  // 3.1 — claude pass-through: verbatim relay + OAuth bearer, no chain.
  it('claude pass-through → verbatim body + Bearer <oauth>, no transformer chain', async () => {
    await startProxy();
    const token = proxy.addRoute(subRoute(claudeProfile(upstreamUrl('/v1/messages'))));
    const sentBody = {
      model: 'cli',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'ping' }],
      // A server-tool block the unified pivot would strip — must survive verbatim.
      extra_server_tool: { type: 'server_tool_use', id: 'srv_1' },
    };
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify(sentBody),
    });

    expect(res.status).toBe(200);
    expect(upstream.hits).toBe(1);
    expect(upstream.lastAuthHeader).toBe(`Bearer ${CLAUDE_OAUTH}`);
    // Verbatim: the server-tool `type` field survived (no Unified round-trip).
    const received = JSON.parse(upstream.lastBody ?? '{}') as typeof sentBody;
    expect(received.extra_server_tool.type).toBe('server_tool_use');
    // Response relayed unchanged (the Anthropic upstream body, not round-tripped).
    const json = (await res.json()) as { id?: string; type?: string };
    expect(json.id).toBe(ANTHROPIC_RESPONSE.id);
    expect(json.type).toBe('message');
  });

  // 3.2 — opencodego-MiniMax: upstream ends in /v1/messages → verbatim + both auth headers.
  it('opencodego MiniMax (anthropic-shape) → verbatim relay with Bearer + x-api-key', async () => {
    await startProxy();
    const profile: SubscriptionDispatchProfile = {
      providerId: 'opencodego',
      displayName: 'OpenCodeGo',
      authStrategy: makeOpenCodeGoStrategy(),
      mode: 'transformer',
      // A mapper that resolves a minimax model; the upstream URL (ending in
      // /v1/messages) is what drives the same-format decision.
      resolveUpstreamUrl: () => upstreamUrl('/v1/messages'),
      providerTransformerNames: ['opencodego'],
      modelMapper: () => ({ resolvedModel: 'minimax-m2.5', scenario: 'long_context' }),
    };
    const token = proxy.addRoute(subRoute(profile));
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ model: 'cli', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
    });

    expect(res.status).toBe(200);
    expect(upstream.hits).toBe(1);
    expect(upstream.lastAuthHeader).toBe(`Bearer ${OC_KEY}`);
    expect(upstream.lastApiKeyHeader).toBe(OC_KEY);
  });

  // 3.3 — opencodego OpenAI-shape: upstream ends in /v1/chat/completions → transformer chain.
  it('opencodego OpenAI-shape → transformer chain → Anthropic-shaped response', async () => {
    await startProxy();
    const profile: SubscriptionDispatchProfile = {
      providerId: 'opencodego',
      displayName: 'OpenCodeGo',
      authStrategy: makeOpenCodeGoStrategy(),
      mode: 'transformer',
      resolveUpstreamUrl: () => upstreamUrl('/v1/chat/completions'),
      // The REAL opencodego provider transformer normalizes the OpenAI-shape
      // request; the Anthropic endpoint transformer decodes the OpenAI response
      // → the Anthropic wire (mirrors the production profile's chain).
      providerTransformerNames: ['opencodego'],
      modelMapper: () => ({ resolvedModel: 'kimi-k2.6', scenario: 'default' }),
    };
    const token = proxy.addRoute(subRoute(profile));
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ model: 'cli', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
    });

    expect(res.status).toBe(200);
    expect(upstream.hits).toBe(1);
    // The upstream got the Bearer (no x-api-key — NOT an Anthropic-shape URL).
    expect(upstream.lastAuthHeader).toBe(`Bearer ${OC_KEY}`);
    expect(upstream.lastApiKeyHeader).toBeUndefined();
    // The response was re-encoded to the Anthropic wire by the endpoint transformer.
    const json = (await res.json()) as { type?: string; content?: Array<{ type: string; text?: string }> };
    expect(json.type).toBe('message');
    expect(json.content?.some((b) => b.type === 'text' && b.text === 'pong')).toBe(true);
  });

  // 3.4a — claude 401 → onUnauthorized true → re-run once (two hits + refreshed bearer).
  it('claude 401 → token refresh → retry once (two upstream hits, refreshed bearer)', async () => {
    await startProxy();
    upstream.failFirstN = 1;
    const token = proxy.addRoute(subRoute(claudeProfile(upstreamUrl('/v1/messages'))));
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ model: 'cli', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
    });

    expect(res.status).toBe(200);
    expect(upstream.hits).toBe(2);
    // The retry carried the REFRESHED bearer (proves onUnauthorized ran).
    expect(upstream.lastAuthHeader).toBe(`Bearer ${CLAUDE_OAUTH_REFRESHED}`);
  });

  // 3.4b — opencodego 401 → onUnauthorized false → surfaced, single hit.
  it('opencodego 401 → onUnauthorized false → 401 surfaced, single upstream hit', async () => {
    await startProxy();
    upstream.failFirstN = 1;
    const profile: SubscriptionDispatchProfile = {
      providerId: 'opencodego',
      displayName: 'OpenCodeGo',
      authStrategy: makeOpenCodeGoStrategy(),
      mode: 'transformer',
      resolveUpstreamUrl: () => upstreamUrl('/v1/messages'),
      providerTransformerNames: ['opencodego'],
      modelMapper: () => ({ resolvedModel: 'minimax-m2.5', scenario: 'long_context' }),
    };
    const token = proxy.addRoute(subRoute(profile));
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ model: 'cli', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
    });

    expect(res.status).toBe(401);
    expect(upstream.hits).toBe(1);
  });

  // 3.6 — D6a: user modelMap override flows to the mapper via
  // route.subscriptionConfig AND the resolved override model reaches the upstream.
  // Uses the OpenAI-shape (transformer) path so the outbound body carries the
  // resolved model (the same-format verbatim path relays the ORIGINAL body
  // byte-for-byte — covered by 3.7's byte-identity assertion).
  it('opencodego modelMap override → mapper receives route.subscriptionConfig; override model sent upstream', async () => {
    await startProxy();
    let seenConfig: unknown;
    const profile: SubscriptionDispatchProfile = {
      providerId: 'opencodego',
      displayName: 'OpenCodeGo',
      authStrategy: makeOpenCodeGoStrategy(),
      mode: 'transformer',
      // OpenAI-shape upstream → transformer path → body re-serialized with the
      // resolved model.
      resolveUpstreamUrl: () => upstreamUrl('/v1/chat/completions'),
      providerTransformerNames: ['opencodego'],
      // Mirror the REAL registry mapper's config precedence: a user
      // `modelMap.default` override WINS over the built-in default.
      modelMapper: (_sdkModel, _summary, config) => {
        seenConfig = config;
        const override = (config as { modelMap?: { default?: { modelId?: string } } } | undefined)
          ?.modelMap?.default?.modelId;
        return { resolvedModel: override ?? 'kimi-k2.6', scenario: 'default' };
      },
    };
    const overrideConfig = { modelMap: { default: { modelId: 'user-override-model' } } };
    const token = proxy.addRoute(subRoute(profile, { subscriptionConfig: overrideConfig }));
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ model: 'cli', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
    });

    expect(res.status).toBe(200);
    expect(upstream.hits).toBe(1);
    // The mapper saw the REAL config (NOT undefined) and resolved the override.
    expect(seenConfig).toEqual(overrideConfig);
    expect(upstream.models[0]).toBe('user-override-model');
  });

  // 3.7 — D6b: happy path is a SINGLE verbatim attempt (byte-identical), no fallback.
  it('opencodego success → exactly one verbatim hit, no fallback attempted', async () => {
    await startProxy();
    const next = vi.fn(() => null);
    const profile: SubscriptionDispatchProfile = {
      providerId: 'opencodego',
      displayName: 'OpenCodeGo',
      authStrategy: makeOpenCodeGoStrategy(),
      mode: 'transformer',
      resolveUpstreamUrl: () => upstreamUrl('/v1/messages'),
      providerTransformerNames: ['opencodego'],
      modelMapper: () => ({ resolvedModel: 'minimax-m2.5', scenario: 'long_context' }),
      nextFallback: next,
    };
    const token = proxy.addRoute(subRoute(profile));
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ model: 'cli', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
    });

    expect(res.status).toBe(200);
    expect(upstream.hits).toBe(1);
    expect(next).not.toHaveBeenCalled();
  });

  // 3.8 — D6b: an unrecoverable 5xx advances to the next fallback model (capped at 3).
  it('opencodego 5xx → advances through the fallback chain to the next model', async () => {
    await startProxy();
    // First two hits 503 → loop advances minimax-m2.5 → fb-1 → fb-2 (3rd succeeds).
    upstream.failFirstN5xx = 2;
    const chain = [{ modelId: 'fb-1' }, { modelId: 'fb-2' }];
    const profile: SubscriptionDispatchProfile = {
      providerId: 'opencodego',
      displayName: 'OpenCodeGo',
      authStrategy: makeOpenCodeGoStrategy(),
      mode: 'transformer',
      // All fallback models stay Anthropic-shape (verbatim relay) for this test.
      resolveUpstreamUrl: () => upstreamUrl('/v1/messages'),
      providerTransformerNames: ['opencodego'],
      modelMapper: () => ({ resolvedModel: 'minimax-m2.5', scenario: 'long_context' }),
      nextFallback: (_scenario, attempted) =>
        chain.find((e) => !attempted.includes(e.modelId)) ?? null,
    };
    const token = proxy.addRoute(subRoute(profile));
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ model: 'cli', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
    });

    expect(res.status).toBe(200);
    // 3 attempts total (cap). The FIRST (verbatim same-format) attempt relays the
    // ORIGINAL body byte-for-byte (model 'cli' — happy-path byte-identity); each
    // FALLBACK iteration re-serializes the body with the advanced model id.
    expect(upstream.hits).toBe(3);
    expect(upstream.models).toEqual(['cli', 'fb-1', 'fb-2']);
  });

  // 3.9 — D6b: a fallback that FLIPS shape re-resolves the relay kind (verbatim → transformer).
  it('opencodego fallback flips minimax→non-minimax → relay kind re-resolves', async () => {
    await startProxy();
    upstream.failFirstN5xx = 1; // first (anthropic-shape) attempt fails → fallback.
    const profile: SubscriptionDispatchProfile = {
      providerId: 'opencodego',
      displayName: 'OpenCodeGo',
      authStrategy: makeOpenCodeGoStrategy(),
      mode: 'transformer',
      // minimax → Anthropic-shape /v1/messages (verbatim); kimi → OpenAI-shape
      // /v1/chat/completions (transformer chain). The loop must recompute
      // sameFormat per iteration.
      resolveUpstreamUrl: (model) =>
        model.startsWith('minimax')
          ? upstreamUrl('/v1/messages')
          : upstreamUrl('/v1/chat/completions'),
      providerTransformerNames: ['opencodego'],
      modelMapper: () => ({ resolvedModel: 'minimax-m2.5', scenario: 'long_context' }),
      nextFallback: (_scenario, attempted) =>
        attempted.includes('kimi-k2.6') ? null : { modelId: 'kimi-k2.6' },
    };
    const token = proxy.addRoute(subRoute(profile));
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ model: 'cli', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
    });

    // The first (verbatim /v1/messages) hit 503; the fallback re-resolved to the
    // OpenAI-shape /v1/chat/completions transformer path and succeeded → Anthropic
    // response. The x-api-key was injected only on the first (Anthropic-shape) hit.
    expect(res.status).toBe(200);
    expect(upstream.hits).toBe(2);
    // First (verbatim /v1/messages) hit relays the ORIGINAL body ('cli'); the
    // shape-flipped fallback (OpenAI-shape transformer path) re-serializes the
    // body with the resolved fallback model.
    expect(upstream.models).toEqual(['cli', 'kimi-k2.6']);
    const json = (await res.json()) as { type?: string };
    expect(json.type).toBe('message');
  });

  // 3.10 — D6b: exhausted fallbacks surface the LAST error (cap reached / null next).
  it('opencodego all-fail → surfaces the last 5xx after exhausting fallbacks', async () => {
    await startProxy();
    upstream.alwaysStatus = 503; // every hit fails.
    const chain = [{ modelId: 'fb-1' }, { modelId: 'fb-2' }, { modelId: 'fb-3' }];
    const profile: SubscriptionDispatchProfile = {
      providerId: 'opencodego',
      displayName: 'OpenCodeGo',
      authStrategy: makeOpenCodeGoStrategy(),
      mode: 'transformer',
      resolveUpstreamUrl: () => upstreamUrl('/v1/messages'),
      providerTransformerNames: ['opencodego'],
      modelMapper: () => ({ resolvedModel: 'minimax-m2.5', scenario: 'long_context' }),
      nextFallback: (_scenario, attempted) =>
        chain.find((e) => !attempted.includes(e.modelId)) ?? null,
    };
    const token = proxy.addRoute(subRoute(profile));
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ model: 'cli', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
    });

    // Cap = 3 attempts (initial + 2 fallbacks); the last 503 surfaces. The first
    // (verbatim) attempt relays the ORIGINAL body ('cli'); fallbacks re-serialize.
    expect(res.status).toBe(503);
    expect(upstream.hits).toBe(3);
    expect(upstream.models).toEqual(['cli', 'fb-1', 'fb-2']);
  });

  // 3.11 — D6b: claude (no nextFallback) is unaffected — single attempt even on 5xx.
  it('claude 5xx → no fallback attempted (claude declares no nextFallback)', async () => {
    await startProxy();
    upstream.alwaysStatus = 503;
    const token = proxy.addRoute(subRoute(claudeProfile(upstreamUrl('/v1/messages'))));
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ model: 'cli', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
    });

    expect(res.status).toBe(503);
    expect(upstream.hits).toBe(1);
  });

  // 3.12 — D6b (review r1): a THROWN network error on model 1 is caught and
  // advances to a fallback (NOT a bare 502). The primary's verbatim first attempt
  // relays the original body ('cli') → upstream destroys the socket → fetch rejects
  // → loop catches → advances to `minimax-fb` (succeeds).
  it('opencodego network throw on model 1 → catches + advances → succeeds on fallback', async () => {
    await startProxy();
    // Primary attempt's body model on the verbatim path is the ORIGINAL 'cli'.
    upstream.throwForModels.add('cli');
    const profile: SubscriptionDispatchProfile = {
      providerId: 'opencodego',
      displayName: 'OpenCodeGo',
      authStrategy: makeOpenCodeGoStrategy(),
      mode: 'transformer',
      resolveUpstreamUrl: () => upstreamUrl('/v1/messages'),
      providerTransformerNames: ['opencodego'],
      modelMapper: () => ({ resolvedModel: 'minimax-m2.5', scenario: 'long_context' }),
      nextFallback: (_scenario, attempted) =>
        attempted.includes('minimax-fb') ? null : { modelId: 'minimax-fb' },
    };
    const token = proxy.addRoute(subRoute(profile));
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ model: 'cli', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
    });

    // NOT a 502: the thrown primary advanced to the fallback, which succeeded.
    expect(res.status).toBe(200);
    expect(upstream.hits).toBe(2);
    // hit 1 = primary verbatim body ('cli', socket destroyed); hit 2 = fallback model.
    expect(upstream.models).toEqual(['cli', 'minimax-fb']);
  });

  // 3.13 — D6b (review r1): a 429 (rate-limit) on model 1 ADVANCES (transient).
  it('opencodego 429 on model 1 → advances to fallback (rate-limit is transient)', async () => {
    await startProxy();
    // Primary verbatim body model 'cli' → 429; fallback 'minimax-fb' → 200.
    upstream.statusByModel.set('cli', 429);
    const profile: SubscriptionDispatchProfile = {
      providerId: 'opencodego',
      displayName: 'OpenCodeGo',
      authStrategy: makeOpenCodeGoStrategy(),
      mode: 'transformer',
      resolveUpstreamUrl: () => upstreamUrl('/v1/messages'),
      providerTransformerNames: ['opencodego'],
      modelMapper: () => ({ resolvedModel: 'minimax-m2.5', scenario: 'long_context' }),
      nextFallback: (_scenario, attempted) =>
        attempted.includes('minimax-fb') ? null : { modelId: 'minimax-fb' },
    };
    const token = proxy.addRoute(subRoute(profile));
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ model: 'cli', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
    });

    expect(res.status).toBe(200);
    expect(upstream.hits).toBe(2);
    expect(upstream.models).toEqual(['cli', 'minimax-fb']);
  });

  // 3.14 — D6b (review r1): a 400 (client error) on model 1 SURFACES — does NOT
  // advance (a client error fails identically on every model). Locks the narrow
  // criterion: `nextFallback` is never consulted.
  it('opencodego 400 on model 1 → surfaces the 400 WITHOUT advancing', async () => {
    await startProxy();
    upstream.statusByModel.set('cli', 400);
    const nextFallback = vi.fn(() => ({ modelId: 'minimax-fb' }));
    const profile: SubscriptionDispatchProfile = {
      providerId: 'opencodego',
      displayName: 'OpenCodeGo',
      authStrategy: makeOpenCodeGoStrategy(),
      mode: 'transformer',
      resolveUpstreamUrl: () => upstreamUrl('/v1/messages'),
      providerTransformerNames: ['opencodego'],
      modelMapper: () => ({ resolvedModel: 'minimax-m2.5', scenario: 'long_context' }),
      nextFallback,
    };
    const token = proxy.addRoute(subRoute(profile));
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ model: 'cli', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
    });

    // The 400 surfaced verbatim; no fallback was consulted or attempted.
    expect(res.status).toBe(400);
    expect(upstream.hits).toBe(1);
    expect(upstream.models).toEqual(['cli']);
    expect(nextFallback).not.toHaveBeenCalled();
  });

  // ── ZEN four-shape matrix + sameFormat + cross-half fallback ──────────────────
  // (opencodego-zen-provider Phase 3 tasks 3.4/3.5/3.6). The profiles mirror the
  // REAL registry's shape→(url, names) mapping WITHOUT importing
  // `@omnicross/subscriptions` (core litmus stays 0). `// UNVERIFIED (no live zen
  // key)`: byte-acceptance is proven only by the in-process fake upstream; the
  // wiring + the bytes the core controls are real.

  /** A zen shape classifier local to the test (mirrors the registry, no import). */
  function zenShape(model: string): 'anthropic' | 'responses' | 'gemini' | 'chat' {
    if (model.startsWith('claude') || model === 'qwen3.7-max' || model.startsWith('minimax'))
      return 'anthropic';
    if (model.startsWith('gemini-')) return 'gemini';
    if (model.startsWith('gpt-5') || model.endsWith('-codex')) return 'responses';
    return 'chat';
  }
  function zenNamesForShape(shape: ReturnType<typeof zenShape>): readonly string[] {
    return shape === 'anthropic'
      ? []
      : shape === 'responses'
        ? ['openai-response']
        : shape === 'gemini'
          ? ['gemini']
          : ['opencodego'];
  }
  /** zen upstream URL for a model on this mock (the gemini base ends in /models/). */
  function zenUrl(model: string): string {
    const shape = zenShape(model);
    if (shape === 'anthropic') return upstreamUrl('/v1/messages');
    if (shape === 'responses') return upstreamUrl('/v1/responses');
    if (shape === 'gemini') return upstreamUrl('/v1/models/');
    return upstreamUrl('/v1/chat/completions');
  }
  /** Build an opencodego ZEN profile resolving the mapped `model` per shape. */
  function zenProfile(model: string): SubscriptionDispatchProfile {
    return {
      providerId: 'opencodego',
      displayName: 'OpenCodeGo',
      authStrategy: makeOpenCodeGoStrategy(),
      mode: 'transformer',
      resolveUpstreamUrl: (m) => zenUrl(m),
      resolveProviderTransformerNames: (m) => zenNamesForShape(zenShape(m)),
      providerTransformerNames: ['opencodego'],
      modelMapper: () => ({ resolvedModel: model, scenario: 'default' }),
    };
  }

  // 3.4a — zen responses (gpt-5-codex) → /v1/responses, Bearer only, Anthropic resp.
  it('zen responses → /v1/responses, Bearer only, Anthropic-shaped response', async () => {
    await startProxy();
    const token = proxy.addRoute(subRoute(zenProfile('gpt-5-codex')));
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ model: 'cli', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
    });
    expect(res.status).toBe(200);
    expect(upstream.hits).toBe(1);
    // The openai-response chain hit /v1/responses (NOT the lossy /v1 root — the
    // core keeps the profile upstreamUrl for the responses chain).
    expect(upstream.paths[0]).toBe('/v1/responses');
    expect(upstream.lastAuthHeader).toBe(`Bearer ${OC_KEY}`);
    expect(upstream.lastApiKeyHeader).toBeUndefined();
    const json = (await res.json()) as { type?: string; content?: Array<{ type: string; text?: string }> };
    expect(json.type).toBe('message');
    expect(json.content?.some((b) => b.type === 'text' && b.text === 'pong')).toBe(true);
  });

  // 3.4b — zen gemini non-stream → /v1/models/{id}:generateContent, Bearer only.
  it('zen gemini (non-stream) → per-model :generateContent, Bearer only', async () => {
    await startProxy();
    const token = proxy.addRoute(subRoute(zenProfile('gemini-3-flash')));
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ model: 'cli', max_tokens: 16, stream: false, messages: [{ role: 'user', content: 'ping' }] }),
    });
    expect(res.status).toBe(200);
    expect(upstream.hits).toBe(1);
    expect(upstream.paths[0]).toBe('/v1/models/gemini-3-flash:generateContent');
    expect(upstream.lastAuthHeader).toBe(`Bearer ${OC_KEY}`);
    expect(upstream.lastApiKeyHeader).toBeUndefined();
    const json = (await res.json()) as { type?: string };
    expect(json.type).toBe('message');
  });

  // 3.4b — zen gemini STREAM → :streamGenerateContent?alt=sse, Bearer only.
  it('zen gemini (stream) → :streamGenerateContent?alt=sse, Bearer only', async () => {
    await startProxy();
    const token = proxy.addRoute(subRoute(zenProfile('gemini-3-flash')));
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ model: 'cli', max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'ping' }] }),
    });
    expect(res.status).toBe(200);
    expect(upstream.hits).toBe(1);
    expect(upstream.paths[0]).toBe('/v1/models/gemini-3-flash:streamGenerateContent?alt=sse');
    expect(upstream.lastApiKeyHeader).toBeUndefined();
  });

  // 3.4c — zen anthropic (claude) → verbatim /v1/messages, Bearer + x-api-key.
  it('zen anthropic → verbatim relay at /v1/messages, Bearer + x-api-key', async () => {
    await startProxy();
    const token = proxy.addRoute(subRoute(zenProfile('claude-sonnet-4.5')));
    const sentBody = {
      model: 'cli',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'ping' }],
      extra_server_tool: { type: 'server_tool_use', id: 'srv_1' },
    };
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify(sentBody),
    });
    expect(res.status).toBe(200);
    expect(upstream.hits).toBe(1);
    expect(upstream.paths[0]).toBe('/v1/messages');
    expect(upstream.lastAuthHeader).toBe(`Bearer ${OC_KEY}`);
    expect(upstream.lastApiKeyHeader).toBe(OC_KEY);
    // Verbatim: the server-tool `type` survived (no Unified round-trip).
    const received = JSON.parse(upstream.lastBody ?? '{}') as typeof sentBody;
    expect(received.extra_server_tool.type).toBe('server_tool_use');
  });

  // 3.4d — zen chat (qwen3.6-plus) → opencodego chain at /v1/chat/completions.
  it('zen chat → opencodego chain at /v1/chat/completions, Bearer only', async () => {
    await startProxy();
    const token = proxy.addRoute(subRoute(zenProfile('qwen3.6-plus')));
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ model: 'cli', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
    });
    expect(res.status).toBe(200);
    expect(upstream.hits).toBe(1);
    expect(upstream.paths[0]).toBe('/v1/chat/completions');
    expect(upstream.lastAuthHeader).toBe(`Bearer ${OC_KEY}`);
    expect(upstream.lastApiKeyHeader).toBeUndefined();
    const json = (await res.json()) as { type?: string };
    expect(json.type).toBe('message');
  });

  // 3.5 — sameFormat NO false positive: ONLY zen anthropic takes the verbatim
  // relay (the others run the chain). Proven structurally: a zen non-anthropic
  // body is re-encoded (its server-tool `type` is STRIPPED by the Unified pivot),
  // while the zen anthropic body survives verbatim (asserted above in 3.4c).
  it('sameFormat false for zen responses (chain runs → body re-encoded, not verbatim)', async () => {
    await startProxy();
    const token = proxy.addRoute(subRoute(zenProfile('gpt-5-codex')));
    const sentBody = {
      model: 'cli',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'ping' }],
      // A field only the VERBATIM relay would forward; the chain drops it.
      extra_server_tool: { type: 'server_tool_use', id: 'srv_1' },
    };
    await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify(sentBody),
    });
    expect(upstream.paths[0]).toBe('/v1/responses');
    // The chain ran (Responses body), so the verbatim-only field is ABSENT.
    expect(upstream.lastBody).not.toContain('extra_server_tool');
  });

  // 3.6 — go↔zen cross-half fallback: a zen responses PRIMARY fails (mock 500) →
  // a GO chat fallback succeeds. The fallback re-resolved the go-half URL + shape +
  // chain + auth (Responses → opencodego chain at /v1/chat/completions).
  it('zen responses primary 5xx → go chat fallback re-resolves URL/shape/chain', async () => {
    await startProxy();
    upstream.failFirstN5xx = 1; // first (zen responses) attempt → 503 → fallback.
    const profile: SubscriptionDispatchProfile = {
      providerId: 'opencodego',
      displayName: 'OpenCodeGo',
      authStrategy: makeOpenCodeGoStrategy(),
      mode: 'transformer',
      // gpt-5-codex → zen responses; kimi-k2.6 → go chat (/v1/chat/completions).
      resolveUpstreamUrl: (m) =>
        m === 'gpt-5-codex' ? upstreamUrl('/v1/responses') : upstreamUrl('/v1/chat/completions'),
      resolveProviderTransformerNames: (m) =>
        m === 'gpt-5-codex' ? ['openai-response'] : ['opencodego'],
      providerTransformerNames: ['opencodego'],
      modelMapper: () => ({ resolvedModel: 'gpt-5-codex', scenario: 'default' }),
      nextFallback: (_scenario, attempted) =>
        attempted.includes('kimi-k2.6') ? null : { modelId: 'kimi-k2.6' },
    };
    const token = proxy.addRoute(subRoute(profile));
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ model: 'cli', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
    });
    expect(res.status).toBe(200);
    expect(upstream.hits).toBe(2);
    // hit 1 = zen responses (failed 503); hit 2 = go chat fallback (succeeded).
    expect(upstream.paths[0]).toBe('/v1/responses');
    expect(upstream.paths[1]).toBe('/v1/chat/completions');
    const json = (await res.json()) as { type?: string };
    expect(json.type).toBe('message');
  });

  // 3.6b — zen anthropic → go chat flip (verbatim → transformer) + breaker keys-by-id.
  it('zen anthropic primary 5xx → go chat fallback flips verbatim→transformer', async () => {
    await startProxy();
    upstream.failFirstN5xx = 1; // first (zen anthropic verbatim /v1/messages) → 503.
    const recorded: Array<{ id: string; ok: boolean }> = [];
    const profile: SubscriptionDispatchProfile = {
      providerId: 'opencodego',
      displayName: 'OpenCodeGo',
      authStrategy: makeOpenCodeGoStrategy(),
      mode: 'transformer',
      resolveUpstreamUrl: (m) =>
        m.startsWith('claude') ? upstreamUrl('/v1/messages') : upstreamUrl('/v1/chat/completions'),
      resolveProviderTransformerNames: (m) => (m.startsWith('claude') ? [] : ['opencodego']),
      providerTransformerNames: ['opencodego'],
      modelMapper: () => ({ resolvedModel: 'claude-sonnet-4.5', scenario: 'default' }),
      nextFallback: (_scenario, attempted) =>
        attempted.includes('kimi-k2.6') ? null : { modelId: 'kimi-k2.6' },
      // Breaker keys-by-id: distinct ids → distinct record calls.
      recordModelOutcome: (id, ok) => recorded.push({ id, ok }),
    };
    const token = proxy.addRoute(subRoute(profile));
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ model: 'cli', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
    });
    expect(res.status).toBe(200);
    expect(upstream.hits).toBe(2);
    // hit 1 = zen anthropic verbatim /v1/messages (503); hit 2 = go chat transformer.
    expect(upstream.paths[0]).toBe('/v1/messages');
    expect(upstream.paths[1]).toBe('/v1/chat/completions');
    // Breaker recorded distinct per-id outcomes (primary failure, fallback success).
    expect(recorded).toEqual([
      { id: 'claude-sonnet-4.5', ok: false },
      { id: 'kimi-k2.6', ok: true },
    ]);
  });

  // 3.5 — subscription profile absent → deterministic 502, no upstream call.
  it('subscription route with no profile → 502, no upstream call', async () => {
    await startProxy();
    const token = proxy.addRoute(
      subRoute(claudeProfile(upstreamUrl('/v1/messages')), { subscriptionProfile: undefined }),
    );
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ model: 'cli', max_tokens: 16, messages: [] }),
    });

    expect(res.status).toBe(502);
    const json = (await res.json()) as { error?: { message?: string } };
    expect(json.error?.message).toMatch(/subscription/i);
    expect(upstream.hits).toBe(0);
  });
});
