/**
 * Integration tests for the queue/concurrency wiring (`omnicross-uqc-wire`).
 *
 * Drives the REAL `handleOutboundRequest` pipeline with the two `omnicross-uqc-
 * core` primitives, mocking only the shared `routeRequest` dispatch so a test can
 * hold a response open, start a stream, or abort a client mid-stream. Covers the
 * concurrency gate (bypass, queue-full 429, wait-timeout 429, the CRS #1130
 * streaming-abort slot leak, release-after-routing-error), the user-message
 * serial queue (serialize-per-provider, tool-loop bypass, disabled bypass, 503
 * wait-timeout), and the server's `getQueueStatus()` seam.
 */
import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProviderProxyRouteMap } from '../../provider-proxy/providerProxyRouteMap';
import { handleOutboundRequest, type OutboundRequestConfig } from '../outboundApiRouter';
import { OutboundApiServer } from '../OutboundApiServer';
import { OutboundConcurrencyGate } from '../outboundConcurrencyGate';
import { OutboundRateLimiter } from '../outboundRateLimiter';
import type { OutboundApiDeps, OutboundKeyDb, OutboundKeyDbRow } from '../types';
import { UserMessageSerialQueue } from '../userMessageSerialQueue';

// --- controllable dispatch --------------------------------------------------
// Only the shared `routeRequest` is mocked; the rest of the pipeline is real.
// `h.state.dispatch`, when set, replaces the default (immediate 200) so a test
// can hold the response open / start a stream / branch by the `x-test-tag`.
const h = vi.hoisted(() => {
  const state: { dispatch: ((req: unknown, res: unknown) => Promise<void>) | null } = {
    dispatch: null,
  };
  return { state };
});

vi.mock('../../provider-proxy/providerProxyRouter', () => ({
  routeRequest: async (req: unknown, res: unknown): Promise<void> => {
    if (h.state.dispatch) {
      await h.state.dispatch(req, res);
      return;
    }
    (res as MockRes).writeHead(200, {});
    (res as MockRes).end('ok');
  },
}));

// --- mocks ------------------------------------------------------------------

function makeReq(opts: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
}): http.IncomingMessage {
  const body = opts.body ?? '{}';
  const r = Readable.from([Buffer.from(body, 'utf8')]) as unknown as http.IncomingMessage;
  r.method = opts.method ?? 'POST';
  r.url = opts.url ?? '/v1/chat/completions';
  r.headers = opts.headers ?? {};
  r.httpVersion = '1.1';
  (r as unknown as { socket: unknown }).socket = { remoteAddress: '127.0.0.1', destroy: () => {} };
  return r;
}

/** A `ServerResponse`-shaped EventEmitter (supports `once`/`removeListener`). */
class MockRes extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = '';
  headersSent = false;
  closed = false;
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
  /** Simulate a client that disconnects mid-stream. */
  abort(): void {
    this.closed = true;
    this.emit('close');
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

/** Deps whose DB resolves `r` for any presented key hash. */
function mkDeps(r: OutboundKeyDbRow | null): OutboundApiDeps {
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
    providerProxy: {
      getRouteMap: () => routeMap,
    } as unknown as OutboundApiDeps['providerProxy'],
    proxyDeps: {
      llmConfig: { getProvider: async () => provider },
      apiKeyPool: null,
    } as unknown as OutboundApiDeps['proxyDeps'],
  };
}

const CHAT_ONLY: OutboundRequestConfig['endpoints'] = [
  { endpoint: 'chat', models: ['openai,gpt-4o'], useSubscription: false },
];

const USER_MSG = JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
// Last turn is a tool result → NOT a user message (serial queue must bypass).
const TOOL_LOOP = JSON.stringify({
  model: 'gpt-4o',
  messages: [
    { role: 'user', content: 'hi' },
    { role: 'tool', content: 'result' },
  ],
});

const AUTH = { authorization: 'Bearer any' };

/** Invoke the real pipeline; returns the response + the settling promise. */
function call(opts: {
  row: OutboundKeyDbRow | null;
  config: OutboundRequestConfig;
  serial: UserMessageSerialQueue;
  gate: OutboundConcurrencyGate;
  limiter?: OutboundRateLimiter;
  body?: string;
  url?: string;
  method?: string;
  tag?: string;
}): { res: MockRes; done: Promise<void> } {
  const res = new MockRes();
  const headers: Record<string, string> = { ...AUTH };
  if (opts.tag) headers['x-test-tag'] = opts.tag;
  const req = makeReq({ headers, body: opts.body, url: opts.url, method: opts.method });
  const done = handleOutboundRequest(
    req,
    res as unknown as http.ServerResponse,
    mkDeps(opts.row),
    opts.config,
    opts.limiter ?? new OutboundRateLimiter(),
    opts.serial,
    opts.gate,
  );
  return { res, done };
}

async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition never met');
    await new Promise((r) => setTimeout(r, 3));
  }
}

/** A dispatch that starts a stream then holds until the client closes/finishes. */
async function holdUntilClose(_req: unknown, res: unknown): Promise<void> {
  const r = res as MockRes;
  r.writeHead(200, { 'content-type': 'text/event-stream' });
  r.write('data: chunk\n\n');
  await new Promise<void>((resolve) => {
    if (r.closed) return resolve();
    r.once('close', resolve);
    r.once('finish', resolve);
  });
}

beforeEach(() => {
  h.state.dispatch = null;
});

afterEach(() => {
  h.state.dispatch = null;
});

// --- concurrency gate -------------------------------------------------------

describe('concurrency gate wiring', () => {
  it('6.1 GET /v1/models + unlimited key bypass the gate; disabled serial never serializes', async () => {
    const gate = new OutboundConcurrencyGate();
    const serial = new UserMessageSerialQueue();
    const config: OutboundRequestConfig = { endpoints: CHAT_ONLY };

    // GET models — served before the gate, no route, no gate engagement.
    const models = call({
      row: row(),
      config,
      serial,
      gate,
      url: '/v1/models',
      method: 'GET',
    });
    await models.done;
    expect(models.res.statusCode).toBe(200);
    expect(gate.getStatus()).toEqual([]);

    // Unlimited key POST — dispatches, gate never engages, serial disabled.
    const post = call({ row: row(), config, serial, gate, body: USER_MSG });
    await post.done;
    expect(post.res.statusCode).toBe(200);
    expect(gate.getStatus()).toEqual([]);
    expect(serial.getStatus()).toEqual([]);
  });

  it('6.2 over-limit past the queue cap → 429 + Retry-After: 5', async () => {
    const gate = new OutboundConcurrencyGate();
    const serial = new UserMessageSerialQueue();
    const limiter = new OutboundRateLimiter();
    // limit 1, queue cap = max(1*1, 1) = 1 → 1 active + 1 queued, the 3rd rejects.
    const config: OutboundRequestConfig = {
      endpoints: CHAT_ONLY,
      concurrencyQueue: { maxQueueSizeFactor: 1, minQueueSize: 1, waitTimeoutMs: 60_000 },
    };
    h.state.dispatch = holdUntilClose;

    const a = call({ row: row({ maxConcurrency: 1 }), config, serial, gate, limiter, body: USER_MSG });
    await waitFor(() => gate.getStatus().some((e) => e.active === 1));
    const b = call({ row: row({ maxConcurrency: 1 }), config, serial, gate, limiter, body: USER_MSG });
    await waitFor(() => gate.getStatus().some((e) => e.waiting === 1));

    // Third request: 1 active + 1 already queued = queue full → 429.
    const c = call({ row: row({ maxConcurrency: 1 }), config, serial, gate, limiter, body: USER_MSG });
    await c.done;
    expect(c.res.statusCode).toBe(429);
    expect(c.res.headers['Retry-After']).toBe('5');

    // Cleanup: aborting A frees the slot and grants B; abort B too.
    a.res.abort();
    b.res.abort();
    await Promise.allSettled([a.done, b.done]);
  });

  it('6.2 wait-timeout → 429', async () => {
    const gate = new OutboundConcurrencyGate();
    const serial = new UserMessageSerialQueue();
    const limiter = new OutboundRateLimiter();
    const config: OutboundRequestConfig = {
      endpoints: CHAT_ONLY,
      concurrencyQueue: { maxQueueSizeFactor: 4, minQueueSize: 4, waitTimeoutMs: 30 },
    };
    h.state.dispatch = holdUntilClose;

    const a = call({ row: row({ maxConcurrency: 1 }), config, serial, gate, limiter, body: USER_MSG });
    await waitFor(() => gate.getStatus().some((e) => e.active === 1));

    // B queues (cap not full) then times out after 30ms → 429.
    const b = call({ row: row({ maxConcurrency: 1 }), config, serial, gate, limiter, body: USER_MSG });
    await b.done;
    expect(b.res.statusCode).toBe(429);
    expect(b.res.headers['Retry-After']).toBe('5');

    a.res.abort();
    await Promise.allSettled([a.done]);
  });

  it('6.2 slot is released when routing fails after acquire', async () => {
    const gate = new OutboundConcurrencyGate();
    const serial = new UserMessageSerialQueue();
    // Empty chat model list → the requested model resolves to a 404 AFTER the
    // concurrency slot is acquired. The enclosing finally must free the slot.
    const config: OutboundRequestConfig = {
      endpoints: [{ endpoint: 'chat', models: [], useSubscription: false }],
      concurrencyQueue: { maxQueueSizeFactor: 2, minQueueSize: 4, waitTimeoutMs: 60_000 },
    };

    const r = call({ row: row({ maxConcurrency: 2 }), config, serial, gate, body: USER_MSG });
    await r.done;
    expect(r.res.statusCode).toBe(404);
    expect(gate.getStatus()).toEqual([]);
  });

  it('6.3 streaming client abort does not leak a slot (the #1130 guard)', async () => {
    const gate = new OutboundConcurrencyGate();
    const serial = new UserMessageSerialQueue();
    const config: OutboundRequestConfig = {
      endpoints: CHAT_ONLY,
      concurrencyQueue: { maxQueueSizeFactor: 2, minQueueSize: 4, waitTimeoutMs: 60_000 },
    };
    h.state.dispatch = holdUntilClose;

    const a = call({ row: row({ maxConcurrency: 1 }), config, serial, gate, body: USER_MSG });
    await waitFor(() => gate.getStatus().some((e) => e.apiKeyId === 'oak_1' && e.active === 1));

    // Client aborts mid-stream — the gate's active count must return to zero.
    a.res.abort();
    await a.done;
    expect(gate.getStatus()).toEqual([]);
  });
});

// --- serial queue -----------------------------------------------------------

describe('user-message serial queue wiring', () => {
  const serialConfig = (over?: { delayMs?: number; waitTimeoutMs?: number }): OutboundRequestConfig => ({
    endpoints: CHAT_ONLY,
    userMessageQueue: {
      enabled: true,
      delayMs: over?.delayMs ?? 10,
      waitTimeoutMs: over?.waitTimeoutMs ?? 60_000,
    },
  });

  it('6.4 two real user messages for one provider serialize (second waits for the first writeHead)', async () => {
    const gate = new OutboundConcurrencyGate();
    const serial = new UserMessageSerialQueue();
    const limiter = new OutboundRateLimiter();

    let releaseA!: () => void;
    const aHeld = new Promise<void>((r) => {
      releaseA = r;
    });
    h.state.dispatch = async (req, res) => {
      const r = res as MockRes;
      if ((req as http.IncomingMessage).headers['x-test-tag'] === 'A') {
        await aHeld; // hold BEFORE writeHead so the serial lock stays held
        r.writeHead(200, {});
        r.end('a');
        return;
      }
      r.writeHead(200, {});
      r.end('b');
    };

    const config = serialConfig();
    const a = call({ row: row(), config, serial, gate, limiter, body: USER_MSG, tag: 'A' });
    await waitFor(() => serial.getStatus().some((e) => e.providerId === 'openai' && e.holding));

    const b = call({ row: row(), config, serial, gate, limiter, body: USER_MSG, tag: 'B' });
    await waitFor(() => serial.getStatus().some((e) => e.waiting === 1));
    // B must not have dispatched while A holds the serial lock.
    expect(b.res.statusCode).toBe(0);

    // A's response starts → serial released → after delayMs, B is granted.
    releaseA();
    await waitFor(() => b.res.statusCode === 200);
    await Promise.allSettled([a.done, b.done]);
    expect(a.res.statusCode).toBe(200);
  });

  it('6.4 a tool-loop turn bypasses the serial queue', async () => {
    const gate = new OutboundConcurrencyGate();
    const serial = new UserMessageSerialQueue();
    const limiter = new OutboundRateLimiter();

    let releaseA!: () => void;
    const aHeld = new Promise<void>((r) => {
      releaseA = r;
    });
    h.state.dispatch = async (req, res) => {
      const r = res as MockRes;
      if ((req as http.IncomingMessage).headers['x-test-tag'] === 'A') {
        await aHeld;
        r.writeHead(200, {});
        r.end('a');
        return;
      }
      r.writeHead(200, {});
      r.end('t');
    };

    const config = serialConfig();
    const a = call({ row: row(), config, serial, gate, limiter, body: USER_MSG, tag: 'A' });
    await waitFor(() => serial.getStatus().some((e) => e.providerId === 'openai' && e.holding));

    // A tool-loop request for the SAME provider dispatches immediately despite A
    // holding the serial lock (it is not a user-message turn).
    const t = call({ row: row(), config, serial, gate, limiter, body: TOOL_LOOP, tag: 'T' });
    await waitFor(() => t.res.statusCode === 200);
    // No waiter was ever enqueued for the tool-loop turn.
    expect(serial.getStatus().every((e) => e.waiting === 0)).toBe(true);

    releaseA();
    await Promise.allSettled([a.done, t.done]);
  });

  it('6.4 serial wait-timeout returns 503 with nothing streamed', async () => {
    const gate = new OutboundConcurrencyGate();
    const serial = new UserMessageSerialQueue();
    const limiter = new OutboundRateLimiter();

    let releaseA!: () => void;
    const aHeld = new Promise<void>((r) => {
      releaseA = r;
    });
    let bDispatched = false;
    h.state.dispatch = async (req, res) => {
      const r = res as MockRes;
      if ((req as http.IncomingMessage).headers['x-test-tag'] === 'A') {
        await aHeld;
        r.writeHead(200, {});
        r.end('a');
        return;
      }
      bDispatched = true;
      r.writeHead(200, {});
      r.end('b');
    };

    const config = serialConfig({ delayMs: 10, waitTimeoutMs: 30 });
    const a = call({ row: row(), config, serial, gate, limiter, body: USER_MSG, tag: 'A' });
    await waitFor(() => serial.getStatus().some((e) => e.providerId === 'openai' && e.holding));

    // B waits for the lock; A never releases within 30ms → 503, no dispatch.
    const b = call({ row: row(), config, serial, gate, limiter, body: USER_MSG, tag: 'B' });
    await b.done;
    expect(b.res.statusCode).toBe(503);
    expect(bDispatched).toBe(false);

    releaseA();
    await Promise.allSettled([a.done]);
  });

  it('6.4 disabled queue never serializes', async () => {
    const gate = new OutboundConcurrencyGate();
    const serial = new UserMessageSerialQueue();
    const config: OutboundRequestConfig = {
      endpoints: CHAT_ONLY,
      userMessageQueue: { enabled: false, delayMs: 10, waitTimeoutMs: 60_000 },
    };
    const r = call({ row: row(), config, serial, gate, body: USER_MSG });
    await r.done;
    expect(r.res.statusCode).toBe(200);
    expect(serial.getStatus()).toEqual([]);
  });
});

// --- server getQueueStatus() seam ------------------------------------------

describe('OutboundApiServer.getQueueStatus()', () => {
  it('6.5 empty when idle; reflects an active concurrency entry; getStatus() unchanged', async () => {
    const server = new OutboundApiServer(mkDeps(row({ maxConcurrency: 1 })));
    // enabled:false stores endpoints + queue segments WITHOUT binding a listener.
    await server.applyConfig({
      enabled: false,
      networkBinding: false,
      endpoints: CHAT_ONLY,
      concurrencyQueue: { maxQueueSizeFactor: 2, minQueueSize: 4, waitTimeoutMs: 60_000 },
      userMessageQueue: { enabled: false, delayMs: 200, waitTimeoutMs: 60_000 },
    });

    // Idle.
    expect(server.getQueueStatus()).toEqual({ serial: [], concurrency: [] });

    // Hold one request open through the server's private per-request handler.
    h.state.dispatch = holdUntilClose;
    const res = new MockRes();
    (server as unknown as { onRequest: (req: unknown, res: unknown) => void }).onRequest(
      makeReq({ headers: AUTH, body: USER_MSG }),
      res,
    );
    await waitFor(() => server.getQueueStatus().concurrency.length > 0);
    expect(server.getQueueStatus().concurrency).toEqual([
      { apiKeyId: 'oak_1', active: 1, waiting: 0 },
    ]);
    expect(server.getQueueStatus().serial).toEqual([]);

    // The existing getStatus() shape is unchanged (not running here).
    const status = server.getStatus();
    expect(status.running).toBe(false);
    expect(status).toHaveProperty('loopbackUrl', null);
    expect(status).not.toHaveProperty('queueStatus');

    // Abort frees the slot.
    res.abort();
    await waitFor(() => server.getQueueStatus().concurrency.length === 0);
  });
});
