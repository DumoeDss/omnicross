/**
 * Legacy ↔ target search conversions — a Phase-1 compat layer.
 *
 * **This module is temporary.** It exists so consumers can migrate from the
 * legacy `WebSearch*` vocabulary in `./websearch-types` to the target
 * `Search*` vocabulary in `./search-types` one at a time, instead of in one
 * flag day. It is scheduled for deletion in Phase 2 (阶段8), once no consumer
 * speaks the legacy shapes; every import of it is migration debt and is meant
 * to be grep-able as such.
 *
 * Nothing here classifies a provider from its id's spelling. The one place a
 * string is interpreted is {@link legacyErrorStringToSearchErrorCode}, which
 * translates the *frozen* legacy error literals (recorded in
 * `docs/design/search-baseline/elftia-search-baseline.md` §6.2) into the stable
 * taxonomy — a single, tested mapping so the five Phase-1 stages do not each
 * re-derive one.
 *
 * Pure module: no Node, Electron, HTTP, or SDK imports.
 */

import type {
  SearchErrorCode,
  SearchErrorShape,
  SearchProviderId,
  SearchResponse,
  SearchResult,
} from './search-types';
import type {
  WebSearchProviderId,
  WebSearchResponse,
  WebSearchResult,
} from './websearch-types';

/**
 * Provider id used when a legacy response carries results but no `provider`.
 *
 * Namespaced so it can never collide with a real provider id, and deliberately
 * not a member of `KnownSearchProviderId` — it marks "the legacy payload did
 * not say", not a provider.
 */
export const LEGACY_UNKNOWN_PROVIDER_ID: SearchProviderId = 'legacy:unknown';

/** The code an unrecognized legacy error string maps to. */
const DEFAULT_LEGACY_ERROR_CODE: SearchErrorCode = 'upstream_unavailable';

/**
 * Widen a legacy provider id into the open id space.
 *
 * Identity at runtime; the value is a re-typing, not a translation. Every
 * member of the closed legacy union is a valid {@link SearchProviderId}.
 */
export function legacyProviderIdToSearchProviderId(id: WebSearchProviderId): SearchProviderId {
  return id;
}

/**
 * Ordered rules mapping a legacy error string to a taxonomy code.
 *
 * Order is part of the contract: the first matching rule wins, and the rules
 * are arranged so no legacy literal can satisfy two of them with different
 * codes. Cancellation and timeout lead because they are runtime facts that
 * must never be swallowed by a generic upstream phrase. All patterns are
 * case-insensitive and stateless (no `g` flag — a global regex would carry
 * `lastIndex` between calls and make the mapping non-deterministic).
 */
const LEGACY_ERROR_RULES: readonly { readonly pattern: RegExp; readonly code: SearchErrorCode }[] = [
  // Runtime facts first.
  { pattern: /abort|cancell?ed|cancell?ing/i, code: 'cancelled' },
  { pattern: /timed ?out|timeout/i, code: 'timeout' },

  // WebSearchService.search()
  { pattern: /not configured/i, code: 'config_missing' },
  { pattern: /is disabled/i, code: 'policy_denied' },
  { pattern: /not implemented/i, code: 'upstream_unavailable' },

  // HttpOnlyWebSearchService / WebSearchOrchestrator transport availability
  { pattern: /unavailable in this host/i, code: 'upstream_unavailable' },
  { pattern: /HTTP search transport is unavailable/i, code: 'upstream_unavailable' },

  // Exhausted-candidate summaries (both fallback implementations)
  { pattern: /No eligible web search provider returned usable results/i, code: 'upstream_unavailable' },
  { pattern: /No keyless HTTP search provider returned usable results/i, code: 'upstream_unavailable' },

  // Anti-bot / anti-decoy refusals — the page came back, it just cannot be trusted.
  { pattern: /bot-challenge/i, code: 'upstream_unavailable' },
  {
    pattern: /returned an untrusted search result page|refusing to return possible bot-decoy content/i,
    code: 'upstream_unavailable',
  },
  { pattern: /JavaScript-only search shell without result entries/i, code: 'upstream_unavailable' },

  // Response the provider did return, but which could not be turned into results.
  { pattern: /response contained no result entries/i, code: 'parse_failed' },
  { pattern: /returned an invalid response/i, code: 'parse_failed' },
  { pattern: /returned an invalid result list/i, code: 'parse_failed' },
  { pattern: /returned only duplicate results/i, code: 'parse_failed' },
  { pattern: /returned no usable direct results/i, code: 'parse_failed' },
  { pattern: /returned no results/i, code: 'parse_failed' },
];

/**
 * Translate a legacy error string into a stable {@link SearchErrorCode}.
 *
 * Total and deterministic: every input returns a code, and the same input
 * always returns the same one. Unrecognized strings — including a provider's
 * own transport error text — map to the documented default
 * `upstream_unavailable`, which is the safe assumption for a fallback policy
 * (retry a different provider) as opposed to `cancelled` or `policy_denied`,
 * which stop the loop.
 *
 * The recognized strings are the frozen legacy literals from baseline §6.2;
 * they are asserted verbatim in this module's tests, so a future baseline
 * drift fails loudly instead of silently re-coding a failure.
 */
export function legacyErrorStringToSearchErrorCode(message: string): SearchErrorCode {
  for (const rule of LEGACY_ERROR_RULES) {
    if (rule.pattern.test(message)) return rule.code;
  }
  return DEFAULT_LEGACY_ERROR_CODE;
}

/**
 * Recover the provider id from a legacy `Provider <id> …` error sentence.
 *
 * The lookahead skips the sentences whose second word is grammar rather than
 * an id (`Provider is not eligible …`, `Provider returned an invalid response`,
 * `Provider request failed`), so this never invents a provider called `is`.
 * Returns `undefined` when the string does not name one.
 */
function providerIdFromLegacyErrorString(message: string): SearchProviderId | undefined {
  const match = /^Provider\s+(?!is\b|returned\b|request\b)(\S+)\s+(?:is|not)\b/i.exec(message);
  return match?.[1];
}

/** Copy a legacy result into the target shape. Field names are identical by design. */
function toSearchResult(result: WebSearchResult): SearchResult {
  return { title: result.title, url: result.url, content: result.content };
}

/**
 * Convert a legacy provider response into the target vocabulary.
 *
 * A legacy `success: false` becomes a taxonomy-coded {@link SearchErrorShape}
 * (the original string is preserved verbatim in `message`, so the baseline's
 * comparison oracles still work); a `success: true` becomes a
 * {@link SearchResponse}, falling back to {@link LEGACY_UNKNOWN_PROVIDER_ID}
 * when the legacy payload named no provider.
 */
export function fromLegacyWebSearchResponse(
  resp: WebSearchResponse,
): { ok: true; response: SearchResponse } | { ok: false; error: SearchErrorShape } {
  if (resp.success) {
    return {
      ok: true,
      response: {
        query: resp.query,
        providerId: resp.provider ?? LEGACY_UNKNOWN_PROVIDER_ID,
        results: resp.results.map(toSearchResult),
      },
    };
  }

  const message = resp.error ?? 'Unknown error';
  const error: SearchErrorShape = {
    code: legacyErrorStringToSearchErrorCode(message),
    message,
  };
  const providerId = resp.provider ?? providerIdFromLegacyErrorString(message);
  if (providerId !== undefined) error.providerId = providerId;
  return { ok: false, error };
}

/**
 * Convert a target response back into the legacy shape for a consumer that
 * still speaks it.
 *
 * The legacy `provider` field is typed as the closed `WebSearchProviderId`
 * union, which cannot express the ids Omnicross ships for HTTP providers
 * (`http-bing`, `http-duckduckgo` — Elftia widened its own copy to
 * `WebSearchExecutionProviderId` for exactly this reason). The id is preserved
 * verbatim through a cast rather than dropped: losing which provider produced
 * a result set is worse than a union the legacy type cannot name, and this
 * mismatch is one of the reasons the compat layer is temporary.
 */
export function toLegacyWebSearchResponse(response: SearchResponse): WebSearchResponse {
  return {
    success: true,
    query: response.query,
    results: response.results.map((result) => ({
      title: result.title,
      content: result.content,
      url: result.url,
    })),
    provider: response.providerId as WebSearchProviderId,
  };
}

/**
 * Render a target error as a legacy failure response.
 *
 * The message is passed through unchanged — no code prefix — because legacy
 * consumers and the baseline oracles compare these strings literally. An empty
 * message falls back to the taxonomy code so the legacy `error` field is never
 * blank.
 */
export function searchErrorToLegacyWebSearchResponse(
  query: string,
  error: SearchErrorShape,
): WebSearchResponse {
  const response: WebSearchResponse = {
    success: false,
    query,
    results: [],
    error: error.message.trim().length > 0 ? error.message : error.code,
  };
  if (error.providerId !== undefined) {
    // Same deliberate widening cast as toLegacyWebSearchResponse, for the same
    // reason: the closed legacy union cannot name the http-* ids.
    response.provider = error.providerId as WebSearchProviderId;
  }
  return response;
}
