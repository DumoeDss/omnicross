/**
 * OutboundApiServer — the external-facing HTTP listener for the outbound API
 * server (`outbound-api-server`, design D1/D4/D5).
 *
 * A SEPARATE long-lived `http.Server` (distinct from the resident loopback
 * `ProviderProxy`). It binds `127.0.0.1` by default, or `0.0.0.0` when network
 * binding is enabled. Every request — INCLUDING loopback — is authenticated by
 * a named API key (no loopback bypass). Each authenticated request mints a route
 * on the SHARED `ProviderProxyRouteMap` and delegates to the existing
 * `routeRequest()` dispatch so the four ingress parsers + transformer are
 * reused (one conversion stack).
 *
 * Lifecycle:
 *  - `applyConfig({ enabled, networkBinding, endpoints, port })` — restart ONLY
 *    when the bind address or port changes; per-endpoint routing config is read
 *    live per request (no restart).
 *  - `getStatus()` — running, actual port, loopback + optional LAN URLs, the
 *    four format URLs.
 *  - `EADDRINUSE` → fall back to an ephemeral port, persist it (via the caller's
 *    `onPortChange`), and surface the actual port.
 *
 * @module outbound-api/OutboundApiServer
 */

import http from 'node:http';
import { networkInterfaces } from 'node:os';

import { serializeError } from '@omnicross/core/serializeError';

import type { EndpointModelConfigError } from './kindDetection';
import { validateServerModelConfig } from './kindDetection';
import { handleOutboundRequest } from './outboundApiRouter';
import { OutboundRateLimiter } from './outboundRateLimiter';
import type {
  EndpointRoutingConfig,
  OutboundApiDeps,
  OutboundApiServerStatus,
  OutboundFormatUrls,
} from './types';

/** Fixed default port (design D5). Persisted + configurable. */
export const DEFAULT_OUTBOUND_PORT = 8765;

const LOOPBACK_ADDR = '127.0.0.1';
const LAN_ADDR = '0.0.0.0';

/** Per-call apply config (the persisted server config minus runtime state). */
export interface ApplyConfigInput {
  enabled: boolean;
  networkBinding: boolean;
  endpoints: EndpointRoutingConfig[];
  port?: number;
}

/**
 * Thrown by {@link OutboundApiServer.applyConfig} when an ENABLED server is asked
 * to bind with an INCOMPLETE model-kind map (the "未配置 → 无法启动接口服务" gate,
 * design D6). Carries the per-endpoint missing kinds so the daemon/UI can render
 * an actionable message; the server does NOT bind. Exported from the barrel so
 * the daemon (surface) can `instanceof`-narrow it.
 */
export class OutboundApiConfigError extends Error {
  readonly missing: EndpointModelConfigError[];
  constructor(missing: EndpointModelConfigError[]) {
    super(
      'Outbound API server cannot start: incomplete model-kind configuration — ' +
        missing
          .map((m) => `${m.endpoint} missing [${m.missingKinds.join(', ')}]`)
          .join('; '),
    );
    this.name = 'OutboundApiConfigError';
    this.missing = missing;
  }
}

export class OutboundApiServer {
  private server: http.Server | null = null;
  private boundPort = 0;
  private boundAddr = LOOPBACK_ADDR;
  private endpoints: EndpointRoutingConfig[] = [];
  private readonly rateLimiter = new OutboundRateLimiter();

  constructor(
    private readonly deps: OutboundApiDeps,
    /** Called when the actual bound port differs from the requested one. */
    private readonly onPortChange?: (port: number) => void,
  ) {}

  /**
   * Apply a config. Restarts the listener ONLY when the bind address or port
   * changes (or when toggling enabled); per-endpoint routing config is updated
   * in place (read live per request — no restart).
   */
  async applyConfig(input: ApplyConfigInput): Promise<void> {
    this.endpoints = input.endpoints;
    const wantAddr = input.networkBinding ? LAN_ADDR : LOOPBACK_ADDR;
    const wantPort = input.port ?? DEFAULT_OUTBOUND_PORT;

    if (!input.enabled) {
      await this.stop();
      return;
    }

    // Startup gate (design D6): an enabled server with an incomplete model-kind
    // map REFUSES to bind. `this.endpoints` is recorded above for status
    // introspection, but we throw the typed error BEFORE (re)binding so the boot
    // path can log + leave the server stopped and the daemon PUT surfaces a clear
    // 400. The daemon pre-validates with the same `validateServerModelConfig`, so
    // the typical UI path never reaches this throw.
    const missing = validateServerModelConfig({
      enabled: true,
      networkBinding: input.networkBinding,
      endpoints: input.endpoints,
      port: input.port,
    });
    if (missing.length > 0) {
      // If a listener is CURRENTLY bound, tear it down so the live state matches
      // the "cannot start" the UI shows (an enable that turns an already-running
      // server's config incomplete must STOP serving, not keep the stale config
      // live). `stop()` is idempotent — a no-op on the boot path where nothing is
      // bound yet, so boot still throws-and-stays-stopped exactly as before.
      await this.stop();
      throw new OutboundApiConfigError(missing);
    }

    const running = this.server !== null;
    const bindChanged = running && (this.boundAddr !== wantAddr || this.boundPort !== wantPort);
    if (running && !bindChanged) {
      // Only per-endpoint config changed — nothing to restart.
      return;
    }
    if (running) await this.stop();
    await this.start(wantAddr, wantPort);
  }

  /** Start the listener on `bindAddr:port`, falling back on EADDRINUSE. */
  async start(bindAddr: string, port: number): Promise<number> {
    if (this.server) return this.boundPort;
    const actualPort = await this.listen(bindAddr, port);
    this.boundAddr = bindAddr;
    this.boundPort = actualPort;
    if (actualPort !== port) this.onPortChange?.(actualPort);
    console.log(`[OutboundApiServer] Listening on ${bindAddr}:${actualPort}`);
    return actualPort;
  }

  /** Bind once; on EADDRINUSE retry with an ephemeral port (port 0). */
  private listen(bindAddr: string, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.onRequest(req, res);
      });
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && port !== 0) {
          server.removeListener('error', onError);
          // Retry on an ephemeral port.
          this.listen(bindAddr, 0).then(resolve, reject);
          return;
        }
        reject(err);
      };
      server.on('error', onError);
      server.listen(port, bindAddr, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          server.removeListener('error', onError);
          server.on('error', (e) => console.error('[OutboundApiServer] server error', serializeError(e)));
          this.server = server;
          resolve(addr.port);
        } else {
          reject(new Error('Failed to get outbound server address'));
        }
      });
    });
  }

  /** Per-request handler. Auth is enforced on EVERY request (incl. loopback). */
  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    handleOutboundRequest(
      req,
      res,
      this.deps,
      { endpoints: this.endpoints },
      this.rateLimiter,
    ).catch((err) => {
      const message = serializeError(err);
      console.error('[OutboundApiServer] unhandled error:', message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'outbound_api_error', message } }));
      }
    });
  }

  /** Stop the listener and release the port. */
  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    this.boundPort = 0;
    return new Promise((resolve) => {
      server.close(() => {
        console.log('[OutboundApiServer] Stopped');
        resolve();
      });
    });
  }

  /** A live status snapshot for the Settings tab. */
  getStatus(): OutboundApiServerStatus {
    const running = this.server !== null;
    if (!running) {
      return {
        running: false,
        port: 0,
        loopbackUrl: null,
        lanUrl: null,
        formats: null,
        lanFormats: null,
      };
    }
    const port = this.boundPort;
    const loopbackBase = `http://${LOOPBACK_ADDR}:${port}`;
    const isLan = this.boundAddr === LAN_ADDR;
    const lanIp = isLan ? firstLanIPv4() : null;
    const lanBase = lanIp ? `http://${lanIp}:${port}` : null;
    return {
      running: true,
      port,
      loopbackUrl: loopbackBase,
      lanUrl: lanBase,
      formats: formatUrls(loopbackBase),
      lanFormats: lanBase ? formatUrls(lanBase) : null,
    };
  }
}

/** Build the four format endpoint URLs for a base URL. */
export function formatUrls(base: string): OutboundFormatUrls {
  return {
    chat: `${base}/v1/chat/completions`,
    responses: `${base}/v1/responses`,
    messages: `${base}/v1/messages`,
    gemini: `${base}/v1beta/models/{model}:generateContent`,
  };
}

/** First non-internal IPv4 address (the LAN URL host), or null. */
function firstLanIPv4(): string | null {
  const ifaces = networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}
