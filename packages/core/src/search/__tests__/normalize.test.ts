/**
 * The baseline's result safety checks, ported (`elftia-search-baseline.md`
 * §6.3/§6.4) — plus the one rule deliberately left behind.
 */

import type { SearchResult } from '@omnicross/contracts/search-types';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_NORMALIZED_MAX_RESULTS,
  isDirectResultUrl,
  normalizeSearchResults,
  normalizedResultLimit,
} from '../normalize';

function result(overrides: Partial<SearchResult> = {}): SearchResult {
  return { title: 'Title', url: 'https://example.com/page', content: 'snippet', ...overrides };
}

describe('isDirectResultUrl — SERP-redirect rejection table', () => {
  it('accepts ordinary http(s) result URLs', () => {
    expect(isDirectResultUrl('https://example.com/page')).toBe(true);
    expect(isDirectResultUrl('http://example.com/page')).toBe(true);
    expect(isDirectResultUrl('https://developer.mozilla.org/en-US/docs/Web/HTTP')).toBe(true);
  });

  it('rejects non-http schemes and unparseable URLs', () => {
    expect(isDirectResultUrl('ftp://example.com/file')).toBe(false);
    expect(isDirectResultUrl('javascript:alert(1)')).toBe(false);
    expect(isDirectResultUrl('data:text/html,<b>x</b>')).toBe(false);
    expect(isDirectResultUrl('not a url')).toBe(false);
    expect(isDirectResultUrl('')).toBe(false);
  });

  it('rejects each engine redirect path in the baseline table', () => {
    expect(isDirectResultUrl('https://www.google.com/search?q=x')).toBe(false);
    expect(isDirectResultUrl('https://google.com/goto?u=x')).toBe(false);
    expect(isDirectResultUrl('https://www.bing.com/search?q=x')).toBe(false);
    expect(isDirectResultUrl('https://duckduckgo.com/html/?q=x')).toBe(false);
    expect(isDirectResultUrl('https://duckduckgo.com/l/?uddg=x')).toBe(false);
    expect(isDirectResultUrl('https://www.baidu.com/s?wd=x')).toBe(false);
  });

  it('matches a host exactly or as a subdomain, and nothing else', () => {
    expect(isDirectResultUrl('https://cn.bing.com/search?q=x')).toBe(false);
    // `notbing.com` merely ENDS with the domain text; it is a different site.
    expect(isDirectResultUrl('https://notbing.com/search?q=x')).toBe(true);
    expect(isDirectResultUrl('https://bing.com.evil.example/search')).toBe(true);
  });

  it('matches the pathname exactly, as the baseline does', () => {
    // The baseline compares with `===`/`includes([...])`, not a prefix test:
    // a deeper path under the same host is a real page, not a redirect.
    expect(isDirectResultUrl('https://www.bing.com/images/search')).toBe(true);
    expect(isDirectResultUrl('https://duckduckgo.com/html/faq')).toBe(true);
    expect(isDirectResultUrl('https://www.baidu.com/s/article')).toBe(true);
  });

  it('does not care about case in the host', () => {
    expect(isDirectResultUrl('https://WWW.BING.COM/search?q=x')).toBe(false);
  });
});

describe('normalizedResultLimit', () => {
  it('defaults to the baseline five and never drops below one', () => {
    expect(normalizedResultLimit(undefined)).toBe(DEFAULT_NORMALIZED_MAX_RESULTS);
    expect(normalizedResultLimit(0)).toBe(1);
    expect(normalizedResultLimit(-3)).toBe(1);
  });

  it('imposes no upper clamp of its own', () => {
    expect(normalizedResultLimit(50)).toBe(50);
    expect(normalizedResultLimit(1_000)).toBe(1_000);
  });

  it('falls back to the default for a non-finite request', () => {
    // 阶段2 left NaN at baseline parity and named this layer as the one that
    // should normalize it — otherwise `slice(0, NaN)` silently returns nothing.
    expect(normalizedResultLimit(Number.NaN)).toBe(DEFAULT_NORMALIZED_MAX_RESULTS);
    expect(normalizedResultLimit(Number.POSITIVE_INFINITY)).toBe(DEFAULT_NORMALIZED_MAX_RESULTS);
    expect(normalizedResultLimit(3.7)).toBe(3);
  });
});

describe('normalizeSearchResults', () => {
  it('trims titles and content, and defaults missing content to empty', () => {
    expect(
      normalizeSearchResults([
        result({ title: '  Padded title  ', content: '\n  padded snippet \t' }),
        result({ url: 'https://example.com/other', content: undefined as unknown as string }),
      ]),
    ).toEqual([
      { title: 'Padded title', url: 'https://example.com/page', content: 'padded snippet' },
      { title: 'Title', url: 'https://example.com/other', content: '' },
    ]);
  });

  it('drops items with no usable title', () => {
    expect(
      normalizeSearchResults([
        result({ title: '   ' }),
        result({ title: '', url: 'https://example.com/b' }),
        result({ title: 'Kept', url: 'https://example.com/c' }),
      ]).map((entry) => entry.title),
    ).toEqual(['Kept']);
  });

  it('drops SERP redirects, dedupes by trimmed URL, and preserves order', () => {
    const normalized = normalizeSearchResults([
      result({ title: 'Redirect', url: 'https://www.bing.com/search?q=http' }),
      result({ title: 'First', url: 'https://example.com/a' }),
      result({ title: 'Duplicate', url: '  https://example.com/a  ' }),
      result({ title: 'Second', url: 'https://example.com/b' }),
    ]);

    expect(normalized.map((entry) => entry.title)).toEqual(['First', 'Second']);
    expect(normalized.map((entry) => entry.url)).toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ]);
  });

  it('caps at the requested limit', () => {
    const many = Array.from({ length: 12 }, (_unused, index) =>
      result({ title: `Result ${index}`, url: `https://example.com/${index}` }),
    );

    expect(normalizeSearchResults(many)).toHaveLength(DEFAULT_NORMALIZED_MAX_RESULTS);
    expect(normalizeSearchResults(many, 3)).toHaveLength(3);
    expect(normalizeSearchResults(many, 12)).toHaveLength(12);
  });

  it('keeps a single deduplicated result instead of calling it a scrape failure', () => {
    // The baseline's duplicate-only invalidation is deliberately NOT ported:
    // 阶段2's providers surface a collapsed scrape as `parse_failed`, and for
    // an API or host provider one deduplicated result is a real answer.
    const normalized = normalizeSearchResults([
      result({ title: 'Only', url: 'https://example.com/only' }),
      result({ title: 'Only again', url: 'https://example.com/only' }),
      result({ title: 'Only once more', url: 'https://example.com/only' }),
    ]);

    expect(normalized).toEqual([
      { title: 'Only', url: 'https://example.com/only', content: 'snippet' },
    ]);
  });

  it('filters rather than failing when nothing survives', () => {
    expect(
      normalizeSearchResults([
        result({ title: 'Redirect', url: 'https://duckduckgo.com/l/?uddg=x' }),
        result({ title: '', url: 'https://example.com/b' }),
      ]),
    ).toEqual([]);
  });

  it('survives malformed items from an untrusted provider', () => {
    const hostile = [
      null,
      undefined,
      'a string',
      { title: 42, url: 'https://example.com/x', content: 'c' },
      { title: 'Good', url: 17, content: 'c' },
      result({ title: 'Survivor', url: 'https://example.com/survivor' }),
    ] as unknown as SearchResult[];

    expect(normalizeSearchResults(hostile)).toEqual([
      { title: 'Survivor', url: 'https://example.com/survivor', content: 'snippet' },
    ]);
  });
});
