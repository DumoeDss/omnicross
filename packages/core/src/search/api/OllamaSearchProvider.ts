import type { SearchOptions, SearchProvider, SearchProviderCapabilities, SearchResult } from '@omnicross/contracts/search-types';

import { boundedResults, keyedCredentials, keyedEndpoint, normalizeKeyedSources } from './keyedHelpers';
import { ApiKeyRotator } from './rotator';
import { defaultSearchApiTransport, requireResultArray } from './transport';
import type { OllamaProviderConfig, SearchApiTransport } from './types';

// Hosted search requires an Ollama Cloud key; it is not a localhost inference API.
export const OLLAMA_SEARCH_URL = 'https://ollama.com/api/web_search';
export const OLLAMA_CAPABILITIES: Readonly<SearchProviderCapabilities> = Object.freeze({
  requiresApiKey: true, supportsRegion: false, supportsLanguage: false, supportsTimeRange: false,
  supportsUrlRead: false, supportsCancellation: true, maxResults: 10,
});

export class OllamaSearchProvider implements SearchProvider {
  readonly id = 'ollama';
  private readonly rotator = new ApiKeyRotator();

  constructor(
    private readonly config: OllamaProviderConfig,
    private readonly transport: SearchApiTransport = defaultSearchApiTransport,
  ) {}

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const { apiKey, secrets } = keyedCredentials(this.config.apiKey, this.rotator, this.id, 'Ollama Cloud');
    const limit = boundedResults(options.maxResults, 5, 10);
    const payload = await this.transport({
      url: keyedEndpoint(this.config.apiHost, OLLAMA_SEARCH_URL, this.id), method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      jsonBody: { query, max_results: limit },
      providerId: this.id, label: 'Ollama', timeoutMs: options.timeout, signal: options.signal, secrets,
    });
    return normalizeKeyedSources(requireResultArray(payload, 'results', this.id, 'Ollama'),
      (item) => ({ url: item.url, title: item.title, content: item.content }), query, limit, this.id, 'Ollama');
  }
}
