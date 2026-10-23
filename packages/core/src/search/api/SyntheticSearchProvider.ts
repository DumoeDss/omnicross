import type { SearchOptions, SearchProvider, SearchProviderCapabilities, SearchResult } from '@omnicross/contracts/search-types';

import { boundedResults, keyedCredentials, keyedEndpoint, normalizeKeyedSources } from './keyedHelpers';
import { ApiKeyRotator } from './rotator';
import { defaultSearchApiTransport, requireResultArray } from './transport';
import type { SearchApiTransport, SyntheticProviderConfig } from './types';

export const SYNTHETIC_SEARCH_URL = 'https://api.synthetic.new/v2/search';
// Synthetic exposes no documented count option; 100 is this adapter's output bound.
export const SYNTHETIC_CAPABILITIES: Readonly<SearchProviderCapabilities> = Object.freeze({
  requiresApiKey: true, supportsRegion: false, supportsLanguage: false, supportsTimeRange: false,
  supportsUrlRead: false, supportsCancellation: true, maxResults: 100,
});

export class SyntheticSearchProvider implements SearchProvider {
  readonly id = 'synthetic';
  private readonly rotator = new ApiKeyRotator();

  constructor(
    private readonly config: SyntheticProviderConfig,
    private readonly transport: SearchApiTransport = defaultSearchApiTransport,
  ) {}

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const { apiKey, secrets } = keyedCredentials(this.config.apiKey, this.rotator, this.id, 'Synthetic');
    const limit = boundedResults(options.maxResults, 10, 100);
    const payload = await this.transport({
      url: keyedEndpoint(this.config.apiHost, SYNTHETIC_SEARCH_URL, this.id), method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      jsonBody: { query },
      providerId: this.id, label: 'Synthetic', timeoutMs: options.timeout, signal: options.signal, secrets,
    });
    return normalizeKeyedSources(requireResultArray(payload, 'results', this.id, 'Synthetic'),
      (item) => ({ url: item.url, title: item.title, content: item.text }), query, limit, this.id, 'Synthetic');
  }
}
