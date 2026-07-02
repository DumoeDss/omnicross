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
import {
  extractGeminiModelFromUrl,
  extractPresentedKey,
  handleOutboundRequest,
  selectEndpoint,
} from '../outboundApiRouter';
import { OutboundRateLimiter } from '../outboundRateLimiter';
import type { OutboundApiDeps, OutboundKeyDb, OutboundKeyDbRow } from '../types';

// --- helpers ---------------------------------------------------------------

class MockReq extends EventEmitter {
  method: string;
  url: string;
  headers: Record<string, string>;
  socket = { remoteAddress: '127.0.0.1', destroy: () => {} };
  httpVersion = '1.1';
  private body: string;
  constructor(opts: { method?: string; url?: string; headers?: Record<string, string>; body?: string }) {
    super();
    this.method = opts.method ?? 'POST';
    this.url = opts.url ?? '/v1/chat/completions';
    this.headers = opts.headers ?? {};
    this.body = opts.body ?? '{}';
  }
  // Replay the body once handlers attach (mimics a live request stream).
  start(): void {
    process.nextTick(() => {
      if (this.body) this.emit('data', Buffer.from(this.body, 'utf8'));
      this.emit('end');
    });
  }
}

class MockRes {
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
  end(chunk?: string) {
    if (chunk) this.body += chunk;
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
  };
}

function makeDeps(opts: {
  db: OutboundKeyDb;
  routeMap: ProviderProxyRouteMap;
  /** When set, wires a (stub) ApiKeyPool onto proxyDeps so the router synthesizes
   *  a stable `outbound:<keyId>` sessionId (pool-seam, design D1/D2(a)). */
  apiKeyPool?: unknown;
}): OutboundApiDeps {
  return {
    db: opts.db,
    llmConfig: {
      getProvider: async () => ({ id: 'openai', api_key: 'sk-x', models: ['gpt-4o'] }),
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

const config = {
  endpoints: [
    // chat is LIST-mapped: the request's `model` must be one of these refs' modelIds.
    { endpoint: 'chat' as const, models: ['openai,gpt-4o', 'openai,gpt-4o-mini'], useSubscription: false },
  ],
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

describe('selectEndpoint', () => {
  it('matches the four endpoints and 404s the rest', () => {
    expect(selectEndpoint('POST', '/v1/chat/completions')).toBe('chat');
    expect(selectEndpoint('POST', '/v1/responses')).toBe('responses');
    expect(selectEndpoint('POST', '/v1/messages')).toBe('messages');
    expect(selectEndpoint('POST', '/v1beta/models/gemini-2.5-pro:generateContent')).toBe('gemini');
    expect(selectEndpoint('POST', '/v1beta/models/gemini-2.5-pro:streamGenerateContent')).toBe('gemini');
    expect(selectEndpoint('GET', '/v1/chat/completions')).toBeNull();
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
    await handleOutboundRequest(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse, deps, config, new OutboundRateLimiter());
    expect(res.statusCode).toBe(401);
    expect(routeMap.size()).toBe(0);
  });

  it('401 on an invalid key', async () => {
    const routeMap = new ProviderProxyRouteMap();
    const deps = makeDeps({ db: makeDb(() => null), routeMap });
    const req = new MockReq({ headers: { authorization: 'Bearer wrong' } });
    const res = new MockRes();
    req.start();
    await handleOutboundRequest(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse, deps, config, new OutboundRateLimiter());
    expect(res.statusCode).toBe(401);
  });

  it('429 when the per-key rate limit is exceeded', async () => {
    const routeMap = new ProviderProxyRouteMap();
    const deps = makeDeps({ db: makeDb(() => ({ ...enabledRow })), routeMap });
    const limiter = new OutboundRateLimiter({ windowMs: 1000, maxRequests: 0 });
    const req = new MockReq({ headers: { authorization: 'Bearer any' }, url: '/v1/chat/completions' });
    const res = new MockRes();
    req.start();
    await handleOutboundRequest(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse, deps, config, limiter);
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBeDefined();
  });

  it('GET /v1/models returns the chat model list (OpenAI shape) after auth', async () => {
    const routeMap = new ProviderProxyRouteMap();
    const deps = makeDeps({ db: makeDb(() => ({ ...enabledRow })), routeMap });
    const req = new MockReq({ headers: { authorization: 'Bearer any' }, url: '/v1/models', method: 'GET' });
    const res = new MockRes();
    req.start();
    await handleOutboundRequest(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse, deps, config, new OutboundRateLimiter());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { object: string; data: Array<{ id: string; object: string }> };
    expect(body.object).toBe('list');
    expect(body.data.map((m) => m.id)).toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect(body.data.every((m) => m.object === 'model')).toBe(true);
    // No route minted for the discovery request.
    expect(routeMap.size()).toBe(0);
  });

  it('GET /v1/models still requires a valid API key', async () => {
    const routeMap = new ProviderProxyRouteMap();
    const deps = makeDeps({ db: makeDb(() => null), routeMap });
    const req = new MockReq({ headers: {}, url: '/v1/models', method: 'GET' });
    const res = new MockRes();
    req.start();
    await handleOutboundRequest(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse, deps, config, new OutboundRateLimiter());
    expect(res.statusCode).toBe(401);
  });

  it('404 on an unrecognized path (after a valid key)', async () => {
    const routeMap = new ProviderProxyRouteMap();
    const deps = makeDeps({ db: makeDb(() => ({ ...enabledRow })), routeMap });
    const req = new MockReq({ headers: { authorization: 'Bearer any' }, url: '/nope' });
    const res = new MockRes();
    req.start();
    await handleOutboundRequest(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse, deps, config, new OutboundRateLimiter());
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
    await handleOutboundRequest(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse, deps, config, new OutboundRateLimiter());

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

describe('handleOutboundRequest — pool-seam synthesized sessionId (poolseam D1/D2(a))', () => {
  /** Drive one chat request and return the RouteContext that was minted. */
  async function mintRoute(opts: { apiKeyPool?: unknown }): Promise<{
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
      config,
      new OutboundRateLimiter(),
    );
    errSpy.mockRestore();
    expect(addSpy).toHaveBeenCalledTimes(1);
    const minted = addSpy.mock.calls[0][0] as { sessionId: string | null | undefined };
    return { sessionId: minted.sessionId };
  }

  it('pool wired → minted route carries a STABLE `outbound:<verifiedKeyId>` sessionId', async () => {
    const { sessionId } = await mintRoute({ apiKeyPool: { reportError: vi.fn() } });
    expect(sessionId).toBe('outbound:oak_1');
  });

  it('same verified key → same synthesized id on a second request (stable affinity)', async () => {
    const a = await mintRoute({ apiKeyPool: { reportError: vi.fn() } });
    const b = await mintRoute({ apiKeyPool: { reportError: vi.fn() } });
    expect(a.sessionId).toBe('outbound:oak_1');
    expect(b.sessionId).toBe(a.sessionId);
  });

  it('pool NOT wired → minted route sessionId stays null (byte-identical to pre-seam)', async () => {
    const { sessionId } = await mintRoute({ apiKeyPool: undefined });
    expect(sessionId).toBeNull();
  });
});
