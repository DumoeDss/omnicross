/**
 * sanitizeProxy — secret-free projection of a `ProxyConfig` (upstream-proxy).
 *
 * The proxy `password` (and any userinfo in a `url`-form proxy) is a SECRET. This
 * pure helper masks it to a `hasPassword` presence flag plus a display-safe
 * `host:port` endpoint (userinfo stripped), so admin GET views (per-account +
 * server global/provider) never leak proxy credentials. No core/daemon deps →
 * import-safe from the account walker and the admin router alike.
 *
 * @module @omnicross/daemon/proxy/sanitizeProxy
 */

import type { ProxyConfig, SanitizedProxyConfig } from '@omnicross/contracts/account-tokens-types';
import type { OutboundProxyConfig } from '@omnicross/core';

/** Project a `ProxyConfig` to its secret-free view; the password never leaves. */
export function sanitizeProxyConfig(cfg: ProxyConfig): SanitizedProxyConfig {
  if ('url' in cfg) {
    let endpoint: string | undefined;
    let username: string | undefined;
    let hasPassword = false;
    try {
      const u = new URL(cfg.url);
      endpoint = u.port ? `${u.hostname}:${u.port}` : u.hostname;
      username = u.username ? decodeURIComponent(u.username) : undefined;
      hasPassword = u.password.length > 0;
    } catch {
      /* malformed url → endpoint omitted; still never expose the raw string */
    }
    return { kind: 'url', endpoint, username, hasPassword };
  }
  return {
    kind: cfg.type,
    endpoint: `${cfg.host}:${cfg.port}`,
    username: cfg.username,
    hasPassword: typeof cfg.password === 'string' && cfg.password.length > 0,
  };
}

/**
 * Redact a `ProxyConfig`'s secret while KEEPING its shape (for the server-config
 * GET, which round-trips the config type). Structured → drops `password`; url →
 * strips the userinfo password. The result is safe to serialize to an admin
 * client; the plaintext password never leaves.
 */
export function redactProxyConfig(cfg: ProxyConfig): ProxyConfig {
  if ('url' in cfg) {
    try {
      const u = new URL(cfg.url);
      if (u.password) u.password = '';
      return { url: u.toString() };
    } catch {
      return cfg;
    }
  }
  const { password: _password, ...rest } = cfg;
  return rest;
}

/** Redact the passwords of a whole `OutboundProxyConfig` segment (server GET view). */
export function redactOutboundProxy(proxy: OutboundProxyConfig): OutboundProxyConfig {
  const out: OutboundProxyConfig = {};
  if (proxy.global) out.global = redactProxyConfig(proxy.global);
  if (proxy.byProvider) {
    const byProvider: Record<string, ProxyConfig> = {};
    for (const [key, value] of Object.entries(proxy.byProvider)) {
      byProvider[key] = redactProxyConfig(value);
    }
    out.byProvider = byProvider;
  }
  return out;
}

/**
 * Write-only password preservation (upstream-proxy). The admin GET masks the
 * proxy password, so a subsequent PUT that edits OTHER fields sends the structured
 * proxy WITHOUT a password. When the `incoming` structured proxy omits/blanks the
 * password AND the `current` (decrypted) config had one for the same layer, carry
 * the current password forward — so editing host/port never wipes the secret. A
 * url-form proxy carries its own userinfo, so it is returned as-is.
 */
export function preserveProxyConfigSecret(
  incoming: ProxyConfig,
  current: ProxyConfig | undefined,
): ProxyConfig {
  if (!current) return incoming;
  // url form: restore a stripped userinfo password from the current url.
  if ('url' in incoming) {
    if ('url' in current) {
      try {
        const inU = new URL(incoming.url);
        const curU = new URL(current.url);
        if (!inU.password && curU.password) {
          inU.password = curU.password;
          return { url: inU.toString() };
        }
      } catch {
        /* malformed url → return incoming as-is */
      }
    }
    return incoming;
  }
  if ('url' in current) return incoming;
  const blank = incoming.password === undefined || incoming.password === '';
  if (blank && typeof current.password === 'string' && current.password.length > 0) {
    return { ...incoming, password: current.password };
  }
  return incoming;
}

/** Apply {@link preserveProxyConfigSecret} across a whole segment (global + per-provider). */
export function preserveOutboundProxySecrets(
  incoming: OutboundProxyConfig,
  current: OutboundProxyConfig | undefined,
): OutboundProxyConfig {
  const out: OutboundProxyConfig = {};
  if (incoming.global) out.global = preserveProxyConfigSecret(incoming.global, current?.global);
  if (incoming.byProvider) {
    const byProvider: Record<string, ProxyConfig> = {};
    for (const [key, value] of Object.entries(incoming.byProvider)) {
      byProvider[key] = preserveProxyConfigSecret(value, current?.byProvider?.[key]);
    }
    out.byProvider = byProvider;
  }
  return out;
}
