/**
 * upstreamFetch — the single proxy-aware egress seam for `@omnicross/core`
 * (upstream-proxy).
 *
 * Every outbound UPSTREAM call (relay ingress `fetchFn` closures, the OAuth
 * token-refresh `FetchLike`, the Gemini Code Assist handshake) routes through
 * {@link fetchUpstream}. When a proxy resolves for the call it attaches an
 * undici {@link Dispatcher} (`ProxyAgent` for http/https, an `Agent` with a
 * socks5 connector for socks5); ABSENT any proxy it is a BARE `fetch` — the
 * dispatcher option is never set, so behavior is byte-identical to the
 * pre-change code (the zero-regression guarantee).
 *
 * Core stays config/account-agnostic: it only knows opaque `providerId` /
 * `accountId` strings + a {@link ProxyConfig} descriptor. The daemon injects the
 * layered lookup via {@link setUpstreamProxyResolver} — the same module-slot
 * pattern as `setSubscriptionRegistryForOutbound`. Core never imports config or
 * account material.
 *
 * Dispatchers are CACHED by resolved-proxy identity (one instance reused, not
 * per-request, so keep-alive holds and sockets don't leak). A config change bumps
 * a generation via {@link bumpUpstreamProxyGeneration} (also called by
 * `setUpstreamProxyResolver`) which disposes the old dispatchers and rebuilds on
 * next use.
 *
 * FROZEN SEAM: `#7` (client fingerprint) attaches per-account TLS/agent behavior
 * at this SAME dispatcher point — do not fork a second egress path.
 *
 * DEBUG TRACE: when a diagnostic caller explicitly installs an upstream-trace
 * path, relay calls (`ctx.providerId` set) clone the response and append the
 * FULL exchange (request + verbatim response incl. SSE) to the trace file. The
 * daemon audit runtime never installs this path, preventing duplicate body
 * storage. Absent a path (the default) it is a pure no-op — zero regression.
 *
 * @module @omnicross/core/pipeline/upstreamFetch
 */

import type { ProxyConfig } from '@omnicross/contracts/account-tokens-types';
import { Agent, buildConnector, type Dispatcher, ProxyAgent } from 'undici';
import { SocksClient } from 'socks';

import {
  getUpstreamTracePath,
  redactHeaders,
  REDACTED_BODY,
  writeUpstreamTrace,
} from './upstreamTrace';
import { getSharedAccountAllowanceStore } from './AccountAllowanceStore';
import {
  getSharedAccountRouteActivity,
  type AccountRouteActivityRecord,
  type AccountRouteEndpoint,
  type AccountRouteSessionSource,
} from './AccountRouteActivity';

export interface AccountRouteActivityContext {
  endpoint: AccountRouteEndpoint;
  sessionKey?: string;
  sessionSource: AccountRouteSessionSource;
  model: string;
  /**
   * Invoked once with the freshly-recorded activity record. Lets a caller
   * capture the record `id` so it can {@link AccountRouteActivityStore.amend}
   * the SAME row later, once a post-hoc fact (e.g. an overload event buried in
   * the 200 SSE body) becomes known during relay. Best-effort: never throws.
   */
  onRecorded?: (record: AccountRouteActivityRecord) => void;
}

/** The opaque call context the resolver maps to a proxy (precedence input). */
export interface UpstreamProxyContext {
  /** The subscription provider id (`claude`/`codex`/`gemini`/`opencodego`) or `'byo'`. */
  providerId?: string;
  /** The selected pooled account id (per-account override input). */
  accountId?: string;
  /**
   * Irreversible account identity allowed in debug traces. The raw `accountId`
   * remains available to proxy, allowance, and route-attribution internals only.
   */
  traceAccountFingerprint?: string;
  /** Metadata-only live route activity. Never contains prompts, headers, or tokens. */
  routeActivity?: AccountRouteActivityContext;
  /**
   * The target upstream URL. Injected by {@link fetchUpstream} so the resolver can
   * apply host-based bypass (loopback / `NO_PROXY`). Callers of the ingress helpers
   * do NOT set this — it is filled from the fetch `url`.
   */
  url?: string;
  /**
   * CREDENTIAL EXCHANGE — this call's request/response BODIES carry secrets (an
   * authorization code + PKCE verifier out, an access/refresh token back), so the
   * debug trace must record the exchange's METADATA only and replace both bodies
   * with a placeholder.
   *
   * Set it on every OAuth token-endpoint call (interactive login + refresh).
   * Those calls still need a `providerId` so the per-provider proxy layer applies
   * and so a failure is traceable at all — but the trace captures bodies verbatim
   * (that is its purpose for relay traffic), and a plaintext token must never
   * reach the trace file. Purely a trace concern: the proxy resolver ignores it.
   */
  redactBodies?: boolean;
}

/**
 * The layered proxy lookup the daemon injects. Applies precedence
 * account > provider > global > env and returns the WINNING `ProxyConfig`, or
 * `undefined` for a direct (non-proxied) call.
 */
export type UpstreamProxyResolver = (ctx: UpstreamProxyContext) => ProxyConfig | undefined;

/** A normalized, resolver-agnostic proxy the dispatcher factory consumes. */
interface NormalizedProxy {
  kind: 'http' | 'https' | 'socks5';
  host: string;
  port: number;
  username?: string;
  password?: string;
}

let resolver: UpstreamProxyResolver | null = null;
let generation = 0;
let cache = new Map<string, Dispatcher>();

/**
 * Inject (or clear, with `null`) the layered proxy resolver. Idempotent — last
 * write wins. Bumps the dispatcher generation so a resolver swap (or a config
 * edit that re-registers) rebuilds dispatchers from the new lookup and disposes
 * the old ones.
 */
export function setUpstreamProxyResolver(fn: UpstreamProxyResolver | null): void {
  resolver = fn;
  bumpUpstreamProxyGeneration();
}

/**
 * Invalidate every cached dispatcher (config change / admin edit). Old
 * dispatchers are `close()`d best-effort so in-flight sockets drain; new calls
 * rebuild from the current resolver output.
 */
export function bumpUpstreamProxyGeneration(): void {
  generation += 1;
  const old = cache;
  cache = new Map();
  for (const dispatcher of old.values()) {
    try {
      void (dispatcher as { close?: () => Promise<void> }).close?.();
    } catch {
      /* best-effort dispose — a failed close must never break egress */
    }
  }
}

/**
 * Whether this request's own signal was aborted because the downstream client
 * withdrew it (as opposed to a timeout, which is a real failure).
 *
 * Duck-typed on the reason's stable `code` - the `isAccountAllowanceExhaustedError`
 * idiom - because the error is minted in `provider-proxy` and this seam is in
 * `pipeline`, which must not depend on it.
 */
function isClientDisconnectAbort(signal: AbortSignal | null | undefined): boolean {
  if (!signal?.aborted) return false;
  const reason: unknown = signal.reason;
  if (!reason || typeof reason !== 'object') return false;
  return (reason as { code?: unknown }).code === 'client_disconnect';
}

/** Normalize either `ProxyConfig` shape to a resolved proxy, or `undefined` when malformed. */
function normalizeProxy(cfg: ProxyConfig): NormalizedProxy | undefined {
  if ('url' in cfg) {
    let u: URL;
    try {
      u = new URL(cfg.url);
    } catch {
      return undefined;
    }
    const proto = u.protocol.replace(/:$/, '').toLowerCase();
    const kind = proto === 'socks5' || proto === 'socks' ? 'socks5' : proto === 'https' ? 'https' : 'http';
    const port = u.port ? Number(u.port) : kind === 'https' ? 443 : kind === 'socks5' ? 1080 : 80;
    if (!u.hostname || !Number.isFinite(port)) return undefined;
    return {
      kind,
      host: u.hostname,
      port,
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
    };
  }
  const kind = cfg.type === 'socks5' ? 'socks5' : cfg.type === 'https' ? 'https' : 'http';
  if (!cfg.host || !Number.isFinite(cfg.port)) return undefined;
  return {
    kind,
    host: cfg.host,
    port: cfg.port,
    username: cfg.username || undefined,
    password: cfg.password || undefined,
  };
}

/**
 * A stable cache identity for a resolved proxy. Includes userinfo so a
 * credential change rebuilds the dispatcher. This string is an IN-MEMORY key
 * ONLY — it is never logged (logs print `host:port` only).
 */
function proxyKey(p: NormalizedProxy): string {
  return `${p.kind}://${p.username ?? ''}:${p.password ?? ''}@${p.host}:${p.port}`;
}

/** An undici connector that dials the target THROUGH a socks5 proxy. */
function socksConnector(p: NormalizedProxy): ReturnType<typeof buildConnector> {
  const base = buildConnector({});
  return ((options: { hostname: string; port?: number | string; protocol?: string }, callback: (err: Error | null, socket: unknown) => void) => {
    const destPort =
      Number(options.port) || (options.protocol === 'https:' ? 443 : 80);
    SocksClient.createConnection({
      proxy: { host: p.host, port: p.port, type: 5, userId: p.username, password: p.password },
      command: 'connect',
      destination: { host: options.hostname, port: destPort },
    })
      .then(({ socket }) => {
        // Hand undici the established socket so it upgrades TLS for https targets.
        (base as unknown as (o: unknown, cb: unknown) => void)({ ...options, httpSocket: socket }, callback);
      })
      .catch((err: unknown) => callback(err as Error, null));
  }) as ReturnType<typeof buildConnector>;
}

/** Build the undici dispatcher for a resolved proxy (http/https or socks5). */
function buildDispatcher(p: NormalizedProxy): Dispatcher {
  if (p.kind === 'socks5') {
    return new Agent({ connect: socksConnector(p) });
  }
  // http/https CONNECT-tunnel via ProxyAgent; basic-auth carried in the URI userinfo.
  const auth =
    p.username != null
      ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password ?? '')}@`
      : '';
  const uri = `${p.kind}://${auth}${p.host}:${p.port}`;
  return new ProxyAgent({ uri });
}

/**
 * Resolve the dispatcher for one call. Returns `undefined` (⇒ bare fetch) when
 * no resolver is registered, the resolver returns undefined, or the descriptor
 * is malformed. A resolver throw is swallowed → direct call (egress never breaks
 * on a proxy-lookup error).
 */
export function resolveUpstreamDispatcher(ctx: UpstreamProxyContext): Dispatcher | undefined {
  const active = resolver;
  if (!active) return undefined;
  let cfg: ProxyConfig | undefined;
  try {
    cfg = active(ctx);
  } catch {
    return undefined;
  }
  if (!cfg) return undefined;
  const norm = normalizeProxy(cfg);
  if (!norm) return undefined;
  const key = `${generation}\0${proxyKey(norm)}`;
  let dispatcher = cache.get(key);
  if (!dispatcher) {
    dispatcher = buildDispatcher(norm);
    cache.set(key, dispatcher);
  }
  return dispatcher;
}

/**
 * Proxy-aware `fetch`. Attaches the resolved undici dispatcher ONLY when a proxy
 * applies; otherwise it is a BARE `fetch(url, init)` — byte-identical to the
 * pre-change egress (zero-regression). The `dispatcher` option is undici-specific
 * (Node's global fetch IS undici); the cast threads it without a DOM-lib type.
 */
export function fetchUpstream(
  url: string,
  init: RequestInit,
  ctx?: UpstreamProxyContext,
): Promise<Response> {
  // Inject the target url so the resolver can bypass loopback / NO_PROXY hosts.
  const dispatcher = resolveUpstreamDispatcher({ ...(ctx ?? {}), url });
  const doFetch = dispatcher
    ? () => fetch(url, { ...init, dispatcher } as RequestInit)
    : () => fetch(url, init);

  // Passive Codex allowance capture. The egress context contains the account id
  // selected for THIS request, so attribution cannot drift to the active/default
  // account during concurrent pool traffic. Missing account ids and non-Codex
  // calls are strict no-ops. Parsing/storage must never be able to break serving.
  const doFetchWithAllowanceTap = (): Promise<Response> =>
    doFetch().then((response) => {
      if (ctx?.providerId === 'codex' && ctx.accountId) {
        try {
          getSharedAccountAllowanceStore().recordCodexHeaders(ctx.accountId, response.headers);
        } catch {
          /* allowance telemetry is best-effort */
        }
      }
      return response;
    });

  // Metadata-only recent route activity. The account id comes from the auth
  // strategy's reportSelection callback, so it is the account actually used by
  // this upstream attempt rather than the mutable active/default pointer.
  const activity = ctx?.routeActivity;
  const activityStartedAt = activity && ctx?.providerId && ctx.accountId ? Date.now() : 0;
  const recordActivity = (status: number): void => {
    if (!activity || !ctx?.providerId || !ctx.accountId) return;
    const record = getSharedAccountRouteActivity().record({
      providerId: ctx.providerId,
      accountId: ctx.accountId,
      endpoint: activity.endpoint,
      sessionKey: activity.sessionKey,
      sessionSource: activity.sessionSource,
      model: activity.model,
      status,
      durationMs: Math.max(0, Date.now() - activityStartedAt),
      ts: activityStartedAt,
    });
    try {
      activity.onRecorded?.(record);
    } catch {
      /* a telemetry callback must never break egress */
    }
  };
  const doFetchWithActivity = (): Promise<Response> =>
    doFetchWithAllowanceTap().then(
      (response) => {
        recordActivity(response.status);
        return response;
      },
      (error: unknown) => {
        // A request the DOWNSTREAM client withdrew is not an upstream failure:
        // the account did not fail, the caller went away. Recording it would
        // paint a red "Network error" row in the upstreams view (status 0),
        // indistinguishable from a real DNS/connection fault - precisely the
        // distinction an operator needs during a proxy incident. Every OTHER
        // rejection still records, a total-duration TIMEOUT included: that IS a
        // failure worth seeing.
        //
        // Only reachable before the response headers arrive. A mid-stream
        // hang-up aborts the BODY, long after `fetch` resolved and this handler's
        // sibling already recorded the real status.
        if (!isClientDisconnectAbort(init.signal)) recordActivity(0);
        throw error;
      },
    );

  // Upstream-exchange trace (debugging). Only relay calls carry a `providerId`;
  // OAuth-refresh / webhook sends pass no ctx, so they are skipped (less noise).
  // Zero work when no trace path is installed. See `upstreamTrace.ts`.
  const tracePath = getUpstreamTracePath();
  if (!tracePath || !ctx?.providerId) return doFetchWithActivity();

  const startedAt = Date.now();
  const method = typeof init.method === 'string' ? init.method : 'GET';
  const requestHeaders = redactHeaders(
    init.headers as Headers | Record<string, string> | Array<[string, string]> | undefined,
  );
  // A credential exchange (OAuth login / token refresh) carries the code +
  // verifier out and the minted access/refresh token back. Trace the exchange's
  // metadata — url, status, duration, headers, byte count — but NEVER the bodies.
  const redactBodies = ctx.redactBodies === true;
  const requestBody = redactBodies
    ? REDACTED_BODY
    : typeof init.body === 'string'
      ? init.body
      : null;
  const providerId = ctx.providerId;
  const accountId = ctx.traceAccountFingerprint ?? ctx.accountId;

  return doFetchWithActivity()
    .then((res) => {
      // Tee the stream: the relay keeps streaming `res`; the clone is buffered
      // fully (a `text/event-stream` included) and written to the trace.
      const clone = res.clone();
      const status = res.status;
      const statusText = res.statusText;
      const responseHeaders = redactHeaders(res.headers);
      void clone
        .text()
        .then((body) => {
          writeUpstreamTrace({
            ts: startedAt,
            durationMs: Date.now() - startedAt,
            providerId,
            accountId,
            url,
            method,
            requestHeaders,
            requestBody,
            status,
            statusText,
            responseHeaders,
            // The byte count stays REAL even when redacted — it is a useful
            // diagnostic and reveals nothing about the token itself.
            responseBody: redactBodies ? REDACTED_BODY : body,
            responseBytes: Buffer.byteLength(body, 'utf8'),
          });
        })
        .catch(() => {
          /* a trace read failure must never affect egress */
        });
      return res;
    })
    .catch((err: unknown) => {
      // A failed upstream call is often THE thing under test — record it too.
      const msg = err instanceof Error ? err.message : String(err);
      writeUpstreamTrace({
        ts: startedAt,
        durationMs: Date.now() - startedAt,
        providerId,
        accountId,
        url,
        method,
        requestHeaders,
        requestBody,
        status: 0,
        statusText: '',
        responseHeaders: {},
        responseBody: `<UPSTREAM FETCH ERROR: ${msg}>`,
        responseBytes: 0,
      });
      throw err;
    });
}

/** TEST SEAM — clear the resolver + cache so a suite starts from the direct-fetch baseline. */
export function __resetUpstreamProxyForTests(): void {
  resolver = null;
  bumpUpstreamProxyGeneration();
}
