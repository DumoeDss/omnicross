/**
 * Built-in factory-less Anthropic `/v1/messages` BYO ingress tests
 * (`omnicross-anthropic-byo-ingress`, Gate 2).
 *
 * Constructs a `ProviderProxy` WITHOUT an `anthropicIngressHandlerFactory` (the
 * `@omnicross/daemon` shape) + a real `node:http` mock upstream, then drives
 * `/v1/messages` end-to-end through the REAL endpoint transformer + provider
 * chain + relay (NO mocked `executeProviderCall`), asserting:
 *
 *   7.1 non-stream → OpenAI-format provider → Anthropic-shaped 200 response
 *   7.2 stream:true → OpenAI-format provider → Anthropic SSE (`text/event-stream`)
 *   7.3 non-stream → Gemini-format provider → Anthropic-shaped response
 *   7.4 same-format fast path → `anthropic`-format provider → body relayed
 *       VERBATIM (server-tool `type` fields intact) + response unchanged
 *   7.5 `authMode: 'subscription'` → deterministic 502, no upstream call
 *   7.6 usage tap → records exactly one row with a recorder; no row + no throw
 *       without one
 *
 * The mock upstream is format-aware: it returns an OpenAI completion on
 * `/chat/completions`, a Gemini `generateContent` body on `:generateContent`,
 * and an Anthropic Messages body on `/v1/messages` — so each provider's response
 * chain has a real body to decode back to the Anthropic wire (or, for the
 * same-format path, relay verbatim).
 *
 * @module provider-proxy/__tests__/ProviderProxy.anthropicByo.test
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderConfigSource } from '../../ports';
import { setSubscriptionRegistryForOutbound } from '../../outbound-api/subscriptionRegistryPort';
import { GeminiTransformer } from '../../transformer/transformers/GeminiTransformer';
import type { Transformer } from '../../transformer/types';
import { ProviderProxy } from '../ProviderProxy';
import type { ProviderProxyDeps, RouteContext, UsageRecorderImport } from '../types';

// ── Format-aware mock upstream ────────────────────────────────────────────────

const OPENAI_COMPLETION = {
  id: 'chatcmpl-mock',
  object: 'chat.completion',
  created: 1,
  model: 'mock-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
};

const OPENAI_SSE_CHUNKS = [
  'data: {"id":"chatcmpl-mock","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"po"}}]}\n\n',
  'data: {"id":"chatcmpl-mock","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ng"}}]}\n\n',
  'data: {"id":"chatcmpl-mock","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
  'data: [DONE]\n\n',
];

const GEMINI_RESPONSE = {
  responseId: 'mock-gemini',
  modelVersion: 'mock-model',
  candidates: [{ content: { parts: [{ text: 'pong' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
};

const ANTHROPIC_RESPONSE = {
  id: 'msg_mock',
  type: 'message',
  role: 'assistant',
  model: 'mock-model',
  content: [{ type: 'text', text: 'pong' }],
  stop_reason: 'end_turn',
  usage: {
    input_tokens: 7,
    output_tokens: 4,
    cache_read_input_tokens: 2,
    cache_creation_input_tokens: 1,
  },
};

interface MockUpstream {
  server: Server;
  port: number;
  hits: number;
  lastAuthHeader: string | undefined;
  lastApiKeyHeader: string | undefined;
  lastBetaHeader: string | undefined;
  lastBody: string | undefined;
}

function startMockUpstream(): Promise<MockUpstream> {
  const state: MockUpstream = {
    server: undefined as unknown as Server,
    port: 0,
    hits: 0,
    lastAuthHeader: undefined,
    lastApiKeyHeader: undefined,
    lastBetaHeader: undefined,
    lastBody: undefined,
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      state.hits += 1;
      state.lastAuthHeader = req.headers['authorization'] as string | undefined;
      state.lastApiKeyHeader = req.headers['x-api-key'] as string | undefined;
      state.lastBetaHeader = req.headers['anthropic-beta'] as string | undefined;
      state.lastBody = body;
      const url = req.url ?? '';
      // SSE branch — the OpenAI-format streaming response.
      if (url.includes('/chat/completions') && body.includes('"stream":true')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const chunk of OPENAI_SSE_CHUNKS) res.write(chunk);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (url.includes(':generateContent') || url.includes(':streamGenerateContent')) {
        res.end(JSON.stringify(GEMINI_RESPONSE));
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

// ── LLM-config stub (real chain for each format) ─────────────────────────────

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

/**
 * `getMainTransformer` returns a `GeminiTransformer` for the gemini provider
 * (so the request encodes Unified → Gemini and the response decodes Gemini →
 * Unified before the Anthropic endpoint re-encodes), and null otherwise (OpenAI
 * is the unified base; the anthropic same-format path skips the chain entirely).
 */
function makeLlmConfig(upstreamBase: string): ProviderConfigSource {
  const providers: Record<string, ReturnType<typeof makeProvider>> = {
    'openai-prov': makeProvider(`${upstreamBase}/v1`, 'openai'),
    'gemini-prov': makeProvider(upstreamBase, 'gemini'),
    'anthropic-prov': makeProvider(upstreamBase, 'anthropic'),
  };
  const gemini: Transformer = new GeminiTransformer();
  return {
    getProvider: vi.fn(async (id: string) => providers[id] ?? null),
    resolveTransformerChain: vi.fn(async () => ({ providerTransformers: [], modelTransformers: [] })),
    getMainTransformer: vi.fn(async (id: string) => (id === 'gemini-prov' ? gemini : null)),
    getTransformerService: () => ({ getTransformer: () => undefined }),
  } as unknown as ProviderConfigSource;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('ProviderProxy built-in Anthropic /v1/messages BYO (no factory)', () => {
  let proxy: ProviderProxy;
  let baseUrl: string;
  let upstream: MockUpstream;

  async function startProxy(extra: Partial<ProviderProxyDeps> = {}): Promise<void> {
    proxy = new ProviderProxy({ llmConfig: makeLlmConfig(`http://127.0.0.1:${upstream.port}`), ...extra });
    const port = await proxy.start();
    baseUrl = `http://127.0.0.1:${port}`;
  }

  beforeEach(async () => {
    // QA flake fix (see ProviderProxy.anthropicSubscription): defensively NULL the
    // module-global outbound-registry slot so a leaked daemon registry from a
    // sibling suite can never feed a foreign `subscriptionConfig` into the
    // subscription route this suite mints.
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

  function route(over: Partial<RouteContext> = {}): RouteContext {
    return {
      sessionId: 'sess-byo',
      targetProviderFormat: 'transform',
      model: 'mock-model',
      ingressFormat: 'anthropic-messages',
      authMode: 'byo',
      providerId: 'openai-prov',
      ...over,
    };
  }

  // 7.1
  it('non-stream → OpenAI-format provider → Anthropic-shaped 200', async () => {
    await startProxy();
    const token = proxy.addRoute(route());
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ model: 'cli', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { type?: string; content?: Array<{ type: string; text?: string }> };
    expect(json.type).toBe('message');
    expect(json.content?.[0]?.type).toBe('text');
    // Upstream got the OpenAI completion endpoint + the provider's REAL key.
    expect(upstream.hits).toBe(1);
    expect(upstream.lastAuthHeader).toBe(`Bearer ${PROVIDER_KEY}`);
  });

  // 7.2
  it('stream:true → OpenAI-format provider → Anthropic SSE', async () => {
    await startProxy();
    const token = proxy.addRoute(route());
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({
        model: 'cli',
        max_tokens: 16,
        stream: true,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    // Anthropic SSE events (produced by convertOpenAIStreamToAnthropic).
    expect(text).toContain('event: message_start');
    expect(text).toContain('content_block_delta');
  });

  // 7.3
  it('non-stream → Gemini-format provider → Anthropic-shaped response', async () => {
    await startProxy();
    const token = proxy.addRoute(route({ providerId: 'gemini-prov' }));
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ model: 'cli', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { type?: string; content?: Array<{ type: string; text?: string }> };
    expect(json.type).toBe('message');
    expect(json.content?.some((b) => b.type === 'text' && b.text === 'pong')).toBe(true);
    // Upstream got the Gemini generateContent endpoint with the x-goog-api-key.
    expect(upstream.hits).toBe(1);
  });

  // 7.4 — same-format fast path: VERBATIM relay (server-tool type fields intact).
  it('same-format → anthropic-format provider → verbatim body + unchanged response', async () => {
    await startProxy();
    const token = proxy.addRoute(
      route({ providerId: 'anthropic-prov', targetProviderFormat: 'anthropic' }),
    );
    const sentBody = {
      model: 'cli',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'ping' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      // A pre-built server-tool block the unified pivot would strip.
      extra_server_tool: { type: 'server_tool_use', id: 'srv_1' },
    };
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { ...bearer(token), 'anthropic-beta': 'caller-beta-flag' },
      body: JSON.stringify(sentBody),
    });

    expect(res.status).toBe(200);
    // Upstream received the body VERBATIM (server-tool `type` fields intact, NOT
    // round-tripped through Unified).
    expect(upstream.hits).toBe(1);
    const received = JSON.parse(upstream.lastBody ?? '{}') as typeof sentBody;
    expect(received.tools[0].type).toBe('web_search_20250305');
    expect(received.extra_server_tool.type).toBe('server_tool_use');
    // The canonical anthropic key header was set; the caller's `anthropic-beta`
    // was forwarded/merged (LEAD OQ1).
    expect(upstream.lastApiKeyHeader).toBe(PROVIDER_KEY);
    expect(upstream.lastBetaHeader).toContain('caller-beta-flag');
    // The upstream Anthropic response relayed unchanged.
    const json = (await res.json()) as { id?: string; type?: string };
    expect(json.id).toBe(ANTHROPIC_RESPONSE.id);
    expect(json.type).toBe('message');
  });

  // 7.5
  it('authMode subscription → deterministic 502, no upstream call', async () => {
    await startProxy();
    const token = proxy.addRoute(route({ authMode: 'subscription' }));
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

  // 7.6 — usage tap.
  it('usage tap: records exactly one row with a recorder', async () => {
    const records: unknown[] = [];
    const usageRecorder: UsageRecorderImport = { record: (input) => records.push(input) };
    await startProxy({ usageRecorder });
    const token = proxy.addRoute(route({ providerId: 'anthropic-prov', targetProviderFormat: 'anthropic' }));
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ model: 'cli', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
    });

    expect(res.status).toBe(200);
    expect(records).toHaveLength(1);
    const rec = records[0] as { providerId: string; usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number } };
    expect(rec.providerId).toBe('anthropic-prov');
    expect(rec.usage.inputTokens).toBe(ANTHROPIC_RESPONSE.usage.input_tokens);
    expect(rec.usage.outputTokens).toBe(ANTHROPIC_RESPONSE.usage.output_tokens);
    expect(rec.usage.cacheReadTokens).toBe(ANTHROPIC_RESPONSE.usage.cache_read_input_tokens);
    expect(rec.usage.cacheCreationTokens).toBe(ANTHROPIC_RESPONSE.usage.cache_creation_input_tokens);
  });

  it('usage tap: no recorder → no throw, response still relayed', async () => {
    await startProxy();
    const token = proxy.addRoute(route({ providerId: 'anthropic-prov', targetProviderFormat: 'anthropic' }));
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ model: 'cli', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
    });
    expect(res.status).toBe(200);
  });

  // Missing providerId guard (spec scenario).
  it('missing providerId on a BYO route → 502, no upstream call', async () => {
    await startProxy();
    const token = proxy.addRoute(route({ providerId: undefined }));
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ model: 'cli', max_tokens: 16, messages: [] }),
    });
    expect(res.status).toBe(502);
    expect(upstream.hits).toBe(0);
  });

  // Invalid JSON guard (spec scenario).
  it('invalid JSON body → 400, no upstream call', async () => {
    await startProxy();
    const token = proxy.addRoute(route());
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: bearer(token),
      body: 'not-json{',
    });
    expect(res.status).toBe(400);
    expect(upstream.hits).toBe(0);
  });
});
