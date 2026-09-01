/**
 * Result normalization — the baseline's safety checks, ported.
 *
 * A search result is untrusted input: it is produced by a page or an API the
 * user does not control, and it is handed straight to a model that may follow
 * the URL. The baseline (`elftia-search-baseline.md` §6.3/§6.4) filtered three
 * things before letting results out of the orchestrator, and all three are kept
 * here: a result needs a title, its URL must be a DIRECT result rather than a
 * search-engine redirect, and the set must not repeat itself.
 *
 * One baseline behavior is deliberately NOT ported: **duplicate-only
 * invalidation** — the rule that turned "exactly one survivor out of more than
 * one structurally usable item" into `Provider returned only duplicate results`.
 * It existed to catch a scrape that collapsed to a single repeated link, and
 * 阶段2's HTTP providers now detect that themselves and raise `parse_failed`.
 * For an API or host provider, one deduplicated result is a legitimate answer,
 * not a failure. Recorded as an allowed difference for 阶段5's comparison.
 *
 * Normalization NEVER fails: it filters. Whether a search succeeded is the
 * provider's answer, decided before these results get here — turning "every
 * item was filtered" back into an error would hand the fallback policy a third
 * outcome to interpret, which is exactly the conflation 阶段2 removed.
 *
 * @module search/normalize
 */

import type { SearchResult } from '@omnicross/contracts/search-types';

/** Results returned when the caller expresses no preference (baseline parity). */
export const DEFAULT_NORMALIZED_MAX_RESULTS = 5;

/**
 * SERP-redirect shapes to reject, from baseline §6.4.
 *
 * A host matches exactly or as a `.<domain>` suffix; a pathname matches
 * EXACTLY, as the baseline's `===`/`includes([...])` comparisons do. Prefix
 * matching would be a behavior change — `duckduckgo.com/html/x` is rejected by
 * neither implementation.
 */
const SERP_REDIRECT_RULES: readonly { readonly domain: string; readonly paths: readonly string[] }[] = [
  { domain: 'google.com', paths: ['/search', '/goto'] },
  { domain: 'bing.com', paths: ['/search'] },
  { domain: 'duckduckgo.com', paths: ['/html/', '/l/'] },
  { domain: 'baidu.com', paths: ['/s'] },
];

/**
 * Whether a URL points at a result rather than back at a search engine.
 *
 * Accepts only `http:`/`https:`; an unparseable URL is rejected. This is the
 * check that keeps a SERP-redirect link — which re-runs a search instead of
 * opening a page — out of a result set.
 */
export function isDirectResultUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  const host = url.hostname.toLowerCase();
  for (const rule of SERP_REDIRECT_RULES) {
    if (host !== rule.domain && !host.endsWith(`.${rule.domain}`)) continue;
    if (rule.paths.includes(url.pathname)) return false;
  }
  return true;
}

/**
 * How many results to keep.
 *
 * `Math.max(1, …)` with no upper clamp, per baseline §4.4 — a provider's own
 * limit is the provider's business, and imposing a second ceiling here would
 * silently contradict whatever it declared in its capabilities.
 *
 * Non-finite input falls back to the default rather than propagating: 阶段2's
 * `clampMaxResults` left `NaN` at baseline parity on purpose and named the
 * runtime that owns option handling — this one — as where it should be
 * normalized. Without this, a `NaN` reaches `slice(0, NaN)` and silently
 * discards every result.
 */
export function normalizedResultLimit(maxResults: number | undefined): number {
  const requested =
    maxResults === undefined || !Number.isFinite(maxResults)
      ? DEFAULT_NORMALIZED_MAX_RESULTS
      : Math.floor(maxResults);
  return Math.max(1, requested);
}

/**
 * Apply the baseline's safety checks to one provider's results.
 *
 * Order is preserved; trimming happens before every comparison, so dedupe sees
 * the same URL string a consumer will.
 */
export function normalizeSearchResults(
  results: readonly SearchResult[],
  maxResults?: number,
): SearchResult[] {
  const limit = normalizedResultLimit(maxResults);
  const seenUrls = new Set<string>();
  const normalized: SearchResult[] = [];

  for (const result of results) {
    if (result === null || typeof result !== 'object') continue;

    const title = typeof result.title === 'string' ? result.title.trim() : '';
    const url = typeof result.url === 'string' ? result.url.trim() : '';
    if (title.length === 0 || !isDirectResultUrl(url)) continue;
    if (seenUrls.has(url)) continue;

    seenUrls.add(url);
    normalized.push({
      title,
      url,
      content: typeof result.content === 'string' ? result.content.trim() : '',
    });
    if (normalized.length >= limit) break;
  }

  return normalized;
}
