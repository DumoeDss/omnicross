import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpenAIOperationRegistry } from '../../../openai-operation';
import type { ProviderConfigSource } from '../../../ports';
import { ProviderProxy } from '../../ProviderProxy';
import type { ProviderProxyDeps, RouteContext } from '../../types';
import { registerResponsesCompactOperation } from '../responsesCompact';

function makeLlmConfig(): ProviderConfigSource {
  return {
    getProvider: vi.fn(),
    resolveTransformerChain: vi.fn(),
    getMainTransformer: vi.fn(),
    getTransformerService: vi.fn(() => ({ getTransformer: vi.fn() })),
  } as unknown as ProviderConfigSource;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

describe('native Responses create/compact integration', () => {
  let proxy: ProviderProxy | undefined;
  let upstream: Server | undefined;

  afterEach(async () => {
    if (vi.isFakeTimers()) {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
    if (proxy) await proxy.stop();
    if (upstream) await close(upstream);
    proxy = undefined;
    upstream = undefined;
  });

  it('registers compact independently and round-trips the complete canonical output unchanged', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown>; authorization?: string }> = [];
    const compactOutput = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'earlier' }], future_message: { x: 1 } },
      { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'opaque reasoning' }], encrypted_content: 'enc-secret' },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{"q":1}', status: 'completed' },
      { type: 'future_item', id: 'future_1', payload: { nested: true } },
      { type: 'compaction', id: 'cmp_1', encrypted_content: 'opaque-window', future_compaction: 7 },
    ];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        requests.push({
          url: req.url ?? '',
          body: JSON.parse(raw) as Record<string, unknown>,
          authorization: req.headers.authorization,
        });
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': 'req-native' });
        if (req.url?.startsWith('/backend-api/codex/responses/compact')) {
          res.end(JSON.stringify({ object: 'response.compaction', output: compactOutput, future_response_field: { kept: true } }));
        } else {
          res.end(JSON.stringify({ id: 'resp_after_compact', object: 'response', status: 'completed', output: [{ type: 'future_output', value: 9 }] }));
        }
      });
    });
    upstream = server;
    const port = await listen(server);
    const registry = new OpenAIOperationRegistry();
    const dispose = registerResponsesCompactOperation(registry);
    const authHints: unknown[] = [];
    const authStrategy = {
      providerId: 'codex',
      kind: 'oauth-bearer',
      async applyHeaders(headers: Record<string, string>, hints?: unknown) {
        authHints.push(hints);
        headers.Authorization = 'Bearer upstream-token';
        (hints as { reportSelection?: (id: string, active: boolean) => void } | undefined)
          ?.reportSelection?.('account-a', true);
      },
      async onUnauthorized() { return false; },
      async describeStatus() { return { providerId: 'codex', configured: true }; },
    };
    const route: RouteContext = {
      sessionId: 'native-window-session',
      targetProviderFormat: 'openai-responses',
      model: 'mapped-native-model',
      ingressFormat: 'openai-responses',
      authMode: 'subscription',
      subscriptionProfile: {
        authStrategy: authStrategy as never,
        providerTransformerNames: ['metrics-side-tap', 'openai-response'],
        resolveUpstreamUrl: () => `http://127.0.0.1:${port}/backend-api/codex/responses?feature=1`,
      },
    };
    proxy = new ProviderProxy({ llmConfig: makeLlmConfig(), openAIOperationRegistry: registry });
    const proxyPort = await proxy.start();
    const token = proxy.addRoute(route);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'session-id': 'same-client-session' };

    const compact = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses/compact`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'client-model', input: [{ type: 'future_input', opaque: true }], future_request_field: { keep: true } }),
    });
    const compactBody = await compact.json() as { output: unknown[]; future_response_field: unknown };
    expect(compact.status).toBe(200);
    expect(compact.headers.get('x-request-id')).toBe('req-native');
    expect(compactBody.output).toEqual(compactOutput);
    expect(compactBody.future_response_field).toEqual({ kept: true });

    const create = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'client-model',
        input: compactBody.output,
        store: false,
        context_management: [{ type: 'compaction', compact_threshold: 1000 }],
        future_create_field: { untouched: true },
      }),
    });
    expect(create.status).toBe(200);
    expect((await create.json() as Record<string, unknown>).output).toEqual([{ type: 'future_output', value: 9 }]);
    expect(requests).toHaveLength(2);
    expect(requests[0].url).toBe('/backend-api/codex/responses/compact?feature=1');
    expect(requests[0].body).toMatchObject({
      model: 'mapped-native-model',
      input: [{ type: 'future_input', opaque: true }],
      future_request_field: { keep: true },
    });
    expect(requests[1].url).toBe('/backend-api/codex/responses?feature=1');
    expect(requests[1].body.input).toEqual(compactOutput);
    expect(requests[1].body).toMatchObject({
      model: 'mapped-native-model',
      store: false,
      context_management: [{ type: 'compaction', compact_threshold: 1000 }],
      future_create_field: { untouched: true },
    });
    expect(requests.every((request) => request.authorization === 'Bearer upstream-token')).toBe(true);
    expect(authHints).toHaveLength(2);

    dispose();
    dispose();
    const unavailable = await fetch(`http://127.0.0.1:${proxyPort}/prefix/responses/compact`, {
      method: 'POST', headers, body: '{}',
    });
    expect(unavailable.status).toBe(501);
    await expect(unavailable.json()).resolves.toMatchObject({ error: { code: 'unsupported_capability' } });
  });

  it('preserves an unknown native SSE fixture byte-for-byte', async () => {
    const fixture = ': ping\r\nevent: response.future\r\ndata: {not-json}\r\n\r\nevent: response.incomplete\ndata: {"type":"response.incomplete","future":true}\n\n';
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'private, no-transform' });
      for (let index = 0; index < fixture.length; index += 5) res.write(fixture.slice(index, index + 5));
      res.end();
    });
    upstream = server;
    const port = await listen(server);
    const authStrategy = {
      providerId: 'codex', kind: 'oauth-bearer',
      async applyHeaders(headers: Record<string, string>) { headers.Authorization = 'Bearer token'; },
      async onUnauthorized() { return false; },
      async describeStatus() { return { providerId: 'codex', configured: true }; },
    };
    const route: RouteContext = {
      sessionId: 'native-sse', targetProviderFormat: 'openai-responses', model: 'gpt-native',
      ingressFormat: 'openai-responses', authMode: 'subscription',
      subscriptionProfile: {
        authStrategy: authStrategy as never,
        providerTransformerNames: ['openai-response'],
        resolveUpstreamUrl: () => `http://127.0.0.1:${port}/prefix/responses`,
      },
    };
    proxy = new ProviderProxy({ llmConfig: makeLlmConfig() });
    const proxyPort = await proxy.start();
    const token = proxy.addRoute(route);
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'client', stream: true, input: [{ type: 'future_item', opaque: 1 }] }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-transform');
    expect(await response.text()).toBe(fixture);
  });

  it('keeps an active streaming create open beyond two minutes', async () => {
    vi.useFakeTimers();
    const created = 'event: response.created\ndata: {"type":"response.created","response":{"id":"resp-long","object":"response","status":"in_progress","output":[]}}\n\n';
    const completed = 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-long","object":"response","status":"completed","output":[]}}\n\n';
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(created);
      setTimeout(() => res.end(completed), 120_001);
    });
    upstream = server;
    const port = await listen(server);
    const authStrategy = {
      providerId: 'codex', kind: 'oauth-bearer',
      async applyHeaders(headers: Record<string, string>) { headers.Authorization = 'Bearer token'; },
      async onUnauthorized() { return false; },
      async describeStatus() { return { providerId: 'codex', configured: true }; },
    };
    const route: RouteContext = {
      sessionId: 'long-native-sse', targetProviderFormat: 'openai-responses', model: 'gpt-native',
      ingressFormat: 'openai-responses', authMode: 'subscription',
      subscriptionProfile: {
        authStrategy: authStrategy as never,
        providerTransformerNames: ['openai-response'],
        resolveUpstreamUrl: () => `http://127.0.0.1:${port}/responses`,
      },
    };
    proxy = new ProviderProxy({ llmConfig: makeLlmConfig() });
    const proxyPort = await proxy.start();
    const token = proxy.addRoute(route);
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'client', stream: true, input: 'take your time' }),
    });
    const body = response.text();

    await vi.advanceTimersByTimeAsync(120_001);

    expect(response.status).toBe(200);
    await expect(body).resolves.toBe(created + completed);
  });

  it.each([
    ['null', 'null'],
    ['primitive', '7'],
    ['array', '[]'],
  ])('rejects a native create %s body before profile, auth, or upstream work', async (_name, rawBody) => {
    const llmConfig = makeLlmConfig();
    const getProvider = vi.mocked(llmConfig.getProvider);
    proxy = new ProviderProxy({ llmConfig });
    const proxyPort = await proxy.start();
    const token = proxy.addRoute({
      sessionId: 'native-invalid-body',
      targetProviderFormat: 'openai-responses',
      model: 'gpt-native',
      ingressFormat: 'openai-responses',
      authMode: 'byo',
      providerId: 'native-provider',
    });

    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: rawBody,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        type: 'openai_operation_error',
        code: 'invalid_request_body',
        retryable: false,
      },
    });
    expect(getProvider).not.toHaveBeenCalled();
  });

  it('attributes compact usage exactly once and records nothing when usage is absent', async () => {
    let requestCount = 0;
    const server = createServer((_req, res) => {
      requestCount += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'response.compaction',
        output: [],
        ...(requestCount === 1
          ? {
              usage: {
                input_tokens: 12,
                output_tokens: 3,
                input_tokens_details: { cached_tokens: 4 },
              },
            }
          : {}),
      }));
    });
    upstream = server;
    const port = await listen(server);
    const registry = new OpenAIOperationRegistry();
    registerResponsesCompactOperation(registry);
    const record = vi.fn();
    const authStrategy = {
      providerId: 'codex', kind: 'oauth-bearer',
      async applyHeaders(headers: Record<string, string>, hints?: {
        reportSelection?: (accountId: string, active: boolean) => void;
      }) {
        headers.Authorization = 'Bearer token';
        hints?.reportSelection?.('compact-usage-account', true);
      },
      async onUnauthorized() { return false; },
      async describeStatus() { return { providerId: 'codex', configured: true }; },
    };
    const route: RouteContext = {
      sessionId: 'compact-usage',
      apiKeyId: 'client-key',
      providerId: 'codex',
      targetProviderFormat: 'openai-responses',
      model: 'gpt-native',
      ingressFormat: 'openai-responses',
      authMode: 'subscription',
      subscriptionProfile: {
        authStrategy: authStrategy as never,
        providerTransformerNames: ['openai-response'],
        resolveUpstreamUrl: () => `http://127.0.0.1:${port}/v1/responses`,
      },
    };
    proxy = new ProviderProxy({
      llmConfig: makeLlmConfig(),
      openAIOperationRegistry: registry,
      usageRecorder: { record },
    });
    const proxyPort = await proxy.start();
    const token = proxy.addRoute(route);
    const requestHeaders = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'session-id': 'compact-usage-session',
    };

    for (let index = 0; index < 2; index += 1) {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses/compact`, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify({ model: 'client', input: [] }),
      });
      expect(response.status).toBe(200);
      await response.text();
    }

    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0][0]).toMatchObject({
      providerId: 'codex',
      model: 'gpt-native',
      apiKeyId: 'client-key',
      engineOrigin: 'codex-ingress',
      usage: {
        inputTokens: 8,
        outputTokens: 3,
        cacheReadTokens: 4,
      },
    });
  });

  it('rejects lossy reduced create fields and compact before auth, transformer resolution, or fetch', async () => {
    let upstreamHits = 0;
    const server = createServer((_req, res) => {
      upstreamHits += 1;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'reduced request reached upstream' }));
    });
    upstream = server;
    const upstreamPort = await listen(server);
    const applyHeaders = vi.fn();
    const llmConfig = makeLlmConfig();
    const registry = new OpenAIOperationRegistry();
    registerResponsesCompactOperation(registry);
    const route: RouteContext = {
      sessionId: 'reduced', targetProviderFormat: 'transform', model: 'chat-model',
      ingressFormat: 'openai-responses', authMode: 'subscription',
      subscriptionProfile: {
        authStrategy: {
          providerId: 'gemini', kind: 'oauth-bearer', applyHeaders,
          async onUnauthorized() { return false; },
          async describeStatus() { return { providerId: 'gemini', configured: true }; },
        } as never,
        providerTransformerNames: ['gemini'],
        resolveUpstreamUrl: () => `http://127.0.0.1:${upstreamPort}/v1/responses`,
      },
    };
    proxy = new ProviderProxy({ llmConfig, openAIOperationRegistry: registry });
    const port = await proxy.start();
    const token = proxy.addRoute(route);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const rejectedCases = [
      ['prompt cache hint', '/v1/responses', { model: 'x', input: 'hello', prompt_cache_key: 'opaque' }],
      ['function strict mode', '/v1/responses', {
        model: 'x', input: 'hello', tools: [{ type: 'function', name: 'lookup', strict: true }],
      }],
      ['custom tool format', '/v1/responses', {
        model: 'x', input: 'hello', tools: [{ type: 'custom', name: 'shell', format: { type: 'grammar' } }],
      }],
      ['message id and status', '/v1/responses', {
        model: 'x',
        input: [{ type: 'message', id: 'msg_1', role: 'user', content: 'hello', status: 'completed' }],
      }],
      ['invalid function item namespace', '/v1/responses', {
        model: 'x',
        input: [{
          type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{}', namespace: 7,
        }],
      }],
      ['reduced compact', '/v1/responses/compact', { model: 'x', input: [] }],
    ] as const;
    for (const [_name, path, body] of rejectedCases) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { type: 'openai_operation_error', code: 'unsupported_capability', retryable: false },
      });
    }

    for (const transformerName of ['openai', 'anthropic', 'gemini'] as const) {
      const targetApplyHeaders = vi.fn();
      const targetToken = proxy.addRoute({
        sessionId: `summary-${transformerName}`,
        targetProviderFormat: 'transform',
        model: 'mapped-model',
        ingressFormat: 'openai-responses',
        authMode: 'subscription',
        subscriptionProfile: {
          authStrategy: {
            providerId: transformerName,
            kind: 'oauth-bearer',
            applyHeaders: targetApplyHeaders,
            async onUnauthorized() { return false; },
            async describeStatus() { return { providerId: transformerName, configured: true }; },
          } as never,
          providerTransformerNames: [transformerName],
          resolveUpstreamUrl: () => `http://127.0.0.1:${upstreamPort}/v1/responses`,
        },
      });
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${targetToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'x',
          input: 'think',
          reasoning: { effort: 'high', summary: 'detailed' },
        }),
      });
      expect(response.status, transformerName).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          type: 'openai_operation_error',
          code: 'unsupported_capability',
          retryable: false,
          message: expect.stringContaining('$.reasoning.summary'),
        },
      });
      expect(targetApplyHeaders, transformerName).not.toHaveBeenCalled();
    }
    expect(applyHeaders).not.toHaveBeenCalled();
    expect(llmConfig.getTransformerService).not.toHaveBeenCalled();
    expect(llmConfig.resolveTransformerChain).not.toHaveBeenCalled();
    expect(upstreamHits).toBe(0);
  });
});
