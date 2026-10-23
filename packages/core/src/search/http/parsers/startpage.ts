import { commonChallengeError, parseOrganicSerp } from './organic';
import type { ParsedSerp } from '../types';

export function startpageTrustError(finalUrl: string, html: string): string | null {
  if (
    /\/(?:[^/]+\/)?(?:errors|captcha)(?:\/|$)/i.test(new URL(finalUrl).pathname) ||
    /component---src-pages-captcha/.test(html) ||
    /["']\/sp\/captcha(?:[/?"'])/.test(html)
  ) {
    return 'Startpage returned a CAPTCHA page; no challenge solving is attempted';
  }
  return commonChallengeError(html);
}

export function parseStartpageSerp(html: string, maxResults: number, query = ''): ParsedSerp {
  return parseOrganicSerp(html, maxResults, {
    baseUrl: 'https://www.startpage.com/sp/search',
    ownDomains: ['startpage.com'],
    rows: 'div.result',
    heading: 'a.result-link h2, a.result-link h3, a.result-link',
    snippet: 'p.description',
  }, query);
}
