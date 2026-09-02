/**
 * `http-bing` — keyless Bing search over the shared HTTP transport.
 *
 * Standalone by construction: `new HttpBingProvider()` works with no config, no
 * registry and no host. Nothing in Phase 1 阶段2 registers or calls it — that is
 * 阶段3's job.
 *
 * @module search/http/HttpBingProvider
 */

import type {
  SearchOptions,
  SearchProvider,
  SearchProviderId,
  SearchResult,
} from '@omnicross/contracts/search-types';

import { runHttpSearch, type HttpSearchEngine } from './engine';
import { parseBingSerp } from './parsers/bing';
import { bingSearchPageTrustError } from './trust';
import { defaultSearchHttpTransport } from './transport';
import type { SearchHttpTransport } from './types';

/** The id this provider registers under. */
export const HTTP_BING_PROVIDER_ID = 'http-bing';

const BING_ENGINE: HttpSearchEngine = {
  providerId: HTTP_BING_PROVIDER_ID,
  label: 'Bing',
  buildUrls: (query) => [`https://www.bing.com/search?q=${encodeURIComponent(query)}`],
  // Bing has no challenge status of its own; it serves decoy CONTENT instead,
  // which the trust check catches.
  isChallengeStatus: () => false,
  trustError: bingSearchPageTrustError,
  parse: parseBingSerp,
};

export class HttpBingProvider implements SearchProvider {
  readonly id: SearchProviderId = HTTP_BING_PROVIDER_ID;

  private readonly transport: SearchHttpTransport;

  constructor(transport: SearchHttpTransport = defaultSearchHttpTransport) {
    this.transport = transport;
  }

  search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    return runHttpSearch(BING_ENGINE, this.transport, query, options);
  }
}
