import type { SearchOptions, SearchProvider, SearchProviderCapabilities, SearchResult, SearchTimeRange } from '@omnicross/contracts/search-types';

import { boundedResults, keyedCredentials, keyedEndpoint, keyedEnvelopeError, keyedParseError, normalizeKeyedSources, objectRecord } from './keyedHelpers';
import { ApiKeyRotator } from './rotator';
import { defaultSearchApiTransport } from './transport';
import type { KagiProviderConfig, SearchApiTransport } from './types';

export const KAGI_SEARCH_URL = 'https://kagi.com/api/v1/search';
export const KAGI_CAPABILITIES: Readonly<SearchProviderCapabilities> = Object.freeze({
  requiresApiKey: true, supportsRegion: false, supportsLanguage: false, supportsTimeRange: true,
  supportsUrlRead: false, supportsCancellation: true, maxResults: 100,
});

/** Calendar windows are clamped to the last day of the target UTC month. */
function afterDate(range: SearchTimeRange): string {
  const date = new Date();
  if (range === 'day' || range === 'week') date.setUTCDate(date.getUTCDate() - (range === 'day' ? 1 : 7));
  else {
    const day = date.getUTCDate();
    date.setUTCDate(1);
    if (range === 'month') date.setUTCMonth(date.getUTCMonth() - 1);
    else date.setUTCFullYear(date.getUTCFullYear() - 1);
    const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, end));
  }
  return date.toISOString().slice(0, 10);
}

export class KagiSearchProvider implements SearchProvider {
  readonly id = 'kagi';
  private readonly rotator = new ApiKeyRotator();

  constructor(
    private readonly config: KagiProviderConfig,
    private readonly transport: SearchApiTransport = defaultSearchApiTransport,
  ) {}

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const { apiKey, secrets } = keyedCredentials(this.config.apiKey, this.rotator, this.id, 'Kagi');
    const limit = boundedResults(options.maxResults, 10, 100);
    const payload = objectRecord(await this.transport({
      url: keyedEndpoint(this.config.apiHost, KAGI_SEARCH_URL, this.id), method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      jsonBody: { query, workflow: 'search', limit, ...(options.timeRange ? { filters: { after: afterDate(options.timeRange) } } : {}) },
      providerId: this.id, label: 'Kagi', timeoutMs: options.timeout, signal: options.signal, secrets,
    }));
    if (!payload) throw keyedParseError(this.id, 'Kagi');
    const errors = payload.error ?? payload.errors;
    if ((Array.isArray(errors) && errors.length > 0) || (typeof errors === 'string' && errors.trim())) {
      throw keyedEnvelopeError(this.id, 'Kagi', Array.isArray(errors) ? objectRecord(errors[0])?.code : undefined);
    }
    const data = objectRecord(payload.data);
    if (!data) throw keyedParseError(this.id, 'Kagi');
    const sources: unknown[] = [];
    for (const bucket of ['search', 'video', 'news', 'infobox']) {
      if (data[bucket] !== undefined && !Array.isArray(data[bucket])) throw keyedParseError(this.id, 'Kagi');
      if (Array.isArray(data[bucket])) sources.push(...data[bucket]);
    }
    return normalizeKeyedSources(sources, (item) => ({
      url: item.url ?? item.href ?? item.link, title: item.title ?? item.name,
      content: item.snippet ?? item.description ?? item.summary,
    }), query, limit, this.id, 'Kagi');
  }
}
