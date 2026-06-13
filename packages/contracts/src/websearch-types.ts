/**
 * Web Search Types
 *
 * Provider-neutral web-search contract type definitions.
 */

/** Supported search provider IDs */
export type WebSearchProviderId =
  | 'jina'
  | 'zhipu'
  | 'z.ai'
  | 'tavily'
  | 'exa'
  | 'searxng'
  | 'bocha'
  | 'claude'
  | 'grok'
  | 'local-google'
  | 'local-bing'
  | 'local-baidu'
  | 'local-duckduckgo';

/** Provider type classification */
export type WebSearchProviderType = 'api' | 'local';

/** Search provider configuration */
export interface WebSearchProviderConfig {
  /** Unique provider identifier */
  id: WebSearchProviderId;
  /** Whether the provider is enabled */
  enabled: boolean;
  /** API key(s), comma-separated for rotation */
  apiKey?: string;
  /** Custom API host URL */
  apiHost?: string;
  /** HTTP basic auth username (for Searxng) */
  basicAuthUsername?: string;
  /** HTTP basic auth password (for Searxng) */
  basicAuthPassword?: string;
}

/** Individual search result item */
export interface WebSearchResult {
  /** Result title */
  title: string;
  /** Result content/snippet */
  content: string;
  /** Source URL */
  url: string;
}

/** Search response from a provider */
export interface WebSearchResponse {
  /** Whether the search was successful */
  success: boolean;
  /** The search query used */
  query: string;
  /** Array of search results */
  results: WebSearchResult[];
  /** Provider that performed the search */
  provider?: WebSearchProviderId;
  /** Error message if failed */
  error?: string;
}

/** Search options for a single search request */
export interface WebSearchOptions {
  /** Maximum number of results */
  maxResults?: number;
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Fetch full page content (Jina: uses X-Engine: direct) */
  fetchPageContent?: boolean;
}

/** Jina Reader response for fetching URL content */
export interface JinaReaderResponse {
  /** Whether the request was successful */
  success: boolean;
  /** The URL that was read */
  url: string;
  /** Page title */
  title?: string;
  /** Page content in markdown format */
  content?: string;
  /** Error message if failed */
  error?: string;
}

/** Check if provider is API type */
export function isApiProvider(id: WebSearchProviderId): boolean {
  return !id.startsWith('local-');
}

/** Check if provider is local type */
export function isLocalProvider(id: WebSearchProviderId): boolean {
  return id.startsWith('local-');
}
