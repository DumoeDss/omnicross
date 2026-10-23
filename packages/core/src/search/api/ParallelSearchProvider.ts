import type { SearchOptions, SearchProvider, SearchResult } from '@omnicross/contracts/search-types';

import { excludedDomainsFromQuery, isExcludedSearchUrl } from '../domainFilters';
import {
  invalidSearchPayload,
  keylessCapabilities,
  publicSearchMode,
  recencyDate,
  recordOf,
  requireSearchKey,
  resultLimit,
  searchApiEndpoint,
  sourceResult,
  stringList,
} from './keylessSupport';
import { callSearchMcp, mcpPayloads } from './mcp';
import { ApiKeyRotator } from './rotator';
import { defaultSearchApiTransport, requireResultArray } from './transport';
import type { ParallelProviderConfig, SearchApiTransport } from './types';

export const PARALLEL_CAPABILITIES = keylessCapabilities(40);
const PUBLIC_URL = 'https://search.parallel.ai/mcp';
const LABEL = 'Parallel';

export class ParallelSearchProvider implements SearchProvider {
  readonly id = 'parallel';
  private readonly rotator = new ApiKeyRotator();

  constructor(
    private readonly config: ParallelProviderConfig,
    private readonly transport: SearchApiTransport = defaultSearchApiTransport,
  ) {}

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const limit = resultLimit(options.maxResults, 40);
    const after = recencyDate(options.timeRange);
    let payload: unknown;
    if (publicSearchMode(this.config)) {
      const result = await callSearchMcp(this.transport, {
        url: PUBLIC_URL,
        providerId: this.id,
        label: LABEL,
        timeoutMs: options.timeout,
        signal: options.signal,
      }, 'web_search', {
        objective: query,
        search_queries: [after ? `${query} after:${after}` : query],
      });
      payload = mcpPayloads(result).map(recordOf).find((value) => Array.isArray(value?.results));
    } else {
      const key = requireSearchKey(this.rotator.pick(this.config.apiKey), this.id, LABEL);
      payload = await this.transport({
        url: searchApiEndpoint(this.config.apiHost, 'https://api.parallel.ai', '/v1/search'),
        method: 'POST',
        headers: { 'x-api-key': key },
        jsonBody: {
          objective: query,
          search_queries: [query],
          mode: 'fast',
          advanced_settings: {
            max_results: limit,
            excerpt_settings: { max_chars_per_result: 10_000 },
            ...(after ? { source_policy: { after_date: after } } : {}),
          },
        },
        providerId: this.id,
        label: LABEL,
        timeoutMs: options.timeout,
        signal: options.signal,
        secrets: this.rotator.allKeys(this.config.apiKey),
      });
    }
    const items = requireResultArray(payload, 'results', this.id, LABEL);
    const results = items.flatMap((value) => {
      const item = recordOf(value);
      const source = item && sourceResult(item.title, item.url, stringList(item.excerpts));
      return source ? [source] : [];
    });
    if (items.length && !results.length) throw invalidSearchPayload(this.id, LABEL);
    const excluded = excludedDomainsFromQuery(query);
    return results.filter((result) => !isExcludedSearchUrl(result.url, excluded)).slice(0, limit);
  }
}
