/**
 * The browser-impersonating fetch primitive for the keyless HTTP slice.
 *
 * Ported from Elftia's `nodeWebFetchTransport` (the impit half): impit supplies
 * a current-Chrome TLS/HTTP2 fingerprint, which is the difference between a
 * real SERP and a bot-decoy page on engines that fingerprint the client
 * handshake. This is a verified config — `browser`, `followRedirects` and
 * `vanillaFallback` mirror Elftia exactly; do not deviate.
 *
 * Fixed semantics:
 * - `followRedirects: false`, so the transport's manual, egress-validated
 *   redirect walk keeps sole ownership of hop decisions.
 * - `vanillaFallback: false`: if the platform binary is unavailable we degrade
 *   to the bounded undici path IN THIS MODULE'S CALLER — never silently to a
 *   vanilla (non-impersonating) impit mode that would look like a browser and
 *   handshake like Node.
 * - Request-specific `user-agent`/`sec-ch-ua*` headers are REMOVED, so the
 *   headers stay consistent with the impersonated fingerprint (impit sends its
 *   own matching set).
 * - One client per proxy URL, cached; if `impit` cannot be imported at all the
 *   answer is `undefined` and the caller uses the undici fallback.
 *
 * @module search/http/impit
 */

import type { ProxyConfig } from '@omnicross/contracts/account-tokens-types';
import type { Impit, ImpitOptions } from 'impit';
import type { Dispatcher } from 'undici';

/** The impit browser target Elftia's verified transport pins. */
export const IMPIT_BROWSER = 'chrome151' as const;

/**
 * Headers the impersonated client owns. A request-specific value would
 * contradict the fingerprint's own consistent set, so they are deleted.
 */
export const IMPERSONATED_HEADERS = [
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'user-agent',
] as const;

/** Structural constructor type — resilient to impit being absent at runtime. */
export type ImpitConstructor = new (options?: ImpitOptions) => Impit;

/** The kind of client that actually served one fetch — plan §11.4 observable. */
export type SearchFetchKind = 'impit' | 'undici';

/** Marker a fetch wrapper attaches to its own rejections (never enumerated). */
const TRANSPORT_KIND = Symbol('searchFetchKind');

export function tagFetchKind(error: unknown, kind: SearchFetchKind): void {
  if (error instanceof Error) {
    (error as Error & { [TRANSPORT_KIND]?: SearchFetchKind })[TRANSPORT_KIND] = kind;
  }
}

export function fetchKindOf(error: unknown): SearchFetchKind | undefined {
  return (error as { [TRANSPORT_KIND]?: SearchFetchKind } | undefined)?.[TRANSPORT_KIND];
}

let impitConstructorPromise: Promise<ImpitConstructor | undefined> | undefined;
const impitClients = new Map<string, Impit>();

/** Load the impit constructor once; a missing binary resolves `undefined`. */
export function loadImpitConstructor(): Promise<ImpitConstructor | undefined> {
  impitConstructorPromise ??= import('impit')
    .then((module) => module.Impit as unknown as ImpitConstructor)
    .catch(() => undefined);
  return impitConstructorPromise;
}

/**
 * One impit client per proxy URL, mirroring Elftia's client cache.
 *
 * An injectable constructor keeps this unit-testable without a platform
 * binary; production takes the dynamic-import default.
 */
export async function getImpitClient(
  proxyUrl: string | undefined,
  load: (this: void) => Promise<ImpitConstructor | undefined> = loadImpitConstructor,
): Promise<Impit | undefined> {
  const ImpitClient = await load();
  if (!ImpitClient) return undefined;

  const key = proxyUrl ?? '<direct>';
  const cached = impitClients.get(key);
  if (cached) return cached;

  const client = new ImpitClient({
    browser: IMPIT_BROWSER,
    followRedirects: false,
    vanillaFallback: false,
    ...(proxyUrl ? { proxyUrl } : {}),
  });
  impitClients.set(key, client);
  return client;
}

/** Drop the headers the impersonated client owns from a request init. */
export function withImpersonatedHeaders(init: RequestInit): RequestInit {
  const headers = new Headers(init.headers);
  for (const name of IMPERSONATED_HEADERS) headers.delete(name);
  return { ...init, headers };
}

/**
 * A `ProxyConfig` as the URL string impit's `proxyUrl` option takes.
 *
 * SOCKS proxies are rendered as `socks5h://` (remote DNS): impit's local-DNS
 * `socks5://` variant hangs against real SOCKS servers — verified live
 * 2026-09-03, `socks5h` answered in ~1.3s where `socks5` timed out. HTTP and
 * HTTPS proxies pass through unchanged.
 *
 * `undefined` when the config is malformed — the caller then searches direct
 * rather than inventing a proxy target.
 */
export function proxyConfigToUrl(config: ProxyConfig): string | undefined {
  if ('url' in config) {
    try {
      const protocol = new URL(config.url).protocol;
      if (protocol === 'http:' || protocol === 'https:') return config.url;
      if (protocol === 'socks5:' || protocol === 'socks5h:') {
        return `socks5h://${config.url.slice(protocol.length + 2)}`;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }
  if (!config.host || !Number.isFinite(config.port)) return undefined;
  const auth = config.username
    ? `${encodeURIComponent(config.username)}:${encodeURIComponent(config.password ?? '')}@`
    : '';
  if (config.type !== 'http' && config.type !== 'https' && config.type !== 'socks5') {
    return undefined;
  }
  const scheme = config.type === 'socks5' ? 'socks5h' : config.type;
  return `${scheme}://${auth}${config.host}:${config.port}`;
}

/** The layered override's answer for one URL, as an impit proxy URL. */
export function impitProxyUrlFrom(
  resolve: ((url: string) => ProxyConfig | undefined) | undefined,
  url: string,
): string | undefined {
  const config = resolve?.(url);
  return config ? proxyConfigToUrl(config) : undefined;
}

// `Dispatcher` keeps the undici fallback's option surface honest for callers
// that thread both primitives; impit itself never consumes one.
export type { Dispatcher };
