/**
 * The Jina reader — full page content for one URL.
 *
 * Ported from Elftia's `JinaReader` (sha256 `85d8b2a6…`, re-verified
 * byte-identical against the 阶段0 manifest before porting) as a STANDALONE
 * class, kept deliberately separate from `JinaSearchProvider`: the two call
 * different hosts (`r.jina.ai` vs `s.jina.ai`) and answer different questions,
 * and Elftia only ever coupled them through a `setApiKey` call.
 *
 * One behavior change: Elftia returns an in-band `{ success: false, error }`
 * shape on failure, which is exactly the code-less error string the new
 * contract exists to remove — a fallback policy cannot decide on it. This
 * client throws the taxonomy `SearchProviderError` the shared transport
 * produces. The legacy shape is still reachable through the existing
 * `search-compat` converters for any consumer that needs it.
 *
 * The host is fixed at `r.jina.ai`, as in Elftia. Configurability is not added
 * speculatively — but the request still passes egress validation like every
 * other, so the fixed host buys no bypass.
 *
 * NOTE (plan §16, unresolved and owned by a later stage): this reader and
 * `BuiltinToolExecutor`'s `web_fetch` are two ways to turn a URL into text.
 * Whether they should become one capability with different policies or stay two
 * bounded interfaces is NOT decided here, and `web_fetch` is untouched.
 *
 * @module search/api/JinaReaderClient
 */

import type {
  SearchOptions,
  SearchProviderId,
  SearchUrlReadResult,
} from '@omnicross/contracts/search-types';

import { ApiKeyRotator } from './rotator';
import { defaultSearchApiTransport, payloadText } from './transport';
import type { JinaProviderConfig, SearchApiTransport } from './types';

/** Elftia's reader host. Not configurable there, and not made so here. */
export const JINA_READER_HOST = 'https://r.jina.ai';

const LABEL = 'Jina Reader';

export class JinaReaderClient {
  private readonly rotator = new ApiKeyRotator();

  constructor(
    private readonly config: JinaProviderConfig = {},
    private readonly transport: SearchApiTransport = defaultSearchApiTransport,
    private readonly providerId: SearchProviderId = 'jina',
  ) {}

  /**
   * Read one URL.
   *
   * The key is OPTIONAL, as in the baseline: the reader answers unauthenticated
   * requests at a lower rate limit.
   */
  async readUrl(url: string, options: SearchOptions = {}): Promise<SearchUrlReadResult> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const apiKey = this.rotator.pick(this.config.apiKey);
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const payload = await this.transport({
      url: `${JINA_READER_HOST}/${encodeURIComponent(url)}`,
      method: 'GET',
      headers,
      providerId: this.providerId,
      label: LABEL,
      timeoutMs: options.timeout,
      signal: options.signal,
      secrets: this.rotator.allKeys(this.config.apiKey),
    });

    return toReadResult(url, payload);
  }
}

/**
 * Map the reader payload, preferring `data.*` with a top-level fallback — the
 * baseline's `data.data?.title || data.title` shape.
 *
 * Empty fields are OMITTED rather than sent as `''`: the contract declares
 * `title` and `content` optional and documents them as "when available", so an
 * absent field should read as absent, not as an empty page.
 */
function toReadResult(url: string, payload: unknown): SearchUrlReadResult {
  const root = (payload ?? {}) as Record<string, unknown>;
  const nested = (root.data ?? {}) as Record<string, unknown>;

  const title = payloadText(nested.title) || payloadText(root.title);
  const content = payloadText(nested.content) || payloadText(root.content);

  return {
    url,
    ...(title ? { title } : {}),
    ...(content ? { content } : {}),
  };
}
