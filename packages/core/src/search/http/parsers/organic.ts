import type { SearchResult } from '@omnicross/contracts/search-types';
import { JSDOM } from 'jsdom';

import { excludedDomainsFromQuery, isExcludedSearchUrl } from '../../domainFilters';
import { cleanText } from '../text';
import type { ParsedSerp } from '../types';

interface OrganicSelectors {
  baseUrl: string;
  ownDomains: readonly string[];
  rows: string;
  heading: string;
  snippetFallback?: string;
  snippet: string;
}

/** Only scoped organic rows count: a result shell alone is not a successful search. */
export function parseOrganicSerp(
  html: string,
  maxResults: number,
  selectors: OrganicSelectors,
  query = '',
): ParsedSerp {
  const limit = Math.trunc(maxResults);
  if (!(limit > 0)) return { recognized: false, results: [] };
  const excludedDomains = excludedDomainsFromQuery(query);
  const dom = new JSDOM(html, { url: selectors.baseUrl });
  try {
    const results: SearchResult[] = [];
    let sawValidRow = false;
    const seen = new Set<string>();
    for (const row of dom.window.document.querySelectorAll(selectors.rows)) {
      const heading = row.querySelector(selectors.heading);
      const anchor = heading?.closest('a[href]') ?? heading?.querySelector('a[href]');
      // closest() must not escape an organic row into an unrelated enclosing link.
      if (!anchor || !row.contains(anchor)) continue;
      const title = cleanText((heading?.querySelector('h2, h3') ?? heading)?.textContent);
      if (!title || /^(?:n\/?a|not available)$/i.test(title)) continue;
      let url: URL;
      try {
        url = new URL(anchor.getAttribute('href') ?? '', selectors.baseUrl);
      } catch {
        continue;
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
      if (url.username || url.password) continue;
      if (selectors.ownDomains.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) {
        continue;
      }
      sawValidRow = true;
      if (isExcludedSearchUrl(url, excludedDomains)) continue;
      url.hash = '';
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      results.push({
        title,
        url: url.href,
        content: cleanText((
          row.querySelector(selectors.snippet) ??
          (selectors.snippetFallback ? row.querySelector(selectors.snippetFallback) : null)
        )?.textContent),
      });
      if (results.length >= limit) break;
    }
    return { recognized: sawValidRow, results };
  } finally {
    dom.window.close();
  }
}

/** Challenge markers are markup, not arbitrary words in organic snippets. */
export function commonChallengeError(html: string): string | null {
  for (const [script] of html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi)) {
    if (
      /\bsrc\s*=\s*["'][^"']*\/cdn-cgi\/challenge-platform\//i.test(script) ||
      /\b(?:window\.)?_cf_chl_opt\s*=/.test(script)
    ) {
      return 'search engine returned a bot challenge instead of source results';
    }
  }
  return /<title\b[^>]*>\s*(?:Just a moment(?:\.{3})?|Ecosia Firewall|Captcha|Access denied)\s*<\/title>/i.test(html)
    ? 'search engine returned a bot challenge instead of source results'
    : null;
}
