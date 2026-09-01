/**
 * Error construction for the HTTP search slice.
 *
 * Every failure this slice throws is a `SearchProviderError` carrying
 * `details.transport` and `details.stage` (plan §11.4), so a diagnostic can say
 * WHICH phase failed and WHICH client was used without parsing a message.
 *
 * Sanitization rule enforced here: `details` and messages carry HOSTNAMES, never
 * full URLs. A search URL embeds the user's query, and diagnostics are printed
 * and logged — so the query, like proxy URLs, credentials and headers, never
 * reaches an error.
 *
 * @module search/http/errors
 */

import {
  isSearchProviderError,
  SearchProviderError,
  type SearchErrorCode,
  type SearchProviderId,
} from '@omnicross/contracts/search-types';

import { SEARCH_HTTP_TRANSPORT_ID, type SearchHttpStage } from './types';

/** Optional context for {@link searchHttpError}. */
export interface SearchHttpErrorInit {
  /** Which phase failed. Required — a stage-less failure is unobservable. */
  stage: SearchHttpStage;
  /** The provider that failed. */
  providerId?: SearchProviderId;
  /** Whether retrying the SAME provider could plausibly succeed. */
  retryable?: boolean;
  /** Underlying error, kept local (never serialized into the wire shape). */
  cause?: unknown;
  /** Extra pre-sanitized context. Hostnames are fine; URLs and headers are not. */
  details?: Record<string, string>;
}

/** Build a taxonomy-coded search failure with transport + stage attached. */
export function searchHttpError(
  code: SearchErrorCode,
  message: string,
  init: SearchHttpErrorInit,
): SearchProviderError {
  return new SearchProviderError(code, message, {
    providerId: init.providerId,
    retryable: init.retryable,
    cause: init.cause,
    // transport/stage last so a caller-supplied `details` can never shadow them.
    details: { ...init.details, transport: SEARCH_HTTP_TRANSPORT_ID, stage: init.stage },
  });
}

/**
 * Normalize anything thrown inside the slice into a `SearchProviderError` that
 * names its provider, transport and stage.
 *
 * An error already carrying all three is returned untouched, so the precise
 * classification made at the failure site always wins over the fallback.
 */
export function asSearchProviderError(
  value: unknown,
  providerId: SearchProviderId | undefined,
  fallbackStage: SearchHttpStage,
): SearchProviderError {
  if (isSearchProviderError(value)) {
    const complete =
      value.providerId !== undefined &&
      value.details?.transport !== undefined &&
      value.details?.stage !== undefined;
    if (complete) return value;
    return searchHttpError(value.code, value.message, {
      stage: (value.details?.stage as SearchHttpStage | undefined) ?? fallbackStage,
      providerId: value.providerId ?? providerId,
      retryable: value.retryable,
      cause: value,
      details: value.details,
    });
  }

  // An injected transport may throw anything at all. `upstream_unavailable` is
  // the contract's documented default for a non-classifiable failure.
  return searchHttpError('upstream_unavailable', describeError(value), {
    stage: fallbackStage,
    providerId,
    retryable: true,
    cause: value,
  });
}

/** A message for a non-`SearchProviderError` throw, without leaking its shape. */
function describeError(value: unknown): string {
  if (value instanceof Error && value.message) return value.message;
  if (typeof value === 'string' && value) return value;
  return 'search request failed';
}

/**
 * The hostname of a candidate URL, for error context.
 *
 * Deliberately hostname-only: the path and query of a search URL contain the
 * user's query string.
 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown-host';
  }
}
