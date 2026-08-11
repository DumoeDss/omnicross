import { randomBytes, randomUUID } from 'node:crypto';

import type { RouteRegistrationOptions } from './providerProxyRouteMap';
import {
  parseRouteLeaseCreate,
  ROUTE_LEASE_RESULT_SCHEMA,
  RouteLeaseError,
  type NormalizedRouteLeaseCreate,
  type NormalizedRouteLeaseRequest,
  type RouteLeaseCreateResult,
  type RouteLeaseDescriptorPort,
  type RouteLeaseMetadata,
  type RouteLeaseReleaseResult,
  type RouteLeaseRenewResult,
  type RouteLeaseTargetResolverPort,
  type RouteLeaseUpstream,
} from './routeLeaseSchema';
import type { RouteContext } from './types';

export interface RouteLeaseClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const SYSTEM_ROUTE_LEASE_CLOCK: RouteLeaseClock = {
  now: () => Date.now(),
  setTimeout(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  clearTimeout(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

export interface RouteLeaseRoutePort {
  isReady(): boolean;
  getBaseUrl(): string;
  addRoute(context: RouteContext, options?: number | RouteRegistrationOptions): string;
  renewRoute(token: string, idleMs?: number): boolean;
  removeRoute(token: string): boolean;
}

export interface RouteLeaseLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface RouteLeaseManagerOptions {
  readonly clock?: RouteLeaseClock;
  readonly hmacKey?: Uint8Array;
  readonly tombstoneMaxCount?: number;
  readonly tombstoneMaxAgeMs?: number;
  readonly logger?: RouteLeaseLogger;
  /** Test-only fault seam after records are published but before create returns. */
  readonly afterPublish?: () => void;
}

interface ActiveLease {
  readonly leaseId: string;
  readonly routeToken: string;
  readonly idempotencyScope: string;
  readonly payloadHash: string;
  readonly request: NormalizedRouteLeaseRequest;
  readonly route: RouteContext;
  readonly result: RouteLeaseCreateResult;
  metadata: RouteLeaseMetadata;
  expiresAtMs: number;
  timer: unknown;
}

interface IdempotencyRecord {
  readonly leaseId: string;
  readonly payloadHash: string;
}

interface PendingCreate {
  readonly payloadHash: string;
  readonly outcome: Promise<RouteLeaseCreateOutcome>;
}

interface Tombstone {
  readonly metadata: RouteLeaseMetadata;
  readonly terminalAtMs: number;
}

export interface RouteLeaseCreateOutcome {
  readonly created: boolean;
  readonly result: RouteLeaseCreateResult;
}

function cloneUpstream(upstream: RouteLeaseUpstream): RouteLeaseUpstream {
  return { ...upstream };
}

function metadataCopy(metadata: RouteLeaseMetadata): RouteLeaseMetadata {
  return {
    ...metadata,
    upstream: cloneUpstream(metadata.upstream),
    ...(metadata.execution ? { execution: { ...metadata.execution } } : {}),
  };
}

export class RouteLeaseManager {
  private readonly active = new Map<string, ActiveLease>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly pendingCreates = new Map<string, PendingCreate>();
  private readonly tombstones = new Map<string, Tombstone>();
  private readonly clock: RouteLeaseClock;
  private readonly hmacKey: Uint8Array;
  private readonly tombstoneMaxCount: number;
  private readonly tombstoneMaxAgeMs: number;
  private readonly logger?: RouteLeaseLogger;
  private readonly afterPublish?: () => void;
  private closed = false;

  constructor(
    private readonly routePort: RouteLeaseRoutePort,
    private readonly targetResolver: RouteLeaseTargetResolverPort,
    private readonly descriptors: RouteLeaseDescriptorPort,
    options: RouteLeaseManagerOptions = {},
  ) {
    this.clock = options.clock ?? SYSTEM_ROUTE_LEASE_CLOCK;
    this.hmacKey = options.hmacKey ?? randomBytes(32);
    this.tombstoneMaxCount = Math.max(1, options.tombstoneMaxCount ?? 512);
    this.tombstoneMaxAgeMs = Math.max(1, options.tombstoneMaxAgeMs ?? 60 * 60 * 1000);
    this.logger = options.logger;
    this.afterPublish = options.afterPublish;
  }

  parse(raw: unknown, idempotencyKey: unknown): NormalizedRouteLeaseCreate {
    return parseRouteLeaseCreate(raw, idempotencyKey, this.hmacKey);
  }

  async createFromRequest(raw: unknown, idempotencyKey: unknown): Promise<RouteLeaseCreateOutcome> {
    return this.create(this.parse(raw, idempotencyKey));
  }

  async create(input: NormalizedRouteLeaseCreate): Promise<RouteLeaseCreateOutcome> {
    if (this.closed) throw new RouteLeaseError('daemon_not_ready', 'route lease manager is shutting down');
    const request = input.request;
    const scope = `${request.consumer}\0${input.idempotencyKey}`;
    const existing = this.idempotency.get(scope);
    if (existing) {
      const lease = this.active.get(existing.leaseId);
      if (!lease) {
        this.idempotency.delete(scope);
      } else if (existing.payloadHash !== input.payloadHash) {
        throw new RouteLeaseError('idempotency_conflict', 'idempotency key is already used for a different live request');
      } else {
        return { created: false, result: lease.result };
      }
    }

    const pending = this.pendingCreates.get(scope);
    if (pending) {
      if (pending.payloadHash !== input.payloadHash) {
        throw new RouteLeaseError('idempotency_conflict', 'idempotency key is already used for a different live request');
      }
      const outcome = await pending.outcome;
      return { created: false, result: outcome.result };
    }

    const outcome = this.createNew(input, scope);
    const pendingCreate = { payloadHash: input.payloadHash, outcome };
    this.pendingCreates.set(scope, pendingCreate);
    try {
      return await outcome;
    } finally {
      if (this.pendingCreates.get(scope) === pendingCreate) this.pendingCreates.delete(scope);
    }
  }

  private async createNew(
    input: NormalizedRouteLeaseCreate,
    scope: string,
  ): Promise<RouteLeaseCreateOutcome> {
    const request = input.request;

    if (!this.routePort.isReady()) {
      throw new RouteLeaseError('daemon_not_ready', 'resident provider proxy is not ready');
    }
    if (!this.descriptors.has(request.runtime)) {
      throw new RouteLeaseError('runtime_unsupported', 'runtime launch adapter is unavailable');
    }

    const leaseId = randomUUID();
    const resolved = await this.targetResolver.resolve(request);
    this.assertOpen();
    const route: RouteContext = {
      ...resolved,
      sessionId: request.execution?.sessionIdHash ?? null,
      routeLease: {
        leaseId,
        consumer: request.consumer,
        ...(request.execution?.runId ? { runId: request.execution.runId } : {}),
        ...(request.execution?.stageId ? { stageId: request.execution.stageId } : {}),
      },
    };
    const now = this.clock.now();
    const ttlMs = request.ttlSeconds * 1000;
    const expiresAtMs = now + ttlMs;
    let routeToken: string | undefined;
    let published = false;
    let activeLease: ActiveLease | undefined;
    try {
      routeToken = this.routePort.addRoute(route, {
        idleMs: ttlMs,
        onActivity: (at) => this.noteActivity(leaseId, at),
        onEvicted: () => this.onRouteEvicted(leaseId),
      });
      const launch = this.descriptors.build(request.runtime, {
        proxyBaseUrl: this.routePort.getBaseUrl(),
        model: request.model,
        routeToken,
      });
      this.assertOpen();
      const metadata: RouteLeaseMetadata = {
        leaseId,
        consumer: request.consumer,
        runtime: request.runtime,
        upstream: cloneUpstream(request.upstream),
        model: request.model,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
        status: 'active',
        ...(request.execution ? { execution: { ...request.execution } } : {}),
      };
      const result: RouteLeaseCreateResult = {
        schemaVersion: ROUTE_LEASE_RESULT_SCHEMA,
        ...metadata,
        status: 'active',
        launch: { env: { ...launch.env }, extraArgs: [...launch.extraArgs] },
      };
      const timer = this.clock.setTimeout(() => this.expire(leaseId), ttlMs);
      activeLease = {
        leaseId,
        routeToken,
        idempotencyScope: scope,
        payloadHash: input.payloadHash,
        request,
        route,
        result,
        metadata,
        expiresAtMs,
        timer,
      };
      this.assertOpen();
      this.active.set(leaseId, activeLease);
      this.idempotency.set(scope, { leaseId, payloadHash: input.payloadHash });
      published = true;
      this.afterPublish?.();
      if (this.closed) {
        this.finalize(activeLease, 'released');
        throw new RouteLeaseError('daemon_not_ready', 'route lease manager is shutting down');
      }
      return { created: true, result };
    } catch (error) {
      if (published && activeLease) {
        this.active.delete(leaseId);
        this.idempotency.delete(scope);
        this.clock.clearTimeout(activeLease.timer);
      }
      if (routeToken) this.safeRemoveRoute(routeToken, leaseId);
      if (error instanceof RouteLeaseError) throw error;
      throw new RouteLeaseError('upstream_unavailable', 'route lease creation failed safely', { cause: error });
    }
  }

  list(): RouteLeaseMetadata[] {
    this.pruneTombstones();
    return [
      ...[...this.active.values()].map((lease) => metadataCopy(lease.metadata)),
      ...[...this.tombstones.values()].map((entry) => metadataCopy(entry.metadata)),
    ].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  get(leaseId: string): RouteLeaseMetadata {
    const active = this.active.get(leaseId);
    if (active) return metadataCopy(active.metadata);
    this.pruneTombstones();
    const tombstone = this.tombstones.get(leaseId);
    if (tombstone) return metadataCopy(tombstone.metadata);
    throw new RouteLeaseError('lease_not_found', 'route lease was not found');
  }

  renew(leaseId: string, ttlSeconds: number): RouteLeaseRenewResult {
    const lease = this.active.get(leaseId);
    if (!lease) {
      this.pruneTombstones();
      const known = this.tombstones.get(leaseId);
      if (known?.metadata.status === 'expired') {
        throw new RouteLeaseError('lease_expired', 'route lease has expired');
      }
      throw new RouteLeaseError('lease_not_found', 'route lease was not found');
    }
    const now = this.clock.now();
    if (now >= lease.expiresAtMs) {
      this.finalize(lease, 'expired');
      throw new RouteLeaseError('lease_expired', 'route lease has expired');
    }
    const ttlMs = ttlSeconds * 1000;
    const expiresAtMs = now + ttlMs;
    const nextTimer = this.clock.setTimeout(() => this.expire(leaseId), ttlMs);
    const previousTimer = lease.timer;
    lease.timer = nextTimer;
    lease.expiresAtMs = expiresAtMs;
    lease.metadata = { ...lease.metadata, expiresAt: new Date(expiresAtMs).toISOString() };
    this.clock.clearTimeout(previousTimer);
    if (!this.routePort.renewRoute(lease.routeToken, ttlMs)) {
      this.finalize(lease, 'expired', true);
      throw new RouteLeaseError('lease_expired', 'route lease route has expired');
    }
    return { leaseId, expiresAt: lease.metadata.expiresAt, status: 'active' };
  }

  release(leaseId: string): RouteLeaseReleaseResult {
    const lease = this.active.get(leaseId);
    if (!lease) return { leaseId, released: false };
    this.finalize(lease, 'released');
    return { leaseId, released: true };
  }

  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    for (const lease of [...this.active.values()]) {
      try {
        this.finalize(lease, 'released');
      } catch (error) {
        this.logger?.warn('route lease cleanup failed during shutdown', { leaseId: lease.leaseId, error: safeErrorName(error) });
      }
    }
  }

  activeCount(): number {
    return this.active.size;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new RouteLeaseError('daemon_not_ready', 'route lease manager is shutting down');
    }
  }

  private noteActivity(leaseId: string, at: number): void {
    const lease = this.active.get(leaseId);
    if (!lease || at >= lease.expiresAtMs) return;
    lease.metadata = { ...lease.metadata, lastActivityAt: new Date(at).toISOString() };
  }

  private onRouteEvicted(leaseId: string): void {
    const lease = this.active.get(leaseId);
    if (lease) this.finalize(lease, 'expired', true);
  }

  private expire(leaseId: string): void {
    const lease = this.active.get(leaseId);
    if (!lease) return;
    const remaining = lease.expiresAtMs - this.clock.now();
    if (remaining > 0) {
      lease.timer = this.clock.setTimeout(() => this.expire(leaseId), remaining);
      return;
    }
    this.finalize(lease, 'expired');
  }

  private finalize(lease: ActiveLease, status: 'released' | 'expired', routeAlreadyGone = false): void {
    if (this.active.get(lease.leaseId) !== lease) return;
    this.active.delete(lease.leaseId);
    this.idempotency.delete(lease.idempotencyScope);
    this.clock.clearTimeout(lease.timer);
    if (!routeAlreadyGone) this.safeRemoveRoute(lease.routeToken, lease.leaseId);
    const metadata: RouteLeaseMetadata = { ...lease.metadata, status };
    this.tombstones.delete(lease.leaseId);
    this.tombstones.set(lease.leaseId, { metadata, terminalAtMs: this.clock.now() });
    this.pruneTombstones();
  }

  private safeRemoveRoute(routeToken: string, leaseId: string): void {
    try {
      this.routePort.removeRoute(routeToken);
    } catch (error) {
      this.logger?.warn('route lease route cleanup failed', { leaseId, error: safeErrorName(error) });
    }
  }

  private pruneTombstones(): void {
    const cutoff = this.clock.now() - this.tombstoneMaxAgeMs;
    for (const [leaseId, tombstone] of this.tombstones) {
      if (tombstone.terminalAtMs < cutoff) this.tombstones.delete(leaseId);
    }
    while (this.tombstones.size > this.tombstoneMaxCount) {
      const oldest = this.tombstones.keys().next().value as string | undefined;
      if (!oldest) break;
      this.tombstones.delete(oldest);
    }
  }
}

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}
