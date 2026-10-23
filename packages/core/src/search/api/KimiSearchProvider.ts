import type { SearchOptions, SearchProvider, SearchProviderCapabilities, SearchResult } from '@omnicross/contracts/search-types';

import { boundedResults, keyedCredentials, keyedEndpoint, normalizeKeyedSources, searchText } from './keyedHelpers';
import { ApiKeyRotator } from './rotator';
import { defaultSearchApiTransport, requireResultArray } from './transport';
import type { KimiProviderConfig, SearchApiTransport } from './types';

// Kimi Code Console credentials, NOT ordinary Moonshot chat API credentials.
export const KIMI_SEARCH_URL = 'https://api.kimi.com/coding/v1/search';
export const KIMI_CAPABILITIES: Readonly<SearchProviderCapabilities> = Object.freeze({
  requiresApiKey: true, supportsRegion: false, supportsLanguage: false, supportsTimeRange: false,
  supportsUrlRead: false, supportsCancellation: true, maxResults: 20,
});

export class KimiSearchProvider implements SearchProvider {
  readonly id = 'kimi';
  private readonly rotator = new ApiKeyRotator();

  constructor(
    private readonly config: KimiProviderConfig,
    private readonly transport: SearchApiTransport = defaultSearchApiTransport,
  ) {}

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const { apiKey, secrets } = keyedCredentials(this.config.apiKey, this.rotator, this.id, 'Kimi Code search (Kimi Code Console credential, not a Moonshot chat key)');
    const limit = boundedResults(options.maxResults, 10, 20);
    const timeoutMs = options.timeout !== undefined && Number.isFinite(options.timeout) ? options.timeout : 15_000;
    const payload = await this.transport({
      url: keyedEndpoint(this.config.apiHost, KIMI_SEARCH_URL, this.id), method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      jsonBody: {
        text_query: query, limit, enable_page_crawling: options.fetchPageContent ?? false,
        timeout_seconds: Math.max(1, Math.min(30, Math.ceil(timeoutMs / 1_000))),
      },
      providerId: this.id, label: 'Kimi', timeoutMs: options.timeout, signal: options.signal, secrets,
    });
    return normalizeKeyedSources(requireResultArray(payload, 'search_results', this.id, 'Kimi'),
      (item) => ({ url: item.url, title: item.title, content: searchText(item.snippet) || item.content }), query, limit, this.id, 'Kimi');
  }
}
