/**
 * Response `model` passthrough + verbatim same-format body fix, end-to-end
 * through the built-in factory-less Anthropic `/v1/messages` BYO ingress
 * (omnicross-mkm-serving, design D4/D5). Mirrors the `ProviderProxy.anthropicByo`
 * harness: a real loopback proxy + a format-aware mock upstream (no mocked
 * `executeProviderCall`). Proves:
 *
 *   - the client receives its ORIGINAL requested id in the response `model`
 *     (`route.requestedModel`), NOT the upstream provider model;
 *   - usage accounting stays on the UPSTREAM resolved model;
 *   - the same-format upstream receives the RESOLVED provider model when the
 *     route remapped it, and the RAW client bytes verbatim when it did not;
 *   - an internal route (no `requestedModel`) is NOT rewritten (zero regression).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setSubscriptionRegistryForOutbound } from '../../outbound-api/subscriptionRegistryPort';
import type { ProviderConfigSource } from '../../ports';
import { ProviderProxy } from '../ProviderProxy';
import type { ProviderProxyDeps, RouteContext, UsageRecorderImport } from '../types';

const ANTHROPIC_RESPONSE = {
  id: 'msg_mock',
  type: 'message',
  role: 'assistant',
  model: 'provider-real-model',
  content: [{ type: 'text', text: 'pong' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 7, output_tokens: 4, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
};

// A non-stream OpenAI-Responses final object (the "response.completed"-analog):
// its top-level `model` is what a kind-mapped Codex caller must see rewritten.
const RESPONSES_JSON = {
  id: 'resp_1',
  object: 'response',
  model: 'provider-real-model',
  status: 'completed',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'pong' }] }],
  usage: { input_tokens: 3, output_tokens: 2 },
};

interface MockUpstream {
  server: Server;
  port: number;
  hits: number;
  lastBody: string | undefined;
}

function startMockUpstream(): Promise<MockUpstream> {
  const state: MockUpstream = { server: undefined as unknown as Server, port: 0, hits: 0, lastBody: undefined };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      state.hits += 1;
      state.lastBody = body;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // Format-aware: `/responses` → Responses-shaped JSON; else Anthropic.
      res.end(JSON.stringify((req.url ?? '').includes('/responses') ? RESPONSES_JSON : ANTHROPIC_RESPONSE));
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

const PROVIDER_KEY = 'sk-byo-real-key';

function makeLlmConfig(upstreamBase: string): ProviderConfigSource {
  const providers: Record<string, unknown> = {
    'anthropic-prov': {
      id: 'anthropic-prov',
      name: 'anthropic',
      apiFormat: 'anthropic',
      api_base_url: upstreamBase,
      api_key: PROVIDER_KEY,
      models: ['provider-real-model'],
      enabled: true,
    },
    'codex-prov': {
      id: 'codex-prov',
      name: 'codex',
      apiFormat: 'openai',
      api_base_url: upstreamBase,
      api_key: PROVIDER_KEY,
      models: ['provider-real-model'],
      enabled: true,
    },
  };
  return {
    getProvider: vi.fn(async (id: string) => providers[id] ?? null),
    resolveTransformerChain: vi.fn(async () => ({ providerTransformers: [], modelTransformers: [] })),
    getMainTransformer: vi.fn(async () => null),
    getTransformerService: () => ({ getTransformer: () => undefined }),
  } as unknown as ProviderConfigSource;
}

describe('Anthropic /v1/messages — response model passthrough + verbatim body (D4/D5)', () => {
  let proxy: ProviderProxy;
  let baseUrl: string;
  let upstream: MockUpstream;

  async function startProxy(extra: Partial<ProviderProxyDeps> = {}): Promise<void> {
    proxy = new ProviderProxy({ llmConfig: makeLlmConfig(`http://127.0.0.1:${upstream.port}`), ...extra });
    const port = await proxy.start();
    baseUrl = `http://127.0.0.1:${port}`;
  }

  beforeEach(async () => {
    setSubscriptionRegistryForOutbound(null);
    upstream = await startMockUpstream();
  });
  afterEach(async () => {
    await proxy.stop();
    await new Promise<void>((r) => upstream.server.close(() => r()));
    setSubscriptionRegistryForOutbound(null);
  });

  function bearer(token: string): Record<string, string> {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  }

  function route(over: Partial<RouteContext> = {}): RouteContext {
    return {
      sessionId: 'sess-byo',
      targetProviderFormat: 'anthropic',
      model: 'provider-real-model',
      ingressFormat: 'anthropic-messages',
      authMode: 'byo',
      providerId: 'anthropic-prov',
      ...over,
    };
  }

  it('response model = client original; usage on upstream model; upstream gets resolved model', async () => {
    const records: Array<{ model: string }> = [];
    const usageRecorder: UsageRecorderImport = { record: (i) => records.push(i as { model: string }) };
    await startProxy({ usageRecorder });
    // Route remapped `claude-opus-4-8-orig` (client) → `provider-real-model` (upstream).
    const token = proxy.addRoute(route({ requestedModel: 'claude-opus-4-8-orig' }));

    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ model: 'claude-opus-4-8-orig', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
    });
    expect(res.status).toBe(200);

    // Client sees ITS original requested id, not the upstream provider model.
    const json = (await res.json()) as { model?: string; id?: string };
    expect(json.model).toBe('claude-opus-4-8-orig');
    expect(json.id).toBe(ANTHROPIC_RESPONSE.id);

    // Usage accounted on the UPSTREAM resolved model.
    expect(records).toHaveLength(1);
    expect(records[0].model).toBe('provider-real-model');

    // The same-format upstream received the RESOLVED provider model (client sent
    // `claude-opus-4-8-orig`, which differs → re-serialized).
    const sent = JSON.parse(upstream.lastBody ?? '{}') as { model?: string };
    expect(sent.model).toBe('provider-real-model');
  });

  it('verbatim: resolved === client → raw client bytes forwarded unchanged (server-tool types intact)', async () => {
    await startProxy();
    // route.model === client model → no remap → keep raw bytes.
    const token = proxy.addRoute(route({ model: 'passthru-model', requestedModel: 'passthru-model' }));
    const sentBody = {
      model: 'passthru-model',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'ping' }],
      extra_server_tool: { type: 'server_tool_use', id: 'srv_1' },
    };
    const rawBytes = JSON.stringify(sentBody);
    const res = await fetch(`${baseUrl}/v1/messages`, { method: 'POST', headers: bearer(token), body: rawBytes });
    expect(res.status).toBe(200);

    // Byte-identical body forwarded (server-tool `type` preserved), model unchanged.
    expect(upstream.lastBody).toBe(rawBytes);
    const sent = JSON.parse(upstream.lastBody ?? '{}') as { model?: string; extra_server_tool?: { type?: string } };
    expect(sent.model).toBe('passthru-model');
    expect(sent.extra_server_tool?.type).toBe('server_tool_use');
  });

  it('Responses ingress: response model = client id (final completed object); usage on upstream model', async () => {
    const records: Array<{ model: string }> = [];
    const usageRecorder: UsageRecorderImport = { record: (i) => records.push(i as { model: string }) };
    await startProxy({ usageRecorder });
    // Route remapped `gpt-5-codex-orig` (client) → `provider-real-model` (upstream).
    const token = proxy.addRoute({
      sessionId: 'sess-r',
      targetProviderFormat: 'transform',
      model: 'provider-real-model',
      ingressFormat: 'openai-responses',
      authMode: 'byo',
      providerId: 'codex-prov',
      requestedModel: 'gpt-5-codex-orig',
    });

    const res = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ model: 'gpt-5-codex-orig', input: 'hi' }),
    });
    expect(res.status).toBe(200);

    // The Responses final object's `model` reads back the client's original id
    // (top-level + any nested `response.model` are rewritten); upstream name gone.
    const json = (await res.json()) as { model?: string; response?: { model?: string } };
    expect(json.model).toBe('gpt-5-codex-orig');
    if (json.response) expect(json.response.model).toBe('gpt-5-codex-orig');
    expect(JSON.stringify(json)).not.toContain('provider-real-model');

    // Usage accounted on the UPSTREAM resolved model.
    expect(records).toHaveLength(1);
    expect(records[0].model).toBe('provider-real-model');
  });

  it('internal route (no requestedModel) → response model NOT rewritten (zero regression)', async () => {
    await startProxy();
    // No requestedModel (resident-proxy style). Client model matches route.model
    // so the same-format body is byte-identical too.
    const token = proxy.addRoute(route({ model: 'provider-real-model' }));
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ model: 'provider-real-model', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { model?: string };
    // Upstream model passes through unchanged (no passthrough rewrite).
    expect(json.model).toBe('provider-real-model');
  });
});
