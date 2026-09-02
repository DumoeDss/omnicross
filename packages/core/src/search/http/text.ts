/**
 * Text normalization shared by both SERP parsers.
 *
 * Ported verbatim from Elftia's `webFetchSearch.cleanText` / `isUsableResult`,
 * down to the `entities` version (`^6.0.1`), so extraction is byte-comparable
 * with the baseline when 阶段5 compares the two runtimes.
 *
 * @module search/http/text
 */

import type { SearchResult } from '@omnicross/contracts/search-types';
import { decodeHTML } from 'entities';

/** Upper bound on any extracted title or snippet. */
const MAX_TEXT_LENGTH = 500;

/**
 * Decode entities, collapse whitespace, trim, cap.
 *
 * The double decode is intentional and inherited: jsdom's `textContent` already
 * resolves entities once, and `decodeHTML` resolves them again, so a literal
 * `&amp;lt;` in the page becomes `<`. Byte-parity with the baseline beats
 * theoretical correctness here — both runtimes share the quirk, so behavior
 * comparisons stay clean.
 */
export function cleanText(value: string | null | undefined): string {
  return decodeHTML(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT_LENGTH);
}

/** A result is usable when it has a title and an absolute http(s) URL. */
export function isUsableResult(result: SearchResult): boolean {
  return Boolean(result.title && /^https?:\/\//i.test(result.url));
}
