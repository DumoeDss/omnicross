import type { SearchOptions, SearchProvider, SearchResult } from '@omnicross/contracts/search-types';

import { runHttpSearch, type HttpSearchEngine } from './engine';
import { parseStartpageSerp, startpageTrustError } from './parsers/startpage';
import { defaultSearchHttpTransport } from './transport';
import type { SearchHttpTransport } from './types';

export const HTTP_STARTPAGE_PROVIDER_ID = 'http-startpage';

const STARTPAGE_ENGINE: HttpSearchEngine = {
  providerId: HTTP_STARTPAGE_PROVIDER_ID,
  label: 'Startpage',
  // The shared transport is GET-only. Use the official tokenless endpoint and
  // fail closed if it requires a session/CAPTCHA, never synthesize session tokens.
  buildUrls: (query) => [`https://www.startpage.com/sp/search?query=${encodeURIComponent(query)}`],
  isChallengeStatus: (status) => status === 403 || status === 429,
  trustError: startpageTrustError,
  parse: parseStartpageSerp,
};

export class HttpStartpageProvider implements SearchProvider {
  readonly id = HTTP_STARTPAGE_PROVIDER_ID;

  constructor(private readonly transport: SearchHttpTransport = defaultSearchHttpTransport) {}

  search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    return runHttpSearch(STARTPAGE_ENGINE, this.transport, query, options);
  }
}
