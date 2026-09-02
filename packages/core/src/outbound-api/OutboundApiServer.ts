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

import { KeyedMutex } from './keyedMutex';
import {
  isAnthropicProtocolResponse,
  writeAnthropicError,
} from '../provider-proxy/ingress/anthropicErrorEnvelope';
import { setAnthropicPingHeartbeatMs } from '../transformer/transformers/AnthropicOpenAIToAnthropicStream';
import { handleOutboundRequest } from './outboundApiRouter';
import { OutboundConcurrencyGate } from './outboundConcurrencyGate';
import { OutboundRateLimiter } from './outboundRateLimiter';
import type {
  AnthropicConfigSegment,
  ConcurrencyQueueConfig,
  EndpointRoutingConfig,
  GatewayBinding,
  OutboundApiDeps,
  OutboundApiServerStatus,
  OutboundFormatUrls,
  SearchServerConfig,
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
  /** Additive Images URL publication; serving still depends on runtime capability. */
  imagesEnabled?: boolean;
  endpoints: EndpointRoutingConfig[];
  /** Independent resource bindings; absent preserves legacy endpoint routing. */
  bindings?: GatewayBinding[];
  port?: number;
  /** User-message serial-queue segment (normalized/defaulted by core). */
  userMessageQueue?: UserMessageQueueConfig;
  /** Per-key concurrency-queue segment (normalized/defaulted by core). */
  concurrencyQueue?: ConcurrencyQueueConfig;
  /** Voucher segment (voucher-redemption #9). Read live per request; absent ⇒
   *  disabled ⇒ the `/redeem` endpoint is inert (zero regression). */
  voucher?: VoucherConfig;
  /** Anthropic-protocol segment (claude-api-protocol-fidelity, §10). Read live
   *  per request; the heartbeat value is hot-applied to the stream synthesizer. */
  anthropic?: AnthropicConfigSegment;
  /**
   * Search assembly segment (plan 阶段5). Read live per request for the Codex
   * frontend's mode; the runtime itself is wired once through `deps`.
   */
  search?: SearchServerConfig;
}

/** Prepared listener/config publication used by the daemon's settings transaction. */
export interface PreparedOutboundApiConfig {
  publish(): Promise<void>;
  rollback(): Promise<void>;
  dispose(): Promise<void>;
}

interface OutboundRuntimeSnapshot {
  readonly server: http.Server | null;
  readonly boundPort: number;
  readonly boundAddr: string;
  readonly endpoints: EndpointRoutingConfig[];
  readonly bindings: GatewayBinding[];
  readonly userMessageQueue: UserMessageQueueConfig | undefined;
  readonly concurrencyQueue: ConcurrencyQueueConfig | undefined;
  readonly voucher: VoucherConfig | undefined;
  readonly anthropic: AnthropicConfigSegment | undefined;
  readonly search: SearchServerConfig | undefined;
  readonly imagesEnabled: boolean;
}

export class OutboundApiServer {
  private server: http.Server | null = null;
  private boundPort = 0;
  private boundAddr = LOOPBACK_ADDR;
  private endpoints: EndpointRoutingConfig[] = [];
  private bindings: GatewayBinding[] = [];
  private userMessageQueue: UserMessageQueueConfig | undefined;
  private concurrencyQueue: ConcurrencyQueueConfig | undefined;
  private voucherConfig: VoucherConfig | undefined;
  private anthropicConfig: AnthropicConfigSegment | undefined;
  private searchConfig: SearchServerConfig | undefined;
  private imagesEnabled = false;
  /** R10 `/api/hello` switch (§10 `anthropic.apiHello`, default true). */
  private apiHelloEnabled = true;
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
    const prepared = await this.prepareConfig(input);
    try {
      await prepared.publish();
    } catch (error) {
      await prepared.dispose().catch(() => undefined);
      throw error;
    }
  }

  /**
   * Prepare any new listener before persistence when the target can coexist with
   * the current socket. A live fixed-port address-only change cannot be made
   * failure-atomic on every supported platform because the replacement cannot
   * coexist with the old socket, so reject it before persistence instead of
   * performing a fallible close-then-bind during publication.
   */
  async prepareConfig(input: ApplyConfigInput): Promise<PreparedOutboundApiConfig> {
    const wantAddr = input.networkBinding ? LAN_ADDR : LOOPBACK_ADDR;
    const wantPort = input.port ?? DEFAULT_OUTBOUND_PORT;
    const running = this.server !== null;
    const portMatches = wantPort === 0 || this.boundPort === wantPort;
    const bindChanged = running && (this.boundAddr !== wantAddr || !portMatches);
    const requiresSerialHandoff = Boolean(
      input.enabled && running && bindChanged && this.boundPort === wantPort,
    );
    if (requiresSerialHandoff) {
      throw new Error(
        'outbound listener address changes on a live fixed port require disabling first or changing the port',
      );
    }
    const old = this.captureRuntimeSnapshot();
    let preparedListener: { server: http.Server; port: number } | null = null;
    if (input.enabled && (!running || bindChanged)) {
      preparedListener = await this.listenDetached(wantAddr, wantPort, true);
    }

    let published = false;
    const publish = async (): Promise<void> => {
      if (published) return;
      if (!input.enabled) {
        this.installConfigSnapshot(input);
        const previous = this.server;
        this.server = null;
        this.boundPort = 0;
        if (previous) this.closePublishedServer(previous);
        published = true;
        return;
      }
      if (!bindChanged && running) {
        this.installConfigSnapshot(input);
        published = true;
        return;
      }
      const replacement = preparedListener;
      if (!replacement) throw new Error('prepared outbound listener is unavailable');
      const previous = this.server;
      this.installConfigSnapshot(input);
      this.server = replacement.server;
      this.boundAddr = wantAddr;
      this.boundPort = replacement.port;
      preparedListener = null;
      this.announcePublishedListener(wantAddr, wantPort, replacement.port);
      if (previous) this.closePublishedServer(previous);
      published = true;
    };

    return {
      publish,
      rollback: async () => {
        if (!published) return;
        await this.restoreRuntimeSnapshot(old);
        published = false;
      },
      dispose: async () => {
        if (preparedListener) {
          await this.closeServer(preparedListener.server);
          preparedListener = null;
        }
      },
    };
  }

  /** Start the listener on `bindAddr:port`, falling back on EADDRINUSE. */
  async start(bindAddr: string, port: number): Promise<number> {
    if (this.server) return this.boundPort;
    const listener = await this.listenDetached(bindAddr, port, true);
    const actualPort = listener.port;
    this.server = listener.server;
    this.boundAddr = bindAddr;
    this.boundPort = actualPort;
    if (actualPort !== port) this.onPortChange?.(actualPort);
    this.logInfo(`[OutboundApiServer] Listening on ${bindAddr}:${actualPort}`);
    return actualPort;
  }

  /** Bind once; on EADDRINUSE retry with an ephemeral port (port 0). */
  private listenDetached(
    bindAddr: string,
    port: number,
    allowFallback: boolean,
  ): Promise<{ server: http.Server; port: number }> {
    return new Promise((resolve, reject) => {
      const server = this.createHttpServer();
      const onError = (err: NodeJS.ErrnoException) => {
        if (allowFallback && err.code === 'EADDRINUSE' && port !== 0) {
          server.removeListener('error', onError);
          // Retry on an ephemeral port.
          this.listenDetached(bindAddr, 0, false).then(resolve, reject);
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
          resolve({ server, port: addr.port });
        } else {
          reject(new Error('Failed to get outbound server address'));
        }
      });
    });
  }

  private createHttpServer(): http.Server {
    return http.createServer((req, res) => {
      this.onRequest(req, res);
    });
  }

  private installConfigSnapshot(input: ApplyConfigInput): void {
    this.endpoints = input.endpoints;
    this.bindings = input.bindings ?? [];
    this.userMessageQueue = input.userMessageQueue;
    this.concurrencyQueue = input.concurrencyQueue;
    this.voucherConfig = input.voucher;
    this.anthropicConfig = input.anthropic;
    this.searchConfig = input.search;
    this.imagesEnabled = input.imagesEnabled === true;
    this.apiHelloEnabled = input.anthropic?.apiHello !== false;
    setAnthropicPingHeartbeatMs(input.anthropic?.heartbeatIntervalMs);
  }

  private captureRuntimeSnapshot(): OutboundRuntimeSnapshot {
    return {
      server: this.server,
      boundPort: this.boundPort,
      boundAddr: this.boundAddr,
      endpoints: this.endpoints,
      bindings: this.bindings,
      userMessageQueue: this.userMessageQueue,
      concurrencyQueue: this.concurrencyQueue,
      voucher: this.voucherConfig,
      anthropic: this.anthropicConfig,
      search: this.searchConfig,
      imagesEnabled: this.imagesEnabled,
    };
  }

  private installRuntimeSnapshot(snapshot: OutboundRuntimeSnapshot): void {
    this.endpoints = snapshot.endpoints;
    this.bindings = snapshot.bindings;
    this.userMessageQueue = snapshot.userMessageQueue;
    this.concurrencyQueue = snapshot.concurrencyQueue;
    this.voucherConfig = snapshot.voucher;
    this.anthropicConfig = snapshot.anthropic;
    this.searchConfig = snapshot.search;
    this.imagesEnabled = snapshot.imagesEnabled;
    this.apiHelloEnabled = snapshot.anthropic?.apiHello !== false;
    setAnthropicPingHeartbeatMs(snapshot.anthropic?.heartbeatIntervalMs);
  }

  private async restoreRuntimeSnapshot(snapshot: OutboundRuntimeSnapshot): Promise<void> {
    const current = this.server;
    if (current && current !== snapshot.server) await this.closeServer(current);
    this.installRuntimeSnapshot(snapshot);
    if (!snapshot.server) {
      this.server = null;
      this.boundAddr = LOOPBACK_ADDR;
      this.boundPort = 0;
      return;
    }
    if (snapshot.server.listening) {
      this.server = snapshot.server;
      this.boundAddr = snapshot.boundAddr;
      this.boundPort = snapshot.boundPort;
      return;
    }
    const restored = await this.listenDetached(snapshot.boundAddr, snapshot.boundPort, false);
    this.server = restored.server;
    this.boundAddr = snapshot.boundAddr;
    this.boundPort = restored.port;
  }

  private closeServer(server: http.Server): Promise<void> {
    if (!server.listening) return Promise.resolve();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  /** Publication already swapped the authoritative pointer; retirement cannot fail it. */
  private closePublishedServer(server: http.Server): void {
    if (!server.listening) return;
    try {
      server.close(() => {
        try {
          this.logInfo('[OutboundApiServer] Stopped');
        } catch {
          // Logging cannot turn a committed listener snapshot into a failure.
        }
      });
    } catch {
      // A prepared publication never reports failure after its snapshot swap.
    }
  }

  private announcePublishedListener(bindAddr: string, requestedPort: number, actualPort: number): void {
    if (actualPort !== requestedPort) {
      try {
        this.onPortChange?.(actualPort);
      } catch {
        // Publication hooks are advisory and cannot invalidate the committed socket swap.
      }
    }
    try {
      this.logInfo(`[OutboundApiServer] Listening on ${bindAddr}:${actualPort}`);
    } catch {
      // Logging cannot turn a committed listener snapshot into a failure.
    }
  }

  /** Per-request handler. Auth is enforced on EVERY request (incl. loopback). */
  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Defensively collapse a doubled `/v1/messages/v1/messages` (etc.) request
    // path ONCE at the entry so audit / selectEndpoint / dispatch all see the
    // clean path. elftia's baseUrl already ends in `/v1/messages` and some
    // clients (ClaudeCode) append it again. No-op for normal (non-doubled)
    // paths and for /health, /admin/*, voucher redeem, and Gemini routes.
    if (req.url) req.url = normalizeDoubledEndpointPath(req.url);
    // UNAUTHENTICATED liveness/readiness probe (daemon-health-endpoint, D1
    // secondary mount) — served BEFORE key-auth so an orchestrator can probe the
    // traffic port. Only mounted when the daemon wired a provider; otherwise the
    // path falls through to normal auth (zero-regression).
    if (this.deps.healthReportProvider && this.tryServeHealth(req, res)) return;
    // R10 (claude-api-experience-extras): `HEAD /api/hello` — clients probe
    // whether the endpoint can be safely rejected; a bare unauthenticated 200
    // is the friendly answer. Sits beside /health at the LISTENER level (before
    // key auth) but honors its own switch (default ON; `apiHello:false` keeps
    // the previous fall-through behavior).
    if (this.tryServeApiHello(req, res)) return;
    handleOutboundRequest(
      req,
      res,
      this.deps,
      {
        endpoints: this.endpoints,
        bindings: this.bindings,
        userMessageQueue: this.userMessageQueue,
        concurrencyQueue: this.concurrencyQueue,
        voucher: this.voucherConfig,
        anthropic: this.anthropicConfig,
        search: this.searchConfig,
      },
      this.rateLimiter,
      this.serialQueue,
      this.concurrencyGate,
      this.redeemLimiter,
      this.redeemMutex,
    ).catch((err) => {
      const message = serializeError(err);
      this.logError('[OutboundApiServer] unhandled error:', message);
      // Last-resort 500: consults the Anthropic-protocol mark (set at the
      // handleOutboundRequest entry) so an Anthropic request gets the Anthropic
      // shape; every other path keeps the legacy envelope.
      if (!res.headersSent) {
        if (isAnthropicProtocolResponse(res)) {
          writeAnthropicError(res, 500, message);
        } else {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'outbound_api_error', message } }));
        }
      }
    });
  }

  /**
   * Serve `HEAD /api/hello` (exact path, query tolerated) with a bare 200 —
   * returning true when it handled the request. Unauthenticated by design and
   * gated on `anthropic.apiHello` (default true).
   */
  private tryServeApiHello(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (!this.apiHelloEnabled) return false;
    if (req.method !== 'HEAD') return false;
    const path = (req.url ?? '/').split('?')[0]?.replace(/\/+$/, '') || '/';
    if (path !== '/api/hello') return false;
    res.writeHead(200);
    res.end();
    return true;
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
    const images = this.imagesEnabled ? imageFormatUrls(loopbackBase) : undefined;
    const lanImages = this.imagesEnabled && lanBase ? imageFormatUrls(lanBase) : undefined;
    return {
      running: true,
      port,
      loopbackUrl: loopbackBase,
      lanUrl: lanBase,
      formats: formatUrls(loopbackBase),
      lanFormats: lanBase ? formatUrls(lanBase) : null,
      ...(images ? { images } : {}),
      ...(lanImages ? { lanImages } : {}),
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

function imageFormatUrls(base: string): { generations: string; edits: string } {
  return {
    generations: `${base}/v1/images/generations`,
    edits: `${base}/v1/images/edits`,
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

/**
 * Collapse a repeated `/v1/<endpoint>` suffix (e.g. `/v1/messages/v1/messages`
 * → `/v1/messages`). elftia's baseUrl already ends in `/v1/messages` and some
 * clients (ClaudeCode) append the same path again; routing works today by
 * suffix match, but the doubled path pollutes the audit `path` field and breaks
 * usage correlation. Normalizing once at the http entry keeps every downstream
 * consumer (audit / selectEndpoint / dispatch) on the clean path.
 *
 * Covers the three chat-shape endpoints: `/v1/messages`, `/v1/responses`,
 * `/v1/chat/completions`. Leaves every other path (`/health`, `/admin/*`,
 * voucher `/redeem`, Gemini `:generateContent`) unchanged. The query string is
 * preserved.
 */
export function normalizeDoubledEndpointPath(url: string): string {
  const queryIdx = url.indexOf('?');
  const path = queryIdx === -1 ? url : url.slice(0, queryIdx);
  const query = queryIdx === -1 ? '' : url.slice(queryIdx);
  // Match a prefix followed by the SAME `/v1/<endpoint>` twice (backreference).
  const collapsed = path.replace(
    /^(.*?)(\/v1\/(?:messages|responses|chat\/completions))\2$/,
    '$1$2',
  );
  return collapsed + query;
}
