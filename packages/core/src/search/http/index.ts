/**
 * Bounded Node HTTP search transports and providers. Embedding hosts decide
 * enablement; extended engines and aggregation are not implicit opt-ins.
 */

export { builtinHttpSearchContributions, HTTP_SEARCH_CAPABILITIES } from './contributions';
export {
  extendedHttpSearchContributions,
  EXTENDED_HTTP_SEARCH_CAPABILITIES,
} from './extendedContributions';
export { HttpStartpageProvider } from './HttpStartpageProvider';
export { HttpEcosiaProvider } from './HttpEcosiaProvider';
export { HttpMojeekProvider } from './HttpMojeekProvider';
export {
  HttpPublicSearchProvider,
  type HttpPublicSearchOptions,
  type HttpPublicChildId,
} from './HttpPublicSearchProvider';
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
