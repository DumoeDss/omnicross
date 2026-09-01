/**
 * `searxng` — a self-hosted SearXNG instance on the new provider contract.
 *
 * Ported from Elftia's `SearxngProvider` (sha256 `c1ec6694…`, re-verified
 * byte-identical against the 阶段0 manifest before porting). GET
 * `{apiHost}/search?q=&format=json&pageno=1`, with Basic auth sent only when
 * BOTH credentials are present.
 *
 * The only provider whose required setting is a HOST rather than a key, and
 * therefore the one the egress policy exists to accommodate: a SearXNG instance
 * usually lives on a private address, which the default policy denies. An
 * operator enables theirs by naming its hostname in
 * `SearchEgressPolicy.allowedPrivateHosts` — an explicit, admin-level decision,
 * never something this adapter infers from the fact that a host was configured.
 *
 * @module search/api/SearxngSearchProvider
 */

import type {
  SearchOptions,
  SearchProvider,
  SearchProviderId,
  SearchResult,
} from '@omnicross/contracts/search-types';

import {
  apiConfigMissing,
  defaultSearchApiTransport,
  payloadText,
  requireResultArray,
} from './transport';
import type { SearchApiTransport, SearxngProviderConfig } from './types';

/** The id this provider registers under. */
export const SEARXNG_PROVIDER_ID = 'searxng';

/** Elftia's default result count. */
export const SEARXNG_DEFAULT_MAX_RESULTS = 5;

const LABEL = 'Searxng';

export class SearxngSearchProvider implements SearchProvider {
  readonly id: SearchProviderId = SEARXNG_PROVIDER_ID;

  constructor(
    private readonly config: SearxngProviderConfig,
    private readonly transport: SearchApiTransport = defaultSearchApiTransport,
  ) {}

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    // The host IS this provider's "configured" signal — there is no key.
    if (!this.config.apiHost) throw apiConfigMissing(this.id, `${LABEL} API host is required`);

    const maxResults = options.maxResults || SEARXNG_DEFAULT_MAX_RESULTS;
    const params = new URLSearchParams({ q: query, format: 'json', pageno: '1' });

    const headers: Record<string, string> = { Accept: 'application/json' };
    const { basicAuthUsername, basicAuthPassword } = this.config;
    // Both or neither, as in the baseline: a half-configured credential is not
    // sent as a half-credential.
    const credentials =
      basicAuthUsername && basicAuthPassword
        ? Buffer.from(`${basicAuthUsername}:${basicAuthPassword}`).toString('base64')
        : undefined;
    if (credentials) headers.Authorization = `Basic ${credentials}`;

    const payload = await this.transport({
      url: `${this.config.apiHost}/search?${params.toString()}`,
      method: 'GET',
      headers,
      providerId: this.id,
      label: LABEL,
      timeoutMs: options.timeout,
      signal: options.signal,
      // The encoded blob AND its parts: an upstream error could echo either.
      secrets: [credentials, basicAuthUsername, basicAuthPassword],
    });

    return requireResultArray(payload, 'results', this.id, LABEL)
      .slice(0, maxResults)
      .map((item) => toResult(item));
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
