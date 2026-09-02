/**
 * DuckDuckGo SERP parsing — the `html.duckduckgo.com` layout, falling back to
 * the `lite.duckduckgo.com` table layout within the same document.
 *
 * Ported from Elftia's `webFetchSearch.parseDuckDuckGoResults` /
 * `cleanDuckDuckGoUrl` (baseline §3.3), plus {@link isDuckDuckGoSerp} for the
 * plan-mandated empty-vs-drift distinction.
 *
 * @module search/http/parsers/duckduckgo
 */

import type { SearchResult } from '@omnicross/contracts/search-types';
import { JSDOM } from 'jsdom';

import { cleanText, isUsableResult } from '../text';
import type { ParsedSerp } from '../types';

/** Base URL jsdom resolves relative hrefs against — matches the baseline. */
const DUCKDUCKGO_SERP_URL = 'https://html.duckduckgo.com/html/';

/**
 * Structural markers for "this really is a DuckDuckGo SERP".
 *
 * `#links` / `.results` wrap the html layout; `a.result-link` is the lite
 * layout's result anchor (the committed lite capture has no `#links` wrapper at
 * all). The 202 challenge shell matches none of them, which is correct — its
 * status is what identifies it, and an unrecognized body must stay unrecognized.
 */
const DUCKDUCKGO_SERP_MARKERS = '#links, .results, a.result-link';

/** Whether the document is structurally a DuckDuckGo SERP, results or not. */
export function isDuckDuckGoSerp(document: Document): boolean {
  return document.querySelector(DUCKDUCKGO_SERP_MARKERS) !== null;
}

/** Parse a DuckDuckGo SERP (either layout) into results plus its verdict. */
export function parseDuckDuckGoSerp(html: string, maxResults: number): ParsedSerp {
  const document = new JSDOM(html, { url: DUCKDUCKGO_SERP_URL }).window.document;

  const htmlResults: SearchResult[] = [
    ...document.querySelectorAll<HTMLElement>('.result, .result--web, .web-result'),
  ]
    .map((container) => {
      const link = container.querySelector<HTMLAnchorElement>('a.result__a, .result__a');
      return {
        title: cleanText(link?.textContent),
        url: cleanDuckDuckGoUrl(link?.href ?? ''),
        content: cleanText(container.querySelector('.result__snippet, .result__body')?.textContent),
      };
    })
    .filter(isUsableResult);
  if (htmlResults.length > 0) {
    return { recognized: true, results: htmlResults.slice(0, maxResults) };
  }

  const liteResults: SearchResult[] = [
    ...document.querySelectorAll<HTMLAnchorElement>('a.result-link'),
  ]
    .map((link) => {
      const row = link.closest('tr');
      const snippet = row?.nextElementSibling?.querySelector('.result-snippet');
      return {
        title: cleanText(link.textContent),
        url: cleanDuckDuckGoUrl(link.href),
        content: cleanText(snippet?.textContent),
      };
    })
    .filter(isUsableResult)
    .slice(0, maxResults);

  return { recognized: isDuckDuckGoSerp(document), results: liteResults };
}

/**
 * Unwrap DuckDuckGo's `//duckduckgo.com/l/?uddg=<encoded>` redirects.
 *
 * Protocol-relative hrefs are promoted to `https:` first so the `uddg`
 * parameter is reachable; a link without one keeps its absolute href.
 */
export function cleanDuckDuckGoUrl(rawUrl: string): string {
  try {
    const absoluteUrl = rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl;
    const url = new URL(absoluteUrl, 'https://html.duckduckgo.com');
    return url.searchParams.get('uddg') ?? url.href;
  } catch {
    return rawUrl;
  }
}
