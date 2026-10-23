import type { SearchOptions, SearchProvider, SearchResult } from '@omnicross/contracts/search-types';

import { runHttpSearch, type HttpSearchEngine } from './engine';
import { ecosiaTrustError, parseEcosiaSerp } from './parsers/ecosia';
import { defaultSearchHttpTransport } from './transport';
import type { SearchHttpTransport } from './types';

export const HTTP_ECOSIA_PROVIDER_ID = 'http-ecosia';

const ECOSIA_ENGINE: HttpSearchEngine = {
  providerId: HTTP_ECOSIA_PROVIDER_ID,
  label: 'Ecosia',
  buildUrls: (query) => [`https://www.ecosia.org/search?q=${encodeURIComponent(query)}`],
  isChallengeStatus: (status) => status === 403 || status === 429,
  trustError: ecosiaTrustError,
  parse: parseEcosiaSerp,
};

export class HttpEcosiaProvider implements SearchProvider {
  readonly id = HTTP_ECOSIA_PROVIDER_ID;

  constructor(private readonly transport: SearchHttpTransport = defaultSearchHttpTransport) {}

  search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    return runHttpSearch(ECOSIA_ENGINE, this.transport, query, options);
  }
}
