/**
 * `@omnicross/core/search/http` — the keyless HTTP search slice (plan 阶段2).
 *
 * Two providers (`http-bing`, `http-duckduckgo`) implementing
 * `SearchProvider` from `@omnicross/contracts/search-types`, on one shared
 * undici transport with explicit UA/redirect/body-cap/timeout/proxy/cancellation
 * semantics. Pure Node: no Elftia, no Electron, no host runtime.
 *
 * This is the ONLY subpath the search tree exports. The bare `search` subpath is
 * deliberately unclaimed — it belongs to 阶段3's runtime index.
 *
 * Nothing here is wired into an existing runtime path: the providers are
 * standalone until the registry arrives.
 *
 * @module search/http
 */

export { builtinHttpSearchContributions, HTTP_SEARCH_CAPABILITIES } from './contributions';
export {
  clampMaxResults,
  DEFAULT_MAX_RESULTS,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_RESULTS,
  SEARCH_RESPONSE_BYTES,
} from './engine';
export { SEARCH_BROWSER_HEADERS } from './headers';
export { HttpBingProvider, HTTP_BING_PROVIDER_ID } from './HttpBingProvider';
export { HttpDuckDuckGoProvider, HTTP_DUCKDUCKGO_PROVIDER_ID } from './HttpDuckDuckGoProvider';
export {
  createSearchHttpTransport,
  defaultSearchHttpTransport,
  MAX_REDIRECTS,
  type SearchHttpTransportOptions,
} from './transport';
export { SEARCH_HTTP_TRANSPORT_ID } from './types';
export type {
  ParsedSerp,
  SearchHttpFetch,
  SearchHttpRequest,
  SearchHttpResource,
  SearchHttpStage,
  SearchHttpTransport,
} from './types';
