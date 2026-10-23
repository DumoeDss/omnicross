import type { SearchOptions, SearchProvider, SearchProviderCapabilities, SearchResult } from '@omnicross/contracts/search-types';

import { boundedResults, keyedCredentials, keyedEndpoint, normalizeKeyedSources, objectRecord, searchText } from './keyedHelpers';
import { ApiKeyRotator } from './rotator';
import { defaultSearchApiTransport, requireResultArray } from './transport';
import type { BraveProviderConfig, SearchApiTransport } from './types';

export const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';
export const BRAVE_CAPABILITIES: Readonly<SearchProviderCapabilities> = Object.freeze({
  requiresApiKey: true, supportsRegion: true, supportsLanguage: true, supportsTimeRange: true,
  supportsUrlRead: false, supportsCancellation: true, maxResults: 20,
});
const FRESHNESS = { day: 'pd', week: 'pw', month: 'pm', year: 'py' } as const;

export class BraveSearchProvider implements SearchProvider {
  readonly id = 'brave';
  private readonly rotator = new ApiKeyRotator();

  constructor(
    private readonly config: BraveProviderConfig,
    private readonly transport: SearchApiTransport = defaultSearchApiTransport,
  ) {}

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const { apiKey, secrets } = keyedCredentials(this.config.apiKey, this.rotator, this.id, 'Brave');
    const limit = boundedResults(options.maxResults, 10, 20);
    const url = new URL(keyedEndpoint(this.config.apiHost, BRAVE_SEARCH_URL, this.id));
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(limit));
    url.searchParams.set('extra_snippets', 'true');
    url.searchParams.set('text_decorations', 'false');
    url.searchParams.set('safesearch', 'moderate');
    if (options.timeRange) url.searchParams.set('freshness', FRESHNESS[options.timeRange]);
    if (options.region && /^(?:[a-z]{2}|ALL)$/i.test(options.region)) {
      url.searchParams.set('country', options.region.toUpperCase());
    }
    if (options.language && /^[a-z]{2,3}(?:-[a-z]{2,8})?$/i.test(options.language)) {
      url.searchParams.set('search_lang', options.language.toLowerCase());
    }
    const payload = await this.transport({
      url: url.toString(), method: 'GET', headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
      providerId: this.id, label: 'Brave', timeoutMs: options.timeout, signal: options.signal, secrets,
    });
    return normalizeKeyedSources(requireResultArray(objectRecord(payload)?.web, 'results', this.id, 'Brave'),
      (item) => ({
        url: item.url, title: item.title,
        content: [item.description, ...(Array.isArray(item.extra_snippets) ? item.extra_snippets : [])]
          .map((value) => searchText(value)).filter(Boolean).join('\n'),
      }), query, limit, this.id, 'Brave');
  }
}
