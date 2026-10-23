import { describe, expect, it } from 'vitest';

import { excludedDomainsFromQuery, isExcludedSearchUrl } from '../domainFilters';

describe('search domain exclusion policy', () => {
  it('retains every exclusion beyond wire-level provider limits', () => {
    const domains = Array.from({ length: 75 }, (_, index) => `excluded-${index}.test`);
    const excluded = excludedDomainsFromQuery(`query ${domains.map((domain) => `-site:${domain}`).join(' ')}`);
    expect(excluded).toEqual(domains);
    expect(isExcludedSearchUrl('https://excluded-74.test/source', excluded)).toBe(true);
  });

  it('canonicalizes case, terminal DNS dots and IDNA in directives and results', () => {
    const excluded = excludedDomainsFromQuery('query -site:BÜCHER.example. -site:Example.TEST.');
    expect(excluded).toEqual(['xn--bcher-kva.example', 'example.test']);
    for (const url of [
      'https://xn--bcher-kva.example./a', 'https://sub.bücher.example/a',
      'https://EXAMPLE.TEST./a', new URL('https://sub.example.test./a'),
    ]) expect(isExcludedSearchUrl(url, excluded)).toBe(true);
  });

  it('matches exact hostnames and real subdomains, never string suffix lookalikes', () => {
    const excluded = excludedDomainsFromQuery('query -site:blocked.test');
    for (const url of ['https://blocked.test/', 'https://a.blocked.test/']) {
      expect(isExcludedSearchUrl(url, excluded)).toBe(true);
    }
    for (const url of ['https://notblocked.test/', 'https://blocked.test.attacker.test/', 'https://allowed.test/path/blocked.test', 'not a URL']) {
      expect(isExcludedSearchUrl(url, excluded)).toBe(false);
    }
  });

  it('accepts quoted domain directives but leaves positive and path-specific site queries upstream', () => {
    const excluded = excludedDomainsFromQuery('query site:included.test -site:"blocked.test" -site:\'other.test.\' -site:https://third.test/ -site:paths.test/some/path');
    expect(excluded).toEqual(['blocked.test', 'other.test', 'third.test']);
    expect(isExcludedSearchUrl('https://included.test/', excluded)).toBe(false);
    expect(isExcludedSearchUrl('https://paths.test/unrelated', excluded)).toBe(false);
  });
});
