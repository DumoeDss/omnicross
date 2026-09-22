import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProviderProxyRouteMap } from '../../provider-proxy/providerProxyRouteMap';
import type { SubscriptionDispatchProfile } from '../../provider-proxy/types';
import { handleOutboundRequest, type OutboundRequestConfig } from '../outboundApiRouter';
import { OutboundConcurrencyGate } from '../outboundConcurrencyGate';
import { OutboundRateLimiter } from '../outboundRateLimiter';
import { normalizeSearchServerConfig } from '../searchServerConfig';
import { setSubscriptionRegistryForOutbound } from '../subscriptionRegistryPort';
import type { GatewayBinding, OutboundApiDeps, OutboundKeyDb, OutboundKeyDbRow } from '../types';
import { UserMessageSerialQueue } from '../userMessageSerialQueue';

class Request extends Readable {
  method = 'POST';
  url = '/v1/alpha/search';
  headers: http.IncomingHttpHeaders = {
    authorization: 'Bearer gateway-secret', 'content-type': 'application/json',
    'session-id': 'conversation-1', 'user-agent': 'codex_cli_rs/0.155.1',
    cookie: 'never-forward', 'x-openai-actor-authorization': 'never-forward',
  };
  socket = { remoteAddress: '127.0.0.1', destroy() {} };
  httpVersion = '1.1';
  complete = true;
  aborted = false;
  constructor(private readonly body: string) { super(); }
  override _read(): void { this.push(Buffer.from(this.body)); this.push(null); }
}

class Reply extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = '';
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  writeHead(status: number, headers: Record<string, string> = {}): this {
    this.statusCode = status; this.headers = headers; this.headersSent = true; return this;
  }
  write(chunk: string | Uint8Array): boolean { this.body += Buffer.from(chunk).toString(); return true; }
  end(chunk?: string | Uint8Array): void {
    if (chunk) this.write(chunk);
    this.writableEnded = true; this.emit('close');
  }
  destroy(): void { this.destroyed = true; this.emit('close'); }
}

const KEY: OutboundKeyDbRow = {
  id: 'search-client', name: 'Search client', keyHash: '', keyPrefix: 'sk-', enabled: true,
  createdAt: 1, lastUsedAt: null, revokedAt: null, allowedEndpoints: ['responses'],
  kind: 'integration', loopbackOnly: true,
};
const BINDING: GatewayBinding = {
  id: 'search-upstream', name: 'Search upstream', enabled: true, endpoint: 'responses',
  keyScope: 'selected', apiKeyIds: [KEY.id], target: { kind: 'provider', providerId: 'native' },
  priority: 10, fallback: 'fail', modelMode: 'passthrough',
};
// From Codex SearchRequest: commands/settings and opaque history must survive.
const BODY = {
  id: 'conversation-1', model: 'gpt-6-astra',
  commands: {
    search_query: [{ q: 'OpenAI', recency: 7, domains: ['openai.com'] }, { q: 'Codex' }],
    open: [{ ref_id: 'turn0search0', lineno: 12 }],
    find: [{ ref_id: 'turn0search0', pattern: 'Codex' }],
    response_length: 'short',
  },
  input: [{ type: 'future_history', encrypted_content: 'ciphertext-in' }],
  settings: { external_web_access: 'indexed', filters: { allowed_domains: ['openai.com'] } },
  future_field: { keep: true },
};
const OUTPUT = '{ "output":"Native search", "encrypted_output":"ciphertext-out", "results":[{"type":"future_result","ref_id":"turn1view0","extra":true}] }';

function setup(row: OutboundKeyDbRow | null = KEY, bindings: GatewayBinding[] = [BINDING]) {
  const routeMap = new ProviderProxyRouteMap();
  const provider = {
    id: 'native', name: 'Native', apiFormat: 'openai-response',
    api_base_url: 'https://upstream.test/prefix/v1', api_key: 'upstream-secret',
    models: ['gpt-6-astra'], enabled: true,
  };
  const llmConfig = {
    getProvider: async (id: string) => id === 'native' ? provider : null,
    getTransformerService: vi.fn(() => ({ getTransformer: vi.fn() })),
  } as unknown as OutboundApiDeps['llmConfig'];
  const db = {
    outboundApiKeysGetByHash: async () => row,
    outboundApiKeysTouchLastUsed: async () => true,
  } as unknown as OutboundKeyDb;
  const config: OutboundRequestConfig = {
    endpoints: [], bindings, search: normalizeSearchServerConfig({ modes: { codex: 'native' } }),
  };
  const runtimeSearch = vi.fn();
  const deps: OutboundApiDeps = {
    db, llmConfig,
    providerProxy: { getRouteMap: () => routeMap } as OutboundApiDeps['providerProxy'],
    // Deliberately stale bootstrap mode: outbound's live mode must win.
    proxyDeps: { llmConfig, searchFrontendModes: { codex: 'off', responses: 'native', anthropic: 'native' } },
    searchRuntime: { search: runtimeSearch } as unknown as OutboundApiDeps['searchRuntime'],
  };
  const gate = new OutboundConcurrencyGate();
  const start = (request = new Request(JSON.stringify(BODY, null, 2))) => {
    const response = new Reply();
    const completed = handleOutboundRequest(
      request as unknown as http.IncomingMessage, response as unknown as http.ServerResponse,
      deps, config, new OutboundRateLimiter(), new UserMessageSerialQueue(), gate,
    ).then(() => response);
    return { response, request, completed };
  };
  return { deps, config, provider, routeMap, runtimeSearch, start };
}

function nativeResponse(status = 200, body = OUTPUT): Response {
  return new Response(body, { status, headers: {
    'Content-Type': 'application/json', 'X-Request-Id': 'req-search',
    'Retry-After': '9', 'Set-Cookie': 'never-forward',
  } });
}

afterEach(() => { vi.unstubAllGlobals(); setSubscriptionRegistryForOutbound(null); });

describe('native Codex search through outbound routing', () => {
  it('relays complete commands and opaque results using the bound upstream credential', async () => {
    const upstream = vi.fn(async () => nativeResponse());
    vi.stubGlobal('fetch', upstream);
    const harness = setup();
    const response = await harness.start().completed;
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(OUTPUT);
    expect(response.headers['x-request-id']).toBe('req-search');
    expect(response.headers).not.toHaveProperty('set-cookie');
    const [url, init] = upstream.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://upstream.test/prefix/v1/alpha/search');
    expect(init.body).toBe(JSON.stringify(BODY, null, 2));
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer upstream-secret');
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('session-id')).toBe('conversation-1');
    expect(headers.has('cookie')).toBe(false);
    expect(headers.has('x-openai-actor-authorization')).toBe(false);
    expect(harness.runtimeSearch).not.toHaveBeenCalled();
    expect(harness.routeMap.size()).toBe(0);
  });

  it('supports open/find-only follow-ups and preserves upstream errors without local fallback', async () => {
    const upstream = vi.fn(async () => nativeResponse(429, '{"error":{"code":"upstream_limit"}}'));
    vi.stubGlobal('fetch', upstream);
    const harness = setup();
    const followup = { ...BODY, commands: { open: [{ ref_id: 'turn0search0' }], find: [{ ref_id: 'turn0search0', pattern: 'API' }] } };
    const response = await harness.start(new Request(JSON.stringify(followup))).completed;
    expect(response.statusCode).toBe(429);
    expect(response.body).toBe('{"error":{"code":"upstream_limit"}}');
    expect(response.headers['Retry-After']).toBe('9');
    expect(harness.runtimeSearch).not.toHaveBeenCalled();
  });

  it.each(['missing-key', 'wrong-permission', 'unbound', 'wrong-pin', 'reduced'] as const)(
    'rejects %s before any upstream request', async (scenario) => {
      const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
      const harness = setup(scenario === 'missing-key' ? null : scenario === 'wrong-permission'
        ? { ...KEY, allowedEndpoints: ['messages'] } : KEY, scenario === 'unbound' ? [] : [BINDING]);
      if (scenario === 'reduced') harness.provider.apiFormat = 'openai';
      const request = new Request(JSON.stringify(BODY));
      if (scenario === 'wrong-pin') request.headers['x-omnicross-binding-id'] = 'other-route';
      const response = await harness.start(request).completed;
      expect(response.statusCode).toBe(scenario === 'missing-key' ? 401
        : scenario === 'wrong-permission' ? 403 : scenario === 'reduced' ? 400 : 503);
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it('maps only the model when the selected binding uses a model mapping', async () => {
    const upstream = vi.fn(async () => nativeResponse()); vi.stubGlobal('fetch', upstream);
    const harness = setup(KEY, [{ ...BINDING, modelMode: 'mapped',
      modelMappings: [{ source: 'gpt-6-astra', target: 'gpt-search', effort: 'low' }],
    }]);
    expect((await harness.start().completed).statusCode).toBe(200);
    const [, init] = upstream.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ ...BODY, model: 'gpt-search' });
  });

  it('uses Codex account bindings, session affinity and OAuth refresh without adding Responses-only fields', async () => {
    let refreshed = false;
    const applyHeaders: SubscriptionDispatchProfile['authStrategy']['applyHeaders'] = vi.fn(async (headers, hints) => {
      headers.Authorization = `Bearer ${refreshed ? 'fresh-token' : 'expired-token'}`;
      hints?.reportSelection?.('bound-account', true);
    });
    const onUnauthorized = vi.fn(async () => { refreshed = true; return true; });
    const profile: SubscriptionDispatchProfile = {
      providerId: 'codex', displayName: 'Codex', mode: 'transformer',
      providerTransformerNames: ['openai-response'],
      resolveUpstreamUrl: () => 'https://chatgpt.com/backend-api/codex/responses',
      authStrategy: {
        providerId: 'codex', kind: 'oauth-bearer', applyHeaders, onUnauthorized,
        describeStatus: async () => ({ providerId: 'codex', configured: true }),
      },
    };
    setSubscriptionRegistryForOutbound({ getProfile: () => profile });
    const upstream = vi.fn(async () => nativeResponse(refreshed ? 200 : 401)); vi.stubGlobal('fetch', upstream);
    const harness = setup(KEY, [{ ...BINDING, target: { kind: 'account', providerId: 'codex', accountId: 'bound-account' } }]);
    const response = await harness.start().completed;
    expect(response.statusCode).toBe(200);
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(upstream).toHaveBeenCalledTimes(2);
    for (const args of upstream.mock.calls) {
      const [url, init] = args as unknown as [string, RequestInit];
      expect(url).toBe('https://chatgpt.com/backend-api/codex/alpha/search');
      expect(init.body).toBe(JSON.stringify(BODY, null, 2));
      expect(new Headers(init.headers).get('accept')).toBe('application/json');
    }
    const calls = vi.mocked(applyHeaders).mock.calls;
    expect(calls[0][1]).toMatchObject({ preferredAccountId: 'bound-account', boundAccountFallbackPolicy: 'strict' });
    expect(calls[0][1]?.sessionKey).toBeTruthy();
    expect(calls[1][1]?.sessionKey).toBe(calls[0][1]?.sessionKey);
  });

  it('keeps the request alive after replay EOF and aborts upstream when the client disconnects', async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signal = init.signal!; markStarted();
      signal.addEventListener('abort', () => reject(signal!.reason), { once: true });
    })));
    const harness = setup();
    const pending = harness.start();
    await started;
    expect(signal!.aborted).toBe(false);
    pending.response.destroy();
    await pending.completed;
    expect(signal!.aborted).toBe(true);
    expect(harness.routeMap.size()).toBe(0);
  });
});
