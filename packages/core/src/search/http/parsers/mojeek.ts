import { commonChallengeError, parseOrganicSerp } from './organic';
import type { ParsedSerp } from '../types';

export function mojeekTrustError(_finalUrl: string, html: string): string | null {
  if (
    /<altcha-widget\b/i.test(html) ||
    /\bclass\s*=\s*["'][^"']*\bcaptcha-wrap\b/i.test(html) ||
    /<title\b[^>]*>[^<]*automated queries[^<]*<\/title>/i.test(html)
  ) {
    return 'Mojeek returned an automated-queries wall; no challenge solving is attempted';
  }
  return commonChallengeError(html);
}

export function parseMojeekSerp(html: string, maxResults: number, query = ''): ParsedSerp {
  return parseOrganicSerp(html, maxResults, {
    baseUrl: 'https://www.mojeek.de/search',
    ownDomains: ['mojeek.com', 'mojeek.co.uk', 'mojeek.fr', 'mojeek.de'],
    rows: 'ul.results-standard > li',
    heading: 'h2 a.title, a.title',
    snippet: 'p.s',
  }, query);
}
