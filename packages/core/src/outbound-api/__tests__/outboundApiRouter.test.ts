/**
 * Unit tests for the outbound request pipeline (`outbound-api-server` tasks
 * 8.3 + 8.4). Auth → rate-limit → endpoint-select → route-mint → shared
 * `routeRequest` dispatch. Uses a real `ProviderProxyRouteMap` so we can assert
 * the route is minted on the SHARED map and removed in the finally (proving the
 * reuse of the existing ingress dispatch, not a duplicated conversion stack).
 */
import { EventEmitter } from 'node:events';
import type http from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import { ProviderProxyRouteMap } from '../../provider-proxy/providerProxyRouteMap';
import { legacyEndpointsToBindings } from '../apiServerConfig';
import {
  buildProviderModelsUrl,
  directUpstreamBinding,
  directUpstreamUrl,
  extractGeminiModelFromUrl,
  extractPresentedKey,
  handleOutboundRequest,
  isLoopbackPeer,
  resetUpstreamModelsDiscoveryCache,
  selectEndpoint,
} from '../outboundApiRouter';
import { OutboundConcurrencyGate } from '../outboundConcurrencyGate';
import { OutboundRateLimiter } from '../outboundRateLimiter';
import type { GatewayBinding, OutboundApiDeps, OutboundKeyDb, OutboundKeyDbRow } from '../types';
import { UserMessageSerialQueue } from '../userMessageSerialQueue';

// --- helpers ---------------------------------------------------------------

class MockReq extends EventEmitter {
  method: string;
  url: string;
  headers: Record<string, string>;
  socket = { remoteAddress: '127.0.0.1', destroy: () => {} };
  httpVersion = '1.1';
  private body: string;
  constructor(opts: { method?: string; url?: string; headers?: Record<string, string>; body?: string; remoteAddress?: string }) {
    super();
    this.method = opts.method ?? 'POST';
    this.url = opts.url ?? '/v1/chat/completions';
    this.headers = opts.headers ?? {};
    this.body = opts.body ?? '{}';
    this.socket.remoteAddress = opts.remoteAddress ?? '127.0.0.1';
  }
  // Replay the body once handlers attach (mimics a live request stream).
  start(): void {
    process.nextTick(() => {
      if (this.body) this.emit('data', Buffer.from(this.body, 'utf8'));
      this.emit('end');
    });
  }
}

// An EventEmitter-backed response stand-in: enough of the Writable surface
// (`write`/`end`/`on`/`once`/`destroy`) for both direct writes and
// `Readable.pipe(res)` in the direct-upstream relay branch.
class MockRes extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = '';
  headersSent = false;
  writeHead(status: number, headers: Record<string, string> = {}) {
    this.statusCode = status;
    this.headers = { ...this.headers, ...headers };
    this.headersSent = true;
    return this;
  }
  write(chunk?: string) {
    if (chunk) this.body += chunk;
  }
  end(chunk?: string) {
    if (chunk) this.body += chunk;
    this.emit('close');
  }
  destroy() {
    this.emit('close');
  }
}

const enabledRow: OutboundKeyDbRow = {
  id: 'oak_1',
  name: 'k',
  keyHash: '', // filled per-test
  keyPrefix: 'sk-omnicross-',
  enabled: true,
  createdAt: Date.now(),
  lastUsedAt: null,
  revokedAt: null,
};

function makeDb(byHash: (h: string) => OutboundKeyDbRow | null): OutboundKeyDb {
  return {
    outboundApiKeysList: async () => [],
    outboundApiKeysGetByHash: async (h) => byHash(h),
    outboundApiKeysCreate: async () => enabledRow,
    outboundApiKeysRevoke: async () => true,
    outboundApiKeysTouchLastUsed: async () => true,
    outboundApiKeysSetEnabled: async () => true,
    outboundApiKeysSetMaxConcurrency: async () => true,
    outboundApiKeysSetUpstream: async () => true,
    outboundApiKeysSetPolicy: async () => true,
    outboundApiKeysMarkActivated: async () => true,
    outboundApiKeysReveal: async () => null,
    outboundApiKeysDelete: async () => true,
  };
}

function makeDeps(opts: {
  db: OutboundKeyDb;
  routeMap: ProviderProxyRouteMap;
  /** When set, wires a (stub) ApiKeyPool onto proxyDeps so the router synthesizes
   *  a stable `outbound:<keyId>` sessionId (pool-seam, design D1/D2(a)). */
  apiKeyPool?: unknown;
  /** Overrides the router-level provider row (llmConfig.getProvider). A
   * function becomes getProvider itself (id-aware); `null` forces a miss. */
  llmProvider?: Record<string, unknown> | null | ((id: string) => Record<string, unknown> | null);
}): OutboundApiDeps {
  return {
    db: opts.db,
    llmConfig: {
      getProvider:
        typeof opts.llmProvider === 'function'
          ? async (id: string) => opts.llmProvider?.(id)
          : async () =>
              'llmProvider' in opts ? opts.llmProvider : { id: 'openai', api_key: 'sk-x', models: ['gpt-4o'] },
    } as unknown as OutboundApiDeps['llmConfig'],
    providerProxy: { getRouteMap: () => opts.routeMap } as unknown as OutboundApiDeps['providerProxy'],
    // The shared chat ingress reads provider rows off proxyDeps.llmConfig; a
    // minimal getProvider lets the dispatch reach the shared chat ingress.
    proxyDeps: {
      llmConfig: {
        getProvider: async () => ({
          id: 'openai',
          name: 'OpenAI',
          api_key: 'sk-x',
          api_base_url: 'https://api.openai.com/v1',
          models: ['gpt-4o'],
          enabled: true,
        }),
      },
      apiKeyPool: opts.apiKeyPool ?? null,
    } as unknown as OutboundApiDeps['proxyDeps'],
  };
}

// Routing is downstream-route-only: the legacy endpoint shape below is projected
// into the route that serves these requests (chat is LIST-mapped, so the
// request's `model` must be one of these refs' modelIds).
const CHAT_ENDPOINTS = [
  { endpoint: 'chat' as const, models: ['openai,gpt-4o', 'openai,gpt-4o-mini'], useSubscription: false },
];
const config = {
  endpoints: [],
  bindings: legacyEndpointsToBindings(CHAT_ENDPOINTS),
};

// --- tests -----------------------------------------------------------------

describe('extractPresentedKey', () => {
  it('reads Authorization Bearer, x-api-key, and x-goog-api-key', () => {
    expect(extractPresentedKey({ headers: { authorization: 'Bearer abc' } } as unknown as http.IncomingMessage)).toBe('abc');
    expect(extractPresentedKey({ headers: { 'x-api-key': 'def' } } as unknown as http.IncomingMessage)).toBe('def');
    expect(extractPresentedKey({ headers: { 'x-goog-api-key': 'ghi' } } as unknown as http.IncomingMessage)).toBe('ghi');
    expect(extractPresentedKey({ headers: {} } as unknown as http.IncomingMessage)).toBeUndefined();
  });
});

describe('isLoopbackPeer', () => {
  it('accepts IPv4, IPv6, and IPv4-mapped loopback only', () => {
    expect(isLoopbackPeer('127.0.0.1')).toBe(true);
    expect(isLoopbackPeer('127.12.4.8')).toBe(true);
    expect(isLoopbackPeer('::1')).toBe(true);
    expect(isLoopbackPeer('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackPeer('192.168.1.10')).toBe(false);
    expect(isLoopbackPeer(undefined)).toBe(false);
  });
});

describe('selectEndpoint', () => {
  it('matches the four endpoints and 404s the rest', () => {
    expect(selectEndpoint('POST', '/v1/chat/completions')).toBe('chat');
    expect(selectEndpoint('POST', '/v1/responses')).toBe('responses');
    expect(selectEndpoint('POST', '/openai/responses/compact/?model=gpt-5.6')).toBe('responses');
    expect(selectEndpoint('POST', '/v1/messages')).toBe('messages');
    expect(selectEndpoint('POST', '/v1beta/models/gemini-2.5-pro:generateContent')).toBe('gemini');
    expect(selectEndpoint('POST', '/v1beta/models/gemini-2.5-pro:streamGenerateContent')).toBe('gemini');
    expect(selectEndpoint('GET', '/v1/chat/completions')).toBeNull();
    // Image operations are classified by the shared catalog but deliberately
    // have no legacy endpoint-policy projection until the Images change wires
    // an independent least-privilege scope.
    expect(selectEndpoint('POST', '/v1/images/generations')).toBeNull();
    expect(selectEndpoint('POST', '/v1/images/edits')).toBeNull();
    expect(selectEndpoint('POST', '/nope')).toBeNull();
  });

  it('m3: bare /messages does NOT match (must be /v1/messages, agreeing with the dispatcher)', () => {
    // A bare `/messages` previously selected `messages`, minted a route, then
    // 404'd in the shared dispatcher (which requires `/v1/messages`). Now it is
    // not selected at all — selection and dispatch agree.
    expect(selectEndpoint('POST', '/messages')).toBeNull();
    // The canonical path still matches (incl. with a provider-prefixed base).
    expect(selectEndpoint('POST', '/anthropic/v1/messages')).toBe('messages');
  });

  it('claude-api-routing-errors: count_tokens selects the messages endpoint (authorized like it)', () => {
    expect(selectEndpoint('POST', '/v1/messages/count_tokens')).toBe('messages');
    expect(selectEndpoint('POST', '/v1/messages/count_tokens?beta=true')).toBe('messages');
  });

  it('claude-api-routing-errors: other /v1/messages subpaths and lookalikes select nothing', () => {
    // Sub-resources must NOT enter the generation pipeline (audit F-1).
    expect(selectEndpoint('POST', '/v1/messages/batches')).toBeNull();
    expect(selectEndpoint('POST', '/v1/messages/batches/msg_123')).toBeNull();
    expect(selectEndpoint('POST', '/v1/messages/count_tokensfoo')).toBeNull();
    // Lookalike: no longer caught by the old substring match.
    expect(selectEndpoint('POST', '/v1/messagesfoo')).toBeNull();
  });
});

describe('extractGeminiModelFromUrl (m4)', () => {
  it('reads the model from a generateContent / streamGenerateContent path', () => {
    expect(extractGeminiModelFromUrl('/v1beta/models/gemini-2.0-flash:generateContent')).toBe('gemini-2.0-flash');
    expect(extractGeminiModelFromUrl('/v1beta/models/gemini-2.5-pro:streamGenerateContent')).toBe('gemini-2.5-pro');
    expect(extractGeminiModelFromUrl('/v1beta/models/gemini-2.0-flash:generateContent?alt=sse')).toBe('gemini-2.0-flash');
  });
  it('returns undefined for non-matching urls', () => {
    expect(extractGeminiModelFromUrl('/v1/chat/completions')).toBeUndefined();
    expect(extractGeminiModelFromUrl(undefined)).toBeUndefined();
  });
});

describe('handleOutboundRequest — auth', () => {
  it('401 on a missing key (no upstream contacted)', async () => {
    const routeMap = new ProviderProxyRouteMap();
    const deps = makeDeps({ db: makeDb(() => null), routeMap });
    const req = new MockReq({ headers: {} });
    const res = new MockRes();
    req.start();
    await handleOutboundRequest(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse, deps, config, new OutboundRateLimiter(), new UserMessageSerialQueue(), new OutboundConcurrencyGate());
    expect(res.statusCode).toBe(401);
    expect(routeMap.size()).toBe(0);
  });

  it('401 on an invalid key', async () => {
    const routeMap = new ProviderProxyRouteMap();
    const deps = makeDeps({ db: makeDb(() => null), routeMap });
    const req = new MockReq({ headers: { authorization: 'Bearer wrong' } });
    const res = new MockRes();
    req.start();
    await handleOutboundRequest(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse, deps, config, new OutboundRateLimiter(), new UserMessageSerialQueue(), new OutboundConcurrencyGate());
    expect(res.statusCode).toBe(401);
  });

  it('403 when a loopback-only integration key is used from a LAN peer', async () => {
    const routeMap = new ProviderProxyRouteMap();
    const deps = makeDeps({
      db: makeDb(() => ({ ...enabledRow, kind: 'integration', loopbackOnly: true })),
      routeMap,
    });
    const req = new MockReq({
      headers: { authorization: 'Bearer integration' },
      remoteAddress: '192.168.1.20',
    });
    const res = new MockRes();
    req.start();
    await handleOutboundRequest(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse, deps, config, new OutboundRateLimiter(), new UserMessageSerialQueue(), new OutboundConcurrencyGate());
    expect(res.statusCode).toBe(403);
    expect(routeMap.size()).toBe(0);
  });

  it('403 when an integration key calls an endpoint outside its allow-list', async () => {
    const routeMap = new ProviderProxyRouteMap();
    const deps = makeDeps({
      db: makeDb(() => ({
        ...enabledRow,
        kind: 'integration',
        loopbackOnly: true,
        allowedEndpoints: ['responses'],
      })),
      routeMap,
    });
    const req = new MockReq({ headers: { authorization: 'Bearer integration' } });
    const res = new MockRes();
    req.start();
    await handleOutboundRequest(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse, deps, config, new OutboundRateLimiter(), new UserMessageSerialQueue(), new OutboundConcurrencyGate());
    expect(res.statusCode).toBe(403);
    expect(routeMap.size()).toBe(0);
  });

  it('429 when the per-key rate limit is exceeded', async () => {
    const routeMap = new ProviderProxyRouteMap();
    const deps = makeDeps({ db: makeDb(() => ({ ...enabledRow })), routeMap });
    // A 1/window limiter, pre-exhausted for this key's bucket, so the handler's
    // own check is the 2nd hit within the window and is denied. (Instance
    // `maxRequests: 0` now means UNLIMITED per the frozen key-policy contract, so
    // the bucket is pre-filled instead.)
    const limiter = new OutboundRateLimiter({ windowMs: 60_000, maxRequests: 1 });
    limiter.check(enabledRow.id);
    const req = new MockReq({ headers: { authorization: 'Bearer any' }, url: '/v1/chat/completions' });
    const res = new MockRes();
    req.start();
    await handleOutboundRequest(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse, deps, config, limiter, new UserMessageSerialQueue(), new OutboundConcurrencyGate());
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBeDefined();
  });

  it('GET /v1/models returns the chat model list (OpenAI shape) after auth', async () => {
    const routeMap = new ProviderProxyRouteMap();
    const deps = makeDeps({ db: makeDb(() => ({ ...enabledRow })), routeMap });
    const req = new MockReq({ headers: { authorization: 'Bearer any' }, url: '/v1/models', method: 'GET' });
    const res = new MockRes();
    req.start();
    // claude-api-protocol-fidelity: an unrestricted key defaults to the
    // Anthropic shape now — force OpenAI to keep testing the OpenAI writer
    // (its default-shape behavior is covered in outboundAnthropicModels.test).
    const openaiConfig = { ...config, anthropic: { modelsShape: 'openai' as const } };
    await handleOutboundRequest(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse, deps, openaiConfig, new OutboundRateLimiter(), new UserMessageSerialQueue(), new OutboundConcurrencyGate());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { object: string; data: Array<{ id: string; object: string }> };
    expect(body.object).toBe('list');
    expect(body.data.map((m) => m.id)).toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect(body.data.every((m) => m.object === 'model')).toBe(true);
    // No route minted for the discovery request.
    expect(routeMap.size()).toBe(0);
  });

  it('GET /v1/models advertises exact client model names from generic route mappings', async () => {
    const routeMap = new ProviderProxyRouteMap();
    const deps = makeDeps({ db: makeDb(() => ({ ...enabledRow })), routeMap });
    const mappedConfig = {
      endpoints: [],
      // Force the OpenAI writer (unrestricted keys default to Anthropic shape now).
      anthropic: { modelsShape: 'openai' as const },
      bindings: [{
        id: 'responses-mapped',
        name: 'Responses mapped',
        enabled: true,
        keyScope: 'selected',
        apiKeyIds: [enabledRow.id],
        endpoint: 'responses',
        target: { kind: 'provider', providerId: 'zhipu' },
        priority: 100,
        fallback: 'fail',
        modelMode: 'mapped',
        modelMappings: [
          { source: 'gpt-5.6-sol', target: 'glm-5.3' },
          { source: 'gpt-5.6-luna', target: 'glm-4.5-air' },
          { source: '*', target: 'glm-5.3' },
        ],
      } satisfies GatewayBinding],
    };
    const req = new MockReq({
      headers: { authorization: 'Bearer any' },
      url: '/v1/models',
      method: 'GET',
    });
    const res = new MockRes();
    req.start();
    await handleOutboundRequest(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse, deps, mappedConfig, new OutboundRateLimiter(), new UserMessageSerialQueue(), new OutboundConcurrencyGate());

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Array<{ id: string }> };
    // Exact aliases first; the `*` wildcard routes ANY client id, so the
    // target's catalog (stub row: ['gpt-4o']) AND the wildcard's own target
    // id ('glm-5.3', reachable by name) join the advertisement.
    expect(body.data.map((model) => model.id)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-luna',
      'gpt-4o',
      'glm-5.3',
    ]);
  });

  it('GET /v1/models advertises the SUBSCRIPTION catalog for a wildcard-only mapping route', async () => {
    const routeMap = new ProviderProxyRouteMap();
    const deps = makeDeps({ db: makeDb(() => ({ ...enabledRow })), routeMap, llmProvider: null });
    // Mirrors the operator shape: messages → opencodego account-group with a
    // single `*` mapping. Requests route fine, but pre-change the list
    // advertised NOTHING (wildcards are not nameable aliases) — the app saw an
    // empty catalog while chat worked.
    const wildcardConfig = {
      endpoints: [],
      anthropic: { modelsShape: 'openai' as const },
      bindings: [{
        id: 'opencodego-wildcard',
        name: 'claude-opencodego',
        enabled: true,
        keyScope: 'selected',
        apiKeyIds: [enabledRow.id],
        endpoint: 'messages',
        target: { kind: 'account-group', providerId: 'opencodego', group: 'opencodego' },
        priority: 100,
        fallback: 'fail',
        modelMode: 'mapped',
        modelMappings: [{ source: '*', target: 'deepseek-v4.1-flash' }],
      } satisfies GatewayBinding],
    };
    const req = new MockReq({
      headers: { authorization: 'Bearer any' },
      url: '/v1/models',
      method: 'GET',
    });
    const res = new MockRes();
    req.start();
    await handleOutboundRequest(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse, deps, wildcardConfig, new OutboundRateLimiter(), new UserMessageSerialQueue(), new OutboundConcurrencyGate());

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Array<{ id: string }> };
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.map((model) => model.id)).toContain('deepseek-v4.1-flash');
  });

  it('GET /v1/models advertises the target provider catalog for a passthrough route', async () => {
    const routeMap = new ProviderProxyRouteMap();
    const deps = makeDeps({ db: makeDb(() => ({ ...enabledRow })), routeMap });
    const passthroughConfig = {
      endpoints: [],
      // Force the OpenAI writer (unrestricted keys default to Anthropic shape now).
      anthropic: { modelsShape: 'openai' as const },
      bindings: [{
        id: 'chat-passthrough',
        name: 'Chat passthrough',
        enabled: true,
        keyScope: 'selected',
        apiKeyIds: [enabledRow.id],
        endpoint: 'chat',
        target: { kind: 'provider', providerId: 'openai' },
        priority: 100,
        fallback: 'fail',
        modelMode: 'passthrough',
      } satisfies GatewayBinding],
    };
    const req = new MockReq({
      headers: { authorization: 'Bearer any' },
      url: '/v1/models',
      method: 'GET',
    });
    const res = new MockRes();
    req.start();
    await handleOutboundRequest(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse, deps, passthroughConfig, new OutboundRateLimiter(), new UserMessageSerialQueue(), new OutboundConcurrencyGate());

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Array<{ id: string }> };
    expect(body.data.map((model) => model.id)).toEqual(['gpt-4o']);
  });

  it('GET /v1/models advertises the built-in catalog for a subscription passthrough route', async () => {
    const routeMap = new ProviderProxyRouteMap();
    const deps = makeDeps({ db: makeDb(() => ({ ...enabledRow })), routeMap });
    const passthroughConfig = {
      endpoints: [],
      // Force the OpenAI writer (unrestricted keys default to Anthropic shape now).
      anthropic: { modelsShape: 'openai' as const },
      bindings: [{
        id: 'responses-subscription-passthrough',
        name: 'Responses subscription passthrough',
        enabled: true,
        keyScope: 'selected',
        apiKeyIds: [enabledRow.id],
        endpoint: 'responses',
        target: { kind: 'account', providerId: 'codex', accountId: 'account-a' },
        priority: 100,
        fallback: 'fail',
        modelMode: 'passthrough',
      } satisfies GatewayBinding],
    };
    const req = new MockReq({
      headers: { authorization: 'Bearer any' },
      url: '/v1/models',
      method: 'GET',
    });
    const res = new MockRes();
    req.start();
    await handleOutboundRequest(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse, deps, passthroughConfig, new OutboundRateLimiter(), new UserMessageSerialQueue(), new OutboundConcurrencyGate());

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Array<{ id: string }> };
    expect(body.data.map((model) => model.id)).toEqual([
      'gpt-5.6-luna',
      'gpt-5.6-terra',
      'gpt-5.6-sol',
      'gpt-6-astra',
    ]);
  });

  it('GET /v1/models live-discovers the upstream catalog for a passthrough provider route with no configured models', async () => {
    resetUpstreamModelsDiscoveryCache();
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: 'live-a' }, { id: 'live-b' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const routeMap = new ProviderProxyRouteMap();
      const deps = makeDeps({
        db: makeDb(() => ({ ...enabledRow })),
        routeMap,
        llmProvider: {
          id: 'relay',
          name: 'relay',
          apiFormat: 'openai',
          api_base_url: 'https://relay.example/v1',
          api_key: 'sk-x',
          models: [],
          enabled: true,
        },
      });
      const passthroughConfig = {
        endpoints: [],
        anthropic: { modelsShape: 'openai' as const },
        bindings: [{
          id: 'chat-passthrough-empty',
          name: 'Chat passthrough (unconfigured list)',
          enabled: true,
          keyScope: 'selected' as const,
          apiKeyIds: [enabledRow.id],
          endpoint: 'chat' as const,
          target: { kind: 'provider', providerId: 'relay' },
          priority: 100,
          fallback: 'fail' as const,
          modelMode: 'passthrough' as const,
        } satisfies GatewayBinding],
      };
      const run = async (): Promise<{ data: Array<{ id: string }> }> => {
        const req = new MockReq({
          headers: { authorization: 'Bearer any' },
          url: '/v1/models',
          method: 'GET',
        });
        const res = new MockRes();
        req.start();
        await handleOutboundRequest(
          req as unknown as http.IncomingMessage,
          res as unknown as http.ServerResponse,
          deps,
          passthroughConfig,
          new OutboundRateLimiter(),
          new UserMessageSerialQueue(),
          new OutboundConcurrencyGate(),
        );
        expect(res.statusCode).toBe(200);
        return JSON.parse(res.body) as { data: Array<{ id: string }> };
      };
      // First request live-discovers the upstream list (the completion suffix is
      // stripped: .../v1 → .../v1/models) and the cached result serves the second
      // request without a second upstream GET.
      const first = await run();
      expect(first.data.map((model) => model.id)).toEqual(['live-a', 'live-b']);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe('https://relay.example/v1/models');
      const second = await run();
      expect(second.data.map((model) => model.id)).toEqual(['live-a', 'live-b']);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(routeMap.size()).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      resetUpstreamModelsDiscoveryCache();
    }
  });

  it('GET /v1/models keeps the empty list when live discovery fails (no configured models)', async () => {
    resetUpstreamModelsDiscoveryCache();
    const fetchMock = vi.fn(async () => {
      throw new Error('upstream unreachable');
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const deps = makeDeps({
        db: makeDb(() => ({ ...enabledRow })),
        routeMap: new ProviderProxyRouteMap(),
        llmProvider: {
          id: 'relay',
          name: 'relay',
          apiFormat: 'openai',
          api_base_url: 'https://relay.example/v1',
          api_key: 'sk-x',
          models: [],
          enabled: true,
        },
      });
      const passthroughConfig = {
        endpoints: [],
        anthropic: { modelsShape: 'openai' as const },
        bindings: [{
          id: 'chat-passthrough-down',
          name: 'Chat passthrough (upstream down)',
          enabled: true,
          keyScope: 'selected' as const,
          apiKeyIds: [enabledRow.id],
          endpoint: 'chat' as const,
          target: { kind: 'provider', providerId: 'relay' },
          priority: 100,
          fallback: 'fail' as const,
          modelMode: 'passthrough' as const,
        } satisfies GatewayBinding],
      };
      const req = new MockReq({
        headers: { authorization: 'Bearer any' },
        url: '/v1/models',
        method: 'GET',
      });
      const res = new MockRes();
      req.start();
      await handleOutboundRequest(
        req as unknown as http.IncomingMessage,
        res as unknown as http.ServerResponse,
        deps,
        passthroughConfig,
        new OutboundRateLimiter(),
        new UserMessageSerialQueue(),
        new OutboundConcurrencyGate(),
      );
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { data: Array<{ id: string }> };
      expect(body.data).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      resetUpstreamModelsDiscoveryCache();
    }
  });

  it('buildProviderModelsUrl derives the catalog URL from each wire format', () => {
    // openai: versioned base, full completion endpoint, bare host.
    expect(buildProviderModelsUrl('https://api.siliconflow.com/v1', 'openai'))
      .toBe('https://api.siliconflow.com/v1/models');
    expect(buildProviderModelsUrl('https://api.openai.com/v1/chat/completions', 'openai'))
      .toBe('https://api.openai.com/v1/models');
    expect(buildProviderModelsUrl('https://api.openai.com', 'openai'))
      .toBe('https://api.openai.com/v1/models');
    // openai-response rows store a base or the full responses endpoint.
    expect(buildProviderModelsUrl('https://api.openai.com/v1/responses', 'openai-response'))
      .toBe('https://api.openai.com/v1/models');
    expect(buildProviderModelsUrl('https://api.openai.com', 'openai-response'))
      .toBe('https://api.openai.com/v1/models');
    // anthropic rows store the messages endpoint (or a versioned/base root).
    expect(buildProviderModelsUrl('https://api.anthropic.com/v1/messages', 'anthropic'))
      .toBe('https://api.anthropic.com/v1/models');
    expect(buildProviderModelsUrl('https://api.anthropic.com', 'anthropic'))
      .toBe('https://api.anthropic.com/v1/models');
    // gemini rows store the models-collection URL itself.
    expect(buildProviderModelsUrl('https://generativelanguage.googleapis.com/v1beta/models/', 'google'))
      .toBe('https://generativelanguage.googleapis.com/v1beta/models');
    expect(buildProviderModelsUrl('https://generativelanguage.googleapis.com/v1beta', 'google'))
      .toBe('https://generativelanguage.googleapis.com/v1beta/models');
    expect(buildProviderModelsUrl('   ', 'openai')).toBeNull();
  });


  it('directUpstreamBinding synthesizes a messages passthrough binding scoped to the key at LOW precedence', () => {
    const binding = directUpstreamBinding(
      { kind: 'account', providerId: 'claude', accountId: 'acct-a' },
      'oak_direct',
    );
    expect(binding).toMatchObject({
      id: 'direct:oak_direct',
      enabled: true,
      keyScope: 'selected',
      apiKeyIds: ['oak_direct'],
      endpoint: 'messages',
      target: { kind: 'account', providerId: 'claude', accountId: 'acct-a' },
      priority: 1000,
      fallback: 'fail',
      modelMode: 'passthrough',
    });
  });

  it('a key direct-bound to a claude account routes /v1/messages through the subscription resolver', async () => {
    const routeMap = new ProviderProxyRouteMap();
    const deps = makeDeps({
      db: makeDb(() => ({
        ...enabledRow,
        boundUpstream: { kind: 'account', providerId: 'claude', accountId: 'acct-a' },
      })),
      routeMap,
      // null ⇒ the 'claude' row lookup misses ⇒ the subscription branch runs
      // (makeDeps' default row would pose as a BYO 'claude' provider).
      llmProvider: null,
    });
    const req = new MockReq({
      headers: { authorization: 'Bearer any' },
      url: '/v1/messages',
      method: 'POST',
      body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16, messages: [] }),
    });
    const res = new MockRes();
    req.start();
    await handleOutboundRequest(
      req as unknown as http.IncomingMessage,
      res as unknown as http.ServerResponse,
      deps,
      // NO bindings configured — the direct target alone must serve the key.
      { endpoints: [], bindings: [] },
      new OutboundRateLimiter(),
      new UserMessageSerialQueue(),
      new OutboundConcurrencyGate(),
    );
    // The synthesized binding carried the request all the way into the
    // subscription route resolver, which fails here ONLY because no registry
    // is wired in this unit context (the daemon wires the real one).
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain("subscription provider 'claude' is not available");
  });

  it('a key direct-bound to a claude account advertises the claude catalog on /v1/models', async () => {
    const deps = makeDeps({
      db: makeDb(() => ({
        ...enabledRow,
        boundUpstream: { kind: 'account-pool', providerId: 'claude' },
      })),
      routeMap: new ProviderProxyRouteMap(),
      llmProvider: null,
    });
    const req = new MockReq({
      headers: { authorization: 'Bearer any' },
      url: '/v1/models',
      method: 'GET',
    });
    const res = new MockRes();
    req.start();
    await handleOutboundRequest(
      req as unknown as http.IncomingMessage,
      res as unknown as http.ServerResponse,
      deps,
      { endpoints: [], bindings: [] },
      new OutboundRateLimiter(),
      new UserMessageSerialQueue(),
      new OutboundConcurrencyGate(),
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Array<{ id: string }> };
    expect(body.data.length).toBeGreaterThan(0);
    for (const entry of body.data) expect(entry.id).toMatch(/^claude-/);
  });

  it('directUpstreamUrl maps the client path 1:1 with version-segment dedup', () => {
    const openaiBase = (base: string): { api_base_url: string; apiFormat?: 'openai' } => ({
      api_base_url: base,
    });
    // Versioned base: the client's duplicate /v1 prefix is dropped.
    expect(directUpstreamUrl(openaiBase('https://api.siliconflow.com/v1'), '/v1/chat/completions'))
      .toBe('https://api.siliconflow.com/v1/chat/completions');
    expect(directUpstreamUrl(openaiBase('https://api.siliconflow.com/v1'), '/v1/models'))
      .toBe('https://api.siliconflow.com/v1/models');
    // Full completion endpoint base: the suffix is stripped to the root first.
    expect(directUpstreamUrl(openaiBase('https://api.openai.com/v1/chat/completions'), '/v1/chat/completions'))
      .toBe('https://api.openai.com/v1/chat/completions');
    // Bare host root keeps the client's /v1 intact.
    expect(directUpstreamUrl(openaiBase('https://api.anthropic.com'), '/v1/messages'))
      .toBe('https://api.anthropic.com/v1/messages');
    // anthropic row carrying the messages endpoint.
    expect(directUpstreamUrl({ api_base_url: 'https://api.anthropic.com/v1/messages', apiFormat: 'anthropic' }, '/v1/messages'))
      .toBe('https://api.anthropic.com/v1/messages');
    // gemini row carrying the models collection; /v1beta dedup + query preserved.
    expect(directUpstreamUrl({ api_base_url: 'https://generativelanguage.googleapis.com/v1beta/models/', apiFormat: 'google' }, '/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse'))
      .toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse');
    // Unrelated path passes through untouched (transparent proxy).
    expect(directUpstreamUrl(openaiBase('https://api.siliconflow.com/v1'), '/v1/embeddings'))
      .toBe('https://api.siliconflow.com/v1/embeddings');
    expect(directUpstreamUrl({ api_base_url: '' }, '/v1/models')).toBeNull();
  });

  it('a key with a bound upstream relays VERBATIM — auth swapped, path/body/status untouched', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true, relayed: true }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const deps = makeDeps({
        db: makeDb(() => ({ ...enabledRow, boundUpstreamProviderId: 'relay' })),
        routeMap: new ProviderProxyRouteMap(),
        llmProvider: {
          id: 'relay',
          name: 'relay',
          apiFormat: 'openai',
          api_base_url: 'https://relay.example/v1',
          api_key: 'sk-upstream-secret',
          models: [],
          enabled: true,
        },
      });
      // No bindings at all — the direct branch must not need one.
      const req = new MockReq({
        headers: { authorization: 'Bearer sk-omnicross-client' },
        url: '/v1/chat/completions',
        method: 'POST',
        body: JSON.stringify({ model: 'whatever-the-client-wants', stream: true }),
      });
      const res = new MockRes();
      req.start();
      await handleOutboundRequest(
        req as unknown as http.IncomingMessage,
        res as unknown as http.ServerResponse,
        deps,
        { endpoints: [], bindings: [] },
        new OutboundRateLimiter(),
        new UserMessageSerialQueue(),
        new OutboundConcurrencyGate(),
      );
      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body)).toEqual({ ok: true, relayed: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(seen[0]?.url).toBe('https://relay.example/v1/chat/completions');
      expect(seen[0]?.init.method).toBe('POST');
      // Body forwarded byte-for-byte.
      expect(seen[0]?.init.body).toBe(JSON.stringify({ model: 'whatever-the-client-wants', stream: true }));
      // Auth swapped to the provider key; the client key NEVER reaches upstream.
      const headers = seen[0]?.init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer sk-upstream-secret');
      expect(JSON.stringify(headers)).not.toContain('sk-omnicross-client');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a bound key renders /v1/models as the union (routes + direct catalog) and relays unknown paths verbatim; missing provider is a clear 503', async () => {
    const fetchMock = vi.fn(async (url: string | URL) =>
      new Response(JSON.stringify({ object: 'list', data: [{ id: 'upstream-model' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const deps = makeDeps({
        db: makeDb(() => ({ ...enabledRow, boundUpstreamProviderId: 'relay' })),
        routeMap: new ProviderProxyRouteMap(),
        llmProvider: {
          id: 'relay',
          name: 'relay',
          apiFormat: 'openai',
          api_base_url: 'https://relay.example/v1',
          api_key: 'sk-x',
          models: [],
          enabled: true,
        },
      });
      const run = async (url: string, method = 'GET'): Promise<MockRes> => {
        const req = new MockReq({ headers: { authorization: 'Bearer any' }, url, method });
        const res = new MockRes();
        req.start();
        await handleOutboundRequest(
          req as unknown as http.IncomingMessage,
          res as unknown as http.ServerResponse,
          deps,
          { endpoints: [], bindings: [], anthropic: { modelsShape: 'openai' as const } },
          new OutboundRateLimiter(),
          new UserMessageSerialQueue(),
          new OutboundConcurrencyGate(),
        );
        return res;
      };
      // /v1/models is the GATEWAY's rendered union — the direct provider's
      // catalog (live-discovered) joins it, because a multi-upstream key must
      // not receive a single upstream's raw list.
      const models = await run('/v1/models');
      expect(models.statusCode).toBe(200);
      const listBody = JSON.parse(models.body) as { object: string; data: Array<{ id: string }> };
      expect(listBody.object).toBe('list');
      expect(listBody.data.map((m) => m.id)).toEqual(['upstream-model']);
      expect(vi.mocked(fetchMock).mock.calls[0]?.[0]).toBe('https://relay.example/v1/models');
      // An arbitrary path the gateway does not implement surfaces upstream's answer.
      const other = await run('/v1/embeddings', 'POST');
      expect(other.statusCode).toBe(200);
      expect(JSON.parse(other.body).data.map((m: { id: string }) => m.id)).toEqual(['upstream-model']);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(vi.mocked(fetchMock).mock.calls[1]?.[0]).toBe('https://relay.example/v1/embeddings');

      // A key whose bound provider row no longer exists gets a deterministic 503.
      const goneDeps = makeDeps({
        db: makeDb(() => ({ ...enabledRow, boundUpstreamProviderId: 'deleted-provider' })),
        routeMap: new ProviderProxyRouteMap(),
        llmProvider: null,
      });
      const req = new MockReq({ headers: { authorization: 'Bearer any' }, url: '/v1/chat/completions', method: 'POST', body: '{}' });
      const res = new MockRes();
      req.start();
      await handleOutboundRequest(
        req as unknown as http.IncomingMessage,
        res as unknown as http.ServerResponse,
        goneDeps,
        { endpoints: [], bindings: [] },
        new OutboundRateLimiter(),
        new UserMessageSerialQueue(),
        new OutboundConcurrencyGate(),
      );
      expect(res.statusCode).toBe(503);
      expect(res.body).toContain('deleted-provider');
    } finally {
      vi.unstubAllGlobals();
      resetUpstreamModelsDiscoveryCache();
    }
  });

  it('routes WIN over the direct tier for their models; unrouted models fall through to the verbatim relay', async () => {
    const fetchMock = vi.fn(async (url: string | URL) =>
      new Response(JSON.stringify({ relayed: true, url: String(url) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const deps = makeDeps({
        db: makeDb(() => ({ ...enabledRow, boundUpstream: { kind: 'provider', providerId: 'direct-relay' } })),
        routeMap: new ProviderProxyRouteMap(),
        // Id-aware provider rows: the ROUTE's target (z-ai) resolves for the
        // routed model, so the request enters the pipeline instead of the
        // relay; the DIRECT target row carries its own base URL.
        llmProvider: (id: string) => {
          if (id === 'direct-relay') {
            return {
              id: 'direct-relay',
              name: 'direct relay',
              apiFormat: 'openai',
              api_base_url: 'https://direct.example/v1',
              api_key: 'sk-direct',
              models: [],
              enabled: true,
            };
          }
          if (id === 'z-ai') {
            return {
              id: 'z-ai',
              name: 'z.ai',
              apiFormat: 'anthropic',
              api_base_url: 'https://api.z.ai/v1/messages',
              api_key: 'sk-z',
              models: ['glm-4.7'],
              enabled: true,
            };
          }
          return null;
        },
      });
      const routedConfig = {
        endpoints: [],
        bindings: [{
          id: 'routed',
          name: 'Routed chat subset',
          enabled: true,
          keyScope: 'selected' as const,
          apiKeyIds: [enabledRow.id],
          endpoint: 'chat' as const,
          target: { kind: 'provider', providerId: 'z-ai' },
          priority: 100,
          fallback: 'fail' as const,
          // LIST mode: the route owns exactly 'special-glm'; everything else
          // on the chat endpoint is unrouted → direct tier.
          modelMode: 'mapped' as const,
          models: ['special-glm'],
        } satisfies GatewayBinding],
      };
      const run = async (model: string): Promise<MockRes> => {
        const req = new MockReq({
          headers: { authorization: 'Bearer any' },
          url: '/v1/chat/completions',
          method: 'POST',
          body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
        });
        const res = new MockRes();
        req.start();
        await handleOutboundRequest(
          req as unknown as http.IncomingMessage,
          res as unknown as http.ServerResponse,
          deps,
          routedConfig,
          new OutboundRateLimiter(),
          new UserMessageSerialQueue(),
          new OutboundConcurrencyGate(),
        );
        return res;
      };
      // The routed model goes to the ROUTE (the pipeline runs; with these stub
      // deps the dispatch errors) — the verbatim relay is NOT used.
      const routed = await run('special-glm');
      expect(routed.statusCode).toBeGreaterThan(399);
      expect(fetchMock).not.toHaveBeenCalled();
      // A model outside the route's mappings falls through to the direct tier.
      const direct = await run('any-other-model');
      expect(direct.statusCode).toBe(200);
      expect(JSON.parse(direct.body)).toEqual({
        relayed: true,
        url: 'https://direct.example/v1/chat/completions',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('GET /v1/models allows a Responses-scoped integration key and filters its catalog', async () => {
    const routeMap = new ProviderProxyRouteMap();
    const deps = makeDeps({
      db: makeDb(() => ({
        ...enabledRow,
        kind: 'integration',
        loopbackOnly: true,
        allowedEndpoints: ['responses'],
      })),
      routeMap,
    });
    const responsesConfig = {
      endpoints: [],
      bindings: legacyEndpointsToBindings([
        ...CHAT_ENDPOINTS,
        {
          endpoint: 'responses' as const,
          modelMap: {
            codex: 'codex,gpt-5.6-sol',
            mini: 'codex,gpt-5.6-luna',
          },
          useSubscription: true,
        },
      ]),
    };
    const req = new MockReq({
      headers: { authorization: 'Bearer integration' },
      url: '/v1/models',
      method: 'GET',
    });
    const res = new MockRes();
    req.start();
    await handleOutboundRequest(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse, deps, responsesConfig, new OutboundRateLimiter(), new UserMessageSerialQueue(), new OutboundConcurrencyGate());

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Array<{ id: string }> };
    expect(body.data.map((model) => model.id)).toEqual(['gpt-5.6-sol', 'gpt-5.6-luna']);
    expect(routeMap.size()).toBe(0);
  });

  it('GET /v1/models still requires a valid API key', async () => {
    const routeMap = new ProviderProxyRouteMap();
    const deps = makeDeps({ db: makeDb(() => null), routeMap });
    const req = new MockReq({ headers: {}, url: '/v1/models', method: 'GET' });
    const res = new MockRes();
    req.start();
    await handleOutboundRequest(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse, deps, config, new OutboundRateLimiter(), new UserMessageSerialQueue(), new OutboundConcurrencyGate());
    expect(res.statusCode).toBe(401);
  });

  it('404 on an unrecognized path (after a valid key)', async () => {
    const routeMap = new ProviderProxyRouteMap();
    const deps = makeDeps({ db: makeDb(() => ({ ...enabledRow })), routeMap });
    const req = new MockReq({ headers: { authorization: 'Bearer any' }, url: '/nope' });
    const res = new MockRes();
    req.start();
    await handleOutboundRequest(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse, deps, config, new OutboundRateLimiter(), new UserMessageSerialQueue(), new OutboundConcurrencyGate());
    expect(res.statusCode).toBe(404);
  });

  it('success path mints + removes a route on the SHARED map and reaches the shared dispatch', async () => {
    const routeMap = new ProviderProxyRouteMap();
    const addSpy = vi.spyOn(routeMap, 'addRoute');
    const removeSpy = vi.spyOn(routeMap, 'removeRoute');
    const deps = makeDeps({ db: makeDb(() => ({ ...enabledRow })), routeMap });
    // Capture the chat-ingress log so we can prove the request reached the
    // SHARED provider-proxy chat ingress (not a duplicated conversion stack).
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const req = new MockReq({
      headers: { authorization: 'Bearer any' },
      url: '/v1/chat/completions',
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const res = new MockRes();
    req.start();
    await handleOutboundRequest(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse, deps, config, new OutboundRateLimiter(), new UserMessageSerialQueue(), new OutboundConcurrencyGate());

    // A route was minted on the SHARED map and removed in the finally — the
    // outbound listener funnels into the existing routeRequest dispatch.
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(routeMap.size()).toBe(0);
    // The request reached the existing `provider-proxy` chat ingress (its log
    // tag proves the shared conversion stack ran — no duplicated converter).
    const reachedSharedIngress = errSpy.mock.calls.some((c) =>
      String(c[0]).includes('[ProviderProxy:chat]'),
    );
    expect(reachedSharedIngress).toBe(true);
    errSpy.mockRestore();
  });
});

describe('handleOutboundRequest — key policy (expiry / cost quota)', () => {
  const run = async (
    row: OutboundKeyDbRow,
    extra: Partial<OutboundApiDeps> = {},
    body = JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
  ): Promise<MockRes> => {
    const routeMap = new ProviderProxyRouteMap();
    const deps = { ...makeDeps({ db: makeDb(() => ({ ...row })), routeMap }), ...extra };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const req = new MockReq({
      headers: { authorization: 'Bearer any' },
      url: '/v1/chat/completions',
      body,
    });
    const res = new MockRes();
    req.start();
    await handleOutboundRequest(
      req as unknown as http.IncomingMessage,
      res as unknown as http.ServerResponse,
      deps,
      config,
      new OutboundRateLimiter(),
      new UserMessageSerialQueue(),
      new OutboundConcurrencyGate(),
    );
    errSpy.mockRestore();
    return res;
  };

  it('401 when the key is expired (fixed mode past expiresAt)', async () => {
    const res = await run({ ...enabledRow, expiresAt: 1 });
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain('expired');
  });

  it('402 when the key is over its daily cost limit, naming only this key', async () => {
    const tracker = {
      getSpend: async () => ({
        dailyUsd: 12,
        dailyWindowStart: 0,
        weeklyUsd: 12,
        weeklyWindowStart: 0,
        totalUsd: 12,
      }),
    };
    const res = await run({ ...enabledRow, id: 'oak_self', dailyCostLimitUsd: 10 }, {
      keySpendTracker: tracker,
    });
    expect(res.statusCode).toBe(402);
    const parsed = JSON.parse(res.body) as { scope: string; limitUsd: number; spentUsd: number; error: { message: string } };
    expect(parsed.scope).toBe('daily');
    expect(parsed.limitUsd).toBe(10);
    expect(parsed.spentUsd).toBe(12);
    // Secret-safe: the body carries THIS key's own numbers only — no other key id.
    expect(res.body).not.toContain('oak_other');
  });

  it('proceeds when under the cost limit (402 not raised)', async () => {
    const tracker = {
      getSpend: async () => ({
        dailyUsd: 2,
        dailyWindowStart: 0,
        weeklyUsd: 2,
        weeklyWindowStart: 0,
        totalUsd: 2,
      }),
    };
    const res = await run({ ...enabledRow, dailyCostLimitUsd: 10 }, { keySpendTracker: tracker });
    expect(res.statusCode).not.toBe(402);
  });

  it('a policy-less key never triggers a cost computation (tracker untouched)', async () => {
    const getSpend = vi.fn();
    const res = await run({ ...enabledRow }, { keySpendTracker: { getSpend } });
    expect(getSpend).not.toHaveBeenCalled();
    expect(res.statusCode).not.toBe(402);
  });
});

describe('handleOutboundRequest — model restriction (#6, 403)', () => {
  /** Drive one chat request for the given row + client model; return res + addSpy. */
  const run = async (
    row: OutboundKeyDbRow,
    clientModel: string,
  ): Promise<{ res: MockRes; addCount: number }> => {
    const routeMap = new ProviderProxyRouteMap();
    const addSpy = vi.spyOn(routeMap, 'addRoute');
    const deps = makeDeps({ db: makeDb(() => ({ ...row })), routeMap });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const req = new MockReq({
      headers: { authorization: 'Bearer any' },
      url: '/v1/chat/completions',
      body: JSON.stringify({ model: clientModel, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const res = new MockRes();
    req.start();
    await handleOutboundRequest(
      req as unknown as http.IncomingMessage,
      res as unknown as http.ServerResponse,
      deps,
      config,
      new OutboundRateLimiter(),
      new UserMessageSerialQueue(),
      new OutboundConcurrencyGate(),
    );
    errSpy.mockRestore();
    return { res, addCount: addSpy.mock.calls.length };
  };

  const blacklistRow = (models: string[]): OutboundKeyDbRow => ({
    ...enabledRow,
    id: 'oak_self',
    enableModelRestriction: true,
    restrictionMode: 'blacklist',
    restrictedModels: models,
  });
  const allowlistRow = (models: string[]): OutboundKeyDbRow => ({
    ...enabledRow,
    id: 'oak_self',
    enableModelRestriction: true,
    restrictionMode: 'allowlist',
    restrictedModels: models,
  });

  it('blacklist blocks the resolved model → 403 naming only the model, no route minted', async () => {
    const { res, addCount } = await run(blacklistRow(['gpt-4o']), 'gpt-4o');
    expect(res.statusCode).toBe(403);
    const parsed = JSON.parse(res.body) as { model: string; mode: string; error: { message: string } };
    expect(parsed.model).toBe('gpt-4o');
    expect(parsed.mode).toBe('blacklist');
    // Rejected BEFORE dispatch — no route was minted (no upstream call).
    expect(addCount).toBe(0);
    // No cross-key leak: the body carries no key id at all.
    expect(res.body).not.toContain('oak_self');
    expect(res.body).not.toContain('oak_other');
  });

  it('blacklist allows an unlisted model → not 403 (route minted, reaches dispatch)', async () => {
    const { res, addCount } = await run(blacklistRow(['claude-opus']), 'gpt-4o');
    expect(res.statusCode).not.toBe(403);
    expect(addCount).toBe(1);
  });

  it('allowlist allows only a listed model; denies an unlisted one → 403', async () => {
    const ok = await run(allowlistRow(['gpt-4o']), 'gpt-4o');
    expect(ok.res.statusCode).not.toBe(403);
    expect(ok.addCount).toBe(1);

    const denied = await run(allowlistRow(['gpt-4o']), 'gpt-4o-mini');
    expect(denied.res.statusCode).toBe(403);
    expect(denied.addCount).toBe(0);
  });

  it('enforces on the RESOLVED model, not the raw client string (case-insensitive)', async () => {
    // Client sends `GPT-4O`; the chat endpoint CI-resolves it to the configured
    // ref `openai,gpt-4o` → resolved model `gpt-4o`. A blacklist of `gpt-4o`
    // therefore blocks it even though the raw client string differs in case —
    // proving the check runs on the resolved model, not the raw request.
    const { res, addCount } = await run(blacklistRow(['gpt-4o']), 'GPT-4O');
    expect(res.statusCode).toBe(403);
    expect(addCount).toBe(0);
  });

  it('a restriction-less key runs no model check (403 never raised)', async () => {
    // enableModelRestriction off but a stale list present → still no check.
    const { res, addCount } = await run(
      { ...enabledRow, restrictionMode: 'blacklist', restrictedModels: ['gpt-4o'] },
      'gpt-4o',
    );
    expect(res.statusCode).not.toBe(403);
    expect(addCount).toBe(1);
  });

  it('the model rejection (403) is distinct from 401/402/429', async () => {
    const { res } = await run(blacklistRow(['gpt-4o']), 'gpt-4o');
    expect(res.statusCode).toBe(403);
    expect([401, 402, 429]).not.toContain(res.statusCode);
  });
});

describe('handleOutboundRequest — pool-seam synthesized sessionId (poolseam D1/D2(a))', () => {
  /** Drive one chat request and return the RouteContext that was minted. */
  async function mintRoute(opts: { apiKeyPool?: unknown; bindings?: GatewayBinding[] }): Promise<{
    sessionId: string | null | undefined;
  }> {
    const routeMap = new ProviderProxyRouteMap();
    const addSpy = vi.spyOn(routeMap, 'addRoute');
    const deps = makeDeps({
      db: makeDb(() => ({ ...enabledRow, id: 'oak_1' })),
      routeMap,
      apiKeyPool: opts.apiKeyPool,
    });
    // Silence the shared chat-ingress error log (no real upstream).
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const req = new MockReq({
      headers: { authorization: 'Bearer any' },
      url: '/v1/chat/completions',
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const res = new MockRes();
    req.start();
    await handleOutboundRequest(
      req as unknown as http.IncomingMessage,
      res as unknown as http.ServerResponse,
      deps,
      opts.bindings ? { ...config, bindings: opts.bindings } : config,
      new OutboundRateLimiter(),
      new UserMessageSerialQueue(),
      new OutboundConcurrencyGate(),
    );
    errSpy.mockRestore();
    expect(addSpy).toHaveBeenCalledTimes(1);
    const minted = addSpy.mock.calls[0][0] as { sessionId: string | null | undefined };
    return { sessionId: minted.sessionId };
  }

  it('pool wired → minted route carries a STABLE `outbound:<verifiedKeyId>:<routeId>` sessionId', async () => {
    const { sessionId } = await mintRoute({ apiKeyPool: { reportError: vi.fn() } });
    expect(sessionId).toBe('outbound:oak_1:legacy-chat-openai');
  });

  it('same verified key → same synthesized id on a second request (stable affinity)', async () => {
    const a = await mintRoute({ apiKeyPool: { reportError: vi.fn() } });
    const b = await mintRoute({ apiKeyPool: { reportError: vi.fn() } });
    expect(a.sessionId).toBe('outbound:oak_1:legacy-chat-openai');
    expect(b.sessionId).toBe(a.sessionId);
  });

  it('each route gets its own affinity namespace', async () => {
    const { sessionId } = await mintRoute({
      apiKeyPool: { reportError: vi.fn() },
      bindings: [{
        id: 'route-a',
        name: 'Route A',
        enabled: true,
        endpoint: 'chat',
        target: { kind: 'provider', providerId: 'openai' },
        fallback: 'fail',
        models: ['gpt-4o'],
      }],
    });
    expect(sessionId).toBe('outbound:oak_1:route-a');
  });

  it('pool NOT wired → minted route sessionId stays null (byte-identical to pre-seam)', async () => {
    const { sessionId } = await mintRoute({ apiKeyPool: undefined });
    expect(sessionId).toBeNull();
  });
});

describe('handleOutboundRequest — apiKeyId attribution (udash-attrib D5)', () => {
  it('minted route carries the verified named-key id; an internal route leaves it undefined', async () => {
    const routeMap = new ProviderProxyRouteMap();
    const addSpy = vi.spyOn(routeMap, 'addRoute');
    const deps = makeDeps({ db: makeDb(() => ({ ...enabledRow, id: 'oak_42' })), routeMap });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const req = new MockReq({
      headers: { authorization: 'Bearer any' },
      url: '/v1/chat/completions',
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const res = new MockRes();
    req.start();
    await handleOutboundRequest(
      req as unknown as http.IncomingMessage,
      res as unknown as http.ServerResponse,
      deps,
      config,
      new OutboundRateLimiter(),
      new UserMessageSerialQueue(),
      new OutboundConcurrencyGate(),
    );
    errSpy.mockRestore();

    expect(addSpy).toHaveBeenCalledTimes(1);
    const minted = addSpy.mock.calls[0][0] as { apiKeyId?: string };
    // Outbound route → attributed to the verified key id.
    expect(minted.apiKeyId).toBe('oak_42');

    // A resident-proxy route is minted WITHOUT resolveRoute (host `addRoute`),
    // so `apiKeyId` is undefined → the taps read `route.apiKeyId ?? null` = null.
    const internalToken = routeMap.addRoute({
      sessionId: null,
      targetProviderFormat: 'anthropic',
      model: 'm',
      ingressFormat: 'anthropic-messages',
      authMode: 'byo',
      providerId: 'anthropic',
    });
    const internal = routeMap.lookup(internalToken);
    expect(internal?.apiKeyId).toBeUndefined();
    expect(internal?.apiKeyId ?? null).toBeNull();
  });
});
