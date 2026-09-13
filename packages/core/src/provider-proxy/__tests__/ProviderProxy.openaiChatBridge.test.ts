/**
 * OpenAI Chat Completions → CLAUDE SUBSCRIPTION bridge (openai-chat-bridge #11).
 *
 * Drives `/v1/chat/completions` SUBSCRIPTION routes end-to-end through the chat
 * ingress's NEW `buildSubscriptionPlan` branch against a real `node:http` mock
 * Anthropic upstream (NO mocked fetch), proving the value is REUSE of the
 * existing `AnthropicTransformer` chain — Unified(OpenAI-chat) → Anthropic on the
 * request, Anthropic → Unified(OpenAI-chat) on the response — with streaming and
 * tools covered by the shipped converters:
 *
 *   1. non-stream → OpenAI Chat Completions shape (choices[0].message.content).
 *   2. streaming  → OpenAI SSE deltas (`chat.completion.chunk`) + `[DONE]`.
 *   3. tools      → OpenAI `tool_calls` round-trip from Anthropic `tool_use`.
 *   4. 401 refresh → onUnauthorized true → retry once (two hits, refreshed bearer).
 *   5. deferral   → a non-claude subscription provider → clear 502 (not half-routed).
 *   6. zero-regression → a BYO chat route still relays the OpenAI completion.
 *
 * The claude profile + auth strategy mirror the REAL `PassThroughAuthStrategy`
 * header contract WITHOUT importing `@omnicross/subscriptions` (core litmus 0);
 * `providerTransformerNames: ['anthropic']` resolve to the REAL
 * `AnthropicTransformer` via the injected `getTransformerService()`.
 *
 * @module provider-proxy/__tests__/ProviderProxy.openaiChatBridge.test
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveRoute } from '../../outbound-api/routeResolver';
import {
  setSubscriptionRegistryForOutbound,
  type SubscriptionRegistryLike,
} from '../../outbound-api/subscriptionRegistryPort';
import type { EndpointRoutingConfig } from '../../outbound-api/types';
import type { ProviderConfigSource } from '../../ports';
import type { AuthStrategy } from '../../pipeline/SubscriptionAuthStrategy';
import { AnthropicTransformer } from '../../transformer/transformers/AnthropicTransformer';
import { OpenAIResponseTransformer } from '../../transformer/transformers/OpenAIResponseTransformer';

// The gemini project resolver is module-level state; stub it for the gemini
// threading test (existing claude/kimi/grok/opencodego tests never reach it).
vi.mock('../../ports/gemini-code-assist-resolver', () => ({
  getGeminiCodeAssistResolver: () => ({ resolveProject: async () => 'proj-gemini-123' }),
}));
// Same for the antigravity-dialect resolver (REQUIRED handshake on that path).
// importOriginal keeps the module's other exports (e.g. the endpoint constant
// the transformer reads) intact.
vi.mock('../../auth/GeminiCodeAssistProjectResolver', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAntigravityProjectResolver: () => ({ resolveProject: async () => 'proj-antigravity-456' }),
}));
import type { Transformer } from '../../transformer/types';
import { ProviderProxy } from '../ProviderProxy';
import type { ProviderProxyDeps, RouteContext, SubscriptionDispatchProfile } from '../types';

// ── Anthropic mock upstream (JSON text / tool_use, and SSE stream) ───────────

const ANTHROPIC_TEXT = {
  id: 'msg_text',
  type: 'message',
  role: 'assistant',
  model: 'claude-x',
  content: [{ type: 'text', text: 'pong' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 7, output_tokens: 4 },
};

const ANTHROPIC_TOOL_USE = {
  id: 'msg_tool',
  type: 'message',
  role: 'assistant',
  model: 'claude-x',
  content: [
    { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'SF' } },
  ],
  stop_reason: 'tool_use',
  usage: { input_tokens: 9, output_tokens: 5 },
};

/** A minimal Anthropic SSE stream: message_start → text delta → stop. */
const ANTHROPIC_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_stream","model":"claude-x","usage":{"input_tokens":5,"output_tokens":0}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"pong"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n');

const OPENAI_COMPLETION = {
  id: 'chatcmpl-byo',
  object: 'chat.completion',
  created: 1,
  model: 'byo-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'byo-pong' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
};

/** A minimal non-stream RESPONSES-shaped body (grok's upstream wire). */
const RESPONSES_COMPLETION = {
  id: 'resp_grok',
  object: 'response',
  status: 'completed',
  model: 'grok-x',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'pong' }] }],
  usage: { input_tokens: 3, output_tokens: 2 },
};

interface MockUpstream {
  server: Server;
  port: number;
  hits: number;
  lastAuthHeader: string | undefined;
  lastBody: string | undefined;
  paths: string[];
  /** When > 0, the first N hits reply 401 (then succeed). */
  failFirstN: number;
}

function startMockUpstream(): Promise<MockUpstream> {
  const state: MockUpstream = {
    server: undefined as unknown as Server,
    port: 0,
    hits: 0,
    lastAuthHeader: undefined,
    lastBody: undefined,
    paths: [],
    failFirstN: 0,
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      state.hits += 1;
      state.lastAuthHeader = req.headers['authorization'] as string | undefined;
      state.lastBody = body;
      state.paths.push(req.url ?? '');
      let parsed: { stream?: unknown; tools?: unknown } = {};
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        /* ignore */
      }
      if (state.failFirstN > 0) {
        state.failFirstN -= 1;
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'unauthorized' } }));
        return;
      }
      const url = req.url ?? '';
      // Grok-style Responses upstream → a Responses-shaped body.
      if (url.includes('/v1/responses')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(RESPONSES_COMPLETION));
        return;
      }
      // Codex-style Responses upstream → SSE with NO Content-Type (the codex
      // backend omits it; both the transformer and the collapse must sniff).
      if (url.includes('/codex-sse')) {
        res.writeHead(200);
        res.end(
          'data: {"type":"response.created","response":{"id":"resp_chat_9","model":"gpt-5.6-luna"}}\n\n' +
            'data: {"type":"response.output_text.delta","delta":"pong"}\n\n' +
            'data: {"type":"response.completed","response":{"id":"resp_chat_9","model":"gpt-5.6-luna","usage":{"input_tokens":3,"output_tokens":2}}}\n\n' +
            'data: [DONE]\n\n',
        );
        return;
      }
      // BYO OpenAI-compat path (not /v1/messages) → OpenAI completion.
      if (!url.includes('/v1/messages')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(OPENAI_COMPLETION));
        return;
      }
      // Anthropic subscription upstream.
      if (parsed.stream === true) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(ANTHROPIC_SSE);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(parsed.tools) ? ANTHROPIC_TOOL_USE : ANTHROPIC_TEXT));
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

// ── Fake claude subscription strategy (mirrors PassThroughAuthStrategy) ───────

const CLAUDE_OAUTH = 'fake-claude-oauth';
const CLAUDE_OAUTH_REFRESHED = 'fake-claude-oauth-2';

function makeClaudeStrategy(providerId = 'claude'): AuthStrategy {
  const refreshed = { value: false };
  return {
    kind: 'pass-through',
    providerId,
    async applyHeaders(headers) {
      headers['Authorization'] = `Bearer ${refreshed.value ? CLAUDE_OAUTH_REFRESHED : CLAUDE_OAUTH}`;
    },
    async onUnauthorized() {
      refreshed.value = true;
      return true;
    },
    async describeStatus() {
      return { providerId, ok: true };
    },
  } as AuthStrategy;
}

function claudeProfile(upstreamUrl: string, providerId = 'claude'): SubscriptionDispatchProfile {
  return {
    providerId: providerId as SubscriptionDispatchProfile['providerId'],
    displayName: providerId,
    authStrategy: makeClaudeStrategy(providerId),
    mode: 'pass-through',
    resolveUpstreamUrl: () => upstreamUrl,
    providerTransformerNames: ['anthropic'],
    modelTransformerNames: [],
  };
}

// ── LLM-config stub (registers the REAL AnthropicTransformer by name) ─────────

function makeLlmConfig(): ProviderConfigSource {
  const transformers: Record<string, Transformer> = { anthropic: new AnthropicTransformer() };
  return {
    // BYO row for the zero-regression test (an OpenAI-compat provider).
    getProvider: vi.fn(async (id: string) =>
      id === 'byo'
        ? { id: 'byo', name: 'byo', api_key: 'sk-byo', api_base_url: `__BASE__`, models: ['byo-model'], enabled: true }
        : null,
    ),
    resolveTransformerChain: vi.fn(async () => ({ providerTransformers: [], modelTransformers: [] })),
    getMainTransformer: vi.fn(async () => null),
    getTransformerService: () => ({ getTransformer: (name: string) => transformers[name] }),
  } as unknown as ProviderConfigSource;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('ProviderProxy OpenAI-chat → CLAUDE subscription bridge (openai-chat-bridge #11)', () => {
  let proxy: ProviderProxy;
  let baseUrl: string;
  let upstream: MockUpstream;
  let llmConfig: ProviderConfigSource;

  async function startProxy(extra: Partial<ProviderProxyDeps> = {}): Promise<void> {
    llmConfig = makeLlmConfig();
    proxy = new ProviderProxy({ llmConfig, ...extra });
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

  function subRoute(profile: SubscriptionDispatchProfile): RouteContext {
    return {
      sessionId: 'sess-chat-sub',
      targetProviderFormat: 'transform',
      model: 'claude-sonnet-4-5',
      ingressFormat: 'openai-chat',
      authMode: 'subscription',
      providerId: profile.providerId,
      subscriptionProfile: profile,
    };
  }

  function upstreamUrl(path: string): string {
    return `http://127.0.0.1:${upstream.port}${path}`;
  }

  // 1 — non-stream: Anthropic upstream response → OpenAI Chat Completions shape.
  it('non-stream → OpenAI Chat Completions shape from a Claude subscription', async () => {
    await startProxy();
    const token = proxy.addRoute(subRoute(claudeProfile(upstreamUrl('/v1/messages'))));
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(upstream.hits).toBe(1);
    expect(upstream.paths[0]).toBe('/v1/messages');
    // Auth: the subscription OAuth bearer reached the upstream (route token discarded).
    expect(upstream.lastAuthHeader).toBe(`Bearer ${CLAUDE_OAUTH}`);
    // The request was re-encoded to the Anthropic wire (max_tokens survived).
    const sent = JSON.parse(upstream.lastBody ?? '{}') as { messages?: unknown };
    expect(Array.isArray(sent.messages)).toBe(true);
    // The response came back as an OpenAI chat.completion.
    const json = (await res.json()) as {
      object?: string;
      choices?: Array<{ message?: { content?: string } }>;
    };
    expect(json.object).toBe('chat.completion');
    expect(json.choices?.[0]?.message?.content).toBe('pong');
  });

  // 2 — streaming: Anthropic SSE → OpenAI SSE delta chunks + [DONE].
  it('streaming → OpenAI SSE deltas translated from the Anthropic event stream', async () => {
    await startProxy();
    const token = proxy.addRoute(subRoute(claudeProfile(upstreamUrl('/v1/messages'))));
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 16,
        stream: true,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    // OpenAI chunk shape (not Anthropic events) + the streamed token + terminator.
    expect(text).toContain('chat.completion.chunk');
    expect(text).toContain('"content":"pong"');
    expect(text).toContain('[DONE]');
    // It must NOT be the raw Anthropic wire (proves the converter ran).
    expect(text).not.toContain('content_block_delta');
  });

  // 3 — tools: Anthropic tool_use → OpenAI tool_calls.
  it('tools → OpenAI tool_calls round-tripped from Anthropic tool_use', async () => {
    await startProxy();
    const token = proxy.addRoute(subRoute(claudeProfile(upstreamUrl('/v1/messages'))));
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'weather in SF?' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'Get weather',
              parameters: { type: 'object', properties: { city: { type: 'string' } } },
            },
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(upstream.hits).toBe(1);
    // The tools were re-encoded to the Anthropic wire on the request.
    const sent = JSON.parse(upstream.lastBody ?? '{}') as { tools?: unknown };
    expect(Array.isArray(sent.tools)).toBe(true);
    // The response carries OpenAI tool_calls (converted from Anthropic tool_use).
    const json = (await res.json()) as {
      choices?: Array<{
        message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> };
        finish_reason?: string;
      }>;
    };
    const toolCall = json.choices?.[0]?.message?.tool_calls?.[0];
    expect(toolCall?.function?.name).toBe('get_weather');
    expect(JSON.parse(toolCall?.function?.arguments ?? '{}')).toEqual({ city: 'SF' });
    expect(json.choices?.[0]?.finish_reason).toBe('tool_calls');
  });

  // 4 — 401 → token refresh → retry once (two hits, refreshed bearer).
  it('401 → onUnauthorized refresh → retry once (two upstream hits, refreshed bearer)', async () => {
    await startProxy();
    upstream.failFirstN = 1;
    const token = proxy.addRoute(subRoute(claudeProfile(upstreamUrl('/v1/messages'))));
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(upstream.hits).toBe(2);
    expect(upstream.lastAuthHeader).toBe(`Bearer ${CLAUDE_OAUTH_REFRESHED}`);
  });

  // 5 — a non-claude subscription provider is DEFERRED with a clear 501 (OQ1):
  // an unimplemented capability, not an upstream (502) failure.
  it('non-claude subscription over chat → clear 501 deferral, no upstream call', async () => {
    await startProxy();
    // An UNKNOWN provider id exercises the gate itself (every built-in catalog
    // id is allowlisted now; the guard remains for custom profiles).
    const token = proxy.addRoute(subRoute(claudeProfile(upstreamUrl('/v1/messages'), 'custom-unknown')));
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({
        model: 'gpt-5-codex',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });

    expect(res.status).toBe(501);
    const json = (await res.json()) as { error?: { message?: string } };
    expect(json.error?.message).toMatch(/does not implement subscription provider 'custom-unknown'/);
    expect(upstream.hits).toBe(0);
  });

  // 6 — zero regression: a BYO chat route still relays the OpenAI completion.
  it('BYO chat route unchanged → relays the upstream OpenAI completion', async () => {
    await startProxy();
    // Point the BYO provider row's base URL at the mock upstream.
    (llmConfig.getProvider as unknown as { mockImplementation: (fn: (id: string) => Promise<unknown>) => void }).mockImplementation(
      async (id: string) =>
        id === 'byo'
          ? {
              id: 'byo',
              name: 'byo',
              api_key: 'sk-byo',
              api_base_url: `http://127.0.0.1:${upstream.port}`,
              models: ['byo-model'],
              enabled: true,
            }
          : null,
    );
    const byoRoute: RouteContext = {
      sessionId: 'sess-byo',
      targetProviderFormat: 'transform',
      model: 'byo-model',
      ingressFormat: 'openai-chat',
      authMode: 'byo',
      providerId: 'byo',
    };
    const token = proxy.addRoute(byoRoute);
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({
        model: 'byo-model',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'ping' }],
        reasoning_effort: 'xhigh',
      }),
    });

    expect(res.status).toBe(200);
    expect(upstream.hits).toBe(1);
    expect(JSON.parse(upstream.lastBody ?? '{}').reasoning_effort).toBe('xhigh');
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    expect(json.choices?.[0]?.message?.content).toBe('byo-pong');
  });

  // 7 — COMPOSITION (Phase 1 × Phase 2): prefix dispatch whose claude target is a
  // SUBSCRIPTION ref → resolveRoute yields a subscription route → the SAME real
  // AnthropicTransformer bridge relays an OpenAI-shaped reply. This exercises the
  // exact combination an operator enables (dispatchMode:'prefix' + a claude
  // subscription prefixTarget), which the unit tests cover only in isolation.
  it('prefix dispatch → claude SUBSCRIPTION target → real bridge end-to-end', async () => {
    await startProxy();
    const profile = claudeProfile(upstreamUrl('/v1/messages'));
    setSubscriptionRegistryForOutbound({
      getProfile: (id) => (id === 'claude' ? profile : null),
    } as SubscriptionRegistryLike);

    // Prefix-mode chat endpoint whose claude prefix target is a SUBSCRIPTION ref.
    const config: EndpointRoutingConfig = {
      endpoint: 'chat',
      models: [],
      useSubscription: true,
      dispatchMode: 'prefix',
      prefixTargets: { claude: 'claude,claude-sonnet-4-5' },
    };
    const resolved = await resolveRoute({
      config,
      ingressFormat: 'openai-chat',
      llmConfig, // getProvider('claude') → null → the subscription branch
      requestedModel: 'claude-opus-4-8-2026xxxx',
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // Prefix classified claude-* → the subscription ref; the gate opened subscription.
    expect(resolved.route.authMode).toBe('subscription');
    expect(resolved.route.providerId).toBe('claude');
    expect(resolved.route.model).toBe('claude-sonnet-4-5');
    expect(resolved.route.subscriptionProfile).toBeTruthy();

    // Feed the RESOLVED route into the shared proxy → real AnthropicTransformer bridge.
    const token = proxy.addRoute(resolved.route);
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({
        model: 'claude-opus-4-8-2026xxxx',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(upstream.hits).toBe(1);
    expect(upstream.paths[0]).toBe('/v1/messages');
    expect(upstream.lastAuthHeader).toBe(`Bearer ${CLAUDE_OAUTH}`);
    const json = (await res.json()) as {
      object?: string;
      choices?: Array<{ message?: { content?: string } }>;
    };
    expect(json.object).toBe('chat.completion');
    expect(json.choices?.[0]?.message?.content).toBe('pong');
  });
});

// ── openai-chat-bridge OQ1 closure: opencodego (shape-aware) + kimi/grok ──────

/**
 * The OQ1 closure: the chat bridge now serves OPENCODEGO (via the profile's
 * shape-aware `chatBridgeTransformerNames` seam + `modelMapper` scenario routing
 * + the opaque `route.subscriptionConfig` threading) and KIMI/GROK (static
 * route-to chains). The fake opencodego profile mirrors the REAL registry
 * implementation (core tests never import `@omnicross/subscriptions`): the
 * anthropic shape takes the `['anthropic']` ENCODER (unlike the messages path's
 * same-shape `[]` verbatim), every other shape the format transformer for its
 * wire.
 */
describe('ProviderProxy OpenAI-chat → OPENCODEGO / KIMI / GROK subscription bridge', () => {
  let proxy: ProviderProxy;
  let baseUrl: string;
  let upstream: MockUpstream;
  let llmConfig: ProviderConfigSource;

  async function startProxy(): Promise<void> {
    llmConfig = makeLlmConfig();
    proxy = new ProviderProxy({ llmConfig });
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

  function subRoute(profile: SubscriptionDispatchProfile, subscriptionConfig?: unknown): RouteContext {
    return {
      sessionId: 'sess-chat-sub-ocg',
      targetProviderFormat: 'transform',
      model: 'sdk-model',
      ingressFormat: 'openai-chat',
      authMode: 'subscription',
      providerId: profile.providerId,
      subscriptionProfile: profile,
      subscriptionConfig,
    };
  }

  function upstreamUrl(path: string): string {
    return `http://127.0.0.1:${upstream.port}${path}`;
  }

  /** Minimal config the fake seam/upstream-url read (mirrors OpenCodeGoTokenConfig). */
  interface OcgConfig {
    shape?: 'anthropic' | 'chat' | 'responses' | 'gemini';
    baseUrl?: string;
    modelMap?: { default?: { modelId: string } };
  }

  /**
   * Fake opencodego profile mirroring the REAL registry entry: per-model shape
   * from the config; anthropic shape ⇒ the `['anthropic']` ENCODER on the chat
   * bridge, chat shape ⇒ `['openai']`; URL honoring a config `baseUrl` override;
   * `modelMapper` scenario routing.
   */
  function opencodegoProfile(): SubscriptionDispatchProfile {
    const namesForShape = (shape: OcgConfig['shape'], anthropicName: 'encoder' | 'verbatim') => {
      if (shape === 'anthropic') return anthropicName === 'encoder' ? ['anthropic'] : [];
      if (shape === 'responses') return ['openai-response'];
      if (shape === 'gemini') return ['gemini'];
      return ['openai'];
    };
    return {
      providerId: 'opencodego',
      displayName: 'OpenCodeGo (Bearer key)',
      authStrategy: makeClaudeStrategy('opencodego'),
      mode: 'transformer',
      resolveUpstreamUrl: (model: string, config?: unknown) => {
        const oc = config as OcgConfig | undefined;
        const base = (oc?.baseUrl ?? upstreamUrl('')).replace(/\/+$/, '');
        return oc?.shape === 'anthropic' ? `${base}/v1/messages` : `${base}/chat/completions`;
      },
      providerTransformerNames: ['openai'],
      modelTransformerNames: [],
      resolveProviderTransformerNames: (_model: string, config?: unknown) =>
        namesForShape((config as OcgConfig | undefined)?.shape, 'verbatim'),
      // The seam under test: same shapes, but anthropic ⇒ the ENCODER.
      chatBridgeTransformerNames: (_model: string, config?: unknown) =>
        namesForShape((config as OcgConfig | undefined)?.shape, 'encoder'),
      modelMapper: (sdkModel: string, _summary: unknown, config?: unknown) => {
        const oc = config as OcgConfig | undefined;
        const mapped = oc?.modelMap?.default?.modelId ?? sdkModel;
        return { resolvedModel: mapped, scenario: 'default' };
      },
    } as unknown as SubscriptionDispatchProfile;
  }

  it('opencodego anthropic shape → AnthropicTransformer bridge with the ENCODER chain', async () => {
    await startProxy();
    const config: OcgConfig = { shape: 'anthropic', baseUrl: upstreamUrl('') };
    const token = proxy.addRoute(subRoute(opencodegoProfile(), config));
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({
        model: 'sdk-model',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(upstream.paths[0]).toBe('/v1/messages');
    // The subscription bearer reached the upstream (route token discarded).
    expect(upstream.lastAuthHeader).toBe(`Bearer ${CLAUDE_OAUTH}`);
    // The request was re-encoded onto the Anthropic wire.
    const sent = JSON.parse(upstream.lastBody ?? '{}') as { messages?: unknown };
    expect(Array.isArray(sent.messages)).toBe(true);
    // The response came back as an OpenAI chat.completion.
    const json = (await res.json()) as { object?: string; choices?: Array<{ message?: { content?: string } }> };
    expect(json.object).toBe('chat.completion');
    expect(json.choices?.[0]?.message?.content).toBe('pong');
  });

  it('opencodego chat shape → openai chain, scenario-mapped model on the wire, config URL honored', async () => {
    await startProxy();
    const config: OcgConfig = {
      shape: 'chat',
      baseUrl: upstreamUrl('/go'),
      modelMap: { default: { modelId: 'deepseek-v4.1-flash' } },
    };
    const token = proxy.addRoute(subRoute(opencodegoProfile(), config));
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ model: 'sdk-model', messages: [{ role: 'user', content: 'ping' }] }),
    });

    expect(res.status).toBe(200);
    // chat shape ⇒ the OpenAI chat-completions path at the config-overridden base.
    expect(upstream.paths[0]).toBe('/go/chat/completions');
    // modelMapper rewrote the SDK model to the scenario-mapped upstream id.
    expect(JSON.parse(upstream.lastBody ?? '{}').model).toBe('deepseek-v4.1-flash');
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    expect(json.choices?.[0]?.message?.content).toBe('byo-pong');
  });

  it('kimi static route-to chain bridges like claude', async () => {
    await startProxy();
    const token = proxy.addRoute(subRoute(claudeProfile(upstreamUrl('/v1/messages'), 'kimi')));
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({
        model: 'sdk-model',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(upstream.paths[0]).toBe('/v1/messages');
    const json = (await res.json()) as { object?: string };
    expect(json.object).toBe('chat.completion');
  });

  it('grok static route-to chain bridges to its responses upstream', async () => {
    const transformers: Record<string, Transformer> = {
      anthropic: new AnthropicTransformer(),
      'openai-response': new OpenAIResponseTransformer(),
    };
    llmConfig = {
      ...makeLlmConfig(),
      getTransformerService: () => ({ getTransformer: (name: string) => transformers[name] }),
    } as unknown as ProviderConfigSource;
    proxy = new ProviderProxy({ llmConfig });
    const port = await proxy.start();
    baseUrl = `http://127.0.0.1:${port}`;

    const token = proxy.addRoute(
      subRoute({
        ...claudeProfile(upstreamUrl('/v1/responses'), 'grok'),
        providerTransformerNames: ['openai-response'],
      }),
    );
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ model: 'sdk-model', messages: [{ role: 'user', content: 'ping' }] }),
    });

    expect(res.status).toBe(200);
    expect(upstream.paths[0]).toBe('/v1/responses');
    const json = (await res.json()) as { object?: string; choices?: Array<{ message?: { content?: string } }> };
    expect(json.object).toBe('chat.completion');
    expect(json.choices?.[0]?.message?.content).toBe('pong');
  });

  it('codex bridges with the Responses encoder contract; NON-stream caller gets a collapsed chat.completion', async () => {
    const transformers: Record<string, Transformer> = {
      anthropic: new AnthropicTransformer(),
      'openai-response': new OpenAIResponseTransformer(),
    };
    llmConfig = {
      ...makeLlmConfig(),
      getTransformerService: () => ({ getTransformer: (name: string) => transformers[name] }),
    } as unknown as ProviderConfigSource;
    proxy = new ProviderProxy({ llmConfig });
    const port = await proxy.start();
    baseUrl = `http://127.0.0.1:${port}`;
    const profile: SubscriptionDispatchProfile = {
      ...claudeProfile(upstreamUrl('/codex-sse/responses'), 'codex'),
      providerTransformerNames: ['openai-response'],
    };
    const token = proxy.addRoute(subRoute(profile));
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ model: 'sdk-model', messages: [{ role: 'user', content: 'ping' }] }),
    });

    expect(res.status).toBe(200);
    // The request reached the profile's PATH-PREFIXED upstream verbatim (the
    // transformer's host-root config.url must NOT have replaced the path).
    expect(upstream.paths[0]).toBe('/codex-sse/responses');
    // The codex body contract rode the encoder: store:false + FORCED stream:true
    // + typed input parts (the caller asked for neither stream nor store).
    const sent = JSON.parse(upstream.lastBody ?? '{}') as {
      store?: unknown;
      stream?: unknown;
      input?: unknown;
    };
    expect(sent.store).toBe(false);
    expect(sent.stream).toBe(true);
    expect(Array.isArray(sent.input)).toBe(true);
    // The SSE answer (sniffed — the mock sends NO Content-Type) collapsed into
    // the single chat.completion JSON a non-streaming client expects.
    expect(res.headers.get('content-type')).toContain('application/json');
    const json = (await res.json()) as {
      object?: string;
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number };
    };
    expect(json.object).toBe('chat.completion');
    expect(json.choices?.[0]?.message?.content).toBe('pong');
    expect(json.choices?.[0]?.finish_reason).toBe('stop');
    expect(json.usage?.prompt_tokens).toBe(3);
  });

  it('codex streaming caller gets chat SSE chunks translated from the Responses stream', async () => {
    const transformers: Record<string, Transformer> = {
      anthropic: new AnthropicTransformer(),
      'openai-response': new OpenAIResponseTransformer(),
    };
    llmConfig = {
      ...makeLlmConfig(),
      getTransformerService: () => ({ getTransformer: (name: string) => transformers[name] }),
    } as unknown as ProviderConfigSource;
    proxy = new ProviderProxy({ llmConfig });
    const port = await proxy.start();
    baseUrl = `http://127.0.0.1:${port}`;
    const profile: SubscriptionDispatchProfile = {
      ...claudeProfile(upstreamUrl('/codex-sse/responses'), 'codex'),
      providerTransformerNames: ['openai-response'],
    };
    const token = proxy.addRoute(subRoute(profile));
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ model: 'sdk-model', stream: true, messages: [{ role: 'user', content: 'ping' }] }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('chat.completion.chunk');
    expect(text).toContain('"content":"pong"');
    expect(text).toContain('[DONE]');
  });

  it('gemini resolves its Code-Assist project before the call and threads it onto the provider', async () => {
    let capturedProject: string | undefined;
    const geminiStub: Transformer = {
      name: 'gemini-code-assist',
      async transformRequestIn(request, provider) {
        capturedProject = (provider as { geminiProject?: string }).geminiProject;
        return request;
      },
    };
    llmConfig = {
      ...makeLlmConfig(),
      getTransformerService: () => ({
        getTransformer: (name: string) =>
          name === 'gemini-code-assist' ? geminiStub : undefined,
      }),
    } as unknown as ProviderConfigSource;
    proxy = new ProviderProxy({ llmConfig });
    const port = await proxy.start();
    baseUrl = `http://127.0.0.1:${port}`;

    const profile: SubscriptionDispatchProfile = {
      ...claudeProfile(upstreamUrl('/gemini-go/v1internal:generateContent'), 'gemini'),
      providerTransformerNames: ['gemini-code-assist'],
    };
    const token = proxy.addRoute(subRoute(profile));
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ model: 'sdk-model', messages: [{ role: 'user', content: 'ping' }] }),
    });

    expect(res.status).toBe(200);
    // The stub transformer observed the resolver's project on the provider.
    expect(capturedProject).toBe('proj-gemini-123');
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    expect(json.choices?.[0]?.message?.content).toBe('byo-pong');
  });

  it('copilot picks its per-wire chain and honors the account-discovered endpoint', async () => {
    const transformers: Record<string, Transformer> = {
      anthropic: new AnthropicTransformer(),
      'openai-response': new OpenAIResponseTransformer(),
    };
    llmConfig = {
      ...makeLlmConfig(),
      getTransformerService: () => ({ getTransformer: (name: string) => transformers[name] }),
    } as unknown as ProviderConfigSource;
    proxy = new ProviderProxy({ llmConfig });
    const port = await proxy.start();
    baseUrl = `http://127.0.0.1:${port}`;

    // The fake mirrors the REAL copilot profile: per-wire path + chain names,
    // and the base honoring the threaded account config's apiEndpoint.
    const wireFor = (model: string): 'anthropic' | 'chat' | 'responses' =>
      model.startsWith('claude-') ? 'anthropic' : model.startsWith('gpt-') ? 'responses' : 'chat';
    const copilotProfile = (model: string, config?: { apiEndpoint?: string }): SubscriptionDispatchProfile =>
      ({
        providerId: 'copilot',
        displayName: 'Copilot (GitHub OAuth)',
        authStrategy: makeClaudeStrategy('copilot'),
        mode: 'transformer',
        resolveUpstreamUrl: (m: string, cfg?: unknown) => {
          const base = (cfg as { apiEndpoint?: string } | undefined)?.apiEndpoint ?? upstreamUrl('');
          const wire = wireFor(m);
          return `${base}${wire === 'anthropic' ? '/v1/messages' : wire === 'chat' ? '/chat/completions' : '/v1/responses'}`;
        },
        providerTransformerNames: ['openai-response'],
        modelTransformerNames: [],
        resolveProviderTransformerNames: (m: string) => {
          const wire = wireFor(m);
          return wire === 'anthropic' ? ['anthropic'] : wire === 'chat' ? ['openai'] : ['openai-response'];
        },
      }) as unknown as SubscriptionDispatchProfile;
    const config = { apiEndpoint: upstreamUrl('/ghe-proxy') };

    // Three wires, three models — each must land on its own upstream path.
    const cases: Array<{ model: string; expectedPath: string; expectJsonChoice: boolean }> = [
      { model: 'claude-sonnet-4-5', expectedPath: '/ghe-proxy/v1/messages', expectJsonChoice: false },
      { model: 'gemini-3-pro', expectedPath: '/ghe-proxy/chat/completions', expectJsonChoice: true },
      { model: 'gpt-5.4', expectedPath: '/ghe-proxy/v1/responses', expectJsonChoice: false },
    ];
    for (const c of cases) {
      const route = {
        ...subRoute(copilotProfile(c.model, config)),
        model: c.model,
        subscriptionConfig: config,
      };
      const token = proxy.addRoute(route);
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: bearer(token),
        body: JSON.stringify({ model: c.model, messages: [{ role: 'user', content: 'ping' }] }),
      });
      expect(res.status, `model ${c.model}`).toBe(200);
      expect(upstream.paths.at(-1), `model ${c.model} path`).toBe(c.expectedPath);
      const json = (await res.json()) as { object?: string };
      expect(json.object).toBe('chat.completion');
    }
  });

  it('antigravity resolves its REQUIRED project and prefers the transformer-emitted URL', async () => {
    let capturedProject: string | undefined;
    // The real antigravity transformer owns the envelope AND emits the
    // per-request URL in config.url — the stub mirrors that contract.
    const emittedUrl = upstreamUrl('/antigravity-emitted/v1internal:generateContent');
    const antigravityStub: Transformer = {
      name: 'antigravity',
      async transformRequestIn(request, provider) {
        capturedProject = (provider as { geminiProject?: string }).geminiProject;
        // Real contract: {body, config} — the chain merges `config` only when a
        // `body` key is present.
        return { body: request, config: { url: new URL(emittedUrl) } } as never;
      },
    };
    llmConfig = {
      ...makeLlmConfig(),
      getTransformerService: () => ({
        getTransformer: (name: string) => (name === 'antigravity' ? antigravityStub : undefined),
      }),
    } as unknown as ProviderConfigSource;
    proxy = new ProviderProxy({ llmConfig });
    const port = await proxy.start();
    baseUrl = `http://127.0.0.1:${port}`;

    const profile: SubscriptionDispatchProfile = {
      ...claudeProfile(upstreamUrl('/antigravity-profile-url-must-not-be-used'), 'antigravity'),
      providerTransformerNames: ['antigravity'],
    };
    const token = proxy.addRoute(subRoute(profile));
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ model: 'sdk-model', messages: [{ role: 'user', content: 'ping' }] }),
    });

    expect(res.status).toBe(200);
    // The dialect resolver's project reached the transformer...
    expect(capturedProject).toBe('proj-antigravity-456');
    // ...and the fetch went to the TRANSFORMER-emitted URL, not the profile's.
    expect(upstream.paths.at(-1)).toBe('/antigravity-emitted/v1internal:generateContent');
  });
});
