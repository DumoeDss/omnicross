/**
 * The `endpoint` lease runtime and the `endpoint` result field are opt-in:
 * a manager built without `endpointRuntime` / `exposeEndpoint` (the daemon's
 * HTTP lease API) behaves exactly as before, while an embedded host's manager
 * accepts `runtime: 'endpoint'` with an explicit wire and returns
 * `{ baseUrl, token, wire }` on every lease.
 */

import { randomBytes } from 'node:crypto';
import type http from 'node:http';
import { describe, expect, it } from 'vitest';

import { RouteLeaseManager, type RouteLeaseRoutePort } from '../RouteLeaseManager';
import { resolveRouteToken } from '../providerProxyRouter';
import {
  parseRouteLeaseCreate,
  ROUTE_LEASE_REQUEST_SCHEMA,
  type NormalizedRouteLeaseRequest,
  type RouteLeaseDescriptorPort,
} from '../routeLeaseSchema';
import type { RouteContext } from '../types';

class Routes implements RouteLeaseRoutePort {
  readonly routes = new Map<string, RouteContext>();
  isReady = () => true;
  getBaseUrl = () => 'http://127.0.0.1:4100';
  addRoute = (route: RouteContext): string => {
    const token = randomBytes(16).toString('hex');
    this.routes.set(token, route);
    return token;
  };
  renewRoute = (token: string) => this.routes.has(token);
  removeRoute = (token: string) => this.routes.delete(token);
}

const descriptors: RouteLeaseDescriptorPort = {
  has: (runtime) => runtime === 'claude' || runtime === 'codex',
  build: (_runtime, input) => ({ env: { TOKEN: input.routeToken }, extraArgs: [] }),
};

function resolverRecording(seen: NormalizedRouteLeaseRequest[]) {
  return {
    async resolve(request: NormalizedRouteLeaseRequest): Promise<RouteContext> {
      seen.push(request);
      return { providerId: 'p1', model: request.model, authMode: 'byo' } as unknown as RouteContext;
    },
  };
}

const body = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: ROUTE_LEASE_REQUEST_SCHEMA,
  consumer: 'host',
  runtime: 'endpoint',
  wire: 'openai-chat',
  upstream: { kind: 'provider', providerId: 'p1' },
  model: 'm1',
  ...overrides,
});

describe('endpoint lease runtime (opt-in)', () => {
  it('default managers reject runtime "endpoint" and add no endpoint field', async () => {
    const manager = new RouteLeaseManager(new Routes(), resolverRecording([]), descriptors);
    await expect(manager.createFromRequest(body(), 'k1')).rejects.toMatchObject({ code: 'runtime_unsupported' });
    const { result } = await manager.createFromRequest(body({ runtime: 'claude', wire: undefined }), 'k2');
    expect(result).not.toHaveProperty('endpoint');
    expect(result).not.toHaveProperty('wire');
  });

  it('default parsing ignores a wire field entirely (unchanged HTTP contract)', () => {
    const parsed = parseRouteLeaseCreate(body({ runtime: 'codex', wire: 'anthropic-messages' }), 'k');
    expect(parsed.request).not.toHaveProperty('wire');
  });

  it('opted-in managers lease an endpoint with an explicit wire and expose it', async () => {
    const seen: NormalizedRouteLeaseRequest[] = [];
    const routes = new Routes();
    const manager = new RouteLeaseManager(routes, resolverRecording(seen), descriptors, {
      endpointRuntime: true,
      exposeEndpoint: true,
    });
    const { result } = await manager.createFromRequest(body(), 'e1');
    expect(result.runtime).toBe('endpoint');
    expect(result.wire).toBe('openai-chat');
    expect(result.launch).toEqual({ env: {}, extraArgs: [] });
    expect(result.endpoint).toEqual({
      baseUrl: 'http://127.0.0.1:4100/v1',
      token: [...routes.routes.keys()][0],
      wire: 'openai-chat',
    });
    expect(seen[0].wire).toBe('openai-chat');

    const claude = await manager.createFromRequest(body({ runtime: 'claude', wire: undefined }), 'e2');
    expect(claude.result.endpoint).toMatchObject({ baseUrl: 'http://127.0.0.1:4100', wire: 'anthropic-messages' });
    expect(claude.result.launch.env['TOKEN']).toBe(claude.result.endpoint!.token);
  });

  it('opted-in parsing requires a wire for endpoint and a matching one for CLIs', async () => {
    const manager = new RouteLeaseManager(new Routes(), resolverRecording([]), descriptors, { endpointRuntime: true });
    await expect(manager.createFromRequest(body({ wire: undefined }), 'w1')).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(manager.createFromRequest(body({ wire: 'gemini' }), 'w2')).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(manager.createFromRequest(body({ runtime: 'codex', wire: 'openai-chat' }), 'w3')).rejects.toMatchObject({ code: 'invalid_request' });
    // A different wire under the same idempotency key is a different request.
    await manager.createFromRequest(body(), 'same');
    await expect(manager.createFromRequest(body({ wire: 'openai-responses' }), 'same')).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });
});

describe('route token headers', () => {
  const req = (headers: Record<string, string>) => ({ headers } as unknown as http.IncomingMessage);

  it('reads Authorization first, then x-goog-api-key, then x-api-key', () => {
    expect(resolveRouteToken(req({ authorization: 'Bearer a', 'x-goog-api-key': 'g', 'x-api-key': 'x' }))).toBe('a');
    expect(resolveRouteToken(req({ 'x-goog-api-key': 'g', 'x-api-key': 'x' }))).toBe('g');
    expect(resolveRouteToken(req({ 'x-api-key': ' x ' }))).toBe('x');
    expect(resolveRouteToken(req({}))).toBeUndefined();
  });
});
