/**
 * ProviderProxy — the single resident `127.0.0.1` listener that subsumes the
 * host's per-session proxies (Anthropic Messages ingress and OpenAI Responses
 * ingress).
 *
 * OpenSpec `engine-provider-decouple` Phase 1 (design D0/D3/D7/D9). It is ONLY
 * about Providers — it does NOT know or care which agent engine is upstream.
 *
 * Lifecycle (task 2.1): `start()` ONCE for the app session (not per run),
 * `stop()` at teardown, `getBaseUrl()` for injector wiring. Per-run state lives
 * in the `ProviderProxyRouteMap`:
 *   - `addRoute(ctx) → token` at run start (task 2.2), returned so the
 *     next-batch injector can mint the forwarded auth-header sentinel;
 *   - `removeRoute(token)` at run end;
 *   - idle TTL reaping inside the map (task 2.3).
 *
 * Isolation is code-enforced (task 2.4 + D9): the listener binds loopback only
 * AND refuses any request whose socket peer is not a loopback address; the
 * route token is unguessable; a lookup miss is rejected with no fallback.
 *
 * @module provider-proxy/ProviderProxy
 */

import http from 'node:http';

import { serializeError } from '@omnicross/core/serializeError';

import { writeError } from './ingress/providerProxyShared';
import { ProviderProxyRouteMap, type RouteRegistrationOptions } from './providerProxyRouteMap';
import { routeRequest } from './providerProxyRouter';
import type { ProviderProxyDeps, RouteContext } from './types';

/**
 * True for IPv4/IPv6 loopback peer addresses. Exported so the isolation gate
 * ("the listener refuses non-loopback origins") can be unit-asserted.
 */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  // Node may report IPv4-mapped IPv6 (`::ffff:127.0.0.1`).
  const normalized = addr.startsWith('::ffff:') ? addr.slice('::ffff:'.length) : addr;
  return (
    normalized === '127.0.0.1' ||
    normalized.startsWith('127.') ||
    normalized === '::1' ||
    addr === '::1'
  );
}

/**
 * Listener placement for {@link ProviderProxy.start}. The host must be a
 * loopback literal; the proxy refuses non-loopback peers either way.
 */
export interface ProviderProxyListenOptions {
  /** `127.0.0.1` (default), `::1` or `localhost`. */
  readonly host?: '127.0.0.1' | '::1' | 'localhost';
  /** TCP port; `0` (default) picks a free port. */
  readonly port?: number;
}

export class ProviderProxy {
  private server: http.Server | null = null;
  private port = 0;
  private host: '127.0.0.1' | '::1' | 'localhost' = '127.0.0.1';
  private readonly routes: ProviderProxyRouteMap;
  private readonly beforeStop = new Set<() => void | Promise<void>>();

  constructor(
    private readonly deps: ProviderProxyDeps,
    routes?: ProviderProxyRouteMap,
  ) {
    this.routes = routes ?? new ProviderProxyRouteMap();
  }

  /**
   * Start the resident listener on a stable port on 127.0.0.1. Idempotent —
   * a second `start()` returns the already-bound port. `options` lets an
   * embedding host pin the loopback host/port (defaults: `127.0.0.1:0`).
   */
  async start(options: ProviderProxyListenOptions = {}): Promise<number> {
    if (this.server) return this.port;
    const host = options.host ?? '127.0.0.1';
    if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
      throw new Error('ProviderProxy must listen on a loopback host');
    }
    const requestedPort = options.port ?? 0;
    if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
      throw new Error('ProviderProxy port must be an integer from 0 to 65535');
    }

    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        // Loopback-only enforcement (defense in depth on top of the bind addr).
        const peer = req.socket.remoteAddress;
        if (!isLoopbackAddress(peer)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'provider_proxy_error', message: 'Loopback only' } }));
          req.socket.destroy();
          return;
        }
        routeRequest(req, res, this.routes, this.deps).catch((err) => {
          const errMsg = serializeError(err);
          if (this.deps.logger) this.deps.logger.error('[ProviderProxy] Unhandled error:', errMsg);
          else console.error('[ProviderProxy] Unhandled error:', errMsg);
          // Last-resort 500: consults the Anthropic-protocol mark (set at the
          // routeRequest entry) so an Anthropic request gets the Anthropic shape.
          if (!res.headersSent) {
            writeError(res, 500, errMsg);
          }
        });
      });

      server.listen(requestedPort, host, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
          this.host = host;
          this.server = server;
          if (this.deps.logger) this.deps.logger.info(`[ProviderProxy] Listening on ${host}`, { port: this.port });
          else console.log(`[ProviderProxy] Listening on ${host}:${this.port}`);
          resolve(this.port);
        } else {
          reject(new Error('Failed to get server address'));
        }
      });

      server.on('error', reject);
    });
  }

  /** Stop the listener, clear all routes, and release the port. */
  async stop(): Promise<void> {
    for (const cleanup of [...this.beforeStop]) {
      try {
        await cleanup();
      } catch {
        // One owner cleanup must not prevent route clearing or listener stop.
      }
    }
    this.routes.clear();
    const server = this.server;
    if (!server) return;
    return new Promise((resolve) => {
      server.close(() => {
        if (this.deps.logger) this.deps.logger.info('[ProviderProxy] Stopped', { port: this.port });
        else console.log(`[ProviderProxy] Stopped (port=${this.port})`);
        this.server = null;
        this.port = 0;
        resolve();
      });
    });
  }

  /** Base URL for injector wiring (`ANTHROPIC_BASE_URL` / codex `base_url`). */
  getBaseUrl(): string {
    const host = this.host === '::1' ? '[::1]' : this.host;
    return `http://${host}:${this.port}`;
  }

  /** Register daemon-owned cleanup that must run before route-map teardown. */
  registerBeforeStop(cleanup: () => void | Promise<void>): () => void {
    this.beforeStop.add(cleanup);
    return () => this.beforeStop.delete(cleanup);
  }

  /** Whether the resident listener has completed binding. */
  isReady(): boolean {
    return this.server !== null && this.port > 0;
  }

  /**
   * The SHARED route map. Exposed so the outbound API server
   * (`outbound-api-server`) can mint per-request routes on the SAME map and
   * delegate to the existing `routeRequest()` dispatch — guaranteeing a single
   * conversion stack. Not used by the resident per-run flow.
   */
  getRouteMap(): ProviderProxyRouteMap {
    return this.routes;
  }

  /**
   * The app-session deps the proxy services all routes with. Exposed so the
   * outbound server can pass them verbatim into `routeRequest()`.
   */
  getDeps(): ProviderProxyDeps {
    return this.deps;
  }

  /** Register a route for one run; returns the crypto route token (task 2.2). */
  addRoute(context: RouteContext, idleMsOrOptions?: number | RouteRegistrationOptions): string {
    return this.routes.addRoute(context, idleMsOrOptions);
  }

  /** Re-arm one route while retaining the exact same bearer token. */
  renewRoute(token: string, idleMs?: number): boolean {
    return this.routes.renewRoute(token, idleMs);
  }

  /** Remove a route at run end. Returns true if an entry existed. */
  removeRoute(token: string): boolean {
    return this.routes.removeRoute(token);
  }

  /** Live-route count (diagnostics / tests). */
  routeCount(): number {
    return this.routes.size();
  }
}
