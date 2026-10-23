import {
  SearchProviderError,
  type SearchOptions,
  type SearchProvider,
  type SearchProviderCapabilities,
  type SearchResult,
} from '@omnicross/contracts/search-types';

import { excludedDomainsFromQuery, isExcludedSearchUrl } from '../domainFilters';
import { keyedEndpoint } from './keyedHelpers';
import { ApiKeyRotator } from './rotator';
import {
  apiConfigMissing,
  defaultSearchApiTransport,
  payloadText,
  requireResultArray,
  sanitizeUpstreamText,
} from './transport';
import { SEARCH_API_TRANSPORT_ID, type KeyedSearchProviderConfig, type SearchApiTransport } from './types';

export const PERPLEXITY_PROVIDER_ID = 'perplexity';
export const PERPLEXITY_DEFAULT_HOST = 'https://api.perplexity.ai';
export const PERPLEXITY_MAX_RESULTS = 20;
export const PERPLEXITY_CAPABILITIES: Readonly<SearchProviderCapabilities> = Object.freeze({
  requiresApiKey: true,
  supportsRegion: false,
  supportsLanguage: false,
  supportsTimeRange: true,
  supportsUrlRead: false,
  supportsCancellation: true,
  maxResults: PERPLEXITY_MAX_RESULTS,
});

/** Official Search API, not Sonar answers or the consumer site's cookie/ask API.
 * https://docs.perplexity.ai/api-reference/search-post
 * This endpoint has no model field; config.model is intentionally unused.
 */
export class PerplexitySearchProvider implements SearchProvider {
  readonly id = PERPLEXITY_PROVIDER_ID;
  private readonly rotator = new ApiKeyRotator();

  constructor(
    private readonly config: KeyedSearchProviderConfig,
    private readonly transport: SearchApiTransport = defaultSearchApiTransport,
  ) {}

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const apiKey = this.rotator.pick(this.config.apiKey);
    if (!apiKey) throw apiConfigMissing(this.id, 'Perplexity API key is required');
    const url = keyedEndpoint(this.config.apiHost, `${PERPLEXITY_DEFAULT_HOST}/search`, this.id);
    const maxResults = Number.isFinite(options.maxResults) && (options.maxResults ?? 0) > 0
      ? Math.min(PERPLEXITY_MAX_RESULTS, Math.max(1, Math.floor(options.maxResults ?? 5)))
      : 5;
    const payload = await this.transport({
      url,
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      jsonBody: {
        query,
        max_results: maxResults,
        ...(options.timeRange ? { search_recency_filter: options.timeRange } : {}),
      },
      providerId: this.id,
      label: 'Perplexity',
      timeoutMs: options.timeout,
      signal: options.signal,
      secrets: this.rotator.allKeys(this.config.apiKey),
    });

    const record = asRecord(payload);
    if (record.error != null || record.type === 'error') {
      const error = asRecord(record.error);
      const type = payloadText(error.type) || payloadText(error.code);
      const code = type === 'authentication_error' || type === 'invalid_api_key'
        ? 'auth_failed'
        : type === 'rate_limit_error' || type === 'rate_limit_exceeded'
          ? 'rate_limited'
          : 'upstream_unavailable';
      const message = sanitizeUpstreamText(
        payloadText(error.message) || payloadText(record.error) || 'Search API returned an error',
        this.rotator.allKeys(this.config.apiKey),
      );
      throw new SearchProviderError(code, `Perplexity: ${message}`, {
        providerId: this.id,
        retryable: code === 'rate_limited' || type === 'api_error' || type === 'server_error',
        details: { transport: SEARCH_API_TRANSPORT_ID, stage: 'fetch' },
      });
    }

    const items = requireResultArray(payload, 'results', this.id, 'Perplexity');
    const results: SearchResult[] = [];
    const seen = new Set<string>();
    const excluded = excludedDomainsFromQuery(query);
    let usableSources = 0;
    for (const item of items) {
      const source = asRecord(item);
      const title = payloadText(source.title).trim();
      const url = sourceUrl(source.url);
      if (!url || !title || /^n\/?a$/i.test(title) || seen.has(url)) continue;
      usableSources += 1;
      if (isExcludedSearchUrl(url, excluded)) continue;
      seen.add(url);
      results.push({ title, url, content: payloadText(source.snippet) });
      if (results.length === maxResults) break;
    }
    if (items.length > 0 && usableSources === 0) {
      throw new SearchProviderError('parse_failed', 'Perplexity returned no usable search sources', {
        providerId: this.id,
        retryable: false,
        details: { transport: SEARCH_API_TRANSPORT_ID, stage: 'parse' },
      });
    }
    return results;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function sourceUrl(value: unknown): string {
  try {
    const url = new URL(payloadText(value));
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
      ? url.href
      : '';
  } catch {
    return '';
  }
}
