/**
 * `tavily` — the Tavily search API on the new provider contract.
 *
 * Ported from Elftia's `TavilyProvider` (sha256 `3134dcd7…`, re-verified
 * byte-identical against the 阶段0 manifest before porting). The wire contract
 * is unchanged: POST `{apiHost}/search` with the key IN THE JSON BODY,
 * `search_depth: 'advanced'`, and no client-side slicing — Tavily honors
 * `max_results` itself.
 *
 * That body-borne key is why the shared transport's redaction is mandatory
 * rather than defensive: a 4xx that quotes the request back is a direct path
 * from a credential to a log file. Every key this provider could have sent is
 * handed to the transport as `secrets`, not just the one this call rotated
 * onto.
 *
 * @module search/api/TavilySearchProvider
 */

import type {
  SearchOptions,
  SearchProvider,
  SearchProviderId,
  SearchResult,
} from '@omnicross/contracts/search-types';

import { ApiKeyRotator } from './rotator';
import {
  apiConfigMissing,
  defaultSearchApiTransport,
  payloadText,
  requireResultArray,
} from './transport';
import type { SearchApiTransport, TavilyProviderConfig } from './types';

/** The id this provider registers under. */
export const TAVILY_PROVIDER_ID = 'tavily';

/** Elftia's default host, used when no `apiHost` override is configured. */
export const TAVILY_DEFAULT_HOST = 'https://api.tavily.com';

/** Elftia's default result count. */
export const TAVILY_DEFAULT_MAX_RESULTS = 5;

const LABEL = 'Tavily';

export class TavilySearchProvider implements SearchProvider {
  readonly id: SearchProviderId = TAVILY_PROVIDER_ID;

  private readonly rotator = new ApiKeyRotator();

  constructor(
    private readonly config: TavilyProviderConfig,
    private readonly transport: SearchApiTransport = defaultSearchApiTransport,
  ) {}

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const apiKey = this.rotator.pick(this.config.apiKey);
    // Pre-flight, before any network IO: an unconfigured provider is a
    // configuration fact, not an upstream failure.
    if (!apiKey) throw apiConfigMissing(this.id, `${LABEL} API key is required`);

    const apiHost = this.config.apiHost || TAVILY_DEFAULT_HOST;
    // `||` not `??`, matching the baseline: `maxResults: 0` means "default".
    const maxResults = options.maxResults || TAVILY_DEFAULT_MAX_RESULTS;

    const payload = await this.transport({
      url: `${apiHost}/search`,
      method: 'POST',
      jsonBody: {
        api_key: apiKey,
        query,
        max_results: maxResults,
        search_depth: 'advanced',
        include_answer: false,
        include_raw_content: false,
      },
      providerId: this.id,
      label: LABEL,
      timeoutMs: options.timeout,
      signal: options.signal,
      secrets: this.rotator.allKeys(this.config.apiKey),
    });

    // No client-side slice: the baseline passes `max_results` to the API and
    // maps whatever comes back.
    return requireResultArray(payload, 'results', this.id, LABEL).map((item) => toResult(item));
  }
}

function toResult(item: unknown): SearchResult {
  const record = (item ?? {}) as Record<string, unknown>;
  return {
    title: payloadText(record.title),
    url: payloadText(record.url),
    content: payloadText(record.content),
  };
}
