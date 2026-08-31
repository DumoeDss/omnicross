import { EventEmitter } from 'node:events';
import type http from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuditConfig, AuditRecord } from '@omnicross/contracts/audit-types';

import {
  __resetAuditSinkForTests,
  setAuditCaptureConfig,
  setAuditSink,
} from '../../pipeline/auditSink';
import { ProviderProxyRouteMap } from '../../provider-proxy/providerProxyRouteMap';
import { legacyEndpointsToBindings } from '../apiServerConfig';
import { handleOutboundRequest } from '../outboundApiRouter';
import { OutboundConcurrencyGate } from '../outboundConcurrencyGate';
import { OutboundRateLimiter } from '../outboundRateLimiter';
import type { OutboundApiDeps, OutboundKeyDb, OutboundKeyDbRow } from '../types';
import { UserMessageSerialQueue } from '../userMessageSerialQueue';

vi.mock('../../provider-proxy/providerProxyRouter', () => ({
  routeRequest: vi.fn(async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    routes: ProviderProxyRouteMap,
  ) => {
    let raw = '';
    for await (const chunk of req) raw += Buffer.from(chunk).toString('utf8');
    const body = JSON.parse(raw) as Record<string, unknown>;
    const auth = String(req.headers.authorization ?? '');
    const route = routes.lookup(auth.replace(/^Bearer\s+/i, ''));
    const hostedImage = Array.isArray(body.tools) && body.tools.some((tool) => (
      !!tool && typeof tool === 'object' &&
      (tool as Record<string, unknown>).type === 'image_generation'
    ));
    if (hostedImage) {
      route?.suppressAuditBodies?.();
      const { stashAuditUsage } = await import('../../pipeline/auditUsageStash');
      stashAuditUsage(res, {
        inputTokens: 13,
        outputTokens: 8,
        costUsd: 0.004,
        model: 'gpt-5.6-sol',
        provider: 'openai',
      });
    }
    if (hostedImage && body.stream === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: response.image_generation_call.partial_image\n');
      res.write('data: {"partial_image_b64":"AUDIT-PARTIAL-BASE64-SENTINEL"}\n\n');
      res.end('data: {"type":"response.completed","result":"AUDIT-FINAL-BASE64-SENTINEL"}\n\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(hostedImage
      ? '{"result":"AUDIT-FINAL-BASE64-SENTINEL"}'
      : '{"output":"ordinary-audit-response"}');
  }),
}));

class MockReq extends EventEmitter {
  method = 'POST';
  url = '/v1/responses';
  headers: Record<string, string> = { authorization: 'Bearer test' };
  socket = { remoteAddress: '127.0.0.1', destroy: () => {} };
  httpVersion = '1.1';

  constructor(private readonly body: Record<string, unknown> = {
    model: 'gpt-5.6-sol',
    input: 'hello',
  }) {
    super();
  }

  start(): void {
    process.nextTick(() => {
      this.emit('data', Buffer.from(JSON.stringify(this.body), 'utf8'));
      this.emit('end');
    });
  }
}

class MockRes extends EventEmitter {
  statusCode = 0;
  headersSent = false;

  writeHead(status: number): this {
    this.statusCode = status;
    this.headersSent = true;
    return this;
  }

  write(_chunk?: unknown): boolean {
    return true;
  }

  end(_chunk?: unknown): this {
    this.emit('close');
    return this;
  }
}

const baseRow: OutboundKeyDbRow = {
  id: 'oak_hosted_images',
  name: 'hosted images route test',
  keyHash: '',
  keyPrefix: 'sk-omnicross-',
  enabled: true,
  createdAt: 1,
  lastUsedAt: null,
  revokedAt: null,
};

function db(row: OutboundKeyDbRow): OutboundKeyDb {
  return {
    outboundApiKeysList: async () => [],
    outboundApiKeysGetByHash: async () => row,
    outboundApiKeysCreate: async () => row,
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

const config = {
  endpoints: [],
  bindings: legacyEndpointsToBindings([{
    endpoint: 'responses' as const,
    modelMap: { codex: 'openai,gpt-5.6-sol' },
    useSubscription: false,
  }]),
};

const auditConfig: AuditConfig = {
  enabled: true,
  captureBodies: true,
  maxBodyBytes: -1,
  retentionDays: 7,
  compactStreamingBodies: false,
  trustForwardedFor: false,
};

async function mintedRouteFor(
  row: OutboundKeyDbRow,
  body?: Record<string, unknown>,
) {
  const routeMap = new ProviderProxyRouteMap();
  const addRoute = vi.spyOn(routeMap, 'addRoute');
  const deps = {
    db: db(row),
    llmConfig: {
      getProvider: async () => ({
        id: 'openai',
        api_key: 'sk-upstream',
        api_base_url: 'https://upstream.invalid/v1',
        models: ['gpt-5.6-sol'],
        enabled: true,
      }),
    },
    providerProxy: { getRouteMap: () => routeMap },
    proxyDeps: {},
  } as unknown as OutboundApiDeps;
  const req = new MockReq(body);
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
  expect(res.statusCode).toBe(200);
  expect(addRoute).toHaveBeenCalledTimes(1);
  return addRoute.mock.calls[0][0];
}

afterEach(() => __resetAuditSinkForTests());

describe('handleOutboundRequest — hosted image permission projection', () => {
  it('projects false for a Responses-only key', async () => {
    const route = await mintedRouteFor({
      ...baseRow,
      kind: 'integration',
      loopbackOnly: true,
      allowedEndpoints: ['responses'],
    });
    expect(route.hostedImageGenerationAllowed).toBe(false);
  });

  it('projects true only when the key explicitly grants Responses and Images', async () => {
    const route = await mintedRouteFor({
      ...baseRow,
      kind: 'integration',
      loopbackOnly: true,
      allowedEndpoints: ['responses', 'images'],
    });
    expect(route.hostedImageGenerationAllowed).toBe(true);
  });

  it('does not grant hosted Images to a legacy text-permission row', async () => {
    const route = await mintedRouteFor({ ...baseRow, allowedEndpoints: undefined });
    expect(route.hostedImageGenerationAllowed).toBe(false);
  });
});

describe('handleOutboundRequest — hosted image audit suppression', () => {
  it.each([
    ['JSON', false],
    ['SSE', true],
  ] as const)('never persists admitted hosted-image %s bodies', async (_label, stream) => {
    setAuditCaptureConfig(auditConfig);
    const seen: AuditRecord[] = [];
    setAuditSink((record) => seen.push(record));

    await mintedRouteFor({
      ...baseRow,
      kind: 'integration',
      loopbackOnly: true,
      allowedEndpoints: ['responses', 'images'],
    }, {
      model: 'gpt-5.6-sol',
      input: 'AUDIT-PRIVATE-PROMPT-SENTINEL',
      stream,
      tools: [{ type: 'image_generation' }],
      tool_choice: { type: 'image_generation' },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      keyId: 'oak_hosted_images',
      model: 'gpt-5.6-sol',
      provider: 'openai',
      inputTokens: 13,
      outputTokens: 8,
      costUsd: 0.004,
      status: 200,
    });
    expect(seen[0]?.requestBody).toBeUndefined();
    expect(seen[0]?.responseBody).toBeUndefined();
    expect(seen[0]?.hasBody).toBeUndefined();
    const serialized = JSON.stringify(seen[0]);
    expect(serialized).not.toContain('AUDIT-PRIVATE-PROMPT-SENTINEL');
    expect(serialized).not.toContain('AUDIT-PARTIAL-BASE64-SENTINEL');
    expect(serialized).not.toContain('AUDIT-FINAL-BASE64-SENTINEL');
  });

  it('preserves captureBodies behavior for an ordinary Responses request', async () => {
    setAuditCaptureConfig(auditConfig);
    const seen: AuditRecord[] = [];
    setAuditSink((record) => seen.push(record));

    await mintedRouteFor({
      ...baseRow,
      kind: 'integration',
      loopbackOnly: true,
      allowedEndpoints: ['responses', 'images'],
    }, {
      model: 'gpt-5.6-sol',
      input: 'ORDINARY-AUDIT-PROMPT',
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.hasBody).toBe(true);
    expect(seen[0]?.requestBody).toContain('ORDINARY-AUDIT-PROMPT');
    expect(seen[0]?.responseBody).toContain('ordinary-audit-response');
  });
});
