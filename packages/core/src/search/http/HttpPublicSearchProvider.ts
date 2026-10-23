import type {
  SearchExecutionContext,
  SearchOptions,
  SearchProvider,
  SearchResult,
} from '@omnicross/contracts/search-types';

import { excludedDomainsFromQuery, isExcludedSearchUrl } from '../domainFilters';
import { clampMaxResults, DEFAULT_SEARCH_TIMEOUT_MS, MAX_RESULTS } from './engine';
import { searchHttpError } from './errors';
import { HttpBingProvider } from './HttpBingProvider';
import { HttpDuckDuckGoProvider } from './HttpDuckDuckGoProvider';
import { HttpEcosiaProvider } from './HttpEcosiaProvider';
import { HttpMojeekProvider } from './HttpMojeekProvider';
import { HttpStartpageProvider } from './HttpStartpageProvider';
import type { SearchHttpTransport } from './types';

export const HTTP_PUBLIC_PROVIDER_ID = 'public';
export type HttpPublicChildId =
  | 'http-bing'
  | 'http-duckduckgo'
  | 'http-startpage'
  | 'http-ecosia'
  | 'http-mojeek';

export interface HttpPublicSearchOptions {
  /** Read on every search; omitted means no children, never all children. */
  allowedChildIds?: readonly HttpPublicChildId[] | (() => readonly HttpPublicChildId[]);
}

interface RankedResult {
  result: SearchResult;
  score: number;
  order: number;
}

/** Reciprocal-rank fusion gives consensus hits priority without trusting engine scores. */
function rankResults(
  pages: readonly SearchResult[][],
  maxResults: number,
  excludedDomains: readonly string[],
): SearchResult[] {
  const ranked = new Map<string, RankedResult>();
  for (const page of pages) {
    const seen = new Set<string>();
    for (const [index, result] of page.entries()) {
      if (!result.title.trim() || /^(?:n\/?a|not available)$/i.test(result.title.trim())) continue;
      let url: URL;
      try {
        url = new URL(result.url);
      } catch {
        continue;
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
      if (url.username || url.password) continue;
      if (isExcludedSearchUrl(url, excludedDomains)) continue;
      // Existing parsers can retain an unresolved tracking/navigation link;
      // aggregate results must still be direct external source URLs.
      if (/(?:^|\.)(?:bing\.com|duckduckgo\.com|startpage\.com|ecosia\.org|mojeek\.(?:com|co\.uk|fr|de))$/i.test(url.hostname)) continue;
      url.hash = '';
      for (const key of [...url.searchParams.keys()]) {
        if (/^(?:utm_.+|gclid|fbclid|msclkid)$/i.test(key)) url.searchParams.delete(key);
      }
      url.searchParams.sort();
      const key = url.href;
      if (seen.has(key)) continue;
      seen.add(key);
      const score = 1 / (60 + index + 1);
      const existing = ranked.get(key);
      if (existing) {
        existing.score += score;
        if (!existing.result.content && result.content) {
          existing.result = { ...existing.result, content: result.content };
        }
      } else {
        ranked.set(key, { result: { ...result, url: key }, score, order: ranked.size });
      }
    }
  }
  return [...ranked.values()]
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, maxResults)
    .map((entry) => entry.result);
}

/** Only Node HTTP engines are eligible, and the host must explicitly allow each child. */
export class HttpPublicSearchProvider implements SearchProvider {
  readonly id = HTTP_PUBLIC_PROVIDER_ID;
  private readonly children: readonly SearchProvider[];

  constructor(
    transport?: SearchHttpTransport,
    private readonly config: HttpPublicSearchOptions = {},
  ) {
    this.children = [
      new HttpBingProvider(transport),
      new HttpDuckDuckGoProvider(transport),
      new HttpStartpageProvider(transport),
      new HttpEcosiaProvider(transport),
      new HttpMojeekProvider(transport),
    ];
  }

  async search(
    query: string,
    options: SearchOptions = {},
    context?: SearchExecutionContext,
  ): Promise<SearchResult[]> {
    const failure = (code: 'cancelled' | 'timeout' | 'config_missing' | 'policy_denied' | 'upstream_unavailable') =>
      searchHttpError(code, {
        cancelled: 'public search was cancelled',
        timeout: 'public search deadline expired without source results',
        config_missing: 'public search has no enabled HTTP child engines',
        policy_denied: 'public search HTTP child engines are denied by runtime policy',
        upstream_unavailable: 'public search child engines produced no valid source results',
      }[code], { stage: 'fetch', providerId: this.id, retryable: code === 'timeout' || code === 'upstream_unavailable' });
    if (options.signal?.aborted) throw failure('cancelled');
    const allowed = typeof this.config.allowedChildIds === 'function'
      ? this.config.allowedChildIds()
      : this.config.allowedChildIds ?? [];
    const configuredChildren = this.children.filter((child) => allowed.some((id) => id === child.id));
    if (configuredChildren.length === 0) throw failure('config_missing');
    const runtimeAllowed = context?.allowedProviderIds;
    const children = runtimeAllowed === undefined
      ? configuredChildren
      : configuredChildren.filter((child) => runtimeAllowed.includes(child.id));
    if (children.length === 0) throw failure('policy_denied');

    const timeout = options.timeout ?? DEFAULT_SEARCH_TIMEOUT_MS;
    if (!Number.isFinite(timeout) || timeout <= 0) throw failure('timeout');
    const controller = new AbortController();
    const pages: SearchResult[][] = children.map(() => []);
    let timedOut = false;
    let cancelled = false;
    let finish!: () => void;
    const stopped = new Promise<void>((resolve) => { finish = resolve; });
    const onCancel = () => {
      cancelled = true;
      controller.abort();
      finish();
    };
    options.signal?.addEventListener('abort', onCancel, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      finish();
    }, Math.min(timeout, 2_147_483_647));
    try {
      const excludedDomains = excludedDomainsFromQuery(query);
      // Catch every child rejection, including late aborts after the race settles.
      const tasks = children.map(async (child, index) => {
        try {
          const results = await child.search(query, {
            ...options,
            maxResults: MAX_RESULTS,
            timeout,
            signal: controller.signal,
          });
          if (!controller.signal.aborted) pages[index] = results;
        } catch {
          // One blocked engine does not erase independent, valid source rows.
        }
      });
      await Promise.race([Promise.all(tasks), stopped]);
      if (cancelled || options.signal?.aborted) throw failure('cancelled');
      const results = rankResults(pages, clampMaxResults(options.maxResults), excludedDomains);
      if (results.length > 0) return results;
      throw failure(timedOut ? 'timeout' : 'upstream_unavailable');
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onCancel);
      controller.abort();
    }
  }
}
