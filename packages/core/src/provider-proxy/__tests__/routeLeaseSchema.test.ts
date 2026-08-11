import { describe, expect, it } from 'vitest';

import {
  canonicalizeRouteLeasePayload,
  hashRouteLeasePayload,
  parseRouteLeaseCreate,
  ROUTE_LEASE_CAPABILITIES,
  ROUTE_LEASE_REQUEST_SCHEMA,
  routeLeaseRuntime,
} from '../routeLeaseSchema';

const request = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: ROUTE_LEASE_REQUEST_SCHEMA,
  consumer: 'rasen',
  runtime: 'codex',
  upstream: { kind: 'provider', providerId: 'p1' },
  model: 'm1',
  execution: { runId: 'run-1', stageId: 'apply', attempt: 1, sessionId: 'raw-session-canary' },
  ...overrides,
});

describe('Route Lease schema and safe projections', () => {
  it('normalizes defaults and hashes the raw session with domain separation', () => {
    const parsed = parseRouteLeaseCreate(request(), 'rasen:run-1:apply:1', new Uint8Array(32).fill(7));
    expect(parsed.request.ttlSeconds).toBe(600);
    expect(parsed.request.execution?.sessionIdHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(parsed.request)).not.toContain('raw-session-canary');
    expect(JSON.stringify(parsed.request)).not.toContain('rasen:run-1:apply:1');
  });

  it('canonicalizes object keys recursively and keeps payload-sensitive fields', () => {
    expect(canonicalizeRouteLeasePayload({ b: 2, a: { y: 2, x: 1 } }))
      .toBe(canonicalizeRouteLeasePayload({ a: { x: 1, y: 2 }, b: 2 }));
    expect(hashRouteLeasePayload(request())).not.toBe(hashRouteLeasePayload(request({ model: 'm2' })));
  });

  it.each([
    ['bad key', request(), 'has spaces'],
    ['control consumer', request({ consumer: 'bad\nconsumer' }), 'safe-key'],
    ['overlong run id', request({ execution: { runId: 'x'.repeat(129) } }), 'safe-key'],
    ['overlong session id', request({ execution: { sessionId: 'x'.repeat(513) } }), 'safe-key'],
    ['ttl low', request({ ttlSeconds: 0 }), 'safe-key'],
    ['ttl high', request({ ttlSeconds: 3601 }), 'safe-key'],
  ])('rejects %s without echoing unsafe input', (_name, body, key) => {
    expect(() => parseRouteLeaseCreate(body, key)).toThrow();
    try { parseRouteLeaseCreate(body, key); } catch (error) {
      expect(String(error)).not.toContain('bad\nconsumer');
      expect(String(error)).not.toContain('has spaces');
    }
  });

  it('uses an exhaustive runtime table and exact capability document', () => {
    expect(routeLeaseRuntime('claude')).toEqual({ endpoint: 'messages', ingressFormat: 'anthropic-messages', wirePath: '/v1/messages' });
    expect(routeLeaseRuntime('codex')).toEqual({ endpoint: 'responses', ingressFormat: 'openai-responses', wirePath: '/openai/responses' });
    expect(ROUTE_LEASE_CAPABILITIES).toEqual({
      schemaVersion: 'omnicross.route-lease.capabilities/1',
      runtimes: ['claude', 'codex'],
      upstreamKinds: ['provider', 'account', 'account-group', 'account-pool'],
      leaseApiVersion: 1,
      codexAuthMode: 'env_key',
      maxTtlSeconds: 3600,
    });
  });
});
