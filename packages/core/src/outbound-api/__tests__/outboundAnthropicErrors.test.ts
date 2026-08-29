/**
 * Outbound-face integration tests for the Anthropic local-error envelope
 * (`claude-api-routing-errors`, capability anthropic-local-errors).
 *
 * Drives the REAL `handleOutboundRequest` pipeline with only the shared
 * `routeRequest` dispatch mocked (the queue-suite pattern), asserting that every
 * LOCAL error on an Anthropic-protocol path (`/v1/messages*`) answers with the
 * official `{"type":"error","error":{"type","message"}}` shape while
 * non-Anthropic paths (chat) keep the legacy `outbound_api_error` envelope
 * byte-for-byte, and that count_tokens bypasses the concurrency gate.
 *
 * @module outbound-api/__tests__/outboundAnthropicErrors.test
 */
import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { Readable } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BoundAccountSelectionError } from '../../pipeline/BoundAccountSelectionError';
import { ProviderProxyRouteMap } from '../../provider-proxy/providerProxyRouteMap';
import { legacyEndpointsToBindings } from '../apiServerConfig';
import { handleOutboundRequest, type OutboundRequestConfig } from '../outboundApiRouter';
import { OutboundConcurrencyGate } from '../outboundConcurrencyGate';
import { OutboundRateLimiter } from '../outboundRateLimiter';
import type { OutboundApiDeps, OutboundKeyDb, OutboundKeyDbRow } from '../types';
import { UserMessageSerialQueue } from '../userMessageSerialQueue';

// --- controllable dispatch (queue-suite pattern) ------------------------------
const h = vi.hoisted(() => ({
  dispatch: null as ((req: unknown, res: unknown) => Promise<void>) | null,
}));

vi.mock('../../provider-proxy/providerProxyRouter', () => ({
  routeRequest: async (req: unknown, res: unknown): Promise<void> => {
    if (h.dispatch) {
      await h.dispatch(req, res);
      return;
    }
    (res as MockRes).writeHead(200, {});
    (res as MockRes).end('ok');
  },
}));

// --- mocks --------------------------------------------------------------------

function makeReq(opts: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
}): http.IncomingMessage {
  const body = opts.body ?? '{}';
  const r = Readable.from([Buffer.from(body, 'utf8')]) as unknown as http.IncomingMessage;
  r.method = opts.method ?? 'POST';
  r.url = opts.url ?? '/v1/messages';
  r.headers = opts.headers ?? {};
  r.httpVersion = '1.1';
  (r as unknown as { socket: unknown }).socket = { remoteAddress: '127.0.0.1', destroy: () => {} };
  return r;
}

class MockRes extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = '';
  headersSent = false;
  writeHead(status: number, headers: Record<string, string> = {}): this {
    this.statusCode = status;
    this.headers = { ...this.headers, ...headers };
    this.headersSent = true;
    return this;
  }
  write(chunk: string): boolean {
    this.body += chunk;
    return true;
  }
  end(chunk?: string): this {
    if (chunk) this.body += chunk;
    this.emit('finish');
    return this;
  }
}

const enabledRow: OutboundKeyDbRow = {
  id: 'oak_1',
  name: 'k',
  keyHash: '',
  keyPrefix: 'sk-omnicross-',
  enabled: true,
  createdAt: Date.now(),
  lastUsedAt: null,
  revokedAt: null,
};

function row(overrides: Partial<OutboundKeyDbRow> = {}): OutboundKeyDbRow {
  return { ...enabledRow, ...overrides };
}

function mkDeps(r: OutboundKeyDbRow | null, extra: Partial<OutboundApiDeps> = {}): OutboundApiDeps {
  const routeMap = new ProviderProxyRouteMap();
  const db: OutboundKeyDb = {
    outboundApiKeysList: async () => [],
    outboundApiKeysGetByHash: async () => r,
    outboundApiKeysCreate: async () => r ?? enabledRow,
    outboundApiKeysRevoke: async () => true,
    outboundApiKeysTouchLastUsed: async () => true,
    outboundApiKeysSetEnabled: async () => true,
    outboundApiKeysSetMaxConcurrency: async () => true,
    outboundApiKeysSetPolicy: async () => true,
    outboundApiKeysMarkActivated: async () => true,
    outboundApiKeysReveal: async () => null,
    outboundApiKeysDelete: async () => true,
  };
  const provider = {
    id: 'openai',
    name: 'OpenAI',
    api_key: 'sk-x',
    api_base_url: 'https://api.openai.com/v1',
    models: ['gpt-4o'],
    enabled: true,
  };
  return {
    db,
    llmConfig: { getProvider: async () => provider } as unknown as OutboundApiDeps['llmConfig'],
    providerProxy: { getRouteMap: () => routeMap } as unknown as OutboundApiDeps['providerProxy'],
    proxyDeps: {
      llmConfig: { getProvider: async () => provider },
      apiKeyPool: null,
    } as unknown as OutboundApiDeps['proxyDeps'],
    ...extra,
  };
}

const MESSAGES_ENDPOINTS: OutboundRequestConfig['endpoints'] = [
  { endpoint: 'messages', modelMap: { sonnet: 'openai,gpt-4o' }, useSubscription: false },
  { endpoint: 'chat', models: ['openai,gpt-4o'], useSubscription: false },
];
const CONFIG: OutboundRequestConfig = {
  endpoints: [],
  bindings: legacyEndpointsToBindings(MESSAGES_ENDPOINTS),
};

const AUTH = { authorization: 'Bearer any' };

interface CallResult {
  res: MockRes;
  done: Promise<void>;
}

function call(opts: {
  r: OutboundKeyDbRow | null;
  url?: string;
  body?: string;
  config?: OutboundRequestConfig;
  limiter?: OutboundRateLimiter;
  gate?: OutboundConcurrencyGate;
  extraDeps?: Partial<OutboundApiDeps>;
}): CallResult {
  const res = new MockRes();
  const req = makeReq({ headers: { ...AUTH }, body: opts.body, url: opts.url ?? '/v1/messages' });
  const done = handleOutboundRequest(
    req,
    res as unknown as http.ServerResponse,
    mkDeps(opts.r, opts.extraDeps),
    opts.config ?? CONFIG,
    opts.limiter ?? new OutboundRateLimiter(),
    new UserMessageSerialQueue(),
    opts.gate ?? new OutboundConcurrencyGate(),
  );
  return { res, done };
}

function parseBody(res: MockRes): Record<string, any> {
  return JSON.parse(res.body) as Record<string, any>;
}

beforeEach(() => {
  h.dispatch = null;
});

describe('outbound face — Anthropic local-error envelope', () => {
  it('invalid key on /v1/messages → 401 authentication_error (SDK-typeable)', async () => {
    const { res, done } = await Promise.resolve(call({ r: null }));
    await done;
    expect(res.statusCode).toBe(401);
    const json = parseBody(res);
    expect(json.type).toBe('error');
    expect(json.error.type).toBe('authentication_error');
    expect(typeof json.error.message).toBe('string');
  });

  it('invalid key on /v1/messages/count_tokens → same Anthropic 401', async () => {
    const { res, done } = await Promise.resolve(call({ r: null, url: '/v1/messages/count_tokens' }));
    await done;
    expect(res.statusCode).toBe(401);
    expect(parseBody(res).error.type).toBe('authentication_error');
  });

  it('invalid key on /v1/chat/completions → legacy outbound_api_error shape (regression pin)', async () => {
    const { res, done } = await Promise.resolve(call({ r: null, url: '/v1/chat/completions' }));
    await done;
    expect(res.statusCode).toBe(401);
    expect(parseBody(res)).toEqual({
      error: { type: 'outbound_api_error', message: 'Invalid or missing API key' },
    });
  });

  it('unsupported subpath /v1/messages/batches → 404 not_found_error, no route minted', async () => {
    const { res, done } = await Promise.resolve(
      call({
        r: row(),
        url: '/v1/messages/batches',
        body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }),
      }),
    );
    await done;
    expect(res.statusCode).toBe(404);
    const json = parseBody(res);
    expect(json.type).toBe('error');
    expect(json.error.type).toBe('not_found_error');
    expect(h.dispatch).toBeNull(); // never dispatched — but prove no upstream work happened via no route
  });

  it('lookalike /v1/messagesfoo → generic 404 (legacy shape, no Anthropic semantics)', async () => {
    const { res, done } = await Promise.resolve(call({ r: row(), url: '/v1/messagesfoo' }));
    await done;
    expect(res.statusCode).toBe(404);
    expect(parseBody(res).error.type).toBe('outbound_api_error');
  });

  it('GET /v1/messages (mark ignores method) → Anthropic-shaped 404', async () => {
    const res = new MockRes();
    const req = makeReq({ headers: { ...AUTH }, url: '/v1/messages', method: 'GET' });
    await handleOutboundRequest(
      req,
      res as unknown as http.ServerResponse,
      mkDeps(row()),
      CONFIG,
      new OutboundRateLimiter(),
      new UserMessageSerialQueue(),
      new OutboundConcurrencyGate(),
    );
    expect(res.statusCode).toBe(404);
    expect(parseBody(res).error.type).toBe('not_found_error');
  });

  it('a key authorized for messages is authorized for count_tokens; chat-only is not', async () => {
    const body = JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] });
    // messages-authorized → passes the endpoint check (200 via mocked dispatch).
    const allowed = await Promise.resolve(
      call({
        r: row({ kind: 'integration', allowedEndpoints: ['messages'] }),
        url: '/v1/messages/count_tokens',
        body,
      }),
    );
    await allowed.done;
    expect(allowed.res.statusCode).toBe(200);
    // chat-only → endpoint 403 (permission_error on the Anthropic path).
    const denied = await Promise.resolve(
      call({
        r: row({ kind: 'integration', allowedEndpoints: ['chat'] }),
        url: '/v1/messages/count_tokens',
        body,
      }),
    );
    await denied.done;
    expect(denied.res.statusCode).toBe(403);
    expect(parseBody(denied.res).error.type).toBe('permission_error');
  });

  it('rate-limited /v1/messages → 429 rate_limit_error with Retry-After kept', async () => {
    const limiter = new OutboundRateLimiter({ maxRequests: 1, windowMs: 60_000 });
    const body = JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] });
    // First request consumes the window (it 200s via the mocked dispatch).
    const first = await Promise.resolve(call({ r: row(), limiter, body }));
    await first.done;
    expect(first.res.statusCode).toBe(200);
    const { res, done } = await Promise.resolve(call({ r: row(), limiter, body }));
    await done;
    expect(res.statusCode).toBe(429);
    expect(parseBody(res).error.type).toBe('rate_limit_error');
    expect(res.headers['Retry-After']).toBeDefined();
  });

  it('rate-limited /v1/chat/completions → legacy shape with Retry-After (pin)', async () => {
    const limiter = new OutboundRateLimiter({ maxRequests: 1, windowMs: 60_000 });
    const first = await Promise.resolve(
      call({ r: row(), url: '/v1/chat/completions', limiter, body: JSON.stringify({ model: 'gpt-4o' }) }),
    );
    await first.done;
    const { res, done } = await Promise.resolve(
      call({ r: row(), url: '/v1/chat/completions', limiter, body: JSON.stringify({ model: 'gpt-4o' }) }),
    );
    await done;
    expect(res.statusCode).toBe(429);
    expect(parseBody(res).error.type).toBe('outbound_api_error');
    expect(res.headers['Retry-After']).toBeDefined();
  });

  it('no downstream route on messages → 503 api_error', async () => {
    const noRouteConfig: OutboundRequestConfig = {
      endpoints: [],
      bindings: legacyEndpointsToBindings([
        { endpoint: 'chat', models: ['openai,gpt-4o'], useSubscription: false },
      ]),
    };
    const { res, done } = await Promise.resolve(call({ r: row(), config: noRouteConfig }));
    await done;
    expect(res.statusCode).toBe(503);
    expect(parseBody(res).error.type).toBe('api_error');
  });

  it('dispatch pipeline failure on messages → 502 api_error with the sanitized message', async () => {
    h.dispatch = async () => {
      throw new Error('pipeline exploded');
    };
    const { res, done } = await Promise.resolve(
      call({ r: row(), body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }) }),
    );
    await done;
    expect(res.statusCode).toBe(502);
    const json = parseBody(res);
    expect(json.error.type).toBe('api_error');
    expect(String(json.error.message)).toContain('pipeline exploded');
  });

  it('bound-account failure on messages → status kept, code/reason + Retry-After preserved', async () => {
    const resumeAt = new Date(Date.now() + 30_000).toISOString();
    h.dispatch = async () => {
      throw new BoundAccountSelectionError('claude', 'allowance-paused', resumeAt);
    };
    const { res, done } = await Promise.resolve(
      call({ r: row(), body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }) }),
    );
    await done;
    expect(res.statusCode).toBe(429);
    const json = parseBody(res);
    expect(json.type).toBe('error');
    expect(json.error.type).toBe('rate_limit_error');
    expect(json.error.code).toBe('bound_account_unavailable');
    expect(json.error.reason).toBe('allowance-paused');
    expect(res.headers['Retry-After']).toBeDefined();
  });

  it('cost limit on messages → 402 rate_limit_error with scope/limitUsd/spentUsd inside error', async () => {
    const { res, done } = await Promise.resolve(
      call({
        r: row({ dailyCostLimitUsd: 1 }),
        extraDeps: {
          keySpendTracker: {
            getSpend: async () => ({ dailyUsd: 5, weeklyUsd: 0, totalUsd: 0 }),
          },
        },
      }),
    );
    await done;
    expect(res.statusCode).toBe(402);
    const json = parseBody(res);
    expect(json.error.type).toBe('rate_limit_error');
    expect(json.error.scope).toBe('daily');
    expect(json.error.limitUsd).toBe(1);
    expect(json.error.spentUsd).toBe(5);
  });

  it('model restriction on messages → 403 permission_error with model/mode inside error', async () => {
    // The messages route resolves claude-sonnet-4-5 → kind sonnet → openai,gpt-4o,
    // which this key blacklists.
    const { res, done } = await Promise.resolve(
      call({
        r: row({
          enableModelRestriction: true,
          restrictionMode: 'blacklist',
          restrictedModels: ['gpt-4o'],
        }),
        body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }),
      }),
    );
    await done;
    expect(res.statusCode).toBe(403);
    const json = parseBody(res);
    expect(json.error.type).toBe('permission_error');
    expect(json.error.model).toBe('gpt-4o');
    expect(json.error.mode).toBe('blacklist');
  });
});

describe('outbound face — count_tokens concurrency-gate bypass', () => {
  it('count_tokens completes while the gate slot is held; a generation request 429s', async () => {
    const gate = new OutboundConcurrencyGate();
    // Hold the key's only slot from outside (simulates an in-flight inference).
    const holder = gate.acquire('oak_1', 1, {
      maxQueueSizeFactor: 1,
      minQueueSize: 1,
      waitTimeoutMs: 100,
    });
    await holder.granted;

    const countTokens = await Promise.resolve(
      call({
        r: row({ maxConcurrency: 1 }),
        url: '/v1/messages/count_tokens',
        body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }),
        gate,
        config: {
          ...CONFIG,
          concurrencyQueue: { maxQueueSizeFactor: 1, minQueueSize: 1, waitTimeoutMs: 100 },
        },
      }),
    );
    await countTokens.done;
    // The mocked dispatch answers 200 — proving the request never touched the gate
    // (it would otherwise queue behind the held slot and time out 429).
    expect(countTokens.res.statusCode).toBe(200);

    // Negative control: a GENERATION request on the same held gate times out 429.
    const generation = await Promise.resolve(
      call({
        r: row({ maxConcurrency: 1 }),
        url: '/v1/messages',
        body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }),
        gate,
        config: {
          ...CONFIG,
          concurrencyQueue: { maxQueueSizeFactor: 1, minQueueSize: 1, waitTimeoutMs: 100 },
        },
      }),
    );
    await generation.done;
    expect(generation.res.statusCode).toBe(429);
    expect(parseBody(generation.res).error.type).toBe('rate_limit_error');
    expect(generation.res.headers['Retry-After']).toBe('5');
  });

  it('count_tokens route carries anthropicCountTokensMode from the config segment', async () => {
    const routeMap = new ProviderProxyRouteMap();
    const deps = mkDeps(row());
    // Swap in our own observable map so the dispatch mock can read the minted route.
    (deps as { providerProxy: { getRouteMap: () => ProviderProxyRouteMap } }).providerProxy = {
      getRouteMap: () => routeMap,
    };
    let captured:
      | { anthropicCountTokensMode?: string; anthropicCountTokensEstimateBudgetMs?: number }
      | undefined;
    h.dispatch = async (req: unknown, res: unknown) => {
      const headers = (req as { headers: Record<string, string> }).headers;
      const token = /^Bearer\s+(.+)$/i.exec(headers['authorization'] ?? '')?.[1];
      captured = routeMap.lookup(token);
      (res as MockRes).writeHead(200, {});
      (res as MockRes).end('ok');
    };
    const res = new MockRes();
    const req = makeReq({
      headers: { ...AUTH },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }),
      url: '/v1/messages/count_tokens',
    });
    await handleOutboundRequest(
      req,
      res as unknown as http.ServerResponse,
      deps,
      {
        ...CONFIG,
        anthropic: { countTokens: { mode: 'reject', estimateBudgetMs: 500 } },
      },
      new OutboundRateLimiter(),
      new UserMessageSerialQueue(),
      new OutboundConcurrencyGate(),
    );
    expect(res.statusCode).toBe(200);
    // The minted route carries the configured mode + budget (undefined would
    // mean 'auto' / the estimator default).
    expect(captured?.anthropicCountTokensMode).toBe('reject');
    expect(captured?.anthropicCountTokensEstimateBudgetMs).toBe(500);
  });
});
