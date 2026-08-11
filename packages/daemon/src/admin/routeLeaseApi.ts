import http from 'node:http';

import {
  isLoopbackAddress,
  normalizeRouteLeaseTtl,
  ROUTE_LEASE_CAPABILITIES,
  RouteLeaseError,
  type RouteLeaseManager,
} from '@omnicross/core/provider-proxy';

const MAX_BODY_BYTES = 64 * 1024;
const SAFE_LEASE_ID = /^[A-Za-z0-9-]{1,128}$/u;

export interface RouteLeaseApiDeps {
  readonly routeLeaseManager?: RouteLeaseManager;
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new RouteLeaseError('invalid_request', 'request body is too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new RouteLeaseError('invalid_request', 'request body is not valid JSON');
  }
}

function json(res: http.ServerResponse, status: number, body: unknown, noStore = false): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  if (noStore) res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function leaseId(value: string | undefined): string {
  if (!value || !SAFE_LEASE_ID.test(value)) throw new RouteLeaseError('invalid_request', 'lease id is invalid');
  return value;
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function writeError(res: http.ServerResponse, error: unknown, noStore: boolean): void {
  const safe = error instanceof RouteLeaseError
    ? error
    : new RouteLeaseError('upstream_unavailable', 'route lease operation failed safely');
  if (safe.retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(safe.retryAfterSeconds));
  json(res, safe.status, safe.toResponse(), noStore);
}

/** Focused machine API. AdminServer calls this only after its existing auth gate. */
export async function handleRouteLeaseApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string,
  deps: RouteLeaseApiDeps,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  const noStore = method === 'POST' && (
    path === '/admin/api/route-leases' || path.endsWith('/renew')
  );
  try {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      throw new RouteLeaseError('control_unauthorized', 'route lease control plane is loopback only');
    }
    const manager = deps.routeLeaseManager;
    if (!manager) throw new RouteLeaseError('daemon_not_ready', 'route lease manager is unavailable');
    const base = '/admin/api/route-leases';
    const suffix = path.slice(base.length).replace(/^\/+|\/+$/gu, '');
    const segments = suffix ? suffix.split('/') : [];

    if (segments.length === 1 && segments[0] === 'capabilities') {
      if (method !== 'GET' && method !== 'HEAD') throw new RouteLeaseError('invalid_request', 'method is not allowed');
      return json(res, 200, ROUTE_LEASE_CAPABILITIES);
    }
    if (segments.length === 0) {
      if (method === 'GET') return json(res, 200, { leases: manager.list() });
      if (method === 'POST') {
        const outcome = await manager.createFromRequest(await readJson(req), header(req, 'idempotency-key'));
        return json(res, outcome.created ? 201 : 200, outcome.result, true);
      }
      throw new RouteLeaseError('invalid_request', 'method is not allowed');
    }

    const id = leaseId(segments[0]);
    if (segments.length === 1) {
      if (method === 'GET') return json(res, 200, manager.get(id));
      if (method === 'DELETE') return json(res, 200, manager.release(id));
      throw new RouteLeaseError('invalid_request', 'method is not allowed');
    }
    if (segments.length === 2 && segments[1] === 'renew' && method === 'POST') {
      const body = await readJson(req);
      const ttl = normalizeRouteLeaseTtl(
        body && typeof body === 'object' && !Array.isArray(body)
          ? (body as Record<string, unknown>).ttlSeconds
          : undefined,
      );
      return json(res, 200, manager.renew(id, ttl), true);
    }
    throw new RouteLeaseError('lease_not_found', 'route lease endpoint was not found');
  } catch (error) {
    writeError(res, error, noStore);
  }
}
