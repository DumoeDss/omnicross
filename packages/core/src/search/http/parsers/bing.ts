/**
 * Bing SERP parsing.
 *
 * Ported from Elftia's `webFetchSearch.parseBingResults` / `bingResultLinks` /
 * `cleanBingUrl` (baseline §3.3), plus one addition the plan requires:
 * {@link isBingSerp}, the structural marker that separates "Bing found nothing"
 * from "Bing's markup changed under us".
 *
 * @module search/http/parsers/bing
 */

import type { SearchResult } from '@omnicross/contracts/search-types';
import { JSDOM } from 'jsdom';

import { cleanText, isUsableResult } from '../text';
import type { ParsedSerp } from '../types';

/** Base URL jsdom resolves relative hrefs against — matches the baseline. */
const BING_SERP_URL = 'https://www.bing.com/search';

/**
 * Structural markers for "this really is a Bing SERP".
 *
 * Both selectors are present in the committed fixtures (`#b_results` wraps
 * every capture; `.b_algo` is the organic result container). Nothing broader is
 * used: an unrecognized page must stay unrecognized, because that is the
 * parser-drift alarm.
 */
const BING_SERP_MARKERS = '#b_results, .b_algo';

/** The organic result anchors, scoped first and document-wide as a fallback. */
export function bingResultLinks(document: Document): HTMLAnchorElement[] {
  const scoped = [
    ...document.querySelectorAll<HTMLAnchorElement>('li.b_algo h2 a, #b_results .b_algo h2 a'),
  ];
  return scoped.length > 0 ? scoped : [...document.querySelectorAll<HTMLAnchorElement>('h2 a[href]')];
}

/** Whether the document is structurally a Bing SERP, results or not. */
export function isBingSerp(document: Document): boolean {
  return document.querySelector(BING_SERP_MARKERS) !== null;
}

/** Parse a Bing SERP into results plus its recognition verdict. */
export function parseBingSerp(html: string, maxResults: number): ParsedSerp {
  const document = new JSDOM(html, { url: BING_SERP_URL }).window.document;
  const results: SearchResult[] = bingResultLinks(document)
    .map((link) => {
      const container = link.closest('li.b_algo, .b_algo');
      return {
        title: cleanText(link.textContent),
        url: cleanBingUrl(link.href),
        content: cleanText(container?.querySelector('.b_caption p, .b_algoSlug, p')?.textContent),
      };
    })
    .filter(isUsableResult)
    .slice(0, maxResults);

  return { recognized: isBingSerp(document), results };
}

/**
 * Unwrap Bing's `/ck/a?u=a1<base64url>` click-tracking links.
 *
 * The decoded target is used only when it is an absolute http(s) URL; anything
 * else (a missing `a1` prefix, a relative path, undecodable base64) falls back
 * to the absolute `/ck/a` href rather than dropping the result.
 */
export function cleanBingUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl, 'https://www.bing.com');
    const hostname = url.hostname.toLowerCase();
    if ((hostname === 'bing.com' || hostname.endsWith('.bing.com')) && url.pathname === '/ck/a') {
      const encodedTarget = url.searchParams.get('u');
      if (encodedTarget?.startsWith('a1')) {
        const decoded = Buffer.from(encodedTarget.slice(2), 'base64url').toString('utf8');
        if (/^https?:\/\//i.test(decoded)) return decoded;
      }
    }
    return url.href;
  } catch {
    return rawUrl;
  }
}
