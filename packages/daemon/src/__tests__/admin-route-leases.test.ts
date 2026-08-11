import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ROUTE_LEASE_CAPABILITIES,
  ROUTE_LEASE_REQUEST_SCHEMA,
  RouteLeaseError,
  type RouteLeaseManager,
} from '@omnicross/core/provider-proxy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleRouteLeaseApi } from '../admin/routeLeaseApi';
import { buildDaemon, type Daemon, resetDaemonSingletonsForTests } from '../bootstrap';
import { loadConfig } from '../config';
import { IntegrationManager } from '../integrations';

const ADMIN_TOKEN = 'admin-route-lease-control-token';
const ANTHROPIC_KEY = 'sk-anthropic-upstream-canary';
const CODEX_KEY = 'sk-codex-upstream-canary';
const RAW_SESSION = 'raw-route-lease-session-canary';

interface UpstreamState {
  readonly server: Server;
  readonly baseUrl: string;
  hits: number;
  lastUrl?: string;
  lastHeaders?: Record<string, string | string[] | undefined>;
  lastBody?: Record<string, unknown>;
}

function startUpstream(kind: 'anthropic' | 'codex'): Promise<UpstreamState> {
  const state = {} as UpstreamState;
  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      state.hits += 1;
      state.lastUrl = req.url;
      state.lastHeaders = { ...req.headers };
      state.lastBody = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (kind === 'anthropic') {
        res.end(JSON.stringify({
          id: 'msg_route_lease',
          type: 'message',
          role: 'assistant',
          model: 'claude-frozen',
          content: [{ type: 'text', text: 'claude-ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 2, output_tokens: 1 },
        }));
      } else {
        res.end(JSON.stringify({
          id: 'resp_route_lease',
          object: 'response',
          status: 'completed',
          model: 'codex-frozen',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'codex-ok' }] }],
          usage: { input_tokens: 2, output_tokens: 1 },
        }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      Object.assign(state, {
        server,
        baseUrl: `http://127.0.0.1:${port}`,
        hits: 0,
      });
      resolve(state);
    });
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

interface HttpResult {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  readonly json: unknown;
}

let tmpDir = '';
let configPath = '';
let daemon: Daemon | undefined;
let adminBase = '';
let anthropic: UpstreamState;
let codex: UpstreamState;
let openerCalls = 0;

function createBody(
  runtime: 'claude' | 'codex',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: ROUTE_LEASE_REQUEST_SCHEMA,
    consumer: 'rasen',
    runtime,
    upstream: {
      kind: 'provider',
      providerId: runtime === 'claude' ? 'anthropic-route' : 'codex-route',
    },
    model: runtime === 'claude' ? 'claude-frozen' : 'codex-frozen',
    execution: {
      runId: 'run-1',
      stageId: runtime === 'claude' ? 'plan' : 'apply',
      attempt: 1,
      sessionId: RAW_SESSION,
    },
    ttlSeconds: 30,
    ...overrides,
  };
}

async function adminFetch(
  method: string,
  path: string,
  options: {
    body?: unknown;
    idempotencyKey?: string;
    authorized?: boolean;
  } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = {};
  if (options.authorized !== false) headers.Authorization = `Bearer ${ADMIN_TOKEN}`;
  if (options.idempotencyKey !== undefined) headers['Idempotency-Key'] = options.idempotencyKey;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${adminBase}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* test reports raw text */ }
  return { status: response.status, headers: response.headers, text, json };
}

function writeConfig(): void {
  writeFileSync(configPath, JSON.stringify({
    providers: [
      {
        id: 'anthropic-route',
        apiFormat: 'anthropic',
        baseUrl: anthropic.baseUrl,
        apiKey: ANTHROPIC_KEY,
        models: ['claude-frozen'],
      },
      {
        id: 'codex-route',
        apiFormat: 'openai-response',
        baseUrl: codex.baseUrl,
        apiKey: CODEX_KEY,
        models: ['codex-frozen'],
      },
    ],
    admin: { port: 0, token: ADMIN_TOKEN },
  }, null, 2), 'utf8');
}

async function boot(): Promise<void> {
  writeConfig();
  daemon = buildDaemon(loadConfig(configPath), {
    configPath,
    keysPath: join(tmpDir, 'keys.json'),
    tokensPath: join(tmpDir, 'tokens.json'),
    masterKeyFilePath: join(tmpDir, 'master.key'),
    cliTerminalOpener: () => { openerCalls += 1; },
  });
  await daemon.llmConfig.ready();
  await daemon.providerProxy.start();
  await daemon.adminServer.start();
  adminBase = daemon.adminServer.getStatus().url as string;
}

beforeEach(async () => {
  resetDaemonSingletonsForTests();
  openerCalls = 0;
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-route-lease-'));
  configPath = join(tmpDir, 'config.json');
  [anthropic, codex] = await Promise.all([startUpstream('anthropic'), startUpstream('codex')]);
  await boot();
});

afterEach(async () => {
  if (daemon) {
    await daemon.adminServer.stop();
    await daemon.providerProxy.stop();
    daemon.apiKeyPool.dispose();
    daemon.tokenRefreshScheduler.dispose();
    daemon.claudeAllowanceRefreshScheduler.dispose();
    daemon.accountHealthSweeper.dispose();
    daemon.accountHealthProbeScheduler.dispose();
    daemon.auditPruneSweeper.dispose();
    daemon.billingRetrySweeper.dispose();
    daemon.pricingRefreshScheduler.dispose();
  }
  await Promise.all([stopServer(anthropic.server), stopServer(codex.server)]);
  resetDaemonSingletonsForTests();
  vi.restoreAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
  daemon = undefined;
});

describe('Admin Route Lease API', () => {
  it('enforces Admin auth and returns the exact authenticated capabilities document', async () => {
    const unauthorized = await adminFetch('GET', '/admin/api/route-leases/capabilities', {
      authorized: false,
    });
    expect(unauthorized.status).toBe(401);
    expect(daemon?.routeLeaseManager.activeCount()).toBe(0);

    const capabilities = await adminFetch('GET', '/admin/api/route-leases/capabilities');
    expect(capabilities.status).toBe(200);
    expect(capabilities.json).toEqual(ROUTE_LEASE_CAPABILITIES);
    expect(capabilities.text).not.toContain(ADMIN_TOKEN);
  });

  it('supports create replay, list/get/renew/delete, redaction, and persistent-store non-pollution', async () => {
    const integrationInstall = vi.spyOn(IntegrationManager.prototype, 'install');
    const configBefore = readFileSync(configPath);
    const first = await adminFetch('POST', '/admin/api/route-leases', {
      body: createBody('codex'),
      idempotencyKey: 'rasen:run-1:apply:1',
    });
    expect(first.status).toBe(201);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const created = first.json as {
      leaseId: string;
      launch: { env: Record<string, string>; extraArgs: string[] };
    };
    const routeToken = created.launch.env.OMNICROSS_CODEX_ROUTE_TOKEN;
    expect(routeToken).toMatch(/^[0-9a-f]{64}$/u);
    expect(created.launch.env.OPENAI_API_KEY).toBeUndefined();

    const replay = await adminFetch('POST', '/admin/api/route-leases', {
      body: createBody('codex'),
      idempotencyKey: 'rasen:run-1:apply:1',
    });
    expect(replay.status).toBe(200);
    expect(replay.headers.get('cache-control')).toBe('no-store');
    expect(replay.json).toEqual(first.json);
    expect(daemon?.providerProxy.routeCount()).toBe(1);

    const conflict = await adminFetch('POST', '/admin/api/route-leases', {
      body: createBody('codex', { model: 'different-model' }),
      idempotencyKey: 'rasen:run-1:apply:1',
    });
    expect(conflict.status).toBe(409);
    expect(conflict.json).toMatchObject({ error: { type: 'route_lease_error', code: 'idempotency_conflict', retryable: false } });

    const list = await adminFetch('GET', '/admin/api/route-leases');
    const get = await adminFetch('GET', `/admin/api/route-leases/${created.leaseId}`);
    for (const projection of [list, get]) {
      expect(projection.status).toBe(200);
      expect(projection.text).not.toContain(routeToken);
      expect(projection.text).not.toContain(CODEX_KEY);
      expect(projection.text).not.toContain(RAW_SESSION);
      expect(projection.text).not.toContain('rasen:run-1:apply:1');
    }

    const renewed = await adminFetch('POST', `/admin/api/route-leases/${created.leaseId}/renew`, {
      body: { ttlSeconds: 45 },
    });
    expect(renewed.status).toBe(200);
    expect(renewed.headers.get('cache-control')).toBe('no-store');
    expect(renewed.text).not.toContain(routeToken);
    expect(renewed.json).toMatchObject({ leaseId: created.leaseId, status: 'active' });

    const released = await adminFetch('DELETE', `/admin/api/route-leases/${created.leaseId}`);
    const releasedAgain = await adminFetch('DELETE', `/admin/api/route-leases/${created.leaseId}`);
    expect(released.json).toEqual({ leaseId: created.leaseId, released: true });
    expect(releasedAgain.json).toEqual({ leaseId: created.leaseId, released: false });
    expect(daemon?.providerProxy.routeCount()).toBe(0);
    expect(readFileSync(configPath)).toEqual(configBefore);
    expect(openerCalls).toBe(0);
    expect(integrationInstall).not.toHaveBeenCalled();
  });

  it('returns safe unknown and expired lease behavior without reviving authority', async () => {
    const unknownGet = await adminFetch('GET', '/admin/api/route-leases/00000000-0000-4000-8000-000000000000');
    const unknownDelete = await adminFetch('DELETE', '/admin/api/route-leases/00000000-0000-4000-8000-000000000000');
    expect(unknownGet.status).toBe(404);
    expect(unknownGet.json).toMatchObject({ error: { code: 'lease_not_found' } });
    expect(unknownDelete.status).toBe(200);
    expect(unknownDelete.json).toEqual({
      leaseId: '00000000-0000-4000-8000-000000000000',
      released: false,
    });

    const created = await adminFetch('POST', '/admin/api/route-leases', {
      body: createBody('codex', { ttlSeconds: 1 }),
      idempotencyKey: 'expiry-behavior',
    });
    expect(created.status).toBe(201);
    const result = created.json as {
      leaseId: string;
      launch: { env: Record<string, string> };
    };
    const oldToken = result.launch.env.OMNICROSS_CODEX_ROUTE_TOKEN;
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const expiredGet = await adminFetch('GET', `/admin/api/route-leases/${result.leaseId}`);
    const expiredRenew = await adminFetch('POST', `/admin/api/route-leases/${result.leaseId}/renew`, {
      body: { ttlSeconds: 30 },
    });
    expect(expiredGet.status).toBe(200);
    expect(expiredGet.json).toMatchObject({ leaseId: result.leaseId, status: 'expired' });
    expect(expiredGet.text).not.toContain(oldToken);
    expect(expiredRenew.status).toBe(410);
    expect(expiredRenew.headers.get('cache-control')).toBe('no-store');
    expect(expiredRenew.json).toMatchObject({ error: { code: 'lease_expired', retryable: false } });

    const malformedCreate = await fetch(`${adminBase}/admin/api/route-leases`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'malformed-create',
      },
      body: '{',
    });
    expect(malformedCreate.status).toBe(400);
    expect(malformedCreate.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects unsupported schema, header, body, field, union, and TTL shapes at their documented boundary', async () => {
    const cases: Array<{
      name: string;
      body: Record<string, unknown>;
      key?: string;
      code?: string;
    }> = [
      { name: 'missing idempotency key', body: createBody('claude'), key: undefined },
      { name: 'unsupported schema', body: createBody('claude', { schemaVersion: 'omnicross.route-lease.request/2' }), key: 'schema-v2' },
      { name: 'overlong idempotency key', body: createBody('claude'), key: 'x'.repeat(257) },
      { name: 'unsafe idempotency key', body: createBody('claude'), key: 'contains spaces' },
      { name: 'overlong consumer', body: createBody('claude', { consumer: 'x'.repeat(65) }), key: 'consumer-limit' },
      { name: 'unsupported runtime', body: createBody('claude', { runtime: 'future-runtime' }), key: 'runtime-limit', code: 'runtime_unsupported' },
      { name: 'unknown upstream kind', body: createBody('claude', { upstream: { kind: 'future', providerId: 'anthropic-route' } }), key: 'kind-limit' },
      { name: 'missing account id', body: createBody('claude', { upstream: { kind: 'account', providerId: 'claude' } }), key: 'account-limit' },
      { name: 'missing group', body: createBody('claude', { upstream: { kind: 'account-group', providerId: 'claude' } }), key: 'group-limit' },
      { name: 'missing model', body: createBody('claude', { model: undefined }), key: 'model-missing', code: 'model_not_configured' },
      { name: 'blank model', body: createBody('claude', { model: '   ' }), key: 'model-blank', code: 'model_not_configured' },
      { name: 'overlong model', body: createBody('claude', { model: 'x'.repeat(257) }), key: 'model-limit' },
      { name: 'overlong run id', body: createBody('claude', { execution: { runId: 'x'.repeat(129) } }), key: 'run-limit' },
      { name: 'overlong stage id', body: createBody('claude', { execution: { stageId: 'x'.repeat(129) } }), key: 'stage-limit' },
      { name: 'overlong session id', body: createBody('claude', { execution: { sessionId: 'x'.repeat(513) } }), key: 'session-limit' },
      { name: 'invalid attempt', body: createBody('claude', { execution: { attempt: 0 } }), key: 'attempt-limit' },
      { name: 'TTL below minimum', body: createBody('claude', { ttlSeconds: 0 }), key: 'ttl-low' },
      { name: 'TTL above maximum', body: createBody('claude', { ttlSeconds: 3601 }), key: 'ttl-high' },
    ];
    for (const testCase of cases) {
      const response = await adminFetch('POST', '/admin/api/route-leases', {
        body: testCase.body,
        idempotencyKey: testCase.key,
      });
      expect(response.status, testCase.name).toBe(400);
      expect(response.json, testCase.name).toMatchObject({
        error: { code: testCase.code ?? 'invalid_request', retryable: false },
      });
    }

    const oversizedResponse = await fetch(`${adminBase}/admin/api/route-leases`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'oversized-body',
      },
      body: JSON.stringify({ padding: 'x'.repeat(65 * 1024) }),
    });
    expect(oversizedResponse.status).toBe(400);
    await expect(oversizedResponse.json()).resolves.toMatchObject({
      error: { code: 'invalid_request' },
    });
    expect(daemon?.routeLeaseManager.activeCount()).toBe(0);
  });

  it('bounds Retry-After from typed pool exhaustion without serializing unsafe details', async () => {
    const unsafe = 'pool-secret-canary';
    const manager = {
      createFromRequest: vi.fn(async () => {
        throw new RouteLeaseError('upstream_exhausted', 'the selected pool is exhausted', {
          retryAfterSeconds: 99_999,
          cause: new Error(unsafe),
        });
      }),
    } as unknown as RouteLeaseManager;
    const req = {
      method: 'POST',
      headers: { 'idempotency-key': 'safe-key' },
      socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from('{}', 'utf8');
      },
    } as unknown as IncomingMessage;
    const headers = new Map<string, string>();
    let body = '';
    const res = {
      statusCode: 0,
      setHeader: (name: string, value: string) => { headers.set(name.toLowerCase(), value); },
      end: (value: string) => { body = value; },
    } as unknown as ServerResponse;

    await handleRouteLeaseApi(req, res, '/admin/api/route-leases', { routeLeaseManager: manager });

    expect(res.statusCode).toBe(429);
    expect(headers.get('retry-after')).toBe('3600');
    expect(JSON.parse(body)).toMatchObject({
      error: { code: 'upstream_exhausted', retryable: true },
    });
    expect(body).not.toContain(unsafe);
  });

  it('maps safe validation and readiness errors without reflecting unsafe input', async () => {
    const unsafe = 'unsafe\nconsumer-canary';
    const invalid = await adminFetch('POST', '/admin/api/route-leases', {
      body: createBody('claude', { consumer: unsafe }),
      idempotencyKey: 'safe-key',
    });
    expect(invalid.status).toBe(400);
    expect(invalid.json).toMatchObject({ error: { code: 'invalid_request', retryable: false } });
    expect(invalid.text).not.toContain(unsafe);

    const missing = await adminFetch('POST', '/admin/api/route-leases', {
      body: createBody('claude', { upstream: { kind: 'provider', providerId: 'missing-provider' } }),
      idempotencyKey: 'missing-provider-key',
    });
    expect(missing.status).toBe(404);
    expect(missing.json).toMatchObject({ error: { code: 'upstream_not_found', retryable: false } });

    await daemon?.providerProxy.stop();
    const notReady = await adminFetch('POST', '/admin/api/route-leases', {
      body: createBody('claude'),
      idempotencyKey: 'daemon-not-ready',
    });
    expect(notReady.status).toBe(503);
    expect(notReady.headers.get('cache-control')).toBe('no-store');
    expect(notReady.json).toMatchObject({ error: { code: 'daemon_not_ready', retryable: true } });
  });

  it('ignores forwarded loopback headers when the actual socket peer is not loopback', async () => {
    const req = {
      method: 'GET',
      headers: { 'x-forwarded-for': '127.0.0.1', forwarded: 'for=127.0.0.1' },
      socket: { remoteAddress: '203.0.113.8' },
    } as unknown as IncomingMessage;
    const headers = new Map<string, string>();
    let body = '';
    const res = {
      statusCode: 0,
      setHeader: (name: string, value: string) => { headers.set(name.toLowerCase(), value); },
      end: (value: string) => { body = value; },
    } as unknown as ServerResponse;

    await handleRouteLeaseApi(req, res, '/admin/api/route-leases/capabilities', {
      routeLeaseManager: daemon?.routeLeaseManager,
    });

    expect(res.statusCode).toBe(403);
    expect(headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(body)).toMatchObject({ error: { code: 'control_unauthorized' } });
  });
});

describe('leased resident proxy integration', () => {
  async function create(runtime: 'claude' | 'codex') {
    const response = await adminFetch('POST', '/admin/api/route-leases', {
      body: createBody(runtime),
      idempotencyKey: `proxy:${runtime}:1`,
    });
    expect(response.status).toBe(201);
    return response.json as {
      leaseId: string;
      launch: { env: Record<string, string>; extraArgs: string[] };
    };
  }

  it('isolates Claude/Codex routes, freezes models, re-authenticates upstream, and invalidates only the released token', async () => {
    const claude = await create('claude');
    const codexLease = await create('codex');
    const claudeToken = claude.launch.env.ANTHROPIC_AUTH_TOKEN;
    const codexToken = codexLease.launch.env.OMNICROSS_CODEX_ROUTE_TOKEN;
    const proxyBase = daemon?.providerProxy.getBaseUrl() as string;

    const callClaude = () => fetch(`${proxyBase}/v1/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${claudeToken}`,
        'x-api-key': 'downstream-claude-sentinel',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'client-must-not-reroute',
        max_tokens: 8,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    const callCodex = () => fetch(`${proxyBase}/openai/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${codexToken}`,
        'x-api-key': 'downstream-codex-sentinel',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'client-must-not-reroute', input: 'ping' }),
    });

    const [claudeResponse, codexResponse] = await Promise.all([callClaude(), callCodex()]);
    expect(claudeResponse.status).toBe(200);
    expect(codexResponse.status).toBe(200);
    expect(anthropic.hits).toBe(1);
    expect(codex.hits).toBe(1);
    expect(anthropic.lastBody?.model).toBe('claude-frozen');
    expect(codex.lastBody?.model).toBe('codex-frozen');
    expect(anthropic.lastHeaders?.['x-api-key']).toBe(ANTHROPIC_KEY);
    expect(codex.lastHeaders?.authorization).toBe(`Bearer ${CODEX_KEY}`);
    expect(JSON.stringify(anthropic.lastHeaders)).not.toContain(claudeToken);
    expect(JSON.stringify(codex.lastHeaders)).not.toContain(codexToken);
    expect(JSON.stringify(anthropic.lastHeaders)).not.toContain('downstream-claude-sentinel');
    expect(JSON.stringify(codex.lastHeaders)).not.toContain('downstream-codex-sentinel');

    const renewClaude = await adminFetch('POST', `/admin/api/route-leases/${claude.leaseId}/renew`, { body: { ttlSeconds: 60 } });
    const renewCodex = await adminFetch('POST', `/admin/api/route-leases/${codexLease.leaseId}/renew`, { body: { ttlSeconds: 60 } });
    expect(renewClaude.status).toBe(200);
    expect(renewCodex.status).toBe(200);

    expect((await adminFetch('DELETE', `/admin/api/route-leases/${claude.leaseId}`)).status).toBe(200);
    expect((await callClaude()).status).toBe(401);
    expect((await callCodex()).status).toBe(200);
    expect(codex.hits).toBe(2);
    expect(daemon?.providerProxy.routeCount()).toBe(1);

    expect((await adminFetch('DELETE', `/admin/api/route-leases/${codexLease.leaseId}`)).status).toBe(200);
    expect((await callCodex()).status).toBe(401);
    expect(daemon?.providerProxy.routeCount()).toBe(0);
  });
});
