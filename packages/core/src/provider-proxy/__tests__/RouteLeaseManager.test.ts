import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';

import type { RouteContext } from '../types';
import {
  RouteLeaseManager,
  type RouteLeaseClock,
  type RouteLeaseRoutePort,
} from '../RouteLeaseManager';
import { ROUTE_LEASE_REQUEST_SCHEMA, RouteLeaseError } from '../routeLeaseSchema';

class FakeClock implements RouteLeaseClock {
  time = Date.parse('2026-08-11T00:00:00.000Z');
  private next = 1;
  private timers = new Map<number, { at: number; callback: () => void }>();
  now = () => this.time;
  setTimeout = (callback: () => void, delayMs: number): unknown => {
    const id = this.next++;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return id;
  };
  clearTimeout = (handle: unknown): void => { this.timers.delete(handle as number); };
  advance(ms: number): void {
    this.time += ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= this.time).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      due[1].callback();
    }
  }
}

class FakeRoutes implements RouteLeaseRoutePort {
  readonly routes = new Map<string, { route: RouteContext; options: any; idleMs?: number }>();
  removeThrowsFor = new Set<string>();
  ready = true;
  isReady = () => this.ready;
  getBaseUrl = () => 'http://127.0.0.1:8766';
  addRoute = (route: RouteContext, options?: any): string => {
    const token = randomBytes(32).toString('hex');
    this.routes.set(token, { route, options });
    return token;
  };
  renewRoute = (token: string, idleMs?: number): boolean => {
    const entry = this.routes.get(token);
    if (!entry) return false;
    entry.idleMs = idleMs;
    return true;
  };
  removeRoute = (token: string): boolean => {
    if (this.removeThrowsFor.has(token)) throw new Error('canary-secret-never-log');
    const entry = this.routes.get(token);
    if (!entry) return false;
    this.routes.delete(token);
    entry.options?.onEvicted?.('removed');
    return true;
  };
  activity(token: string, at: number): void { this.routes.get(token)?.options?.onActivity?.(at); }
  idleEvict(token: string): void {
    const entry = this.routes.get(token);
    if (!entry) return;
    this.routes.delete(token);
    entry.options?.onEvicted?.('idle');
  }
}

const raw = (key: string, overrides: Record<string, unknown> = {}) => ({
  key,
  body: {
    schemaVersion: ROUTE_LEASE_REQUEST_SCHEMA,
    consumer: 'rasen',
    runtime: 'codex',
    upstream: { kind: 'provider', providerId: 'p1' },
    model: 'm1',
    ttlSeconds: 10,
    ...overrides,
  },
});

function makeManager(options: { afterPublish?: () => void; tombstoneMaxCount?: number } = {}) {
  const clock = new FakeClock();
  const routes = new FakeRoutes();
  const resolver = { resolve: vi.fn(async (request: any): Promise<RouteContext> => ({
    sessionId: null,
    targetProviderFormat: 'openai-responses',
    model: request.model,
    ingressFormat: request.runtime === 'codex' ? 'openai-responses' : 'anthropic-messages',
    authMode: 'byo',
    providerId: request.upstream.providerId,
  })) };
  const descriptors = {
    has: () => true,
    build: (_runtime: any, input: any) => ({ env: { TOKEN_CANARY: input.routeToken }, extraArgs: ['-c', 'safe=true'] }),
  };
  const manager = new RouteLeaseManager(routes, resolver, descriptors, { clock, hmacKey: new Uint8Array(32), ...options });
  return { manager, clock, routes, resolver };
}

describe('RouteLeaseManager lifecycle', () => {
  it('replays same/same, conflicts same/different, and recreates after release', async () => {
    const { manager, routes, resolver } = makeManager();
    const input = raw('same-key');
    const first = await manager.createFromRequest(input.body, input.key);
    const replay = await manager.createFromRequest({ ...input.body, upstream: { providerId: 'p1', kind: 'provider' } }, input.key);
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.result).toEqual(first.result);
    expect(routes.routes.size).toBe(1);
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    await expect(manager.createFromRequest({ ...input.body, model: 'm2' }, input.key))
      .rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(manager.release(first.result.leaseId)).toEqual({ leaseId: first.result.leaseId, released: true });
    expect(manager.release(first.result.leaseId).released).toBe(false);
    const recreated = await manager.createFromRequest(input.body, input.key);
    expect(recreated.result.leaseId).not.toBe(first.result.leaseId);
  });

  it('rolls back a create whose pending resolver loses to shutdown', async () => {
    const clock = new FakeClock();
    const routes = new FakeRoutes();
    let releaseResolver!: (route: RouteContext) => void;
    const resolver = {
      resolve: vi.fn(() => new Promise<RouteContext>((resolve) => { releaseResolver = resolve; })),
    };
    const manager = new RouteLeaseManager(routes, resolver, {
      has: () => true,
      build: (_runtime, input) => ({ env: { TOKEN_CANARY: input.routeToken }, extraArgs: [] }),
    }, { clock });

    const pending = manager.createFromRequest(raw('shutdown-race').body, 'shutdown-race');
    await vi.waitFor(() => expect(resolver.resolve).toHaveBeenCalledTimes(1));
    manager.shutdown();
    releaseResolver({
      sessionId: null,
      targetProviderFormat: 'openai-responses',
      model: 'm1',
      ingressFormat: 'openai-responses',
      authMode: 'byo',
      providerId: 'p1',
    });

    await expect(pending).rejects.toMatchObject({ code: 'daemon_not_ready' });
    expect(manager.activeCount()).toBe(0);
    expect(routes.routes.size).toBe(0);
  });

  it('coalesces concurrent same/same creates and conflicts a concurrent different payload', async () => {

    const { manager, routes, resolver } = makeManager();
    const input = raw('concurrent-key');
    const [first, replay] = await Promise.all([
      manager.createFromRequest(input.body, input.key),
      manager.createFromRequest(input.body, input.key),
    ]);
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.result).toEqual(first.result);
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    expect(routes.routes.size).toBe(1);

    const next = raw('conflict-key');
    const pending = manager.createFromRequest(next.body, next.key);
    await expect(manager.createFromRequest({ ...next.body, model: 'other' }, next.key))
      .rejects.toMatchObject({ code: 'idempotency_conflict' });
    await pending;
  });

  it('renews the same token, records activity, and expires absolutely', async () => {
    const { manager, clock, routes } = makeManager();
    const input = raw('ttl-key');
    const created = await manager.createFromRequest(input.body, input.key);
    const token = created.result.launch.env.TOKEN_CANARY;
    clock.advance(5_000);
    routes.activity(token, clock.now());
    expect(manager.get(created.result.leaseId).lastActivityAt).toBe(new Date(clock.now()).toISOString());
    const renewed = manager.renew(created.result.leaseId, 20);
    expect(routes.routes.has(token)).toBe(true);
    expect(routes.routes.get(token)?.idleMs).toBe(20_000);
    expect(renewed.expiresAt).toBe(new Date(clock.now() + 20_000).toISOString());
    clock.advance(20_000);
    expect(routes.routes.has(token)).toBe(false);
    expect(manager.get(created.result.leaseId).status).toBe('expired');
    expect(() => manager.renew(created.result.leaseId, 10)).toThrow(RouteLeaseError);
  });

  it('handles route-idle callbacks, rollback, bounded tombstones, and restart-empty state', async () => {
    const setup = makeManager({ tombstoneMaxCount: 2 });
    const first = await setup.manager.createFromRequest(raw('a').body, 'a');
    setup.routes.idleEvict(first.result.launch.env.TOKEN_CANARY);
    expect(setup.manager.get(first.result.leaseId).status).toBe('expired');
    for (const key of ['b', 'c', 'd']) {
      const made = await setup.manager.createFromRequest(raw(key).body, key);
      setup.manager.release(made.result.leaseId);
    }
    expect(setup.manager.list().filter((entry) => entry.status !== 'active')).toHaveLength(2);
    const fresh = makeManager().manager;
    expect(() => fresh.get(first.result.leaseId)).toThrow();

    const failing = makeManager({ afterPublish: () => { throw new Error('publish failed'); } });
    await expect(failing.manager.createFromRequest(raw('rollback').body, 'rollback')).rejects.toThrow();
    expect(failing.routes.routes.size).toBe(0);
    expect(failing.manager.activeCount()).toBe(0);
  });

  it('isolates 32 mixed leases and removes only their own route', async () => {
    const { manager, routes } = makeManager();
    const leases = await Promise.all(Array.from({ length: 32 }, (_, index) => manager.createFromRequest({
      ...raw(`k${index}`).body,
      runtime: index % 2 ? 'claude' : 'codex',
      model: `m${index}`,
    }, `k${index}`)));
    expect(new Set(leases.map((entry) => entry.result.leaseId)).size).toBe(32);
    expect(new Set(leases.map((entry) => entry.result.launch.env.TOKEN_CANARY)).size).toBe(32);
    expect(routes.routes.size).toBe(32);
    manager.release(leases[0].result.leaseId);
    expect(routes.routes.size).toBe(31);
    expect(manager.get(leases[1].result.leaseId).status).toBe('active');
  });

  it('drops every secret-bearing active result at terminal transition and continues shutdown cleanup', async () => {
    const warnings: unknown[] = [];
    const clock = new FakeClock();
    const routes = new FakeRoutes();
    const manager = new RouteLeaseManager(routes, { resolve: async () => ({
      sessionId: null, targetProviderFormat: 'openai-responses', model: 'm', ingressFormat: 'openai-responses', authMode: 'byo', providerId: 'p',
    }) }, { has: () => true, build: (_runtime, input) => ({ env: { SECRET: input.routeToken }, extraArgs: [] }) }, {
      clock,
      logger: { warn: (_message, meta) => warnings.push(meta) },
    });
    const a = await manager.createFromRequest(raw('shutdown-a').body, 'shutdown-a');
    const b = await manager.createFromRequest(raw('shutdown-b').body, 'shutdown-b');
    routes.removeThrowsFor.add(a.result.launch.env.SECRET);
    manager.shutdown();
    expect(manager.activeCount()).toBe(0);
    expect(routes.routes.has(b.result.launch.env.SECRET)).toBe(false);
    const serialized = JSON.stringify(manager.list());
    expect(serialized).not.toContain(a.result.launch.env.SECRET);
    expect(serialized).not.toContain(b.result.launch.env.SECRET);
    expect(JSON.stringify(warnings)).not.toContain('canary-secret-never-log');
  });

  it('keeps ready-resident create, renew, and release P95 below 100 ms without proxy restart', async () => {
    const { manager, routes } = makeManager();
    const baseUrl = routes.getBaseUrl();
    const createMs: number[] = [];
    const renewMs: number[] = [];
    const releaseMs: number[] = [];

    for (let index = 0; index < 69; index += 1) {
      let started = performance.now();
      const created = await manager.createFromRequest(raw(`benchmark-${index}`).body, `benchmark-${index}`);
      const createdMs = performance.now() - started;

      started = performance.now();
      manager.renew(created.result.leaseId, 30);
      const renewedMs = performance.now() - started;

      started = performance.now();
      manager.release(created.result.leaseId);
      const releasedMs = performance.now() - started;

      // Five warm-up rounds are intentionally excluded from the sample.
      if (index >= 5) {
        createMs.push(createdMs);
        renewMs.push(renewedMs);
        releaseMs.push(releasedMs);
      }
    }

    const p95 = (samples: number[]): number => {
      const sorted = [...samples].sort((left, right) => left - right);
      return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
    };
    const measurements = {
      createP95Ms: p95(createMs),
      renewP95Ms: p95(renewMs),
      releaseP95Ms: p95(releaseMs),
    };

    expect(measurements.createP95Ms).toBeLessThan(100);
    expect(measurements.renewP95Ms).toBeLessThan(100);
    expect(measurements.releaseP95Ms).toBeLessThan(100);
    expect(routes.getBaseUrl()).toBe(baseUrl);
    expect(routes.routes.size).toBe(0);
    expect(manager.activeCount()).toBe(0);
  });
});
