/**
 * `http-duckduckgo` — keyless DuckDuckGo search over the shared HTTP transport.
 *
 * Two candidate endpoints, tried in order under one shared deadline: the html
 * endpoint first, then the lite endpoint. The lite endpoint is reached only when
 * the html one produced no usable results (or failed outright) — the baselined
 * behavior.
 *
 * @module search/http/HttpDuckDuckGoProvider
 */

import type {
  SearchOptions,
  SearchProvider,
  SearchProviderId,
  SearchResult,
} from '@omnicross/contracts/search-types';

import { runHttpSearch, type HttpSearchEngine } from './engine';
import { parseDuckDuckGoSerp } from './parsers/duckduckgo';
import { defaultSearchHttpTransport } from './transport';
import type { SearchHttpTransport } from './types';

/** The id this provider registers under. */
export const HTTP_DUCKDUCKGO_PROVIDER_ID = 'http-duckduckgo';

/**
 * DuckDuckGo answers a rate-limited or suspicious request with HTTP 202 and a
 * challenge shell body. It is a challenge, not a rate-limit protocol — there is
 * no retry-after, no quota, and no credential that would change the outcome —
 * so it maps to `upstream_unavailable` + `stage: 'challenge'`, never
 * `rate_limited`.
 */
const DUCKDUCKGO_CHALLENGE_STATUS = 202;

const DUCKDUCKGO_ENGINE: HttpSearchEngine = {
  providerId: HTTP_DUCKDUCKGO_PROVIDER_ID,
  label: 'DuckDuckGo',
  buildUrls: (query) => [
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
  ],
  isChallengeStatus: (status) => status === DUCKDUCKGO_CHALLENGE_STATUS,
  parse: parseDuckDuckGoSerp,
};

export class HttpDuckDuckGoProvider implements SearchProvider {
  readonly id: SearchProviderId = HTTP_DUCKDUCKGO_PROVIDER_ID;

  private readonly transport: SearchHttpTransport;

  constructor(transport: SearchHttpTransport = defaultSearchHttpTransport) {
    this.transport = transport;
  }

  search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    return runHttpSearch(DUCKDUCKGO_ENGINE, this.transport, query, options);
  }
}
