/**
 * `jina` — the Jina search API on the new provider contract.
 *
 * Ported from Elftia's `JinaProvider` (sha256 `374d2252…`, re-verified
 * byte-identical against the 阶段0 manifest before porting). GET
 * `{apiHost}/<encoded query>`, key OPTIONAL (the endpoint answers
 * unauthenticated at a lower rate limit), `X-Engine: direct` only when the
 * caller asks for page content, and the `content || description` mapping.
 *
 * SEARCH and READER are split, unlike the baseline where one `configureProvider`
 * call pushed the key into both. This class owns search; {@link JinaReaderClient}
 * owns `readUrl` and is injected, so `capabilities.supportsUrlRead: true` names
 * something that always works rather than something that works if a setter was
 * called.
 *
 * @module search/api/JinaSearchProvider
 */

import type {
  SearchOptions,
  SearchProvider,
  SearchProviderId,
  SearchResult,
  SearchUrlReadResult,
} from '@omnicross/contracts/search-types';

import { JinaReaderClient } from './JinaReaderClient';
import { ApiKeyRotator } from './rotator';
import { defaultSearchApiTransport, payloadText, requireResultArray } from './transport';
import type { JinaProviderConfig, SearchApiTransport } from './types';

/** The id this provider registers under. */
export const JINA_PROVIDER_ID = 'jina';

/** Elftia's default search host. */
export const JINA_DEFAULT_HOST = 'https://s.jina.ai';

/** Elftia's default result count. */
export const JINA_DEFAULT_MAX_RESULTS = 5;

const LABEL = 'Jina';

export class JinaSearchProvider implements SearchProvider {
  readonly id: SearchProviderId = JINA_PROVIDER_ID;

  private readonly rotator = new ApiKeyRotator();
  private readonly reader: JinaReaderClient;

  constructor(
    private readonly config: JinaProviderConfig = {},
    private readonly transport: SearchApiTransport = defaultSearchApiTransport,
    reader?: JinaReaderClient,
  ) {
    // Baseline parity: the reader shares the search key. Constructed here
    // rather than set later, so the declared `supportsUrlRead` capability is
    // true from the moment the provider exists.
    this.reader = reader ?? new JinaReaderClient(config, transport, JINA_PROVIDER_ID);
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const apiHost = this.config.apiHost || JINA_DEFAULT_HOST;
    const maxResults = options.maxResults || JINA_DEFAULT_MAX_RESULTS;

    const headers: Record<string, string> = { Accept: 'application/json' };
    const apiKey = this.rotator.pick(this.config.apiKey);
    // No `config_missing` here on purpose: keyless Jina is a supported mode,
    // which is also why the contribution declares `requiresApiKey: false`.
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    if (options.fetchPageContent) headers['X-Engine'] = 'direct';

    const payload = await this.transport({
      url: `${apiHost}/${encodeURIComponent(query)}`,
      method: 'GET',
      headers,
      providerId: this.id,
      label: LABEL,
      timeoutMs: options.timeout,
      signal: options.signal,
      secrets: this.rotator.allKeys(this.config.apiKey),
    });

    return requireResultArray(payload, 'data', this.id, LABEL)
      .slice(0, maxResults)
      .map((item) => toResult(item));
  }

  /** Read one URL through the split-out reader client. */
  readUrl(url: string, options?: SearchOptions): Promise<SearchUrlReadResult> {
    return this.reader.readUrl(url, options);
  }
}

function toResult(item: unknown): SearchResult {
  const record = (item ?? {}) as Record<string, unknown>;
  return {
    title: payloadText(record.title),
    url: payloadText(record.url),
    // The baseline's quirk, preserved: Jina returns a snippet under either
    // name depending on the engine that produced the row.
    content: payloadText(record.content) || payloadText(record.description),
  };
}
