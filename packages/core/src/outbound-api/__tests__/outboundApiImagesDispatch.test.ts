import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { Readable } from 'node:stream';

import {
  OpenAIOperationRegistry,
  unsupportedOpenAIOperation,
} from '../../openai-operation';
import {
  createImageApiContributions,
  DEFAULT_IMAGE_API_LIMITS,
  type ImageApiRuntime,
} from '../../image-generation';
import type { AuditConfig, AuditRecord } from '@omnicross/contracts/audit-types';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __resetAuditSinkForTests,
  setAuditCaptureConfig,
  setAuditSink,
} from '../../pipeline/auditSink';
import { handleOutboundRequest } from '../outboundApiRouter';
import { OutboundConcurrencyGate } from '../outboundConcurrencyGate';
import { OutboundRateLimiter } from '../outboundRateLimiter';
import type {
  OutboundApiDeps,
  OutboundKeyDb,
  OutboundKeyDbRow,
  OutboundPermission,
} from '../types';
import { UserMessageSerialQueue } from '../userMessageSerialQueue';

class ChunkedRequest extends Readable {
  method = 'POST';
  url: string;
  headers: http.IncomingHttpHeaders;
  socket = { remoteAddress: '127.0.0.1', destroy: () => undefined };
  httpVersion = '1.1';
  complete = true;
  aborted = false;
  pushedChunks = 0;
  readonly #chunks: Buffer[];

  constructor(options: {
    url: string;
    chunks?: readonly string[];
    headers?: http.IncomingHttpHeaders;
    remoteAddress?: string;
  }) {
    super();
    this.url = options.url;
    this.headers = { authorization: 'Bearer external-secret', ...options.headers };
    this.socket.remoteAddress = options.remoteAddress ?? '127.0.0.1';
    this.#chunks = (options.chunks ?? ['never-read']).map((chunk) => Buffer.from(chunk, 'utf8'));
  }

  override _read(): void {
    const chunk = this.#chunks.shift();
    if (!chunk) {
      this.push(null);
      return;
    }
    this.pushedChunks += 1;
    this.push(chunk);
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

  end(chunk?: string | Buffer): void {
    if (chunk) this.body += chunk.toString();
    this.writableEnded = true;
  }
}

const BASE_ROW: OutboundKeyDbRow = {
  id: 'oak_images',
  name: 'images key',
  keyHash: 'ignored-by-test-db',
  keyPrefix: 'sk-omnicross-',
  enabled: true,
  createdAt: 1,
  lastUsedAt: null,
  revokedAt: null,
  allowedEndpoints: ['images'],
};

const BODY_CAPTURE_AUDIT_CONFIG: AuditConfig = {
  enabled: true,
  captureBodies: true,
  maxBodyBytes: -1,
  retentionDays: 7,
  compactStreamingBodies: false,
  trustForwardedFor: false,
};

afterEach(() => __resetAuditSinkForTests());

function keyRow(allowedEndpoints?: OutboundPermission[]): OutboundKeyDbRow {
  return {
    ...BASE_ROW,
    ...(allowedEndpoints === undefined ? { allowedEndpoints: undefined } : { allowedEndpoints }),
  };
}

function makeDb(row: OutboundKeyDbRow | null): OutboundKeyDb {
  return {
    outboundApiKeysList: async () => row ? [row] : [],
    outboundApiKeysGetByHash: async () => row,
    outboundApiKeysCreate: async () => BASE_ROW,
    outboundApiKeysRevoke: async () => true,
    outboundApiKeysTouchLastUsed: async () => true,
    outboundApiKeysSetEnabled: async () => true,
    outboundApiKeysSetPermissions: async () => true,
    outboundApiKeysSetMaxConcurrency: async () => true,
    outboundApiKeysSetPolicy: async () => true,
    outboundApiKeysMarkActivated: async () => true,
    outboundApiKeysReveal: async () => null,
    outboundApiKeysDelete: async () => true,
  };
}

interface RouterHarness {
  readonly deps: OutboundApiDeps;
  readonly getRouteMap: ReturnType<typeof vi.fn>;
  readonly getSpend: ReturnType<typeof vi.fn>;
  readonly concurrencyAcquire: ReturnType<typeof vi.fn>;
  readonly serialAcquire: ReturnType<typeof vi.fn>;
}

function harness(
  row: OutboundKeyDbRow | null,
  registry?: OpenAIOperationRegistry,
): RouterHarness {
  const getRouteMap = vi.fn(() => { throw new Error('text route fallback reached'); });
  const getSpend = vi.fn(async () => ({ dailyUsd: 0, weeklyUsd: 0, totalUsd: 0 }));
  const concurrencyAcquire = vi.fn(() => { throw new Error('generic concurrency reached'); });
  const serialAcquire = vi.fn(() => { throw new Error('text serial queue reached'); });
  const proxyDeps = {
    llmConfig: {},
    openAIOperationRegistry: registry,
  } as unknown as OutboundApiDeps['proxyDeps'];
  return {
    deps: {
      db: makeDb(row),
      llmConfig: {} as OutboundApiDeps['llmConfig'],
      providerProxy: { getRouteMap } as unknown as OutboundApiDeps['providerProxy'],
      proxyDeps,
      keySpendTracker: { getSpend },
    },
    getRouteMap,
    getSpend,
    concurrencyAcquire,
    serialAcquire,
  };
}

async function execute(
  request: ChunkedRequest,
  target: RouterHarness,
): Promise<MockResponse> {
  const response = new MockResponse();
  await handleOutboundRequest(
    request as unknown as http.IncomingMessage,
    response as unknown as http.ServerResponse,
    target.deps,
    { endpoints: [], bindings: [] },
    new OutboundRateLimiter(),
    { acquire: target.serialAcquire } as unknown as UserMessageSerialQueue,
    { acquire: target.concurrencyAcquire } as unknown as OutboundConcurrencyGate,
  );
  return response;
}

function expectNoTextSideEffects(target: RouterHarness): void {
  expect(target.getRouteMap).not.toHaveBeenCalled();
  expect(target.getSpend).not.toHaveBeenCalled();
  expect(target.concurrencyAcquire).not.toHaveBeenCalled();
  expect(target.serialAcquire).not.toHaveBeenCalled();
}

describe('outbound Images own-body dispatch', () => {
  it('audits authorized Images metadata without retaining JSON, Base64, or SSE bodies', async () => {
    setAuditCaptureConfig(BODY_CAPTURE_AUDIT_CONFIG);
    const seen: AuditRecord[] = [];
    setAuditSink((record) => seen.push(record));
    const registry = new OpenAIOperationRegistry();
    registry.register('images.generate', async (context) => {
      for await (const _chunk of context.request) {
        // Consume the original stream; audit suppression must remain structural.
      }
      context.response.writeHead(200, { 'content-type': 'text/event-stream' });
      context.response.end('data: {"b64_json":"SSE-BASE64-RESPONSE-SENTINEL"}\n\n');
    });
    const target = harness(keyRow(['images']), registry);
    const request = new ChunkedRequest({
      url: '/v1/images/generations?private=query-sentinel',
      chunks: [
        '{"prompt":"JSON-PROMPT-SENTINEL",',
        '"image":"data:image/png;base64,REQUEST-BASE64-SENTINEL"}',
      ],
      headers: { 'content-type': 'application/json' },
    });

    const response = await execute(request, target);
    response.emit('close');

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: 'POST',
      path: '/v1/images/generations',
      status: 200,
      keyId: 'oak_images',
    });
    expect(seen[0]?.requestBody).toBeUndefined();
    expect(seen[0]?.responseBody).toBeUndefined();
    expect(seen[0]?.hasBody).toBeUndefined();
    const serialized = JSON.stringify(seen[0]);
    expect(serialized).not.toContain('JSON-PROMPT-SENTINEL');
    expect(serialized).not.toContain('REQUEST-BASE64-SENTINEL');
    expect(serialized).not.toContain('SSE-BASE64-RESPONSE-SENTINEL');
    expect(serialized).not.toContain('query-sentinel');
  });

  it('audits rejected Images metadata without retaining multipart or error bodies', async () => {
    setAuditCaptureConfig(BODY_CAPTURE_AUDIT_CONFIG);
    const seen: AuditRecord[] = [];
    setAuditSink((record) => seen.push(record));
    const target = harness(null, new OpenAIOperationRegistry());
    const request = new ChunkedRequest({
      url: '/v1/images/edits',
      chunks: [
        '--boundary\r\nContent-Disposition: form-data; name="image"; filename="PRIVATE-FILENAME-SENTINEL.png"\r\n\r\n',
        'MULTIPART-IMAGE-SENTINEL\r\n--boundary--\r\n',
      ],
      headers: { 'content-type': 'multipart/form-data; boundary=boundary' },
    });
    delete request.headers['authorization'];

    const response = await execute(request, target);
    response.emit('close');

    expect(response.statusCode).toBe(401);
    expect(request.pushedChunks).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: 'POST',
      path: '/v1/images/edits',
      status: 401,
    });
    expect(seen[0]?.requestBody).toBeUndefined();
    expect(seen[0]?.responseBody).toBeUndefined();
    expect(seen[0]?.hasBody).toBeUndefined();
    const serialized = JSON.stringify(seen[0]);
    expect(serialized).not.toContain('PRIVATE-FILENAME-SENTINEL');
    expect(serialized).not.toContain('MULTIPART-IMAGE-SENTINEL');
    expect(serialized).not.toContain('Invalid or missing API key');
  });

  it('passes the original JSON stream through the stable generate contribution with trusted identity', async () => {
    const registry = new OpenAIOperationRegistry();
    const body = ['{"prompt":', '"paint a fox"}'];
    const request = new ChunkedRequest({
      url: '/v1/images/generations',
      chunks: body,
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'duplicate-external-secret',
        'x-goog-api-key': 'duplicate-google-secret',
      },
    });
    const handler = vi.fn(async (context) => {
      expect(context.request).toBe(request);
      expect(request.pushedChunks).toBe(0);
      expect(context.request.headers['authorization']).toBeUndefined();
      expect(context.request.headers['x-api-key']).toBeUndefined();
      expect(context.request.headers['x-goog-api-key']).toBeUndefined();
      expect(context.route).toMatchObject({
        apiKeyId: 'oak_images',
        sessionId: 'outbound:images:oak_images',
      });
      const observed: Buffer[] = [];
      for await (const chunk of context.request) observed.push(Buffer.from(chunk));
      expect(Buffer.concat(observed).toString('utf8')).toBe(body.join(''));
      context.response.writeHead(200, { 'Content-Type': 'application/json' });
      context.response.end('{"ok":true}');
    });
    registry.register('images.generate', handler);
    const target = harness({
      ...keyRow(['images']),
      maxConcurrency: 1,
      dailyCostLimitUsd: 1,
    }, registry);

    const response = await execute(request, target);
    expect(response.statusCode).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
    expectNoTextSideEffects(target);
  });

  it('preserves ordered chunked multipart bytes and backpressure for edit dispatch', async () => {
    const registry = new OpenAIOperationRegistry();
    const chunks = [
      '--boundary\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n',
      'retouch\r\n--boundary\r\nContent-Disposition: form-data; name="image"; filename="x.png"\r\n',
      'Content-Type: image/png\r\n\r\nPNG-BYTES\r\n--boundary--\r\n',
    ];
    const request = new ChunkedRequest({
      url: '/v1/images/edits',
      chunks,
      headers: { 'content-type': 'multipart/form-data; boundary=boundary' },
    });
    const handler = vi.fn(async (context) => {
      expect(context.request).toBe(request);
      expect(request.pushedChunks).toBe(0);
      const observed: Buffer[] = [];
      for await (const chunk of context.request) observed.push(Buffer.from(chunk));
      expect(Buffer.concat(observed).toString('utf8')).toBe(chunks.join(''));
      context.response.writeHead(200);
      context.response.end();
    });
    registry.register('images.edit', handler);
    const target = harness(keyRow(['images']), registry);

    const response = await execute(request, target);
    expect(response.statusCode).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
    expectNoTextSideEffects(target);
  });

  it.each([
    ['missing key', null, {}, '127.0.0.1', 401],
    ['invalid key', null, { authorization: 'Bearer invalid' }, '127.0.0.1', 401],
    ['loopback violation', { ...keyRow(['images']), loopbackOnly: true }, {}, '192.168.1.20', 403],
    ['Responses-only key', keyRow(['responses']), {}, '127.0.0.1', 403],
    ['legacy key', keyRow(undefined), {}, '127.0.0.1', 403],
  ] as const)(
    'rejects %s before consuming the body or entering runtime/text work',
    async (_label, row, headers, remoteAddress, status) => {
      const registry = new OpenAIOperationRegistry();
      const runtimeHandler = vi.fn(async () => undefined);
      registry.register('images.generate', runtimeHandler);
      const target = harness(row, registry);
      const request = new ChunkedRequest({
        url: '/v1/images/generations',
        headers,
        remoteAddress,
      });
      if (_label === 'missing key') delete request.headers['authorization'];

      const response = await execute(request, target);
      expect(response.statusCode).toBe(status);
      expect(request.pushedChunks).toBe(0);
      expect(runtimeHandler).not.toHaveBeenCalled();
      expectNoTextSideEffects(target);
    },
  );

  it('fails closed without a registered handler and never falls through to text ingress', async () => {
    const registry = new OpenAIOperationRegistry();
    const target = harness(keyRow(['images']), registry);
    const request = new ChunkedRequest({ url: '/v1/images/generations' });

    const response = await execute(request, target);
    expect(response.statusCode).toBe(501);
    expect(response.body).toContain('unsupported_capability');
    expect(request.pushedChunks).toBe(0);
    expectNoTextSideEffects(target);
  });

  it('fails closed through a disabled stable runtime handler without consuming the body', async () => {
    const registry = new OpenAIOperationRegistry();
    const disabled = vi.fn(async (context) => {
      throw unsupportedOpenAIOperation(context.operation);
    });
    registry.register('images.generate', disabled);
    const target = harness(keyRow(['images']), registry);
    const request = new ChunkedRequest({ url: '/v1/images/generations' });

    const response = await execute(request, target);
    expect(response.statusCode).toBe(501);
    expect(response.body).toContain('unsupported_capability');
    expect(request.pushedChunks).toBe(0);
    expect(disabled).toHaveBeenCalledOnce();
    expectNoTextSideEffects(target);
  });

  it('lets the real contribution reject an oversized multipart declaration before bytes/provider work', async () => {
    const registry = new OpenAIOperationRegistry();
    const providerRun = vi.fn(() => { throw new Error('provider must not run'); });
    const materialize = vi.fn();
    const cleanup = vi.fn(async () => undefined);
    const runtime: ImageApiRuntime = {
      tenantId: 'tenant',
      providerId: 'codex-subscription',
      defaultModel: 'gpt-image-2',
      modelAliases: new Map(),
      limits: DEFAULT_IMAGE_API_LIMITS,
    };
    const contributions = createImageApiContributions({
      orchestrator: { run: providerRun } as never,
      resolveRuntime: () => runtime,
      createResourceScope: async () => ({ materialize, cleanup }) as never,
    });
    registry.register(contributions.edit.operationId, contributions.edit.handler);
    const target = harness(keyRow(['images']), registry);
    const request = new ChunkedRequest({
      url: '/v1/images/edits',
      headers: {
        'content-type': 'multipart/form-data; boundary=boundary',
        'content-length': String(DEFAULT_IMAGE_API_LIMITS.maxMultipartBytes + 1),
      },
    });

    const response = await execute(request, target);
    expect(response.statusCode).toBe(413);
    expect(response.body).toContain('image_too_large');
    expect(request.pushedChunks).toBe(0);
    expect(materialize).not.toHaveBeenCalled();
    expect(providerRun).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
    expectNoTextSideEffects(target);
  });

  it('rejects unknown Images-like routes without dispatch, body reads, or text fallback', async () => {
    const registry = new OpenAIOperationRegistry();
    const runtimeHandler = vi.fn(async () => undefined);
    registry.register('images.generate', runtimeHandler);
    const target = harness(keyRow(['images']), registry);
    const request = new ChunkedRequest({ url: '/v1/images/variations' });

    const response = await execute(request, target);
    expect(response.statusCode).toBe(404);
    expect(request.pushedChunks).toBe(0);
    expect(runtimeHandler).not.toHaveBeenCalled();
    expectNoTextSideEffects(target);
  });
});
