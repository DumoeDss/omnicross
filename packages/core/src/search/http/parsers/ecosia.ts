import { commonChallengeError, parseOrganicSerp } from './organic';
import type { ParsedSerp } from '../types';

export function parseEcosiaSerp(html: string, maxResults: number, query = ''): ParsedSerp {
  return parseOrganicSerp(html, maxResults, {
    baseUrl: 'https://www.ecosia.org/search',
    ownDomains: ['ecosia.org'],
    rows: 'article[data-test-id="organic-result"]',
    heading: '[data-test-id="result-title"]',
    snippet: '[data-test-id="web-result-description"]',
    snippetFallback: '[data-test-id="result-description"]',
  }, query);
}

export const ecosiaTrustError = (_finalUrl: string, html: string): string | null =>
  commonChallengeError(html);
