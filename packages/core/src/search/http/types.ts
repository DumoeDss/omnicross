/**
 * Shared vocabulary for the keyless HTTP search slice (plan 阶段2).
 *
 * Everything here is transport- and parser-neutral so the providers, the
 * shared transport, and the doctor can agree on one set of names without
 * importing each other.
 *
 * @module search/http/types
 */

import type { SearchProviderId, SearchResult } from '@omnicross/contracts/search-types';

/**
 * The transport identity stamped on every failure this slice throws.
 *
 * Phase 1 ships exactly one transport. `impit` (Elftia's browser-fingerprint
 * client) is deliberately NOT introduced here — the injection seam below is the
 * whole extent of future-proofing, so an alternative transport can never become
 * an implicit behavior change.
 */
export const SEARCH_HTTP_TRANSPORT_ID = 'undici';

/**
 * Which phase of a search failed (plan §11.4 — transport identity and failure
 * stage must be observable).
 *
 * - `connect` — the request never produced a response (DNS, TCP, TLS).
 * - `fetch` — a response arrived but is unusable (refused status, deadline).
 * - `redirect` — the redirect chain exceeded its cap.
 * - `body-cap` — the response body outgrew its byte cap mid-stream.
 * - `challenge` — the engine served a bot challenge instead of a SERP.
 * - `trust` — the page parsed, but the anti-decoy check refused it.
 * - `parse` — the page is not recognizable as this engine's SERP.
 */
export type SearchHttpStage =
  | 'connect'
  | 'fetch'
  | 'redirect'
  | 'body-cap'
  | 'challenge'
  | 'trust'
  | 'parse';

/** One fetched search page. */
export interface SearchHttpResource {
  /** The URL the response was finally served from (after redirects). */
  finalUrl: string;
  /** HTTP status of the final response. */
  status: number;
  /** `content-type` header value, or `''`. */
  contentType: string;
  /** Decoded response body. */
  rawText: string;
}

/** What the transport needs to execute one attempt. */
export interface SearchHttpRequest {
  /** Hard budget for this single attempt, in milliseconds. */
  timeoutMs: number;
  /** Byte cap enforced while the body streams in. */
  maxResponseBytes: number;
  /** Caller cancellation. Aborting surfaces as code `cancelled`, never `timeout`. */
  signal?: AbortSignal;
  /** Stamped onto thrown errors so a failure names its provider. */
  providerId?: SearchProviderId;
}

/**
 * The seam both providers accept in their constructor.
 *
 * This is the test seam (fixtures are served through it) and the seam a future
 * alternative transport would occupy.
 */
export type SearchHttpTransport = (
  url: string,
  request: SearchHttpRequest,
) => Promise<SearchHttpResource>;

/**
 * The low-level fetch primitive the shared transport drives — undici's `fetch`
 * by default. Separate from {@link SearchHttpTransport} so redirect, body-cap
 * and header behavior can be unit-tested without a network.
 */
export type SearchHttpFetch = (url: string, init: RequestInit) => Promise<Response>;

/** The outcome of running one engine's parser over one page. */
export interface ParsedSerp {
  /**
   * Whether the page is structurally recognizable as this engine's SERP.
   *
   * This is what separates "the engine found nothing" (recognized, zero
   * results → `[]`) from "the engine's markup changed under us" (unrecognized
   * → `parse_failed`).
   */
  recognized: boolean;
  /** Usable organic results, already clamped to the caller's `maxResults`. */
  results: SearchResult[];
}
