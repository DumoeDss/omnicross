/**
 * `zhipu` and `z.ai` — one wire contract, two provider ids.
 *
 * Ported from Elftia's `ZhipuProvider` (sha256 `2a9a0f5b…`, re-verified
 * byte-identical against the 阶段0 manifest before porting), including the
 * one-class-two-instances shape: the two services speak the same API and differ
 * only in their default host, so the id is a constructor argument and the
 * contributions factory registers two instances.
 *
 * Two ported quirks that later stages must not "fix":
 *
 * - **`maxResults` defaults to 10**, where every other adapter defaults to 5.
 *   That is the baseline's behavior and it is preserved deliberately; the
 *   orchestrator's normalization caps results at what the caller asked for
 *   anyway.
 * - **Results carry `link`, not `url`.** The mapping is part of the wire
 *   contract, not a typo.
 *
 * @module search/api/ZhipuSearchProvider
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
import type { SearchApiTransport, ZhipuProviderConfig } from './types';

/** The two ids this one class is registered under. */
export const ZHIPU_PROVIDER_ID = 'zhipu';
export const ZAI_PROVIDER_ID = 'z.ai';

/** Per-id default hosts, as in the baseline. */
export const ZHIPU_DEFAULT_HOSTS: Readonly<Record<string, string>> = Object.freeze({
  [ZHIPU_PROVIDER_ID]: 'https://open.bigmodel.cn/api/paas/v4',
  [ZAI_PROVIDER_ID]: 'https://api.z.ai/api/paas/v4',
});

/** The divergent default: 10, where every other adapter uses 5. */
export const ZHIPU_DEFAULT_MAX_RESULTS = 10;

/**
 * Point a configured host at the `/web_search` endpoint.
 *
 * Ported verbatim from the baseline, including which forms it accepts:
 * an explicit `/web_search` is left alone, a bare version segment (`/v4`) gets
 * `/web_search` appended, and anything else gets `/v4/web_search`.
 */
export function normalizeZhipuApiUrl(apiHost: string): string {
  const url = apiHost.replace(/\/+$/, '');
  if (url.endsWith('/web_search')) return url;
  if (/\/v\d+$/.test(url)) return `${url}/web_search`;
  return `${url}/v4/web_search`;
}

export class ZhipuSearchProvider implements SearchProvider {
  readonly id: SearchProviderId;

  private readonly rotator = new ApiKeyRotator();

  constructor(
    id: SearchProviderId,
    private readonly config: ZhipuProviderConfig,
    private readonly transport: SearchApiTransport = defaultSearchApiTransport,
  ) {
    this.id = id;
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const apiKey = this.rotator.pick(this.config.apiKey);
    if (!apiKey) throw apiConfigMissing(this.id, `${this.id} API key is required`);

    const defaultHost = ZHIPU_DEFAULT_HOSTS[this.id] ?? ZHIPU_DEFAULT_HOSTS[ZHIPU_PROVIDER_ID];
    const apiHost = this.config.apiHost || defaultHost;
    const maxResults = options.maxResults || ZHIPU_DEFAULT_MAX_RESULTS;

    const payload = await this.transport({
      url: normalizeZhipuApiUrl(apiHost),
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      jsonBody: { search_query: query, search_engine: 'search_pro', count: maxResults },
      providerId: this.id,
      label: this.id,
      timeoutMs: options.timeout,
      signal: options.signal,
      secrets: this.rotator.allKeys(this.config.apiKey),
    });

    return requireResultArray(payload, 'search_result', this.id, this.id)
      .slice(0, maxResults)
      .map((item) => toResult(item));
  }
}

function toResult(item: unknown): SearchResult {
  const record = (item ?? {}) as Record<string, unknown>;
  return {
    title: payloadText(record.title),
    // `link`, not `url` — the wire contract, not a typo.
    url: payloadText(record.link),
    content: payloadText(record.content),
  };
}
