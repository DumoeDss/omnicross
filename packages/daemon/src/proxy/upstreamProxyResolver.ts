/**
 * upstreamProxyResolver — the daemon's layered proxy lookup injected into the
 * core `fetchUpstream` seam (upstream-proxy).
 *
 * Precedence (most specific wins): **account > provider > global(config) > env-var**.
 *  - account : `SubscriptionAccountEntry.proxy` for the selected pooled account.
 *  - provider: `server.proxy.byProvider[providerId]`.
 *  - global  : `server.proxy.global`.
 *  - env-var : `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` (+ lowercase), default-ON as
 *              the LOWEST layer (LEAD OQ1). `NO_PROXY` bypass is honored against
 *              the provider's canonical upstream host.
 *
 * The server-proxy segment is held in module state so an admin edit takes effect
 * without restart: {@link setServerProxyConfig} swaps it AND bumps the core
 * dispatcher generation (old dispatchers disposed). Core stays config-agnostic —
 * it only calls the resolver this module builds.
 *
 * @module @omnicross/daemon/proxy/upstreamProxyResolver
 */

import type { ProxyConfig } from '@omnicross/contracts/account-tokens-types';
import type { OutboundProxyConfig } from '@omnicross/core';
import {
  bumpUpstreamProxyGeneration,
  type UpstreamProxyContext,
} from '@omnicross/core/pipeline/upstreamFetch';

/** The live global/provider proxy segment (from `server.proxy`). */
let serverProxy: OutboundProxyConfig | undefined;

/**
 * Swap the live global/provider proxy segment (boot + admin PUT) and INVALIDATE
 * the core dispatcher cache so the change takes effect without a restart. Passing
 * `undefined` clears the config layers (env-var may still apply).
 */
export function setServerProxyConfig(proxy: OutboundProxyConfig | undefined): void {
  serverProxy = proxy;
  bumpUpstreamProxyGeneration();
}

/** Read the live global/provider proxy segment (default source for the resolver). */
export function getServerProxyConfig(): OutboundProxyConfig | undefined {
  return serverProxy;
}

/** One-time info-log guard for the env-var proxy layer (keyed by the resolved url). */
let envProxyLoggedFor: string | undefined;

/** Mask any `//user:pass@` userinfo so the log carries at most `host:port`. */
function maskProxyUrl(url: string): string {
  return url.replace(/\/\/[^/@]*@/, '//***@');
}

/** The hostname of the ctx target URL (lowercased), or `undefined` when absent/bad. */
function hostFromCtx(ctx: UpstreamProxyContext): string | undefined {
  if (!ctx.url) return undefined;
  try {
    return new URL(ctx.url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Whether `host` is loopback/localhost (never proxied — direct). */
function isLoopbackHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    host.startsWith('127.') ||
    host.endsWith('.localhost')
  );
}

/** Whether `NO_PROXY` (comma list; `*`, bare host, or `.suffix`) covers `host`. */
function noProxyMatches(noProxy: string | undefined, host: string): boolean {
  if (!noProxy) return false;
  for (const raw of noProxy.split(',')) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;
    const bare = entry.startsWith('.') ? entry.slice(1) : entry;
    if (host === bare || host.endsWith(`.${bare}`)) return true;
  }
  return false;
}

/**
 * The env-var proxy layer (default-ON, lowest precedence). Reads
 * `HTTPS_PROXY`/`ALL_PROXY`/`HTTP_PROXY` (+ lowercase). Returns `undefined` when
 * unset OR when the target host is loopback OR `NO_PROXY` covers it. The target
 * host comes from `ctx.url` ({@link fetchUpstream} injects it).
 */
export function resolveEnvProxy(
  ctx: UpstreamProxyContext,
  env: NodeJS.ProcessEnv = process.env,
): ProxyConfig | undefined {
  const raw =
    env.HTTPS_PROXY ??
    env.https_proxy ??
    env.ALL_PROXY ??
    env.all_proxy ??
    env.HTTP_PROXY ??
    env.http_proxy;
  if (!raw || !raw.trim()) return undefined;
  const host = hostFromCtx(ctx);
  if (host && (isLoopbackHost(host) || noProxyMatches(env.NO_PROXY ?? env.no_proxy, host))) {
    return undefined;
  }
  const url = raw.trim();
  // m6 (OQ1 default-ON): surface the env-var layer ONCE so a stale `HTTPS_PROXY`
  // silently routing upstream traffic is not a field surprise. Userinfo masked.
  if (envProxyLoggedFor !== url) {
    envProxyLoggedFor = url;
    console.info(`[upstream-proxy] routing upstream egress through the environment proxy: ${maskProxyUrl(url)}`);
  }
  return { url };
}

/** Injectable sources for the resolver (defaults read the module holder + process.env). */
export interface ProxyResolverSources {
  /** Per-account proxy lookup (decrypted). Absent ⇒ no per-account layer. */
  getAccountProxy?: (providerId: string, accountId: string) => ProxyConfig | undefined;
  /** Live global/provider segment source (default: the module holder). */
  getServerProxy?: () => OutboundProxyConfig | undefined;
  /** Env source (default: live `process.env`). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Build the layered resolver for `setUpstreamProxyResolver`. Applies precedence
 * account > provider > global > env and returns the winning `ProxyConfig` (or
 * `undefined` ⇒ direct fetch). Pure w.r.t. its sources — no throw escapes (a
 * source throw would propagate to the caller, which the core seam swallows).
 */
export function createUpstreamProxyResolver(
  src: ProxyResolverSources = {},
): (ctx: UpstreamProxyContext) => ProxyConfig | undefined {
  const readServer = src.getServerProxy ?? getServerProxyConfig;
  return (ctx) => {
    // 0. Universal bypass (ALL layers): a loopback target OR a host in `NO_PROXY`
    // is NEVER proxied — regardless of which layer (account/provider/global/env)
    // would otherwise supply a proxy. Upholds the near-universal proxy convention
    // AND keeps local mock upstreams direct.
    const host = hostFromCtx(ctx);
    if (host) {
      if (isLoopbackHost(host)) return undefined;
      const env = src.env ?? process.env;
      if (noProxyMatches(env.NO_PROXY ?? env.no_proxy, host)) return undefined;
    }
    // 1. per-account override (winning layer).
    if (src.getAccountProxy && ctx.providerId && ctx.accountId) {
      const account = src.getAccountProxy(ctx.providerId, ctx.accountId);
      if (account) return account;
    }
    const server = readServer();
    // 2. per-provider.
    if (ctx.providerId && server?.byProvider?.[ctx.providerId]) {
      return server.byProvider[ctx.providerId];
    }
    // 3. global (config).
    if (server?.global) return server.global;
    // 4. env-var (lowest, default-on).
    return resolveEnvProxy(ctx, src.env);
  };
}
