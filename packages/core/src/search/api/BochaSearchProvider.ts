import type { SearchOptions, SearchProvider, SearchProviderCapabilities, SearchResult } from '@omnicross/contracts/search-types';

import { boundedResults, keyedCredentials, keyedEndpoint, keyedEnvelopeError, keyedParseError, normalizeKeyedSources, objectRecord, searchText } from './keyedHelpers';
import { ApiKeyRotator } from './rotator';
import { defaultSearchApiTransport, requireResultArray } from './transport';
import type { BochaProviderConfig, SearchApiTransport } from './types';

// Official specification: https://github.com/Bocha-Labs/bocha-skills/blob/main/bocha-web-search/SKILL.md
export const BOCHA_SEARCH_URL = 'https://api.bocha.cn/v1/web-search';
export const BOCHA_CAPABILITIES: Readonly<SearchProviderCapabilities> = Object.freeze({
  requiresApiKey: true, supportsRegion: false, supportsLanguage: false, supportsTimeRange: true,
  supportsUrlRead: false, supportsCancellation: true, maxResults: 50,
});
const FRESHNESS = { day: 'oneDay', week: 'oneWeek', month: 'oneMonth', year: 'oneYear' } as const;

export class BochaSearchProvider implements SearchProvider {
  readonly id = 'bocha';
  private readonly rotator = new ApiKeyRotator();

  constructor(
    private readonly config: BochaProviderConfig,
    private readonly transport: SearchApiTransport = defaultSearchApiTransport,
  ) {}

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const { apiKey, secrets } = keyedCredentials(this.config.apiKey, this.rotator, this.id, 'Bocha');
    const limit = boundedResults(options.maxResults, 10, 50);
    const payload = objectRecord(await this.transport({
      url: keyedEndpoint(this.config.apiHost, BOCHA_SEARCH_URL, this.id), method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      jsonBody: { query, summary: true, freshness: options.timeRange ? FRESHNESS[options.timeRange] : 'noLimit', count: limit },
      providerId: this.id, label: 'Bocha', timeoutMs: options.timeout, signal: options.signal, secrets,
    }));
    if (!payload) throw keyedParseError(this.id, 'Bocha');
    if (payload.code !== undefined && Number(payload.code) !== 200) {
      throw keyedEnvelopeError(this.id, 'Bocha', payload.code);
    }
    const data = objectRecord(payload.data);
    if (!data) throw keyedParseError(this.id, 'Bocha');
    // Official responses may omit webPages when there are no web matches.
    const items = data.webPages === undefined || data.webPages === null
      ? [] : requireResultArray(data.webPages, 'value', this.id, 'Bocha');
    return normalizeKeyedSources(items, (item) => ({
      url: item.url, title: item.name, content: searchText(item.summary) || item.snippet,
    }), query, limit, this.id, 'Bocha');
  }
}
