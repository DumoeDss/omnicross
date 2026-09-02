/**
 * `POST /v1/alpha/search` at the ROUTER level.
 *
 * Two things only this level can prove: that the route is detected before the
 * generic 404 fallthrough while every other unknown route still gets it, and
 * that a dispatched request now carries a `sessionKey` — the missing link that
 * caused all 11 baselined `/v1/alpha/search` bodies to be dropped
 * (`AuditWriter.appendBody` discards a body with no session key, wire baseline
 * §1.2). The response shape itself is UNVERIFIED against Codex and is asserted
 * as Omnicross's own emission in `searchRoute.test.ts`.
 *
 * @module outbound-api/__tests__/outboundApiSearchDispatch.test
 */

import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { Readable } from 'node:stream';

import type { AuditConfig, AuditRecord } from '@omnicross/contracts/audit-types';
import type { OrchestratedSearchResponse } from '@omnicross/contracts/search-types';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __resetAuditSinkForTests,
  setAuditCaptureConfig,
  setAuditSink,
} from '../../pipeline/auditSink';
import { normalizeSearchServerConfig } from '../searchServerConfig';
import type { SearchRuntime } from '../../search/runtime';
import { handleOutboundRequest } from '../outboundApiRouter';
import { OutboundConcurrencyGate } from '../outboundConcurrencyGate';
import { OutboundRateLimiter } from '../outboundRateLimiter';
import type { OutboundApiDeps, OutboundKeyDb, OutboundKeyDbRow } from '../types';
import { UserMessageSerialQueue } from '../userMessageSerialQueue';

class BodyRequest extends Readable {
  method = 'POST';
  url: string;
  headers: http.IncomingHttpHeaders;
  socket = { remoteAddress: '127.0.0.1', destroy: () => undefined };
  httpVersion = '1.1';
  complete = true;
  aborted = false;
  readonly #chunks: Buffer[];

  constructor(url: string, body: string) {
    super();
    this.url = url;
    this.headers = { authorization: 'Bearer external-secret' };
    this.#chunks = [Buffer.from(body, 'utf8')];
  }

  override _read(): void {
    const chunk = this.#chunks.shift();
    this.push(chunk ?? null);
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

  write(chunk: string | Buffer): boolean {
    this.body += chunk.toString();
    return true;
  }

  end(chunk?: string | Buffer): void {
    if (chunk) this.body += chunk.toString();
    this.writableEnded = true;
    this.emit('close');
  }
}

const KEY_ROW: OutboundKeyDbRow = {
  id: 'oak_search',
  name: 'search key',
  keyHash: 'ignored-by-test-db',
  keyPrefix: 'sk-omnicross-',
  enabled: true,
  createdAt: 1,
  lastUsedAt: null,
  revokedAt: null,
  allowedEndpoints: ['responses'],
};

const BODY_CAPTURE_AUDIT_CONFIG: AuditConfig = {
  enabled: true,
  captureBodies: true,
  maxBodyBytes: -1,
  retentionDays: 7,
  compactStreamingBodies: false,
  trustForwardedFor: false,
};

function makeDb(): OutboundKeyDb {
  return {
    outboundApiKeysList: async () => [KEY_ROW],
    outboundApiKeysGetByHash: async () => KEY_ROW,
    outboundApiKeysCreate: async () => KEY_ROW,
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

function stubRuntime(): SearchRuntime {
  const response: OrchestratedSearchResponse = {
    query: 'q',
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

function deps(runtime?: SearchRuntime): OutboundApiDeps {
  return {
    db: makeDb(),
    llmConfig: {} as OutboundApiDeps['llmConfig'],
    providerProxy: {
      getRouteMap: vi.fn(() => {
        throw new Error('text route fallback reached');
      }),
    } as unknown as OutboundApiDeps['providerProxy'],
    proxyDeps: { llmConfig: {} } as unknown as OutboundApiDeps['proxyDeps'],
    ...(runtime ? { searchRuntime: runtime } : {}),
  };
}

async function execute(
  request: BodyRequest,
  target: OutboundApiDeps,
  search?: ReturnType<typeof normalizeSearchServerConfig>,
): Promise<MockResponse> {
  const response = new MockResponse();
  await handleOutboundRequest(
    request as unknown as http.IncomingMessage,
    response as unknown as http.ServerResponse,
    target,
    { endpoints: [], bindings: [], ...(search ? { search } : {}) },
    new OutboundRateLimiter(),
    {
      acquire: vi.fn(() => {
        throw new Error('serial queue reached');
      }),
    } as unknown as UserMessageSerialQueue,
    {
      acquire: vi.fn(() => {
        throw new Error('concurrency gate reached');
      }),
    } as unknown as OutboundConcurrencyGate,
  );
  return response;
}

afterEach(() => __resetAuditSinkForTests());

describe('POST /v1/alpha/search routing', () => {
  it('answers a structured unsupported_capability by default, not the generic 404', async () => {
    const runtime = stubRuntime();
    const response = await execute(
      new BodyRequest('/v1/alpha/search', JSON.stringify({ query: 'q' })),
      deps(runtime),
    );

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
    expect(response.body).toContain('unsupported_capability');
    expect(response.body).not.toContain('Unsupported: POST');
    expect(runtime.search).not.toHaveBeenCalled();
  });

  it('leaves the generic 404 in place for every other unknown route', async () => {
    const response = await execute(
      new BodyRequest('/v1/alpha/somethingelse', '{}'),
      deps(stubRuntime()),
    );

    expect(response.statusCode).toBe(404);
    expect(response.body).toContain('Unsupported: POST /v1/alpha/somethingelse');
  });

  it('executes through the shared runtime when the codex mode is managed', async () => {
    const runtime = stubRuntime();
    const response = await execute(
      new BodyRequest('/v1/alpha/search', JSON.stringify({ query: 'q' })),
      deps(runtime),
      normalizeSearchServerConfig({ modes: { codex: 'managed' } }),
    );

    expect(response.statusCode).toBe(200);
    expect(runtime.search).toHaveBeenCalledTimes(1);
    expect(JSON.parse(response.body)).toMatchObject({ provider: 'http-bing' });
  });
});

describe('audit body capture becomes possible on the new route', () => {
  it('records a session key, unlike the 11 baselined 404 records that had none', async () => {
    setAuditCaptureConfig(BODY_CAPTURE_AUDIT_CONFIG);
    const seen: AuditRecord[] = [];
    setAuditSink((record) => seen.push(record));

    await execute(
      new BodyRequest('/v1/alpha/search', JSON.stringify({ query: 'q' })),
      deps(stubRuntime()),
      normalizeSearchServerConfig({ modes: { codex: 'managed' } }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const record = seen.find((entry) => entry.path === '/v1/alpha/search');
    expect(record).toBeDefined();
    // The exact fact `AuditWriter.appendBody` requires before it will persist
    // a body at all. Without it the body is dropped and the metadata line still
    // claims `hasBody: true` — the 阶段0 capture gap, now closed.
    expect(record?.sessionKey).toBeTruthy();
    expect(record?.requestBody).toContain('"query"');
  });

  it('assigns no session key when the route is off, because nothing is dispatched', async () => {
    setAuditCaptureConfig(BODY_CAPTURE_AUDIT_CONFIG);
    const seen: AuditRecord[] = [];
    setAuditSink((record) => seen.push(record));

    await execute(
      new BodyRequest('/v1/alpha/search', JSON.stringify({ query: 'q' })),
      deps(stubRuntime()),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const record = seen.find((entry) => entry.path === '/v1/alpha/search');
    expect(record).toBeDefined();
    expect(record?.sessionKey).toBeUndefined();
  });
});
