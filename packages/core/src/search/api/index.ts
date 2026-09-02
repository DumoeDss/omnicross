/**
 * `@omnicross/core/search/api` — the reliable API search providers (plan 阶段4).
 *
 * Four adapters under five ids (`tavily`, `jina`, `searxng`, `zhipu`, `z.ai`)
 * implementing `SearchProvider` from `@omnicross/contracts/search-types`, on
 * one shared undici transport that owns egress validation, redirect walking,
 * taxonomy error mapping and secret redaction. Pure Node: no Elftia, no
 * Electron, no host runtime.
 *
 * Deliberately absent, with reasons:
 *
 * - `exa` and `bocha` — declared-but-dead ids in Elftia with NO adapter files.
 *   There is nothing to port, and inventing wire contracts from vendor docs
 *   would fail the plan's 经契约核对 gate. Deferred.
 * - `grok` and `claude` — not registered in Phase 1 (plan hard constraint 5).
 *
 * Nothing here auto-registers into a runtime. 阶段5's daemon assembly supplies
 * real configuration and decides what to expose; a runtime holding unconfigured
 * providers would advertise capabilities it cannot honor.
 *
 * @module search/api
 */

export {
  apiSearchContributions,
  JINA_CAPABILITIES,
  SEARXNG_CAPABILITIES,
  TAVILY_CAPABILITIES,
  ZHIPU_CAPABILITIES,
  type ApiSearchContributionOptions,
} from './contributions';
export { JinaReaderClient, JINA_READER_HOST } from './JinaReaderClient';
export {
  JinaSearchProvider,
  JINA_DEFAULT_HOST,
  JINA_DEFAULT_MAX_RESULTS,
  JINA_PROVIDER_ID,
} from './JinaSearchProvider';
export { ApiKeyRotator } from './rotator';
export {
  SearxngSearchProvider,
  SEARXNG_DEFAULT_MAX_RESULTS,
  SEARXNG_PROVIDER_ID,
} from './SearxngSearchProvider';
export {
  TavilySearchProvider,
  TAVILY_DEFAULT_HOST,
  TAVILY_DEFAULT_MAX_RESULTS,
  TAVILY_PROVIDER_ID,
} from './TavilySearchProvider';
// `selectApiDispatcher` and `payloadText` are deliberately NOT re-exported here.
// The first decides whether a connection gets the egress-guarded dispatcher or
// the proxy one — a decision that belongs to the transport, not to a consumer
// assembling its own; the second is a two-line coercion. Both stay reachable
// from the module for tests without becoming part of the subpath's contract.
export {
  API_MAX_REDIRECTS,
  API_RESPONSE_BYTES,
  apiConfigMissing,
  createSearchApiTransport,
  DEFAULT_API_TIMEOUT_MS,
  defaultSearchApiTransport,
  requireResultArray,
  sanitizeUpstreamText,
  type SearchApiTransportOptions,
} from './transport';
export { SEARCH_API_TRANSPORT_ID } from './types';
export type {
  JinaProviderConfig,
  SearchApiFetch,
  SearchApiProviderConfigs,
  SearchApiRequest,
  SearchApiStage,
  SearchApiTransport,
  SearxngProviderConfig,
  TavilyProviderConfig,
  ZhipuProviderConfig,
} from './types';
export {
  normalizeZhipuApiUrl,
  ZhipuSearchProvider,
  ZAI_PROVIDER_ID,
  ZHIPU_DEFAULT_HOSTS,
  ZHIPU_DEFAULT_MAX_RESULTS,
  ZHIPU_PROVIDER_ID,
} from './ZhipuSearchProvider';
