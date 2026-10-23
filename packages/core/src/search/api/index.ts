/**
 * API search providers on a shared bounded, redacting and egress-checked
 * transport. Configuration controls registration; public mode never consumes
 * a stored credential and no provider is enabled by importing this module.
 */

export {
  ADDITIONAL_API_CAPABILITIES,
  ADDITIONAL_API_PROVIDER_IDS,
  KEYLESS_API_PROVIDER_IDS,
} from './additionalContributions';
export { BochaSearchProvider, BOCHA_CAPABILITIES } from './BochaSearchProvider';
export { BraveSearchProvider, BRAVE_CAPABILITIES } from './BraveSearchProvider';
export { ClaudeSearchProvider, CLAUDE_CAPABILITIES } from './ClaudeSearchProvider';
export { ExaSearchProvider, EXA_CAPABILITIES } from './ExaSearchProvider';
export { FirecrawlSearchProvider, FIRECRAWL_CAPABILITIES } from './FirecrawlSearchProvider';
export { KagiSearchProvider, KAGI_CAPABILITIES } from './KagiSearchProvider';
export { KimiSearchProvider, KIMI_CAPABILITIES } from './KimiSearchProvider';
export { OllamaSearchProvider, OLLAMA_CAPABILITIES } from './OllamaSearchProvider';
export { ParallelSearchProvider, PARALLEL_CAPABILITIES } from './ParallelSearchProvider';
export { PerplexitySearchProvider, PERPLEXITY_CAPABILITIES } from './PerplexitySearchProvider';
export { SyntheticSearchProvider, SYNTHETIC_CAPABILITIES } from './SyntheticSearchProvider';
export { TinyfishSearchProvider, TINYFISH_CAPABILITIES } from './TinyfishSearchProvider';
export {
  apiSearchContributions,
  DEEPSEEK_CAPABILITIES,
  JINA_CAPABILITIES,
  SEARXNG_CAPABILITIES,
  TAVILY_CAPABILITIES,
  ZHIPU_CAPABILITIES,
  type ApiSearchContributionOptions,
} from './contributions';
export {
  DEEPSEEK_DEFAULT_HOST,
  DEEPSEEK_DEFAULT_MAX_RESULTS,
  DEEPSEEK_MAX_RESULTS_LIMIT,
  DEEPSEEK_PROVIDER_ID,
  DeepseekSearchProvider,
  normalizeDeepseekApiUrl,
  type DeepseekApiKeyResolver,
} from './DeepseekSearchProvider';
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
  DeepseekProviderConfig,
  KeyedSearchProviderConfig,
  KeylessSearchProviderConfig,
  ExaProviderConfig,
  ParallelProviderConfig,
  FirecrawlProviderConfig,
  BraveProviderConfig,
  KagiProviderConfig,
  KimiProviderConfig,
  SyntheticProviderConfig,
  OllamaProviderConfig,
  TinyfishProviderConfig,
  PerplexityProviderConfig,
  BochaProviderConfig,
  ClaudeProviderConfig,
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
