/**
 * `deepseek` — DeepSeek's official search and fetch tool APIs.
 *
 * Both endpoints are plain JSON `POST`s on the same host and credential:
 *
 * - `POST /v1/tools/search` — `{ query, count, need_content, ... }` →
 *   `{ results: [...] }`, where each result carries `title`, `url`, `snippet`,
 *   `summary`, `content`, `rerank_score`, `site_name`, `site_icon`, `date` and
 *   `authority`.
 * - `POST /v1/tools/fetch` — `{ url }` → `{ title, content }`, the page body as
 *   Markdown. This is the provider's `readUrl`, and the reason its contribution
 *   declares `supportsUrlRead: true`.
 *
 * KEY REUSE: unlike the other keyed adapters, `config.apiKey` is optional. An
 * empty key means "use the official DeepSeek key already configured on an LLM
 * provider row"; the assembly supplies that resolver. A DeepSeek key belongs to
 * the account, not to one billing surface, so asking the operator to paste the
 * same credential twice would only create a second copy to leak and rotate.
 * When the resolver yields nothing either, the provider fails `config_missing`
 * before any network IO — it never sends an unauthenticated request in the hope
 * of a keyless mode, because DeepSeek does not have one.
 *
 * Response mapping choices, both deliberate:
 *
 * - `need_content` follows {@link SearchOptions.fetchPageContent}; when false
 *   the API returns an EMPTY `content` string, so `content || summary ||
 *   snippet` keeps a useful snippet on every row.
 * - `count` is clamped to the API's documented 1..50 window. Unlike the other
 *   adapters, 50 is a real upper bound and the contribution declares it as
 *   `capabilities.maxResults`, not a default dressed up as a cap.
 *
 * @module search/api/DeepseekSearchProvider
 */

import type {
  SearchOptions,
  SearchProvider,
  SearchProviderId,
  SearchResult,
  SearchUrlReadResult,
} from '@omnicross/contracts/search-types';

import { ApiKeyRotator } from './rotator';
import {
  apiConfigMissing,
  defaultSearchApiTransport,
  payloadText,
  requireResultArray,
} from './transport';
import type { DeepseekProviderConfig, SearchApiTransport } from './types';

/** The id this provider registers under. */
export const DEEPSEEK_PROVIDER_ID = 'deepseek';

/** DeepSeek's official API host. */
export const DEEPSEEK_DEFAULT_HOST = 'https://api.deepseek.com';

/** The result count used when the caller asks for none. */
export const DEEPSEEK_DEFAULT_MAX_RESULTS = 5;

/** The API's documented `count` ceiling (1..50). */
export const DEEPSEEK_MAX_RESULTS_LIMIT = 50;

const LABEL = 'DeepSeek';

/** The `tools/search` / `tools/fetch` pair this adapter speaks. */
type DeepseekEndpoint = 'search' | 'fetch';

/**
 * Point a configured host at one of the two tool endpoints.
 *
 * Accepts every form an operator plausibly writes: the bare host, `/v1`, the
 * `/v1/tools` prefix, or a full endpoint URL (which is retargeted to the
 * requested operation). Anything else gets `/v1/tools/<endpoint>` appended.
 */
export function normalizeDeepseekApiUrl(apiHost: string, endpoint: DeepseekEndpoint): string {
  const base = apiHost.replace(/\/+$/, '');
  const tail = `/tools/${endpoint}`;
  if (base.endsWith(tail)) return base;
  if (base.endsWith('/tools/search') || base.endsWith('/tools/fetch')) {
    return `${base.slice(0, base.lastIndexOf('/tools/'))}${tail}`;
  }
  if (base.endsWith('/tools')) return `${base}/${endpoint}`;
  if (/\/v\d+$/.test(base)) return `${base}${tail}`;
  return `${base}/v1${tail}`;
}

/** The fallback-key seam: resolves an official DeepSeek key from the LLM catalog. */
export type DeepseekApiKeyResolver = () => string | undefined;

export class DeepseekSearchProvider implements SearchProvider {
  readonly id: SearchProviderId = DEEPSEEK_PROVIDER_ID;

  private readonly rotator = new ApiKeyRotator();

  constructor(
    private readonly config: DeepseekProviderConfig,
    private readonly transport: SearchApiTransport = defaultSearchApiTransport,
    private readonly resolveReusedApiKey?: DeepseekApiKeyResolver,
  ) {}

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const apiKey = this.apiKey();
    if (!apiKey) throw apiConfigMissing(this.id, configMissingMessage());

    const apiHost = this.config.apiHost || DEEPSEEK_DEFAULT_HOST;
    // `||` not `??`, matching the other adapters: `maxResults: 0` means default.
    const maxResults = options.maxResults || DEEPSEEK_DEFAULT_MAX_RESULTS;
    const count = Math.min(Math.max(1, Math.floor(maxResults)), DEEPSEEK_MAX_RESULTS_LIMIT);

    const payload = await this.transport({
      url: normalizeDeepseekApiUrl(apiHost, 'search'),
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      jsonBody: {
        query,
        count,
        // Asked only when the caller wants page bodies. The API still answers
        // `summary`/`snippet` regardless, which is what the mapping falls back to.
        need_content: options.fetchPageContent === true,
      },
      providerId: this.id,
      label: LABEL,
      timeoutMs: options.timeout,
      signal: options.signal,
      secrets: this.secrets(apiKey),
    });

    return requireResultArray(payload, 'results', this.id, LABEL)
      .slice(0, maxResults)
      .map((item) => toSearchResult(item));
  }

  /** Read one URL through DeepSeek's `/tools/fetch`. */
  async readUrl(url: string, options: SearchOptions = {}): Promise<SearchUrlReadResult> {
    const apiKey = this.apiKey();
    if (!apiKey) throw apiConfigMissing(this.id, configMissingMessage());

    const apiHost = this.config.apiHost || DEEPSEEK_DEFAULT_HOST;
    const payload = await this.transport({
      url: normalizeDeepseekApiUrl(apiHost, 'fetch'),
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      jsonBody: { url },
      providerId: this.id,
      label: `${LABEL} fetch`,
      timeoutMs: options.timeout,
      signal: options.signal,
      secrets: this.secrets(apiKey),
    });

    // Empty fields are OMITTED, as in the Jina reader: the contract documents
    // `title`/`content` as "when available", and an empty page is not a title.
    const record = (payload ?? {}) as Record<string, unknown>;
    const title = payloadText(record.title);
    const content = payloadText(record.content);
    return {
      url,
      ...(title ? { title } : {}),
      ...(content ? { content } : {}),
    };
  }

  /** The configured key wins; the provider-catalog resolver is the fallback. */
  private apiKey(): string | undefined {
    const configured = this.rotator.pick(this.config.apiKey);
    if (configured) return configured;
    const reused = this.resolveReusedApiKey?.()?.trim();
    return reused ? reused : undefined;
  }

  /** Every credential this request could have carried, for redaction. */
  private secrets(activeKey: string): ReadonlyArray<string | undefined> {
    return [...this.rotator.allKeys(this.config.apiKey), activeKey];
  }
}

function configMissingMessage(): string {
  return `${LABEL} API key is required (configure one here or on a DeepSeek provider row)`;
}

function toSearchResult(item: unknown): SearchResult {
  const record = (item ?? {}) as Record<string, unknown>;
  return {
    title: payloadText(record.title),
    url: payloadText(record.url),
    // `content` is empty unless `need_content` was requested; the summaries are
    // the API's documented fallback, in decreasing detail.
    content:
      payloadText(record.content) ||
      payloadText(record.summary) ||
      payloadText(record.snippet),
  };
}
