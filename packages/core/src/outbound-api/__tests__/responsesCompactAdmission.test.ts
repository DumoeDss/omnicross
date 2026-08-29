import { EventEmitter } from 'node:events';
import type http from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpenAIOperationRegistry } from '../../openai-operation';
import { ProviderProxyRouteMap } from '../../provider-proxy/providerProxyRouteMap';
import { registerResponsesCompactOperation } from '../../provider-proxy/responses/responsesCompact';
import { handleOutboundRequest } from '../outboundApiRouter';
import { OutboundConcurrencyGate } from '../outboundConcurrencyGate';
import { OutboundRateLimiter } from '../outboundRateLimiter';
import type { GatewayBinding, OutboundApiDeps, OutboundKeyDb, OutboundKeyDbRow } from '../types';
import { UserMessageSerialQueue } from '../userMessageSerialQueue';

class MockRequest extends EventEmitter {
  method = 'POST';
  url = '/openai/responses/compact';
  headers: Record<string, string> = {
    authorization: 'Bearer named-key',
    'content-type': 'application/json',
    'session-id': 'compact-admission-session',
  };
  socket = { remoteAddress: '127.0.0.1', destroy: () => {} };
  httpVersion = '1.1';

  constructor(private readonly body = JSON.stringify({ model: 'gpt-5.6', input: [] })) {
    super();
  }

  start(): void {
    const replay = (): void => process.nextTick(() => {
      this.emit('data', Buffer.from(this.body, 'utf8'));
      this.emit('end');
    });
    if (this.listenerCount('data') > 0 || this.listenerCount('end') > 0) {
      replay();
      return;
    }
    const waitForReader = (event: string | symbol): void => {
      if (event !== 'data' && event !== 'end') return;
      this.removeListener('newListener', waitForReader);
      replay();
    };
    this.on('newListener', waitForReader);
  }
}

class MockResponse extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = '';
  headersSent = false;
  writableEnded = false;
  destroyed = false;

  writeHead(status: number, headers: Record<string, string> = {}): this {
    this.statusCode = status;
    this.headers = { ...this.headers, ...headers };
    this.headersSent = true;
    return this;
  }

  write(chunk: string | Uint8Array): boolean {
    this.body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }

  end(chunk?: string | Uint8Array): void {
    if (chunk) this.write(chunk);
    this.writableEnded = true;
  }
}

const keyRow: OutboundKeyDbRow = {
  id: 'oak_compact',
  name: 'compact key',
  keyHash: '',
  keyPrefix: 'sk-omnicross-',
  enabled: true,
  createdAt: Date.now(),
  lastUsedAt: null,
  revokedAt: null,
  kind: 'integration',
  loopbackOnly: true,
  allowedEndpoints: ['responses'],
};

const binding: GatewayBinding = {
  id: 'responses-compact-native',
  name: 'Native Responses',
  enabled: true,
  keyScope: 'selected',
  apiKeyIds: [keyRow.id],
  endpoint: 'responses',
  target: { kind: 'provider', providerId: 'openai-native' },
  priority: 10,
  fallback: 'fail',
  modelMode: 'passthrough',
};

function makeDb(row: OutboundKeyDbRow | null): OutboundKeyDb {
  return {
    outboundApiKeysList: async () => [],
    outboundApiKeysGetByHash: async () => row,
    outboundApiKeysCreate: async () => keyRow,
    outboundApiKeysRevoke: async () => true,
    outboundApiKeysTouchLastUsed: async () => true,
    outboundApiKeysSetEnabled: async () => true,
    outboundApiKeysSetMaxConcurrency: async () => true,
    outboundApiKeysSetPolicy: async () => true,
    outboundApiKeysMarkActivated: async () => true,
    outboundApiKeysReveal: async () => null,
    outboundApiKeysDelete: async () => true,
  };
}

function makeDeps(row: OutboundKeyDbRow, bindings: GatewayBinding[] = [binding]): {
  deps: OutboundApiDeps;
  routeMap: ProviderProxyRouteMap;
  registry: OpenAIOperationRegistry;
  dispose: () => void;
  config: { endpoints: never[]; bindings: GatewayBinding[] };
} {
  const routeMap = new ProviderProxyRouteMap();
  const registry = new OpenAIOperationRegistry();
  const dispose = registerResponsesCompactOperation(registry);
  const llmConfig = {
    getProvider: async () => ({
      id: 'openai-native',
      name: 'OpenAI native',
      apiFormat: 'openai-response',
      api_base_url: 'https://upstream.example/prefix/v1',
      api_key: 'test-upstream-key',
      models: ['gpt-5.6'],
      enabled: true,
    }),
    resolveTransformerChain: vi.fn(),
    getMainTransformer: vi.fn(),
    getTransformerService: vi.fn(() => ({ getTransformer: vi.fn() })),
  };
  return {
    routeMap,
    registry,
    dispose,
    config: { endpoints: [], bindings },
    deps: {
      db: makeDb(row),
      llmConfig: llmConfig as unknown as OutboundApiDeps['llmConfig'],
      providerProxy: { getRouteMap: () => routeMap } as unknown as OutboundApiDeps['providerProxy'],
      proxyDeps: {
        llmConfig,
        openAIOperationRegistry: registry,
      } as unknown as OutboundApiDeps['proxyDeps'],
    },
  };
}

async function dispatch(
  deps: OutboundApiDeps,
  config: { endpoints: never[]; bindings: GatewayBinding[] },
  gate = new OutboundConcurrencyGate(),
): Promise<MockResponse> {
  return startDispatch(deps, config, gate).completed;
}

function startDispatch(
  deps: OutboundApiDeps,
  config: { endpoints: never[]; bindings: GatewayBinding[] },
  gate = new OutboundConcurrencyGate(),
): { request: MockRequest; response: MockResponse; completed: Promise<MockResponse> } {
  const request = new MockRequest();
  const response = new MockResponse();
  request.start();
  const completed = handleOutboundRequest(
    request as unknown as http.IncomingMessage,
    response as unknown as http.ServerResponse,
    deps,
    config,
    new OutboundRateLimiter(),
    new UserMessageSerialQueue(),
    gate,
  ).then(() => response);
  return { request, response, completed };
}

describe('responses.compact outbound admission', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('admits an authorized named key through its selected Responses binding', async () => {
    const upstream = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://upstream.example/prefix/v1/responses/compact');
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'gpt-5.6', input: [] });
      return new Response(JSON.stringify({ object: 'response.compaction', output: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', upstream);
    const { deps, config, routeMap, dispose } = makeDeps(keyRow);
    try {
      const response = await dispatch(deps, config);
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ object: 'response.compaction', output: [] });
      expect(upstream).toHaveBeenCalledOnce();
      expect(routeMap.size()).toBe(0);
    } finally {
      dispose();
    }
  });

  it('keeps delayed upstream work alive after replay EOF and cancels only on downstream disconnect', async () => {
    let upstreamSignal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const upstream = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      upstreamSignal = init?.signal as AbortSignal | undefined;
      markStarted();
      return new Promise<Response>((_resolve, reject) => {
        upstreamSignal?.addEventListener('abort', () => reject(upstreamSignal?.reason), { once: true });
      });
    });
    vi.stubGlobal('fetch', upstream);
    const { deps, config, routeMap, dispose } = makeDeps(keyRow);
    try {
      const { response, completed } = startDispatch(deps, config);
      await started;
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(upstreamSignal?.aborted).toBe(false);
      expect(routeMap.size()).toBe(1);

      response.destroyed = true;
      response.emit('close');
      await completed;

      expect(upstreamSignal?.aborted).toBe(true);
      expect(routeMap.size()).toBe(0);
    } finally {
      dispose();
    }
  });

  it('rejects a named key without a matching binding before upstream I/O', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const { deps, config, dispose } = makeDeps(
      { ...keyRow, id: 'oak_other' },
      [binding],
    );
    try {
      const response = await dispatch(deps, config);
      expect(response.statusCode).toBe(503);
      expect(upstream).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it('applies named-key cost quota before compact dispatch', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const { deps, config, dispose } = makeDeps({ ...keyRow, dailyCostLimitUsd: 1 });
    deps.keySpendTracker = {
      getSpend: async () => ({
        dailyUsd: 2,
        dailyWindowStart: 0,
        weeklyUsd: 2,
        weeklyWindowStart: 0,
        totalUsd: 2,
      }),
    };
    try {
      const response = await dispatch(deps, config);
      expect(response.statusCode).toBe(402);
      expect(upstream).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it('queues concurrent compact calls per named key and releases every slot', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const handler = vi.fn(async ({ response }: { response: http.ServerResponse }) => {
      if (handler.mock.calls.length === 1) await firstGate;
      response.writeHead(204);
      response.end();
    });
    const gate = new OutboundConcurrencyGate();
    const { deps, config, registry, dispose } = makeDeps({ ...keyRow, maxConcurrency: 1 });
    dispose();
    const disposeHandler = registry.register('responses.compact', handler);
    try {
      const first = dispatch(deps, config, gate);
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
      const second = dispatch(deps, config, gate);
      await vi.waitFor(() => {
        expect(gate.getStatus()).toEqual([{ apiKeyId: keyRow.id, active: 1, waiting: 1 }]);
      });
      expect(handler).toHaveBeenCalledTimes(1);
      releaseFirst();
      const responses = await Promise.all([first, second]);
      expect(responses.map((response) => response.statusCode)).toEqual([204, 204]);
      expect(handler).toHaveBeenCalledTimes(2);
      expect(gate.getStatus()).toEqual([]);
    } finally {
      disposeHandler();
    }
  });
});
