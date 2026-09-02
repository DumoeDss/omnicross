import { describe, expect, it } from 'vitest';

import * as contractsBarrel from '@omnicross/contracts';
import {
  fromLegacyWebSearchResponse,
  legacyErrorStringToSearchErrorCode,
  legacyProviderIdToSearchProviderId,
  LEGACY_UNKNOWN_PROVIDER_ID,
  searchErrorToLegacyWebSearchResponse,
  toLegacyWebSearchResponse,
} from '../search-compat';
import type { SearchErrorCode, SearchErrorShape, SearchResponse } from '../search-types';
import type { WebSearchResponse } from '../websearch-types';

/**
 * Every literal error string in baseline §6.2
 * (`docs/design/search-baseline/elftia-search-baseline.md`), spelled out
 * verbatim with the interpolations filled in, against the code the
 * search-contracts-compat spec fixes for it.
 *
 * Rows marked "documented default" have no spec row of their own and fall
 * through to `upstream_unavailable` — asserted so the default is a decision,
 * not an accident, and so a future baseline drift fails here first.
 */
const BASELINE_ERROR_STRINGS: readonly (readonly [string, SearchErrorCode])[] = [
  // --- WebSearchService.search() ---
  ['Provider local-google is disabled', 'policy_denied'],
  ['Provider tavily not configured', 'config_missing'],
  ['Provider jina is disabled', 'policy_denied'],
  ['Provider claude not implemented', 'upstream_unavailable'],
  ['Unknown error', 'upstream_unavailable'], // documented default

  // --- WebSearchOrchestrator ---
  ['Provider is not eligible in the host runtime', 'upstream_unavailable'], // documented default
  ['Provider request failed', 'upstream_unavailable'], // documented default
  ['HTTP search transport is unavailable', 'upstream_unavailable'],
  ['No eligible web search provider returned usable results', 'upstream_unavailable'],
  ['Provider returned an invalid response', 'parse_failed'],
  ['Provider returned an error', 'upstream_unavailable'], // documented default
  ['Provider returned an invalid result list', 'parse_failed'],
  ['Provider returned no results', 'parse_failed'],
  ['Provider returned only duplicate results', 'parse_failed'],
  ['Provider returned no usable direct results', 'parse_failed'],

  // --- HttpOnlyWebSearchService ---
  ['Provider zhipu is unavailable in this host', 'upstream_unavailable'],
  ['Provider http-bing is disabled', 'policy_denied'],
  [
    'Provider is unavailable in this host; only keyless HTTP search is supported',
    'upstream_unavailable',
  ],
  ['No keyless HTTP search provider returned usable results', 'upstream_unavailable'],

  // --- webFetchSearch.searchWebViaFetch (always `${engine.id}: ${message}`) ---
  ['bing: response contained no result entries', 'parse_failed'],
  ['duckduckgo: response contained no result entries', 'parse_failed'],
  ['duckduckgo: server returned a bot-challenge response (HTTP 202)', 'upstream_unavailable'],
  [
    'bing: Bing returned an untrusted search result page with zero query-term hits in result titles; refusing to return possible bot-decoy content.',
    'upstream_unavailable',
  ],
  [
    'bing: Bing returned an untrusted search result page; refusing to return possible bot-decoy content.',
    'upstream_unavailable',
  ],
  ['bing: fetch failed', 'upstream_unavailable'], // underlying transport error, documented default

  // The Google trust refusal is the one §6.2 trust string that never carries an
  // engine prefix: `webFetchSearch`'s engine ids are only `bing | duckduckgo`
  // (SEARCH_ENGINES, webFetchSearch.ts:37-53), so no `google: ` form can exist.
  // It reaches production through the other `searchPageTrustError` call site —
  // the web_fetch tool (WebTools.ts:159) — which prefixes `Fetch error: `.
  ['Google returned a JavaScript-only search shell without result entries.', 'upstream_unavailable'],
  [
    'Fetch error: Google returned a JavaScript-only search shell without result entries.',
    'upstream_unavailable',
  ],
];

describe('legacy error string → taxonomy code', () => {
  for (const [message, code] of BASELINE_ERROR_STRINGS) {
    it(`maps "${message.slice(0, 60)}${message.length > 60 ? '…' : ''}" to ${code}`, () => {
      expect(legacyErrorStringToSearchErrorCode(message)).toBe(code);
    });
  }

  it('covers every baseline literal exactly once', () => {
    const messages = BASELINE_ERROR_STRINGS.map(([message]) => message);
    expect(new Set(messages).size).toBe(messages.length);
  });

  it('takes the documented default for an unrecognized message', () => {
    expect(legacyErrorStringToSearchErrorCode('something nobody has ever seen')).toBe(
      'upstream_unavailable',
    );
    expect(legacyErrorStringToSearchErrorCode('')).toBe('upstream_unavailable');
  });

  it('classifies cancellation and timeout ahead of the generic phrases', () => {
    expect(legacyErrorStringToSearchErrorCode('The operation was aborted')).toBe('cancelled');
    expect(legacyErrorStringToSearchErrorCode('AbortError: signal is aborted')).toBe('cancelled');
    expect(legacyErrorStringToSearchErrorCode('The request was canceled')).toBe('cancelled');
    expect(legacyErrorStringToSearchErrorCode('bing: request timed out after 10000ms')).toBe(
      'timeout',
    );
    expect(legacyErrorStringToSearchErrorCode('ETIMEDOUT')).toBe('timeout');
  });

  it('is case-insensitive and deterministic across repeated calls', () => {
    expect(legacyErrorStringToSearchErrorCode('PROVIDER TAVILY NOT CONFIGURED')).toBe(
      'config_missing',
    );

    // A stateful (`g`-flagged) pattern would alternate results between calls.
    for (let i = 0; i < 3; i += 1) {
      expect(legacyErrorStringToSearchErrorCode('Provider jina is disabled')).toBe('policy_denied');
      expect(legacyErrorStringToSearchErrorCode('Provider returned no results')).toBe(
        'parse_failed',
      );
    }
  });
});

describe('legacy ↔ target response conversion', () => {
  const legacySuccess: WebSearchResponse = {
    success: true,
    query: 'hypertext transfer protocol',
    provider: 'tavily',
    results: [
      { title: 'HTTP', content: 'An application layer protocol.', url: 'https://example.com/http' },
      { title: 'HTTP headers', content: '', url: 'https://example.com/headers' },
    ],
  };

  it('round-trips a successful response losslessly', () => {
    const converted = fromLegacyWebSearchResponse(legacySuccess);
    expect(converted.ok).toBe(true);
    if (!converted.ok) return;

    expect(converted.response).toEqual({
      query: 'hypertext transfer protocol',
      providerId: 'tavily',
      results: [
        {
          title: 'HTTP',
          url: 'https://example.com/http',
          content: 'An application layer protocol.',
        },
        { title: 'HTTP headers', url: 'https://example.com/headers', content: '' },
      ],
    });

    const back = toLegacyWebSearchResponse(converted.response);
    expect(back).toEqual({
      success: true,
      query: legacySuccess.query,
      provider: legacySuccess.provider,
      results: legacySuccess.results,
    });
  });

  it('falls back to the documented placeholder when the payload names no provider', () => {
    const anonymous: WebSearchResponse = { success: true, query: 'q', results: [] };
    const converted = fromLegacyWebSearchResponse(anonymous);

    expect(converted.ok).toBe(true);
    if (!converted.ok) return;
    expect(converted.response.providerId).toBe(LEGACY_UNKNOWN_PROVIDER_ID);
    expect(LEGACY_UNKNOWN_PROVIDER_ID).toBe('legacy:unknown');
  });

  it('turns a legacy failure into a coded error and derives the provider from the message', () => {
    const failure: WebSearchResponse = {
      success: false,
      query: 'hypertext transfer protocol',
      results: [],
      error: 'Provider tavily not configured',
    };

    const converted = fromLegacyWebSearchResponse(failure);
    expect(converted.ok).toBe(false);
    if (converted.ok) return;

    expect(converted.error).toEqual({
      code: 'config_missing',
      message: 'Provider tavily not configured',
      providerId: 'tavily',
    });
  });

  it('prefers the payload provider over the message when both are present', () => {
    const failure: WebSearchResponse = {
      success: false,
      query: 'q',
      results: [],
      provider: 'zhipu',
      error: 'Provider z.ai is disabled',
    };

    const converted = fromLegacyWebSearchResponse(failure);
    if (converted.ok) throw new Error('expected a failure conversion');
    expect(converted.error.providerId).toBe('zhipu');
    expect(converted.error.code).toBe('policy_denied');
  });

  it('invents no provider when the message names none', () => {
    const cases = [
      'Provider is not eligible in the host runtime',
      'Provider returned an invalid response',
      'Provider request failed',
      'No eligible web search provider returned usable results',
    ];

    for (const message of cases) {
      const converted = fromLegacyWebSearchResponse({
        success: false,
        query: 'q',
        results: [],
        error: message,
      });
      if (converted.ok) throw new Error('expected a failure conversion');
      expect(converted.error.providerId).toBeUndefined();
      expect(converted.error.message).toBe(message);
    }
  });

  it('supplies a message when a legacy failure carries none', () => {
    const converted = fromLegacyWebSearchResponse({ success: false, query: 'q', results: [] });
    if (converted.ok) throw new Error('expected a failure conversion');
    expect(converted.error).toEqual({ code: 'upstream_unavailable', message: 'Unknown error' });
  });

  it('preserves an http-* provider id the legacy union cannot name', () => {
    const response: SearchResponse = {
      query: 'q',
      providerId: 'http-bing',
      results: [{ title: 't', url: 'https://example.com', content: 'c' }],
    };

    expect(toLegacyWebSearchResponse(response).provider).toBe('http-bing');
  });
});

describe('target error → legacy response', () => {
  it('renders the message verbatim with no code prefix', () => {
    const error: SearchErrorShape = {
      code: 'rate_limited',
      message: 'Provider tavily not configured',
      providerId: 'tavily',
    };

    expect(searchErrorToLegacyWebSearchResponse('q', error)).toEqual({
      success: false,
      query: 'q',
      results: [],
      error: 'Provider tavily not configured',
      provider: 'tavily',
    });
  });

  it('falls back to the code so the legacy error field is never blank', () => {
    const legacy = searchErrorToLegacyWebSearchResponse('q', { code: 'timeout', message: '   ' });

    expect(legacy.error).toBe('timeout');
    expect(legacy.provider).toBeUndefined();
    expect(legacy.results).toEqual([]);
  });
});

describe('provider id widening', () => {
  it('is an identity on every legacy id', () => {
    for (const id of ['jina', 'zhipu', 'z.ai', 'tavily', 'searxng', 'local-google'] as const) {
      expect(legacyProviderIdToSearchProviderId(id)).toBe(id);
    }
  });
});

describe('barrel aggregation (collision canary)', () => {
  it('re-exports all six compat values from @omnicross/contracts', () => {
    // The barrel's `export *` SILENTLY drops a name exported by two modules. Every
    // compat export is checked by identity against its subpath import, so a future
    // collision fails here instead of vanishing.
    expect(contractsBarrel.LEGACY_UNKNOWN_PROVIDER_ID).toBe(LEGACY_UNKNOWN_PROVIDER_ID);
    expect(contractsBarrel.legacyProviderIdToSearchProviderId).toBe(
      legacyProviderIdToSearchProviderId,
    );
    expect(contractsBarrel.legacyErrorStringToSearchErrorCode).toBe(
      legacyErrorStringToSearchErrorCode,
    );
    expect(contractsBarrel.fromLegacyWebSearchResponse).toBe(fromLegacyWebSearchResponse);
    expect(contractsBarrel.toLegacyWebSearchResponse).toBe(toLegacyWebSearchResponse);
    expect(contractsBarrel.searchErrorToLegacyWebSearchResponse).toBe(
      searchErrorToLegacyWebSearchResponse,
    );

    // The legacy module still aggregates too — the compat layer sits beside it, not over it.
    expect(contractsBarrel.isApiProvider).toBeDefined();
    expect(contractsBarrel.isLocalProvider).toBeDefined();
  });
});
