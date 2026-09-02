/**
 * Environment proxy resolution for the search transport.
 *
 * Ported from Elftia's `nodeWebFetchTransport.resolveNodeProxySettings` +
 * dispatcher cache. `EnvHttpProxyAgent` applies the `no_proxy` rules itself, so
 * this module only decides WHETHER a proxied dispatcher is needed and keeps one
 * cached per proxy signature.
 *
 * Nothing here ever reaches an error message or a diagnostic: a proxy URL can
 * carry credentials.
 *
 * @module search/http/proxy
 */

import { EnvHttpProxyAgent, type Dispatcher } from 'undici';

/** The conventional proxy variables, read case-insensitively in pairs. */
export type ProxyEnvironment = Readonly<Record<string, string | undefined>>;

/** Resolved proxy configuration, in `EnvHttpProxyAgent`'s option shape. */
export interface SearchProxySettings {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
}

let cachedProxySignature = '';
let cachedProxyDispatcher: Dispatcher | undefined;

/**
 * Resolve `all_proxy` / `http_proxy` / `https_proxy` / `no_proxy` (either case).
 * Returns `undefined` when no proxy is configured — the direct-connection case.
 */
export function resolveSearchProxySettings(
  env: ProxyEnvironment = process.env,
): SearchProxySettings | undefined {
  const allProxy = firstNonEmpty(env.all_proxy, env.ALL_PROXY);
  const httpProxy = firstNonEmpty(env.http_proxy, env.HTTP_PROXY, allProxy);
  const httpsProxy = firstNonEmpty(env.https_proxy, env.HTTPS_PROXY, allProxy);
  if (!httpProxy && !httpsProxy) return undefined;

  const noProxy = firstNonEmpty(env.no_proxy, env.NO_PROXY);
  return {
    ...(httpProxy ? { httpProxy } : {}),
    ...(httpsProxy ? { httpsProxy } : {}),
    ...(noProxy ? { noProxy } : {}),
  };
}

/**
 * One dispatcher per proxy signature, reused across requests.
 *
 * The previous dispatcher is deliberately NOT closed when the signature
 * changes: a concurrent request may still be reading through it.
 */
export function getSearchProxyDispatcher(proxy: SearchProxySettings): Dispatcher {
  const signature = JSON.stringify(proxy);
  if (cachedProxyDispatcher && cachedProxySignature === signature) return cachedProxyDispatcher;

  cachedProxySignature = signature;
  cachedProxyDispatcher = new EnvHttpProxyAgent(proxy);
  return cachedProxyDispatcher;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}
