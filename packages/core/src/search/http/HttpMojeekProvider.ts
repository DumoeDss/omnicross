import type { SearchOptions, SearchProvider, SearchResult } from '@omnicross/contracts/search-types';

import { runHttpSearch, type HttpSearchEngine } from './engine';
import { mojeekTrustError, parseMojeekSerp } from './parsers/mojeek';
import { defaultSearchHttpTransport } from './transport';
import type { SearchHttpTransport } from './types';

export const HTTP_MOJEEK_PROVIDER_ID = 'http-mojeek';

const MOJEEK_ENGINE: HttpSearchEngine = {
  providerId: HTTP_MOJEEK_PROVIDER_ID,
  label: 'Mojeek',
  buildUrls: (query) => [
    `https://www.mojeek.de/search?q=${encodeURIComponent(query)}&t=10&arc=none&lang=en&lb=en`,
  ],
  isChallengeStatus: (status) => status === 403 || status === 429,
  trustError: mojeekTrustError,
  parse: parseMojeekSerp,
};

export class HttpMojeekProvider implements SearchProvider {
  readonly id = HTTP_MOJEEK_PROVIDER_ID;

  constructor(private readonly transport: SearchHttpTransport = defaultSearchHttpTransport) {}

  search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    return runHttpSearch(MOJEEK_ENGINE, this.transport, query, options);
  }
}
