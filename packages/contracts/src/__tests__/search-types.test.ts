import { describe, expect, expectTypeOf, it } from 'vitest';

import * as contractsBarrel from '@omnicross/contracts';
import type {
  SearchProviderContribution as BarrelSearchProviderContribution,
  SearchResult as BarrelSearchResult,
} from '@omnicross/contracts';

import {
  isKnownSearchProviderId,
  isSearchProviderError,
  SearchProviderError,
  toSearchErrorShape,
  type KnownSearchProviderId,
  type SearchErrorCode,
  type SearchErrorShape,
  type SearchOptions,
  type SearchProvider,
  type SearchProviderCapabilities,
  type SearchProviderContribution,
  type SearchProviderDiagnostic,
  type SearchProviderHealthStatus,
  type SearchProviderId,
  type SearchRequest,
  type SearchResponse,
  type SearchResult,
} from '../search-types';
import type { WebSearchOptions, WebSearchResult } from '../websearch-types';

const capabilities: SearchProviderCapabilities = {
  requiresApiKey: false,
  supportsRegion: true,
  supportsLanguage: true,
  supportsTimeRange: false,
  supportsUrlRead: false,
  supportsCancellation: true,
};

describe('search error taxonomy', () => {
  it('round-trips an error into a serializable wire shape', () => {
    const error = new SearchProviderError('rate_limited', 'upstream asked us to slow down', {
      providerId: 'tavily',
      retryable: true,
      details: { retryAfterSeconds: '30' },
    });

    const shape = toSearchErrorShape(error);
    const expected: SearchErrorShape = {
      code: 'rate_limited',
      message: 'upstream asked us to slow down',
      providerId: 'tavily',
      retryable: true,
      details: { retryAfterSeconds: '30' },
    };

    expect(shape).toEqual(expected);
    expect(error.toShape()).toEqual(expected);
    expect(JSON.parse(JSON.stringify(shape))).toEqual(expected);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('SearchProviderError');
  });

  it('omits absent optional fields instead of emitting undefined', () => {
    expect(toSearchErrorShape(new SearchProviderError('cancelled', 'aborted by caller'))).toEqual({
      code: 'cancelled',
      message: 'aborted by caller',
    });
  });

  it('keeps `cause` local — it never reaches the wire shape', () => {
    const error = new SearchProviderError('upstream_unavailable', 'transport failed', {
      cause: new Error('ECONNRESET'),
    });

    expect(error.cause).toBeInstanceOf(Error);
    expect(toSearchErrorShape(error)).not.toHaveProperty('cause');
  });

  it('discriminates search errors from plain errors', () => {
    expect(isSearchProviderError(new SearchProviderError('timeout', 'took too long'))).toBe(true);
    expect(isSearchProviderError(new Error('just an error'))).toBe(false);
    expect(isSearchProviderError('config_missing')).toBe(false);
    expect(isSearchProviderError(undefined)).toBe(false);
  });

  it('recognizes a search error thrown by another copy of this package', () => {
    // Two bundles of @omnicross/contracts (ESM + CJS, or src-under-test beside
    // dist) make `instanceof` fail across the boundary; the structural branch
    // is what keeps the taxonomy usable there.
    const fromOtherCopy = Object.assign(new Error('rate limited'), { code: 'rate_limited' });
    const nodeStyleError = Object.assign(new Error('socket timeout'), { code: 'ETIMEDOUT' });

    expect(isSearchProviderError(fromOtherCopy)).toBe(true);
    expect(isSearchProviderError(nodeStyleError)).toBe(false);
  });

  it('maps a non-search failure to the documented default code', () => {
    expect(toSearchErrorShape(new Error('boom'))).toEqual({
      code: 'upstream_unavailable',
      message: 'boom',
    });
    expect(toSearchErrorShape('provider blew up')).toEqual({
      code: 'upstream_unavailable',
      message: 'provider blew up',
    });
    expect(toSearchErrorShape({ weird: true })).toEqual({
      code: 'upstream_unavailable',
      message: 'Unknown error',
    });
  });

  it('is closed at exactly eight codes', () => {
    const codes: SearchErrorCode[] = [
      'config_missing',
      'auth_failed',
      'rate_limited',
      'timeout',
      'upstream_unavailable',
      'parse_failed',
      'cancelled',
      'policy_denied',
    ];
    expect(new Set(codes).size).toBe(8);

    // @ts-expect-error `blocked` is a diagnostic status, never an error code
    const notACode: SearchErrorCode = 'blocked';
    // @ts-expect-error the taxonomy does not grow in this change
    const alsoNotACode: SearchErrorCode = 'invalid_request';
    expect([notACode, alsoNotACode]).toEqual(['blocked', 'invalid_request']);
  });
});

describe('open provider identifiers', () => {
  it('accepts host and namespaced custom ids as first-class', () => {
    const hostContributed: SearchProviderId = 'local-google';
    const namespacedCustom: SearchProviderId = 'acme:internal-search';
    const shipped: SearchProviderId = 'http-bing';

    expect(isKnownSearchProviderId(hostContributed)).toBe(false);
    expect(isKnownSearchProviderId(namespacedCustom)).toBe(false);
    expect(isKnownSearchProviderId(shipped)).toBe(true);
  });

  it('knows exactly the seven ids Omnicross ships in Phase 1', () => {
    const shipped: KnownSearchProviderId[] = [
      'http-bing',
      'http-duckduckgo',
      'tavily',
      'jina',
      'searxng',
      'zhipu',
      'z.ai',
    ];

    expect(new Set(shipped).size).toBe(7);
    expect(shipped.every((id) => isKnownSearchProviderId(id))).toBe(true);

    // Deliberately unregistered in Phase 1 (plan §9): local browser providers
    // stay with the host, and these four are declared-but-dead upstream.
    for (const id of ['local-bing', 'local-duckduckgo', 'grok', 'claude', 'exa', 'bocha']) {
      expect(isKnownSearchProviderId(id)).toBe(false);
    }

    // @ts-expect-error a host contribution is not one of the shipped ids
    const notShipped: KnownSearchProviderId = 'local-google';
    expect(notShipped).toBe('local-google');
  });

  it('narrows to the known union without closing the id space', () => {
    const id: SearchProviderId = 'searxng';
    if (isKnownSearchProviderId(id)) {
      expectTypeOf(id).toEqualTypeOf<KnownSearchProviderId>();
    }
    expect(isKnownSearchProviderId(id)).toBe(true);
  });
});

describe('provider, capabilities, and contribution shapes', () => {
  it('lets a minimal provider satisfy the interface', async () => {
    const minimal: SearchProvider = {
      id: 'http-bing',
      async search() {
        return [{ title: 'HTTP', url: 'https://example.com/http', content: 'a snippet' }];
      },
    };

    expect(minimal.readUrl).toBeUndefined();
    expect(minimal.healthCheck).toBeUndefined();
    await expect(minimal.search('http')).resolves.toEqual([
      { title: 'HTTP', url: 'https://example.com/http', content: 'a snippet' },
    ]);
  });

  it('requires explicit source/kind/capabilities on a contribution', () => {
    const provider: SearchProvider = { id: 'http-bing', search: async () => [] };
    const contribution: SearchProviderContribution = {
      id: 'http-bing',
      source: 'builtin',
      kind: 'http',
      provider,
      capabilities,
      priorityHint: 10,
    };

    expect(contribution.source).toBe('builtin');
    expect(contribution.kind).toBe('http');

    // @ts-expect-error source, kind and capabilities are required declarations
    const incomplete: SearchProviderContribution = { id: 'http-bing', provider };
    expect(incomplete.id).toBe('http-bing');

    // @ts-expect-error classification is declared, never inferred from an id
    const inferredKind: SearchProviderContribution = { ...contribution, kind: 'local' };
    expect(inferredKind.kind).toBe('local');
  });

  it('carries cancellation only through options.signal', async () => {
    const controller = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    const provider: SearchProvider = {
      id: 'tavily',
      async search(_query, options) {
        seen.push(options?.signal);
        return [];
      },
    };

    await provider.search('q', { signal: controller.signal, timeout: 5_000 });
    expect(seen).toEqual([controller.signal]);
    expect(capabilities.supportsCancellation).toBe(true);
  });
});

describe('request/response shapes stay baseline-compatible', () => {
  it('accepts a legacy result with no field mapping', () => {
    const legacy: WebSearchResult = {
      title: 'Hypertext Transfer Protocol',
      content: 'HTTP is an application layer protocol.',
      url: 'https://example.com/http',
    };
    const migrated: SearchResult = legacy;

    expect(migrated).toEqual(legacy);
    expectTypeOf<WebSearchResult>().toEqualTypeOf<SearchResult>();
  });

  it('extends legacy options rather than replacing them', () => {
    const legacy: WebSearchOptions = {
      maxResults: 5,
      timeout: 10_000,
      signal: new AbortController().signal,
      fetchPageContent: true,
    };
    const migrated: SearchOptions = legacy;

    expect(migrated.maxResults).toBe(5);
    expect(migrated.region).toBeUndefined();
    expect(migrated.language).toBeUndefined();
    expect(migrated.timeRange).toBeUndefined();

    const enriched: SearchOptions = { ...legacy, region: 'us', language: 'en', timeRange: 'week' };
    expect(enriched.timeRange).toBe('week');

    // @ts-expect-error the recency window is a closed set
    const badRange: SearchOptions = { timeRange: 'decade' };
    expect(badRange.timeRange).toBe('decade');
  });

  it('models a response with no success flag and no error string', () => {
    const response: SearchResponse = {
      query: 'hypertext transfer protocol',
      providerId: 'http-duckduckgo',
      results: [{ title: 'HTTP', url: 'https://example.com/http', content: '' }],
    };

    expect(Object.keys(response).sort()).toEqual(['providerId', 'query', 'results']);

    // @ts-expect-error failures travel as errors, not as a response flag
    const withSuccess: SearchResponse = { ...response, success: true };
    expect(withSuccess.results).toHaveLength(1);
  });

  it('models a runtime request that may pin one provider', () => {
    const anyProvider: SearchRequest = { query: 'q' };
    const pinned: SearchRequest = { query: 'q', provider: 'jina', options: { maxResults: 3 } };

    expect(anyProvider.provider).toBeUndefined();
    expect(pinned.provider).toBe('jina');
  });
});

describe('diagnostics', () => {
  it('accepts each of the five doctor statuses and nothing else', () => {
    const statuses: SearchProviderHealthStatus[] = [
      'healthy',
      'degraded',
      'unconfigured',
      'blocked',
      'failed',
    ];
    expect(new Set(statuses).size).toBe(5);

    // @ts-expect-error the status vocabulary is closed at five
    const sixth: SearchProviderHealthStatus = 'unknown';
    expect(sixth).toBe('unknown');
  });

  it('has no field able to carry a credential', () => {
    const diagnostic: SearchProviderDiagnostic = {
      providerId: 'searxng',
      status: 'blocked',
      checkedAt: '2026-09-01T00:00:00.000Z',
      reason: 'egress policy denied the configured apiHost',
    };

    expect(Object.keys(diagnostic).sort()).toEqual([
      'checkedAt',
      'providerId',
      'reason',
      'status',
    ]);

    // @ts-expect-error diagnostics never carry keys, cookies, or raw headers
    const leaky: SearchProviderDiagnostic = { providerId: 'tavily', status: 'failed', apiKey: 'sk-x' };
    expect(leaky.status).toBe('failed');
  });

  it('carries a failure as a coded shape', () => {
    const diagnostic: SearchProviderDiagnostic = {
      providerId: 'tavily',
      status: 'failed',
      error: toSearchErrorShape(new SearchProviderError('auth_failed', 'key rejected')),
    };

    expect(diagnostic.error?.code).toBe('auth_failed');
  });
});

describe('barrel aggregation (collision canary)', () => {
  it('re-exports the new runtime values from @omnicross/contracts', () => {
    // The barrel's `export *` SILENTLY drops a name exported by two modules.
    // These assertions are how such a collision fails loudly instead.
    expect(contractsBarrel.SearchProviderError).toBeDefined();
    expect(contractsBarrel.isSearchProviderError).toBeDefined();
    expect(contractsBarrel.isKnownSearchProviderId).toBeDefined();
    expect(contractsBarrel.toSearchErrorShape).toBeDefined();

    expect(contractsBarrel.SearchProviderError).toBe(SearchProviderError);
    expect(contractsBarrel.isKnownSearchProviderId('z.ai')).toBe(true);
    expect(new contractsBarrel.SearchProviderError('parse_failed', 'bad html')).toBeInstanceOf(
      SearchProviderError,
    );
  });

  it('re-exports the new types from @omnicross/contracts', () => {
    const result: BarrelSearchResult = { title: 't', url: 'https://example.com', content: 'c' };
    const contribution: BarrelSearchProviderContribution = {
      id: 'jina',
      source: 'host',
      kind: 'api',
      provider: { id: 'jina', search: async () => [result] },
      capabilities: { ...capabilities, requiresApiKey: true, supportsUrlRead: true },
    };

    expectTypeOf<BarrelSearchResult>().toEqualTypeOf<SearchResult>();
    expectTypeOf<BarrelSearchProviderContribution>().toEqualTypeOf<SearchProviderContribution>();
    expect(contribution.source).toBe('host');
  });
});
