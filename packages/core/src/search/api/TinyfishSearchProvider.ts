import { SearchProviderError, type SearchOptions, type SearchProvider, type SearchProviderCapabilities, type SearchResult } from '@omnicross/contracts/search-types';

import { domainsFromQuery } from '../domainFilters';
import { boundedResults, keyedCredentials, keyedEndpoint, normalizeKeyedSources } from './keyedHelpers';
import { ApiKeyRotator } from './rotator';
import { DEFAULT_API_TIMEOUT_MS, defaultSearchApiTransport, requireResultArray } from './transport';
import { SEARCH_API_TRANSPORT_ID, type SearchApiTransport, type TinyfishProviderConfig } from './types';

export const TINYFISH_SEARCH_URL = 'https://api.search.tinyfish.ai';
export const TINYFISH_CAPABILITIES: Readonly<SearchProviderCapabilities> = Object.freeze({
  requiresApiKey: true, supportsRegion: true, supportsLanguage: true, supportsTimeRange: true,
  supportsUrlRead: false, supportsCancellation: true, maxResults: 20,
});
const RECENCY_MINUTES = { day: 1_440, week: 10_080, month: 43_200, year: 525_600 } as const;

export class TinyfishSearchProvider implements SearchProvider {
  readonly id = 'tinyfish';
  private readonly rotator = new ApiKeyRotator();

  constructor(
    private readonly config: TinyfishProviderConfig,
    private readonly transport: SearchApiTransport = defaultSearchApiTransport,
  ) {}

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const { apiKey, secrets } = keyedCredentials(this.config.apiKey, this.rotator, this.id, 'Tinyfish');
    const limit = boundedResults(options.maxResults, 10, 20);
    const pageSize = Math.min(limit, 10);
    const url = new URL(keyedEndpoint(this.config.apiHost, TINYFISH_SEARCH_URL, this.id));
    url.searchParams.set('query', query);
    url.searchParams.set('num_results', String(pageSize));
    if (options.timeRange) url.searchParams.set('recency_minutes', String(RECENCY_MINUTES[options.timeRange]));
    if (options.region && /^[a-z]{2}$/i.test(options.region)) url.searchParams.set('location', options.region.toUpperCase());
    if (options.language && /^[a-z]{2}$/i.test(options.language)) url.searchParams.set('language', options.language.toLowerCase());
    for (const excluded of [false, true]) {
      const domains = domainsFromQuery(query, excluded).slice(0, 50);
      if (domains.length) url.searchParams.set(excluded ? 'exclude_domains' : 'include_domains', domains.join(','));
    }
    const deadline = Date.now() + (options.timeout ?? DEFAULT_API_TIMEOUT_MS);
    const seen = new Set<string>();
    const results: SearchResult[] = [];
    // Tinyfish pages are zero-based. Cap pagination even when an upstream repeats full pages.
    for (let page = 0; page <= 10 && results.length < limit; page += 1) {
      if (options.signal?.aborted) throw this.interrupted('cancelled');
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw this.interrupted('timeout');
      url.searchParams.set('page', String(page));
      const payload = await this.transport({
        url: url.toString(), method: 'GET', headers: { Accept: 'application/json', 'X-API-Key': apiKey },
        providerId: this.id, label: 'Tinyfish', timeoutMs: remaining, signal: options.signal, secrets,
      });
      const items = requireResultArray(payload, 'results', this.id, 'Tinyfish');
      const sources = normalizeKeyedSources(items,
        (item) => ({ url: item.url, title: item.title ?? item.site_name, content: item.snippet }), query, limit, this.id, 'Tinyfish');
      for (const source of sources) {
        if (seen.has(source.url)) continue;
        seen.add(source.url);
        results.push(source);
        if (results.length >= limit) break;
      }
      if (items.length < pageSize) break;
    }
    return results;
  }

  private interrupted(code: 'cancelled' | 'timeout'): SearchProviderError {
    return new SearchProviderError(code, code === 'cancelled' ? 'Tinyfish search was cancelled by the caller' : 'Tinyfish search exceeded its request budget', {
      providerId: this.id, retryable: code === 'timeout',
      details: { transport: SEARCH_API_TRANSPORT_ID, stage: 'fetch' },
    });
  }
}
