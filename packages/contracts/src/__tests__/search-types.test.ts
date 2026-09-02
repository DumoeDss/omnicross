import { describe, expect, expectTypeOf, it } from 'vitest';

import * as contractsBarrel from '@omnicross/contracts';
import type {
  OrchestratedSearchResponse as BarrelOrchestratedSearchResponse,
  SearchAttempt as BarrelSearchAttempt,
  SearchAttemptEvent as BarrelSearchAttemptEvent,
  SearchAttemptOutcome as BarrelSearchAttemptOutcome,
  SearchCompleteEvent as BarrelSearchCompleteEvent,
  SearchContributionContext as BarrelSearchContributionContext,
  SearchPolicy as BarrelSearchPolicy,
  SearchProviderContribution as BarrelSearchProviderContribution,
  SearchProviderDescriptor as BarrelSearchProviderDescriptor,
  SearchResult as BarrelSearchResult,
  SearchRuntimeEvent as BarrelSearchRuntimeEvent,
  SearchRuntimeEventBase as BarrelSearchRuntimeEventBase,
} from '@omnicross/contracts';

import * as searchTypesModule from '../search-types';
import {
  isKnownSearchProviderId,
  isSearchProviderError,
  SearchProviderError,
  toSearchErrorShape,
  type KnownSearchProviderId,
  type OrchestratedSearchResponse,
  type SearchAttempt,
  type SearchAttemptEvent,
  type SearchAttemptOutcome,
  type SearchCompleteEvent,
  type SearchContributionContext,
  type SearchErrorCode,
  type SearchErrorShape,
  type SearchOptions,
  type SearchPolicy,
  type SearchProvider,
  type SearchProviderCapabilities,
  type SearchProviderContribution,
  type SearchProviderDescriptor,
  type SearchProviderDiagnostic,
  type SearchProviderHealthStatus,
  type SearchProviderId,
  type SearchRequest,
  type SearchResponse,
  type SearchResult,
  type SearchRuntimeEvent,
  type SearchRuntimeEventBase,
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

describe('orchestration vocabulary (阶段3 additive delta)', () => {
  it('adds types only — the runtime export set of the module is unchanged', () => {
    // The delta is additive and type-level. Types erase, so any change to this
    // list means a VALUE was added or removed from a module whose consumers
    // (core, daemon, and Elftia through the barrel) compile against it.
    expect(Object.keys(searchTypesModule).sort()).toEqual([
      'SearchProviderError',
      'isKnownSearchProviderId',
      'isSearchProviderError',
      'toSearchErrorShape',
    ]);
  });

  it('expresses the plan 11.3 egress knobs, all optional', () => {
    const unrestricted: SearchPolicy = {};
    const sensitive: SearchPolicy = { allowed: ['http-bing'], fallbackEnabled: false };
    const bounded: SearchPolicy = { preferred: 'http-duckduckgo', maxAttempts: 2 };

    expect(unrestricted.fallbackEnabled).toBeUndefined();
    expect(sensitive.allowed).toEqual(['http-bing']);
    expect(bounded.preferred).toBe('http-duckduckgo');

    // The id space stays open here too — a host provider is a legal preference.
    const hostPreferred: SearchPolicy = { preferred: 'local-google' };
    expect(hostPreferred.preferred).toBe('local-google');

    // @ts-expect-error the knob set is closed at four
    const invented: SearchPolicy = { retries: 3 };
    expect(invented).toEqual({ retries: 3 });
  });

  it('records an attempt without the query or its results', () => {
    const succeeded: SearchAttempt = {
      providerId: 'http-bing',
      outcome: 'success',
      resultCount: 0,
      durationMs: 12,
    };
    const failed: SearchAttempt = {
      providerId: 'http-duckduckgo',
      outcome: 'failed',
      errorCode: 'parse_failed',
      durationMs: 34,
    };

    // An empty result set is a success, not a failure — the binding semantics
    // 阶段2 established and 阶段3's orchestrator implements.
    expect(succeeded.outcome).toBe('success');
    expect(failed.errorCode).toBe('parse_failed');

    const outcomes: SearchAttemptOutcome[] = ['success', 'failed'];
    expect(new Set(outcomes).size).toBe(2);

    // @ts-expect-error an attempt is a record, not a carrier for content
    const leaky: SearchAttempt = { ...succeeded, query: 'secret query' };
    expect(leaky.durationMs).toBe(12);

    // @ts-expect-error `skipped` is not an outcome; policy skips are events only
    const thirdOutcome: SearchAttemptOutcome = 'skipped';
    expect(thirdOutcome).toBe('skipped');
  });

  it('extends the single-provider response with the walk that produced it', () => {
    const response: OrchestratedSearchResponse = {
      query: 'hypertext transfer protocol',
      providerId: 'http-duckduckgo',
      results: [{ title: 'HTTP', url: 'https://example.com/http', content: '' }],
      attempts: [
        { providerId: 'http-bing', outcome: 'failed', errorCode: 'timeout', durationMs: 15_000 },
        { providerId: 'http-duckduckgo', outcome: 'success', resultCount: 1, durationMs: 900 },
      ],
      fallbackCount: 1,
    };

    // It IS a SearchResponse — every consumer of the narrow shape keeps working.
    const narrow: SearchResponse = response;
    expect(narrow.providerId).toBe('http-duckduckgo');
    expect(response.attempts).toHaveLength(2);
    expect(response.fallbackCount).toBe(response.attempts.length - 1);
  });

  it('describes a provider without shipping its implementation or config', () => {
    const descriptor: SearchProviderDescriptor = {
      id: 'http-bing',
      source: 'builtin',
      kind: 'http',
      capabilities,
    };

    expect(Object.keys(descriptor).sort()).toEqual(['capabilities', 'id', 'kind', 'source']);
    expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor);

    const withInstance: SearchProviderDescriptor = {
      ...descriptor,
      // @ts-expect-error a descriptor is serializable — no provider instance rides along
      provider: { id: 'http-bing', search: async () => [] },
    };
    expect(withInstance.id).toBe('http-bing');

    // @ts-expect-error and never a credential
    const withSecret: SearchProviderDescriptor = { ...descriptor, apiKey: 'sk-x' };
    expect(withSecret.id).toBe('http-bing');
  });

  it('carries a registration context a Phase-2 host can fill in', () => {
    const anonymous: SearchContributionContext = {};
    const fromHost: SearchContributionContext = { hostId: 'elftia-desktop' };

    expect(anonymous.hostId).toBeUndefined();
    expect(fromHost.hostId).toBe('elftia-desktop');
  });

  it('declares events that cannot carry a query, a URL, or result content', () => {
    const attempt: SearchAttemptEvent = {
      type: 'search_attempt',
      requestId: 'e3b0c442-98fc-4c14-9afb-f4c8996fb924',
      queryHash: '9f86d081884c',
      providerId: 'http-bing',
      outcome: 'failed',
      errorCode: 'upstream_unavailable',
      durationMs: 42,
    };
    const complete: SearchCompleteEvent = {
      type: 'search_complete',
      requestId: 'e3b0c442-98fc-4c14-9afb-f4c8996fb924',
      queryHash: '9f86d081884c',
      providerId: 'http-duckduckgo',
      resultCount: 3,
      fallbackCount: 1,
      durationMs: 913,
    };

    // Every field an event may carry, enumerated. A new field able to hold text
    // fails this assertion before it can reach a log.
    expect(Object.keys(attempt).sort()).toEqual([
      'durationMs',
      'errorCode',
      'outcome',
      'providerId',
      'queryHash',
      'requestId',
      'type',
    ]);
    expect(Object.keys(complete).sort()).toEqual([
      'durationMs',
      'fallbackCount',
      'providerId',
      'queryHash',
      'requestId',
      'resultCount',
      'type',
    ]);

    // @ts-expect-error the query never travels on the events channel — only its hash
    const leakyAttempt: SearchAttemptEvent = { ...attempt, query: 'my private query' };
    expect(leakyAttempt.queryHash).toBe('9f86d081884c');

    // @ts-expect-error nor does a result URL
    const leakyComplete: SearchCompleteEvent = { ...complete, url: 'https://example.com' };
    expect(leakyComplete.resultCount).toBe(3);

    // @ts-expect-error nor result content under any other name
    const leakyBase: SearchRuntimeEventBase = { ...attempt, snippet: 'page text' };
    expect(leakyBase.requestId).toBe(attempt.requestId);
  });

  it('discriminates the two event variants on `type`', () => {
    const events: SearchRuntimeEvent[] = [
      {
        type: 'search_attempt',
        requestId: 'r',
        queryHash: 'h',
        providerId: 'http-bing',
        outcome: 'success',
        resultCount: 2,
        durationMs: 5,
      },
      { type: 'search_complete', requestId: 'r', queryHash: 'h', resultCount: 0, fallbackCount: 1, durationMs: 9 },
    ];

    const seen = events.map((event) =>
      event.type === 'search_attempt' ? event.outcome : `complete:${event.providerId ?? 'none'}`,
    );
    // A complete event with no providerId means no provider succeeded — the one
    // signal that separates a failed search from an authoritative empty one.
    expect(seen).toEqual(['success', 'complete:none']);

    // @ts-expect-error the event vocabulary is closed at two variants
    const invented: SearchRuntimeEvent = { type: 'search_started', requestId: 'r', queryHash: 'h', durationMs: 0 };
    expect(invented.type).toBe('search_started');
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

  it('re-exports every orchestration name added by 阶段3', () => {
    // Each new name has to resolve through the barrel as well as the subpath:
    // `export *` drops a name exported by two modules SILENTLY, and a type-only
    // collision is invisible at runtime. These equalities are the canary.
    expectTypeOf<BarrelSearchPolicy>().toEqualTypeOf<SearchPolicy>();
    expectTypeOf<BarrelSearchAttempt>().toEqualTypeOf<SearchAttempt>();
    expectTypeOf<BarrelSearchAttemptOutcome>().toEqualTypeOf<SearchAttemptOutcome>();
    expectTypeOf<BarrelOrchestratedSearchResponse>().toEqualTypeOf<OrchestratedSearchResponse>();
    expectTypeOf<BarrelSearchProviderDescriptor>().toEqualTypeOf<SearchProviderDescriptor>();
    expectTypeOf<BarrelSearchContributionContext>().toEqualTypeOf<SearchContributionContext>();
    expectTypeOf<BarrelSearchRuntimeEvent>().toEqualTypeOf<SearchRuntimeEvent>();
    expectTypeOf<BarrelSearchRuntimeEventBase>().toEqualTypeOf<SearchRuntimeEventBase>();
    expectTypeOf<BarrelSearchAttemptEvent>().toEqualTypeOf<SearchAttemptEvent>();
    expectTypeOf<BarrelSearchCompleteEvent>().toEqualTypeOf<SearchCompleteEvent>();

    const viaBarrel: BarrelSearchPolicy = { preferred: 'http-bing', maxAttempts: 1 };
    const viaSubpath: SearchPolicy = viaBarrel;
    expect(viaSubpath.preferred).toBe('http-bing');
  });
});
