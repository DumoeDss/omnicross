/**
 * The Bing anti-decoy trust check.
 *
 * Bing sometimes answers a browser-shaped request with a topically unrelated
 * "decoy" result page (the committed `bing-serp-untrusted-decoy.html` is a real
 * one). Those results are indistinguishable from genuine ones structurally, so
 * the only defense is a relevance check between the query and what came back —
 * run BEFORE anything else decides the page's outcome.
 *
 * Ported from Elftia's `webFetchSearch.searchPageTrustError` / `bingTrustError`
 * / `meaningfulQueryTerms` (baseline §3.3, §6.6). The Google JavaScript-shell
 * branch of `searchPageTrustError` is deliberately NOT ported: it serves
 * Elftia's WebFetch of google.com pages, and no Google HTTP provider exists here
 * (`builtin-web-fetch` is out of this change's scope).
 *
 * ONE divergence from the frozen baseline, recorded here because this file is
 * now the single source of truth (Elftia consumes Omnicross's search runtime):
 * substring matching runs on a SEPARATOR-FREE canonical form of the page text,
 * so "Node.js" satisfies the query term "nodejs" and "GLM-4" the term "glm4".
 * The baseline refused real SERPs over exactly that spelling gap — verified
 * live 2026-09-04: the query `nodejs 文件读取` returned genuine results whose
 * titles spell it "Node.js", and the check refused the page as a decoy.
 *
 * @module search/http/trust
 */

import { JSDOM } from 'jsdom';

import { bingResultLinks } from './parsers/bing';

/**
 * Query words that carry no topical signal, plus the search-operator keywords
 * (`site`, `filetype`, …) that appear in queries but never in result text.
 */
const QUERY_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'at',
  'by',
  'for',
  'from',
  'in',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
  'site',
  'filetype',
  'inurl',
  'intitle',
]);

/**
 * Refuse a Bing result page that does not answer its own query.
 *
 * The query is read from the FINAL URL, not from the caller's argument — Bing
 * geo-redirects (`www.bing.com` → `cn.bing.com`) preserve `q`, and it is the
 * served page's own query that has to match its content. A URL without `/search`
 * or without a query yields no verdict.
 *
 * @returns a refusal message, or `null` when the page is trusted.
 */
export function bingSearchPageTrustError(finalUrl: string, html: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(finalUrl);
  } catch {
    return null;
  }
  if (parsed.pathname !== '/search') return null;

  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== 'bing.com' && !hostname.endsWith('.bing.com')) return null;

  return bingTrustError(parsed.searchParams.get('q') ?? '', html);
}

/**
 * Two-stage relevance check over a Bing SERP.
 *
 * 1. Zero query terms anywhere in the result TITLES → refuse outright (the
 *    decoy signature).
 * 2. Otherwise require coverage across titles, hrefs and snippets: one term for
 *    a single-term query, two distinct terms for anything longer.
 */
export function bingTrustError(query: string, html: string): string | null {
  const document = new JSDOM(html).window.document;
  const links = bingResultLinks(document);
  if (links.length === 0) return null;

  const terms = meaningfulQueryTerms(query);
  if (terms.length === 0) return null;

  const titleSearchable = separatorFree(
    links
      .map((link) => link.textContent ?? '')
      .join(' ')
      .normalize('NFKC')
      .toLocaleLowerCase(),
  );
  if (!terms.some((term) => titleSearchable.includes(term))) {
    return 'Bing returned an untrusted search result page with zero query-term hits in result titles; refusing to return possible bot-decoy content.';
  }

  const searchable = separatorFree(
    links
      .map((link) => {
        const container = link.closest('li.b_algo, .b_algo');
        return `${link.textContent ?? ''} ${link.getAttribute('href') ?? ''} ${
          container?.querySelector('.b_caption p, .b_algoSlug, p')?.textContent ?? ''
        }`;
      })
      .join(' ')
      .normalize('NFKC')
      .toLocaleLowerCase(),
  );
  const coveredTerms = terms.filter((term) => searchable.includes(term));
  const requiredCoverage = terms.length === 1 ? 1 : 2;
  return new Set(coveredTerms).size >= requiredCoverage
    ? null
    : 'Bing returned an untrusted search result page; refusing to return possible bot-decoy content.';
}

/**
 * The separator-free canonical form substring matching runs on.
 *
 * Separators INSIDE a word are spelling, not semantics: "Node.js" must satisfy
 * "nodejs", "GLM-4" must satisfy "glm4". Whitespace is kept as a word boundary;
 * everything outside letters and digits goes. Applied to the PAGE text only —
 * query terms are already separator-free (the tokenizer splits on them).
 */
function separatorFree(text: string): string {
  return text.replace(/[^\p{L}\p{N}\s]/gu, '');
}

/**
 * Tokenize a query into matchable terms.
 *
 * Han-script tokens are additionally expanded into character bigrams, because
 * Chinese result titles segment differently than the query does — without the
 * expansion a legitimate `cn.bing.com` page would be refused as a decoy.
 */
export function meaningfulQueryTerms(query: string): string[] {
  const terms =
    query
      .normalize('NFKC')
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const expanded = terms.flatMap((term) => {
    if (QUERY_STOP_WORDS.has(term) || !/\p{Script=Han}/u.test(term)) return [term];
    const characters = [...term];
    const bigrams = characters.slice(0, -1).map((character, index) => {
      return character + characters[index + 1];
    });
    return [term, ...bigrams];
  });
  return [...new Set(expanded.filter((term) => !QUERY_STOP_WORDS.has(term)))];
}
