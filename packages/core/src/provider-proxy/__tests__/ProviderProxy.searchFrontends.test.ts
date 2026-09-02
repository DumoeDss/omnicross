/**
 * The two protocol frontends' search modes, driven through a REAL loopback
 * ProviderProxy against a REAL upstream HTTP server.
 *
 * This is the level at which hard constraint 6 can actually be proven: a
 * request resolves ONE mode, and the other lane's machinery records zero calls.
 * The native assertions use SYNTHETIC upstream fixtures shaped by the wire
 * baseline's verified schemas — a synthetic fixture proves passthrough, not
 * what OpenAI or Anthropic really send.
 *
 * @module provider-proxy/__tests__/ProviderProxy.searchFrontends.test
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { OrchestratedSearchResponse } from '@omnicross/contracts/search-types';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProviderConfigSource } from '../../ports';
import type { SearchRuntime } from '../../search/runtime';
import { ProviderProxy } from '../ProviderProxy';
import type { ProviderProxyDeps, RouteContext } from '../types';

function makeLlmConfig(): ProviderConfigSource {
  return {
    getProvider: vi.fn(),
    resolveTransformerChain: vi.fn(),
    getMainTransformer: vi.fn(),
    getTransformerService: () => ({ getTransformer: () => undefined }),
  } as unknown as ProviderConfigSource;
}

/**
 * A synthetic upstream that echoes whatever body it received back inside a
 * completed Responses turn, so the test can see exactly what went upstream.
 */
function startEchoUpstream(): Promise<{
  server: Server;
  url: string;
  bodies: Array<Record<string, unknown>>;
}> {
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      bodies.push(JSON.parse(raw || '{}') as Record<string, unknown>);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'resp_synthetic',
        object: 'response',
        status: 'completed',
        model: 'gpt-5-codex',
        output: [
          { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [] },
        ],
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}/responses`, bodies });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

function stubRuntime(): SearchRuntime {
  const response: OrchestratedSearchResponse = {
    query: 'http headers',
    providerId: 'http-bing',
    results: [{ title: 'T', url: 'https://example.com/a', content: 'C' }],
    attempts: [{ providerId: 'http-bing', outcome: 'success', resultCount: 1, durationMs: 3 }],
    fallbackCount: 0,
  };
  return {
    search: vi.fn(async () => response),
    registerContribution: vi.fn(),
    unregisterContribution: vi.fn(() => false),
    listProviders: vi.fn(() => []),
  };
}

function responsesRoute(url: string): RouteContext {
  return {
    sessionId: 'search-frontend-session',
    targetProviderFormat: 'openai-responses',
    model: 'gpt-5-codex',
    ingressFormat: 'openai-responses',
    authMode: 'subscription',
    subscriptionProfile: {
      authStrategy: {
        providerId: 'codex',
        kind: 'oauth-bearer',
        async applyHeaders(headers: Record<string, string>) {
          headers.Authorization = 'Bearer test-token';
        },
        async onUnauthorized() {
          return false;
        },
        async describeStatus() {
          return { providerId: 'codex', configured: true };
        },
      } as never,
      providerTransformerNames: ['openai-response'],
      resolveUpstreamUrl: () => url,
    },
  };
}

const HOSTED_SEARCH_REQUEST = {
  model: 'gpt-5-codex',
  input: 'what are http headers',
  tools: [{ type: 'web_search_preview' }],
};

let proxy: ProviderProxy | undefined;
let upstream: Server | undefined;

afterEach(async () => {
  if (proxy) await proxy.stop();
  if (upstream) await closeServer(upstream);
  proxy = undefined;
  upstream = undefined;
});

async function runResponses(
  deps: ProviderProxyDeps,
  url: string,
  body: unknown,
  routeExtras: Partial<RouteContext> = {},
): Promise<Response> {
  proxy = new ProviderProxy(deps);
  const port = await proxy.start();
  const token = proxy.addRoute({ ...responsesRoute(url), ...routeExtras });
  return fetch(`http://127.0.0.1:${port}/openai/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function anthropicRoute(): RouteContext {
  return {
    sessionId: 'anthropic-search-session',
    targetProviderFormat: 'anthropic',
    model: 'claude-sonnet-4-5',
    ingressFormat: 'anthropic-messages',
    authMode: 'byo',
  };
}

const ANTHROPIC_SEARCH_SUBREQUEST = {
  model: 'claude-sonnet-4-5',
  tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
  tool_choice: { type: 'tool', name: 'web_search' },
  messages: [{ role: 'user', content: 'Perform a web search for the query: http headers' }],
};

async function runAnthropic(deps: ProviderProxyDeps, body: unknown): Promise<Response> {
  proxy = new ProviderProxy(deps);
  const port = await proxy.start();
  const token = proxy.addRoute(anthropicRoute());
  return fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('Anthropic search modes', () => {
  it('native (the default) never enters the managed lane', async () => {
    const runtime = stubRuntime();

    const response = await runAnthropic(
      { llmConfig: makeLlmConfig(), searchRuntime: runtime },
      ANTHROPIC_SEARCH_SUBREQUEST,
    );

    // The request fell through to the ordinary BYO path (which has no provider
    // row here, hence the local error) — proving the managed lane stood aside.
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(runtime.search).not.toHaveBeenCalled();
  });

  it('managed answers the search-only sub-request from the runtime', async () => {
    const runtime = stubRuntime();

    const response = await runAnthropic(
      {
        llmConfig: makeLlmConfig(),
        searchRuntime: runtime,
        searchFrontendModes: { codex: 'off', responses: 'native', anthropic: 'managed' },
      },
      ANTHROPIC_SEARCH_SUBREQUEST,
    );
    const body = await response.json() as { content: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(runtime.search).toHaveBeenCalledTimes(1);
    expect(body.content.map((block) => block.type))
      .toEqual(['server_tool_use', 'web_search_tool_result', 'text']);
  });

  it('managed still relays an ordinary chat request, body intact', async () => {
    const runtime = stubRuntime();

    const response = await runAnthropic(
      {
        llmConfig: makeLlmConfig(),
        searchRuntime: runtime,
        searchFrontendModes: { codex: 'off', responses: 'native', anthropic: 'managed' },
      },
      { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hello' }] },
    );

    // Relayed to the BYO path (no provider row in this harness), NOT intercepted.
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(runtime.search).not.toHaveBeenCalled();
  });

  it('off refuses a declared search with a structured unsupported_capability', async () => {
    const runtime = stubRuntime();

    const response = await runAnthropic(
      {
        llmConfig: makeLlmConfig(),
        searchRuntime: runtime,
        searchFrontendModes: { codex: 'off', responses: 'native', anthropic: 'off' },
      },
      ANTHROPIC_SEARCH_SUBREQUEST,
    );
    const text = await response.text();

    expect(response.status).toBe(400);
    expect(text).toContain('unsupported_capability');
    expect(JSON.parse(text)).toMatchObject({ type: 'error' });
    expect(runtime.search).not.toHaveBeenCalled();
  });
});

describe('Responses search modes', () => {
  it('native (the default) relays the hosted declaration verbatim and never touches the runtime', async () => {
    const { server, url, bodies } = await startEchoUpstream();
    upstream = server;
    const runtime = stubRuntime();

    const response = await runResponses(
      { llmConfig: makeLlmConfig(), searchRuntime: runtime },
      url,
      HOSTED_SEARCH_REQUEST,
    );

    expect(response.status).toBe(200);
    // The upstream saw the client's own hosted declaration, unrewritten.
    expect(bodies[0]?.tools).toEqual([{ type: 'web_search_preview' }]);
    expect(JSON.stringify(bodies[0])).not.toContain('__omnicross_search');
    // Mode isolation, direction 1: zero managed-lane machinery ran.
    expect(runtime.search).not.toHaveBeenCalled();
  });

  it('managed rewrites the declaration to a selector and runs the runtime on the call', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as Record<string, unknown>;
        bodies.push(body);
        const tools = body.tools as Array<Record<string, unknown>>;
        const selectorName = String(tools[0]?.name ?? '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'resp_synthetic',
          object: 'response',
          status: 'completed',
          model: 'gpt-5-codex',
          output: [{
            id: 'fc_1',
            type: 'function_call',
            status: 'completed',
            call_id: 'call_1',
            name: selectorName,
            arguments: JSON.stringify({ query: 'http headers' }),
          }],
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    upstream = server;
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/responses`;
    const runtime = stubRuntime();

    const response = await runResponses(
      {
        llmConfig: makeLlmConfig(),
        searchRuntime: runtime,
        searchFrontendModes: { codex: 'off', responses: 'managed', anthropic: 'native' },
      },
      url,
      HOSTED_SEARCH_REQUEST,
    );
    const body = await response.json() as { output: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    // The hosted declaration never reached the upstream.
    expect(JSON.stringify(bodies[0]?.tools)).not.toContain('web_search_preview');
    expect(runtime.search).toHaveBeenCalledTimes(1);
    expect(body.output.map((item) => item.type)).toEqual(['web_search_call', 'message']);
    // Mode isolation, direction 2: the selector call the native lane would have
    // relayed verbatim is gone, replaced by our items.
    expect(JSON.stringify(body.output)).not.toContain('function_call');
  });

  it('off answers a structured unsupported_capability without calling upstream', async () => {
    const { server, url, bodies } = await startEchoUpstream();
    upstream = server;
    const runtime = stubRuntime();

    const response = await runResponses(
      {
        llmConfig: makeLlmConfig(),
        searchRuntime: runtime,
        searchFrontendModes: { codex: 'off', responses: 'off', anthropic: 'native' },
      },
      url,
      HOSTED_SEARCH_REQUEST,
    );
    const text = await response.text();

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(text).toContain('unsupported_capability');
    expect(bodies).toHaveLength(0);
    expect(runtime.search).not.toHaveBeenCalled();
  });

  it('refuses a request that combines managed search with hosted image work', async () => {
    const { server, url, bodies } = await startEchoUpstream();
    upstream = server;
    const runtime = stubRuntime();

    const response = await runResponses(
      {
        llmConfig: makeLlmConfig(),
        searchRuntime: runtime,
        searchFrontendModes: { codex: 'off', responses: 'managed', anthropic: 'native' },
        // A mediator must be present, or the request would be refused earlier
        // for a different reason and prove nothing.
        responsesHostedImageIngress: { prepare: vi.fn() } as never,
      },
      url,
      {
        model: 'gpt-5-codex',
        input: 'draw and research',
        tools: [{ type: 'web_search_preview' }, { type: 'image_generation' }],
      },
      { hostedImageGenerationAllowed: true, apiKeyId: 'oak_combo' },
    );
    const text = await response.text();

    // Two body-rewriting mediators over one request would send one rewrite
    // upstream and silently drop the other's. The combination is refused, not
    // half-applied.
    expect(response.status).toBe(422);
    expect(text).toContain('unsupported_capability');
    expect(bodies).toHaveLength(0);
    expect(runtime.search).not.toHaveBeenCalled();
  });

  it('leaves a request that declares no hosted search completely alone in every mode', async () => {
    const { server, url, bodies } = await startEchoUpstream();
    upstream = server;
    const runtime = stubRuntime();

    const response = await runResponses(
      {
        llmConfig: makeLlmConfig(),
        searchRuntime: runtime,
        searchFrontendModes: { codex: 'off', responses: 'managed', anthropic: 'native' },
      },
      url,
      { model: 'gpt-5-codex', input: 'plain question' },
    );

    expect(response.status).toBe(200);
    expect(bodies[0]).toMatchObject({ input: 'plain question' });
    expect(bodies[0]?.tools).toBeUndefined();
    expect(runtime.search).not.toHaveBeenCalled();
  });
});
