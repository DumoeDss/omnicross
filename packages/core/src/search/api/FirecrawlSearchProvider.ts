import {
  SearchProviderError,
  type SearchOptions,
  type SearchProvider,
  type SearchResult,
} from '@omnicross/contracts/search-types';

import { excludedDomainsFromQuery, isExcludedSearchUrl } from '../domainFilters';
import {
  invalidSearchPayload,
  keylessCapabilities,
  publicSearchMode,
  recordOf,
  requireSearchKey,
  resultLimit,
  searchApiEndpoint,
  sourceResult,
} from './keylessSupport';
import { ApiKeyRotator } from './rotator';
import { defaultSearchApiTransport, payloadText, requireResultArray, sanitizeUpstreamText } from './transport';
import type { FirecrawlProviderConfig, SearchApiTransport } from './types';

export const FIRECRAWL_CAPABILITIES = keylessCapabilities(100);
const LABEL = 'Firecrawl';

export class FirecrawlSearchProvider implements SearchProvider {
  readonly id = 'firecrawl';
  private readonly rotator = new ApiKeyRotator();

  constructor(
    private readonly config: FirecrawlProviderConfig,
    private readonly transport: SearchApiTransport = defaultSearchApiTransport,
  ) {}

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const anonymous = publicSearchMode(this.config);
    const key = anonymous ? '' : requireSearchKey(this.rotator.pick(this.config.apiKey), this.id, LABEL);
    const limit = resultLimit(options.maxResults, 100);
    const tbs = options.timeRange && { day: 'qdr:d', week: 'qdr:w', month: 'qdr:m', year: 'qdr:y' }[options.timeRange];
    const payload = await this.transport({
      url: anonymous ? 'https://api.firecrawl.dev/v2/search'
        : searchApiEndpoint(this.config.apiHost, 'https://api.firecrawl.dev', '/v2/search'),
      method: 'POST',
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      jsonBody: {
        query,
        limit,
        sources: [{ type: 'web' }],
        ...(tbs ? { tbs } : {}),
      },
      providerId: this.id,
      label: LABEL,
      timeoutMs: options.timeout,
      signal: options.signal,
      secrets: anonymous ? [] : this.rotator.allKeys(this.config.apiKey),
    });
    const root = recordOf(payload);
    if (root?.success === false) {
      const message = sanitizeUpstreamText(payloadText(root.error), this.rotator.allKeys(this.config.apiKey));
      throw new SearchProviderError('upstream_unavailable', `${LABEL}: ${message || 'search request failed'}`, {
        providerId: this.id,
        retryable: false,
        details: { transport: 'undici', stage: 'parse' },
      });
    }
    const items = requireResultArray(root?.data, 'web', this.id, LABEL);
    const results = items.flatMap((value) => {
      const item = recordOf(value);
      const source = item && sourceResult(item.title, item.url,
        payloadText(item.description) || payloadText(item.snippet) || payloadText(item.markdown));
      return source ? [source] : [];
    });
    if (items.length && !results.length) throw invalidSearchPayload(this.id, LABEL);
    const excluded = excludedDomainsFromQuery(query);
    return results.filter((result) => !isExcludedSearchUrl(result.url, excluded)).slice(0, limit);
  }
}
