import { createHash, createHmac, randomBytes } from 'node:crypto';

import type { GatewayBindingTarget } from '../outbound-api/types';
import type { IngressFormat, RouteContext } from './types';

export const ROUTE_LEASE_REQUEST_SCHEMA = 'omnicross.route-lease.request/1' as const;
export const ROUTE_LEASE_RESULT_SCHEMA = 'omnicross.route-lease/1' as const;
export const ROUTE_LEASE_CAPABILITIES_SCHEMA = 'omnicross.route-lease.capabilities/1' as const;
export const ROUTE_LEASE_API_VERSION = 1 as const;
export const ROUTE_LEASE_DEFAULT_TTL_SECONDS = 600;
export const ROUTE_LEASE_MAX_TTL_SECONDS = 3600;
export const ROUTE_LEASE_MAX_IDEMPOTENCY_BYTES = 256;
export const ROUTE_LEASE_MAX_CONSUMER_BYTES = 64;
export const ROUTE_LEASE_MAX_EXECUTION_ID_BYTES = 128;
export const ROUTE_LEASE_MAX_SESSION_ID_BYTES = 512;
export const ROUTE_LEASE_MAX_MODEL_BYTES = 256;
export const ROUTE_LEASE_SESSION_HASH_DOMAIN = 'omnicross.route-lease.session/v1';
export const ROUTE_LEASE_CODEX_TOKEN_ENV = 'OMNICROSS_CODEX_ROUTE_TOKEN';

export const ROUTE_LEASE_RUNTIMES = ['claude', 'codex'] as const;
export type RouteLeaseRuntime = (typeof ROUTE_LEASE_RUNTIMES)[number];
export type RouteLeaseUpstream = GatewayBindingTarget;
export type RouteLeaseStatus = 'active' | 'released' | 'expired';

export interface RuntimeLaunchDescriptor {
  readonly env: Record<string, string>;
  readonly extraArgs: string[];
}

export interface RouteLeaseExecutionRequest {
  readonly runId?: string;
  readonly stageId?: string;
  readonly attempt?: number;
  readonly sessionId?: string;
}

export interface RouteLeaseExecutionMetadata {
  readonly runId?: string;
  readonly stageId?: string;
  readonly attempt?: number;
  readonly sessionIdHash?: string;
}

export interface RouteLeaseRequest {
  readonly schemaVersion: typeof ROUTE_LEASE_REQUEST_SCHEMA;
  readonly consumer: string;
  readonly runtime: RouteLeaseRuntime;
  readonly upstream: RouteLeaseUpstream;
  readonly model: string;
  readonly execution?: RouteLeaseExecutionRequest;
  readonly ttlSeconds?: number;
}

export interface NormalizedRouteLeaseRequest {
  readonly schemaVersion: typeof ROUTE_LEASE_REQUEST_SCHEMA;
  readonly consumer: string;
  readonly runtime: RouteLeaseRuntime;
  readonly upstream: RouteLeaseUpstream;
  readonly model: string;
  readonly execution?: RouteLeaseExecutionMetadata;
  readonly ttlSeconds: number;
}

export interface NormalizedRouteLeaseCreate {
  readonly request: NormalizedRouteLeaseRequest;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
}

export interface RouteLeaseMetadata {
  readonly leaseId: string;
  readonly consumer: string;
  readonly runtime: RouteLeaseRuntime;
  readonly upstream: RouteLeaseUpstream;
  readonly model: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastActivityAt?: string;
  readonly status: RouteLeaseStatus;
  readonly execution?: RouteLeaseExecutionMetadata;
}

export interface RouteLeaseCreateResult extends RouteLeaseMetadata {
  readonly schemaVersion: typeof ROUTE_LEASE_RESULT_SCHEMA;
  readonly status: 'active';
  readonly launch: RuntimeLaunchDescriptor;
}

export interface RouteLeaseRenewResult {
  readonly leaseId: string;
  readonly expiresAt: string;
  readonly status: 'active';
}

export interface RouteLeaseReleaseResult {
  readonly leaseId: string;
  readonly released: boolean;
}

export interface RouteLeaseCapabilities {
  readonly schemaVersion: typeof ROUTE_LEASE_CAPABILITIES_SCHEMA;
  readonly runtimes: readonly ['claude', 'codex'];
  readonly upstreamKinds: readonly ['provider', 'account', 'account-group', 'account-pool'];
  readonly leaseApiVersion: 1;
  readonly codexAuthMode: 'env_key';
  readonly maxTtlSeconds: 3600;
}

export const ROUTE_LEASE_CAPABILITIES: RouteLeaseCapabilities = Object.freeze({
  schemaVersion: ROUTE_LEASE_CAPABILITIES_SCHEMA,
  runtimes: Object.freeze(['claude', 'codex']) as readonly ['claude', 'codex'],
  upstreamKinds: Object.freeze(['provider', 'account', 'account-group', 'account-pool']) as readonly ['provider', 'account', 'account-group', 'account-pool'],
  leaseApiVersion: ROUTE_LEASE_API_VERSION,
  codexAuthMode: 'env_key',
  maxTtlSeconds: ROUTE_LEASE_MAX_TTL_SECONDS,
});

export const ROUTE_LEASE_RUNTIME_TABLE: Readonly<Record<RouteLeaseRuntime, {
  readonly endpoint: 'messages' | 'responses';
  readonly ingressFormat: IngressFormat;
  readonly wirePath: '/v1/messages' | '/openai/responses';
}>> = Object.freeze({
  claude: Object.freeze({ endpoint: 'messages', ingressFormat: 'anthropic-messages', wirePath: '/v1/messages' }),
  codex: Object.freeze({ endpoint: 'responses', ingressFormat: 'openai-responses', wirePath: '/openai/responses' }),
});

export type RouteLeaseErrorCode =
  | 'invalid_request'
  | 'runtime_unsupported'
  | 'model_not_configured'
  | 'format_unsupported'
  | 'control_unauthorized'
  | 'upstream_not_found'
  | 'lease_not_found'
  | 'idempotency_conflict'
  | 'upstream_unavailable'
  | 'lease_expired'
  | 'upstream_exhausted'
  | 'daemon_not_ready';

const ERROR_DEFAULTS: Readonly<Record<RouteLeaseErrorCode, { status: number; retryable: boolean }>> = {
  invalid_request: { status: 400, retryable: false },
  runtime_unsupported: { status: 400, retryable: false },
  model_not_configured: { status: 400, retryable: false },
  format_unsupported: { status: 400, retryable: false },
  control_unauthorized: { status: 403, retryable: false },
  upstream_not_found: { status: 404, retryable: false },
  lease_not_found: { status: 404, retryable: false },
  idempotency_conflict: { status: 409, retryable: false },
  upstream_unavailable: { status: 409, retryable: true },
  lease_expired: { status: 410, retryable: false },
  upstream_exhausted: { status: 429, retryable: true },
  daemon_not_ready: { status: 503, retryable: true },
};

export class RouteLeaseError extends Error {
  readonly type = 'route_lease_error' as const;
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;

  constructor(
    readonly code: RouteLeaseErrorCode,
    message: string,
    options: { status?: number; retryable?: boolean; retryAfterSeconds?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'RouteLeaseError';
    const defaults = ERROR_DEFAULTS[code];
    this.status = options.status ?? defaults.status;
    this.retryable = options.retryable ?? defaults.retryable;
    if (options.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = Math.max(1, Math.min(3600, Math.floor(options.retryAfterSeconds)));
    }
  }

  toResponse(): { error: { type: 'route_lease_error'; code: RouteLeaseErrorCode; message: string; retryable: boolean } } {
    return { error: { type: this.type, code: this.code, message: this.message, retryable: this.retryable } };
  }
}

const IDEMPOTENCY_RE = /^[A-Za-z0-9._:-]+$/u;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u;
const PROCESS_SESSION_HMAC_KEY = randomBytes(32);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function normalizedString(
  value: unknown,
  field: string,
  maxBytes: number,
  options: { asciiPattern?: RegExp } = {},
): string {
  if (typeof value !== 'string') throw invalid(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized || byteLength(normalized) > maxBytes || CONTROL_RE.test(normalized)) {
    throw invalid(`${field} is invalid`);
  }
  if (options.asciiPattern && !options.asciiPattern.test(normalized)) {
    throw invalid(`${field} is invalid`);
  }
  return normalized;
}

function optionalExecutionId(value: unknown, field: string): string | undefined {
  return value === undefined
    ? undefined
    : normalizedString(value, field, ROUTE_LEASE_MAX_EXECUTION_ID_BYTES);
}

function invalid(message: string): RouteLeaseError {
  return new RouteLeaseError('invalid_request', message);
}

export function normalizeRouteLeaseIdempotencyKey(value: unknown): string {
  return normalizedString(value, 'Idempotency-Key', ROUTE_LEASE_MAX_IDEMPOTENCY_BYTES, {
    asciiPattern: IDEMPOTENCY_RE,
  });
}

export function normalizeRouteLeaseTtl(value: unknown): number {
  if (value === undefined) return ROUTE_LEASE_DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > ROUTE_LEASE_MAX_TTL_SECONDS) {
    throw invalid(`ttlSeconds must be an integer from 1 to ${ROUTE_LEASE_MAX_TTL_SECONDS}`);
  }
  return value as number;
}

function normalizeUpstream(value: unknown): RouteLeaseUpstream {
  if (!isRecord(value) || typeof value.kind !== 'string') throw invalid('upstream is invalid');
  const providerId = normalizedString(value.providerId, 'upstream.providerId', 128);
  switch (value.kind) {
    case 'provider': {
      const keyId = value.keyId === undefined
        ? undefined
        : normalizedString(value.keyId, 'upstream.keyId', 128);
      return keyId ? { kind: 'provider', providerId, keyId } : { kind: 'provider', providerId };
    }
    case 'account':
      return {
        kind: 'account',
        providerId,
        accountId: normalizedString(value.accountId, 'upstream.accountId', 128),
      };
    case 'account-group':
      return {
        kind: 'account-group',
        providerId,
        group: normalizedString(value.group, 'upstream.group', 128),
      };
    case 'account-pool':
      return { kind: 'account-pool', providerId };
    default:
      throw invalid('upstream kind is unsupported');
  }
}

export function hashRouteLeaseSessionId(
  sessionId: string,
  hmacKey: Uint8Array = PROCESS_SESSION_HMAC_KEY,
): string {
  return createHmac('sha256', hmacKey)
    .update(ROUTE_LEASE_SESSION_HASH_DOMAIN, 'utf8')
    .update('\0', 'utf8')
    .update(sessionId, 'utf8')
    .digest('hex');
}

/** Stable JSON form with recursive object-key sorting and JSON array ordering. */
export function canonicalizeRouteLeasePayload(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalizeRouteLeasePayload(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalizeRouteLeasePayload(record[key])}`);
  return `{${fields.join(',')}}`;
}

export function hashRouteLeasePayload(value: unknown): string {
  return createHash('sha256').update(canonicalizeRouteLeasePayload(value), 'utf8').digest('hex');
}

export function parseRouteLeaseCreate(
  raw: unknown,
  idempotencyHeader: unknown,
  hmacKey: Uint8Array = PROCESS_SESSION_HMAC_KEY,
): NormalizedRouteLeaseCreate {
  if (!isRecord(raw)) throw invalid('request body must be a JSON object');
  if (raw.schemaVersion !== ROUTE_LEASE_REQUEST_SCHEMA) {
    throw invalid(`schemaVersion must be ${ROUTE_LEASE_REQUEST_SCHEMA}`);
  }
  const consumer = normalizedString(raw.consumer, 'consumer', ROUTE_LEASE_MAX_CONSUMER_BYTES);
  const runtime = raw.runtime;
  if (runtime !== 'claude' && runtime !== 'codex') {
    throw new RouteLeaseError('runtime_unsupported', 'runtime is unsupported');
  }
  const upstream = normalizeUpstream(raw.upstream);
  if (typeof raw.model !== 'string' || raw.model.trim().length === 0) {
    throw new RouteLeaseError('model_not_configured', 'model is not configured');
  }
  const model = normalizedString(raw.model, 'model', ROUTE_LEASE_MAX_MODEL_BYTES);
  const ttlSeconds = normalizeRouteLeaseTtl(raw.ttlSeconds);
  const idempotencyKey = normalizeRouteLeaseIdempotencyKey(idempotencyHeader);

  let execution: RouteLeaseExecutionMetadata | undefined;
  let semanticExecution: Record<string, unknown> | undefined;
  if (raw.execution !== undefined) {
    if (!isRecord(raw.execution)) throw invalid('execution must be a JSON object');
    const runId = optionalExecutionId(raw.execution.runId, 'execution.runId');
    const stageId = optionalExecutionId(raw.execution.stageId, 'execution.stageId');
    let attempt: number | undefined;
    if (raw.execution.attempt !== undefined) {
      if (!Number.isSafeInteger(raw.execution.attempt) || (raw.execution.attempt as number) < 1) {
        throw invalid('execution.attempt must be a positive integer');
      }
      attempt = raw.execution.attempt as number;
    }
    let sessionId: string | undefined;
    let sessionIdHash: string | undefined;
    if (raw.execution.sessionId !== undefined) {
      sessionId = normalizedString(raw.execution.sessionId, 'execution.sessionId', ROUTE_LEASE_MAX_SESSION_ID_BYTES);
      sessionIdHash = hashRouteLeaseSessionId(sessionId, hmacKey);
    }
    if (runId !== undefined || stageId !== undefined || attempt !== undefined || sessionIdHash !== undefined) {
      execution = { runId, stageId, attempt, sessionIdHash };
      semanticExecution = { runId, stageId, attempt, sessionId };
    }
  }

  const request: NormalizedRouteLeaseRequest = {
    schemaVersion: ROUTE_LEASE_REQUEST_SCHEMA,
    consumer,
    runtime,
    upstream,
    model,
    ...(execution ? { execution } : {}),
    ttlSeconds,
  };
  const semanticPayload = {
    schemaVersion: request.schemaVersion,
    consumer,
    runtime,
    upstream,
    model,
    ...(semanticExecution ? { execution: semanticExecution } : {}),
    ttlSeconds,
  };
  return { request, idempotencyKey, payloadHash: hashRouteLeasePayload(semanticPayload) };
}

export function routeLeaseRuntime(runtime: RouteLeaseRuntime): (typeof ROUTE_LEASE_RUNTIME_TABLE)[RouteLeaseRuntime] {
  switch (runtime) {
    case 'claude': return ROUTE_LEASE_RUNTIME_TABLE.claude;
    case 'codex': return ROUTE_LEASE_RUNTIME_TABLE.codex;
    default: {
      const exhaustive: never = runtime;
      throw new RouteLeaseError('runtime_unsupported', `runtime is unsupported: ${String(exhaustive)}`);
    }
  }
}

export interface RouteLeaseTargetResolverPort {
  resolve(request: NormalizedRouteLeaseRequest): Promise<RouteContext>;
}

export interface RouteLeaseDescriptorPort {
  has(runtime: RouteLeaseRuntime): boolean;
  build(
    runtime: RouteLeaseRuntime,
    input: { readonly proxyBaseUrl: string; readonly model: string; readonly routeToken: string },
  ): RuntimeLaunchDescriptor;
}
