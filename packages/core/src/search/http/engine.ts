/**
 * The candidate-URL walk both HTTP providers share.
 *
 * Mirrors the baselined `searchWebViaFetch` loop (one shared deadline, split
 * evenly across the remaining candidates, last error retained) with one
 * plan-mandated behavior change: the three-way outcome distinction.
 *
 * Elftia collapses "the engine found nothing" and "the engine's markup changed"
 * into a single `response contained no result entries` error. Here they are
 * different answers:
 *
 * - a recognized SERP with zero organic results → `[]` (a legitimate answer);
 * - an unrecognizable page → `parse_failed` (the parser-drift alarm);
 * - a challenge or decoy page → a `challenge`/`trust` staged failure, checked
 *   before either of the above.
 *
 * The divergence is deliberate (plan §11.4) and is recorded for 阶段5's
 * behavior-comparison report as an allowed difference.
 *
 * @module search/http/engine
 */

import type {
  SearchOptions,
  SearchProviderId,
  SearchResult,
} from '@omnicross/contracts/search-types';
import type { SearchProviderError } from '@omnicross/contracts/search-types';

import { asSearchProviderError, searchHttpError } from './errors';
import type { ParsedSerp, SearchHttpTransport } from './types';

/** Response byte cap at the search call sites (the fetch layer allows 5 MiB). */
export const SEARCH_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Default budget for one whole search, across all its candidate URLs. */
export const DEFAULT_SEARCH_TIMEOUT_MS = 15_000;

/** `maxResults` clamp: [1, 10], defaulting to 5. */
export const DEFAULT_MAX_RESULTS = 5;
export const MAX_RESULTS = 10;

/** Everything that differs between the two engines. */
export interface HttpSearchEngine {
  /** Provider id stamped on every result set and every failure. */
  readonly providerId: SearchProviderId;
  /** Human-readable engine name, used in failure messages (never the query). */
  readonly label: string;
  /** Candidate URLs in preference order. */
  buildUrls(query: string): string[];
  /** Whether this status means "bot challenge" rather than "SERP". */
  isChallengeStatus(status: number): boolean;
  /** Anti-decoy check, run before any outcome classification. */
  trustError?(finalUrl: string, html: string): string | null;
  /** Extract results and decide whether the page is this engine's SERP. */
  parse(html: string, maxResults: number): ParsedSerp;
}

/**
 * Clamp a caller's `maxResults` into the engine-supported range.
 *
 * `NaN` passes through to `slice(0, NaN)` and yields `[]`, exactly as the
 * baseline does. Left at parity deliberately: normalizing pathological option
 * values belongs to the runtime that owns option handling (阶段3), not to two
 * providers that would then disagree with every other one.
 */
export function clampMaxResults(maxResults: number | undefined): number {
  return Math.min(Math.max(maxResults ?? DEFAULT_MAX_RESULTS, 1), MAX_RESULTS);
}

/** Run one engine's search across its candidate URLs under a shared deadline. */
export async function runHttpSearch(
  engine: HttpSearchEngine,
  transport: SearchHttpTransport,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const providerId = engine.providerId;
  if (options.signal?.aborted) {
    throw searchHttpError('cancelled', 'search was cancelled before it started', {
      stage: 'fetch',
      providerId,
      retryable: false,
    });
  }

  const maxResults = clampMaxResults(options.maxResults);
  const timeoutMs = options.timeout ?? DEFAULT_SEARCH_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const urls = engine.buildUrls(query);

  // A recognized-but-empty page is remembered rather than returned at once, so
  // a later candidate (DuckDuckGo's lite endpoint) still gets its turn — the
  // baseline's fallback-on-zero-results behavior, without turning the empty
  // answer back into an error.
  let sawRecognizedEmpty = false;
  let lastError: SearchProviderError = searchHttpError(
    'timeout',
    'search deadline expired before any request was attempted',
    { stage: 'fetch', providerId, retryable: true },
  );

  for (const [index, url] of urls.entries()) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const attemptTimeoutMs = Math.max(1, Math.floor(remainingMs / (urls.length - index)));

    try {
      const resource = await transport(url, {
        timeoutMs: attemptTimeoutMs,
        maxResponseBytes: SEARCH_RESPONSE_BYTES,
        signal: options.signal,
        providerId,
      });

      if (engine.isChallengeStatus(resource.status)) {
        throw searchHttpError(
          'upstream_unavailable',
          `server returned a bot-challenge response (HTTP ${resource.status})`,
          { stage: 'challenge', providerId, retryable: false, details: { status: String(resource.status) } },
        );
      }

      const trustError = engine.trustError?.(resource.finalUrl, resource.rawText);
      if (trustError) {
        throw searchHttpError('upstream_unavailable', trustError, {
          stage: 'trust',
          providerId,
          retryable: false,
        });
      }

      const parsed = engine.parse(resource.rawText, maxResults);
      if (parsed.results.length > 0) return parsed.results;
      if (parsed.recognized) {
        sawRecognizedEmpty = true;
        continue;
      }

      throw searchHttpError(
        'parse_failed',
        `response is not recognizable as a ${engine.label} search result page`,
        { stage: 'parse', providerId, retryable: false },
      );
    } catch (error) {
      const normalized = asSearchProviderError(error, providerId, 'fetch');
      // Cancellation is the caller's decision — never spend another candidate.
      if (normalized.code === 'cancelled') throw normalized;
      lastError = normalized;
    }
  }

  // An engine that answered "nothing found" outranks a failure on a fallback
  // candidate: the authoritative endpoint was reached and had no results.
  if (sawRecognizedEmpty) return [];
  throw lastError;
}
