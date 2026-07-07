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

import { healthHttpStatus } from '@omnicross/contracts/health-logging-types';
import type { VoucherConfig } from '@omnicross/contracts/voucher-types';

import { serializeError } from '@omnicross/core/serializeError';

import type { EndpointModelConfigError } from './kindDetection';
import { validateServerModelConfig } from './kindDetection';
import { KeyedMutex } from './keyedMutex';
import { handleOutboundRequest } from './outboundApiRouter';
import { OutboundConcurrencyGate } from './outboundConcurrencyGate';
import { OutboundRateLimiter } from './outboundRateLimiter';
import type {
  ConcurrencyQueueConfig,
  EndpointRoutingConfig,
  OutboundApiDeps,
  OutboundApiServerStatus,
  OutboundFormatUrls,
  UserMessageQueueConfig,
} from './types';
import { UserMessageSerialQueue } from './userMessageSerialQueue';

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
  /** User-message serial-queue segment (normalized/defaulted by core). */
  userMessageQueue?: UserMessageQueueConfig;
  /** Per-key concurrency-queue segment (normalized/defaulted by core). */
  concurrencyQueue?: ConcurrencyQueueConfig;
  /** Voucher segment (voucher-redemption #9). Read live per request; absent ⇒
   *  disabled ⇒ the `/redeem` endpoint is inert (zero regression). */
  voucher?: VoucherConfig;
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
  private userMessageQueue: UserMessageQueueConfig | undefined;
  private concurrencyQueue: ConcurrencyQueueConfig | undefined;
  private voucherConfig: VoucherConfig | undefined;
  private readonly rateLimiter = new OutboundRateLimiter();
  /**
   * Redeem-attempt limiter (voucher-redemption #9, design D6) — a SEPARATE bucket
   * from the traffic `rateLimiter`, keyed by the authenticating key id, so
   * brute-forcing `CC_` codes is throttled (a handful/min) without touching the
   * per-key request rate. Conservative fixed defaults (10 / 60s).
   */
  private readonly redeemLimiter = new OutboundRateLimiter({ maxRequests: 10, windowMs: 60_000 });
  /**
   * Per-key redeem mutex (voucher-redemption #9, MJ1 fix). One instance for the
   * server's lifetime so concurrent redeem REQUESTS for the same key serialize
   * (relative grant increments accumulate instead of clobbering a snapshot).
   */
  private readonly redeemMutex = new KeyedMutex();
  private readonly serialQueue = new UserMessageSerialQueue();
  private readonly concurrencyGate = new OutboundConcurrencyGate();

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
    // Queue segments are read live per request (no restart on a queue-only
    // change) — store them in place before the bindChanged early-return below.
    this.userMessageQueue = input.userMessageQueue;
    this.concurrencyQueue = input.concurrencyQueue;
    this.voucherConfig = input.voucher;
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
    this.logInfo(`[OutboundApiServer] Listening on ${bindAddr}:${actualPort}`);
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
          server.on('error', (e) => this.logError('[OutboundApiServer] server error', serializeError(e)));
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
    // UNAUTHENTICATED liveness/readiness probe (daemon-health-endpoint, D1
    // secondary mount) — served BEFORE key-auth so an orchestrator can probe the
    // traffic port. Only mounted when the daemon wired a provider; otherwise the
    // path falls through to normal auth (zero-regression).
    if (this.deps.healthReportProvider && this.tryServeHealth(req, res)) return;
    handleOutboundRequest(
      req,
      res,
      this.deps,
      {
        endpoints: this.endpoints,
        userMessageQueue: this.userMessageQueue,
        concurrencyQueue: this.concurrencyQueue,
        voucher: this.voucherConfig,
      },
      this.rateLimiter,
      this.serialQueue,
      this.concurrencyGate,
      this.redeemLimiter,
      this.redeemMutex,
    ).catch((err) => {
      const message = serializeError(err);
      this.logError('[OutboundApiServer] unhandled error:', message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'outbound_api_error', message } }));
      }
    });
  }

  /**
   * Serve `GET|HEAD /health` (+ `/healthz`) from the injected provider, returning
   * true when it handled the request. 200 when `ok`, else 503; secret-free body.
   */
  private tryServeHealth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const provider = this.deps.healthReportProvider;
    if (!provider) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const path = (req.url ?? '/').split('?')[0]?.replace(/\/+$/, '') || '/';
    if (path !== '/health' && path !== '/healthz') return false;
    const report = provider();
    res.writeHead(healthHttpStatus(report.status), { 'Content-Type': 'application/json' });
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify(report));
    return true;
  }

  /** Route an info lifecycle line through the injected logger, else `console.log`
   *  (byte-identical legacy fallback when no logger is wired). */
  private logInfo(message: string): void {
    if (this.deps.logger) this.deps.logger.info(message);
    else console.log(message);
  }

  /** Route an error lifecycle line through the injected logger, else `console.error`. */
  private logError(message: string, detail?: unknown): void {
    if (this.deps.logger) this.deps.logger.error(message, detail);
    else if (detail === undefined) console.error(message);
    else console.error(message, detail);
  }

  /** Stop the listener and release the port. */
  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    this.boundPort = 0;
    return new Promise((resolve) => {
      server.close(() => {
        this.logInfo('[OutboundApiServer] Stopped');
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

  /**
   * Live queue-occupancy snapshot (only active entries). This getter's name +
   * shape are FROZEN — `omnicross-uqc-daemon` spreads it into its `/status`
   * response; the existing {@link getStatus} shape is deliberately NOT changed.
   */
  getQueueStatus(): {
    serial: Array<{ providerId: string; holding: boolean; waiting: number }>;
    concurrency: Array<{ apiKeyId: string; active: number; waiting: number }>;
  } {
    return {
      serial: this.serialQueue.getStatus(),
      concurrency: this.concurrencyGate.getStatus(),
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
