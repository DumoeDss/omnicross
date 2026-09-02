/**
 * Provider-neutral search contracts — the Phase-1 target surface.
 *
 * This module is the vocabulary every later search stage implements against:
 * HTTP providers, API providers, the registry/orchestrator, and the protocol
 * frontends. It is deliberately pure — no Node builtins, no Electron, no HTTP
 * client, no upstream SDK types — so it can be imported from a browser bundle,
 * a daemon, or a host application alike. `AbortSignal` is used only as an
 * ambient web-standard type.
 *
 * Two rules this module exists to enforce:
 *
 * 1. **Nothing is inferred from an identifier's spelling.** A provider's
 *    transport and trust boundary are declared explicitly on
 *    {@link SearchProviderContribution} (`kind` / `source`). No exported
 *    function here classifies a provider from its id, and none ever should —
 *    that is what the deprecated `isApiProvider`/`isLocalProvider` helpers in
 *    `./websearch-types` did.
 * 2. **The provider id space is open.** {@link KnownSearchProviderId} lists
 *    only the providers Omnicross itself ships; host contributions and future
 *    providers arrive as plain strings without a contract change.
 *
 * Legacy `WebSearch*` shapes in `./websearch-types` stay where they are;
 * `./search-compat` converts between the two while consumers migrate.
 */

/** A single search result item. Field names are the legacy ones, on purpose. */
export interface SearchResult {
  /** Result title. Non-empty for a usable result. */
  title: string;
  /** Direct result URL (not a SERP redirect). */
  url: string;
  /** Result snippet or page content. May be `''` when the source has none. */
  content: string;
}

/**
 * A completed search from ONE provider.
 *
 * There is no `success` flag and no error string: a response only exists for a
 * search that produced results. Failures travel as {@link SearchProviderError}
 * (thrown) or {@link SearchErrorShape} (serialized).
 */
export interface SearchResponse {
  /** The query that produced these results. */
  query: string;
  /** The provider that produced them. */
  providerId: SearchProviderId;
  /** Results in provider order, already deduplicated by the producer. */
  results: SearchResult[];
}

/** Recency window for providers whose `supportsTimeRange` capability is true. */
export type SearchTimeRange = 'day' | 'week' | 'month' | 'year';

/**
 * Per-request options. The first four fields are the legacy
 * `WebSearchOptions` set, unchanged, so legacy call sites assign without a
 * mapping; the rest match the capability flags a provider declares.
 *
 * A provider MUST ignore an option it does not declare support for rather than
 * failing the request.
 */
export interface SearchOptions {
  /** Maximum number of results to return. */
  maxResults?: number;
  /** Request timeout in milliseconds. */
  timeout?: number;
  /** Cancellation signal — the only cancellation channel in this contract. */
  signal?: AbortSignal;
  /** Fetch full page content instead of snippets, where the provider can. */
  fetchPageContent?: boolean;
  /** Region/market hint (provider-specific spelling, e.g. `us`, `zh-CN`). */
  region?: string;
  /** Result language hint. */
  language?: string;
  /** Recency window. */
  timeRange?: SearchTimeRange;
}

/** A search to execute, optionally pinned to one provider. */
export interface SearchRequest {
  /** The user or tool supplied query. Untrusted input. */
  query: string;
  /** Pin the search to one provider; omit to let the runtime choose. */
  provider?: SearchProviderId;
  /** Per-request options. */
  options?: SearchOptions;
}

/**
 * The provider ids Omnicross itself ships in Phase 1.
 *
 * This list is NOT the set of valid ids — see {@link SearchProviderId}. Ids
 * absent from it are absent by decision, not by oversight: `local-*` providers
 * remain host (Elftia) contributions because they need a browser runtime, and
 * `grok` / `claude` / `exa` / `bocha` are deliberately not registered in
 * Phase 1.
 */
export type KnownSearchProviderId =
  | 'http-bing'
  | 'http-duckduckgo'
  | 'tavily'
  | 'jina'
  | 'searxng'
  | 'zhipu'
  | 'z.ai';

/**
 * A provider identifier — open by construction.
 *
 * `(string & {})` keeps autocomplete for {@link KnownSearchProviderId} while
 * accepting any other string, so host contributions and namespaced custom ids
 * (`acme:internal-search`) are first-class without growing a union. Whether an
 * id is *registered* is a registry question, not a type-level one.
 */
export type SearchProviderId = KnownSearchProviderId | (string & {});

const KNOWN_SEARCH_PROVIDER_IDS: ReadonlySet<string> = new Set<KnownSearchProviderId>([
  'http-bing',
  'http-duckduckgo',
  'tavily',
  'jina',
  'searxng',
  'zhipu',
  'z.ai',
]);

/**
 * Narrow an id to {@link KnownSearchProviderId}.
 *
 * This is a membership test against the shipped list — it does NOT classify.
 * A `false` result says "not one of the ids Omnicross ships", never "invalid",
 * "untrusted", or "local".
 */
export function isKnownSearchProviderId(id: SearchProviderId): id is KnownSearchProviderId {
  return KNOWN_SEARCH_PROVIDER_IDS.has(id);
}

/**
 * What a provider can do, declared explicitly.
 *
 * Flat booleans plus one limit: the shape serializes as-is into capability
 * discovery and doctor output, and extends additively.
 */
export interface SearchProviderCapabilities {
  /** Requires a configured API key to run at all. */
  requiresApiKey: boolean;
  /** Honors {@link SearchOptions.region}. */
  supportsRegion: boolean;
  /** Honors {@link SearchOptions.language}. */
  supportsLanguage: boolean;
  /** Honors {@link SearchOptions.timeRange}. */
  supportsTimeRange: boolean;
  /** Implements {@link SearchProvider.readUrl}. */
  supportsUrlRead: boolean;
  /** Honors {@link SearchOptions.signal}. */
  supportsCancellation: boolean;
  /** Upper bound on results per request, when the provider imposes one. */
  maxResults?: number;
}

/** The result of reading one URL through a provider that supports it. */
export interface SearchUrlReadResult {
  /** The URL that was read (post-redirect, when the provider reports it). */
  url: string;
  /** Page title, when available. */
  title?: string;
  /** Extracted page content, when available. */
  content?: string;
}

/**
 * A search provider.
 *
 * `search` returns bare results; assembling a {@link SearchResponse} is the
 * runtime's job. Failures are thrown as {@link SearchProviderError} — there is
 * no in-band failure channel, because a code-less error string cannot drive a
 * fallback policy.
 */
export interface SearchProvider {
  /** Stable provider identifier, matching its contribution's `id`. */
  readonly id: SearchProviderId;
  /** Run a search. Throws {@link SearchProviderError} on failure. */
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  /** Read one URL, when `capabilities.supportsUrlRead` is true. */
  readUrl?(url: string, options?: SearchOptions): Promise<SearchUrlReadResult>;
  /** Report health without performing a real search. */
  healthCheck?(): Promise<SearchProviderDiagnostic>;
}

/** Who supplied a provider: the Omnicross runtime, or the embedding host. */
export type SearchProviderSource = 'builtin' | 'host';

/**
 * How a provider reaches the network. This is the baseline's observed
 * transport vocabulary, kept verbatim so behavior comparisons across the
 * legacy and new runtimes speak one language.
 */
export type SearchTransportKind = 'api' | 'http' | 'local-browser' | 'native';

/**
 * A provider offered to the registry, with everything the runtime must never
 * infer stated up front.
 *
 * `source` and `kind` together are the structural replacement for
 * `id.startsWith('local-')`: eligibility, secret handling, and egress policy
 * read these declared fields, never the id's spelling.
 */
export interface SearchProviderContribution {
  /** Stable id the provider registers under. */
  id: SearchProviderId;
  /** Explicit origin declaration. */
  source: SearchProviderSource;
  /** Explicit transport declaration. */
  kind: SearchTransportKind;
  /** The provider implementation. */
  provider: SearchProvider;
  /** Explicit capability declaration. */
  capabilities: SearchProviderCapabilities;
  /** Ordering hint for the registry; lower runs earlier. Ties keep registration order. */
  priorityHint?: number;
}

/**
 * The stable search error taxonomy — exactly eight codes.
 *
 * These are the vocabulary a fallback policy decides on (`cancelled` and
 * `policy_denied` must not be retried) and the vocabulary behavior comparisons
 * are written in. `blocked` is deliberately absent: it is a *diagnostic
 * status* ({@link SearchProviderHealthStatus}), not a failure code.
 */
export type SearchErrorCode =
  | 'config_missing'
  | 'auth_failed'
  | 'rate_limited'
  | 'timeout'
  | 'upstream_unavailable'
  | 'parse_failed'
  | 'cancelled'
  | 'policy_denied';

const SEARCH_ERROR_CODES: ReadonlySet<string> = new Set<SearchErrorCode>([
  'config_missing',
  'auth_failed',
  'rate_limited',
  'timeout',
  'upstream_unavailable',
  'parse_failed',
  'cancelled',
  'policy_denied',
]);

/** The code every non-classifiable failure collapses to. */
const DEFAULT_SEARCH_ERROR_CODE: SearchErrorCode = 'upstream_unavailable';

/**
 * A search failure in serializable form — what crosses a wire, lands in a
 * diagnostic, or gets logged.
 *
 * `message` and `details` values MUST be pre-sanitized by the producer: no API
 * keys, no cookies, no raw headers, no proxy URLs. `details` is deliberately
 * `Record<string, string>` so nothing nested can smuggle a credential object.
 */
export interface SearchErrorShape {
  /** Stable taxonomy code. */
  code: SearchErrorCode;
  /** Human-readable, pre-sanitized message. */
  message: string;
  /** The provider that failed, when known. */
  providerId?: SearchProviderId;
  /** Whether retrying the same provider could plausibly succeed. */
  retryable?: boolean;
  /** Pre-sanitized string-valued context. */
  details?: Record<string, string>;
}

/** Optional fields for {@link SearchProviderError}. */
export interface SearchProviderErrorInit {
  /** The provider that failed. */
  providerId?: SearchProviderId;
  /** Whether retrying the same provider could plausibly succeed. */
  retryable?: boolean;
  /** Pre-sanitized string-valued context. */
  details?: Record<string, string>;
  /** Underlying error, for local diagnosis. Never serialized into the shape. */
  cause?: unknown;
}

/**
 * The error providers throw.
 *
 * Carries the same fields as {@link SearchErrorShape} plus an optional
 * `cause`, which stays local — {@link toSearchErrorShape} never serializes it.
 */
export class SearchProviderError extends Error {
  /** Stable taxonomy code. */
  readonly code: SearchErrorCode;
  /** The provider that failed, when known. */
  readonly providerId?: SearchProviderId;
  /** Whether retrying the same provider could plausibly succeed. */
  readonly retryable?: boolean;
  /** Pre-sanitized string-valued context. */
  readonly details?: Record<string, string>;

  constructor(code: SearchErrorCode, message: string, init: SearchProviderErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'SearchProviderError';
    this.code = code;
    this.providerId = init.providerId;
    this.retryable = init.retryable;
    this.details = init.details;
    // Keeps `instanceof` working when the class is transpiled down or the
    // prototype chain is rebuilt by a bundler.
    Object.setPrototypeOf(this, SearchProviderError.prototype);
  }

  /** This error as its serializable {@link SearchErrorShape}. */
  toShape(): SearchErrorShape {
    return toSearchErrorShape(this);
  }
}

/**
 * Whether a value is a search error carrying a taxonomy code.
 *
 * Structural as well as `instanceof`, because `@omnicross/contracts` can be
 * present twice in one process (ESM and CJS builds, or `src` under test beside
 * `dist` at runtime) and a bare `instanceof` silently fails across those
 * copies.
 */
export function isSearchProviderError(value: unknown): value is SearchProviderError {
  if (value instanceof SearchProviderError) return true;
  if (!(value instanceof Error)) return false;
  const code: unknown = (value as { code?: unknown }).code;
  return typeof code === 'string' && SEARCH_ERROR_CODES.has(code);
}

/**
 * Convert any thrown value into a {@link SearchErrorShape}.
 *
 * A {@link SearchProviderError} keeps its code and fields. Anything else gets
 * the documented default code `upstream_unavailable` — this function does NOT
 * sniff messages; string-to-code translation of legacy error text lives in
 * `./search-compat` so exactly one mapping exists.
 */
export function toSearchErrorShape(value: unknown): SearchErrorShape {
  if (isSearchProviderError(value)) {
    const shape: SearchErrorShape = { code: value.code, message: value.message };
    if (value.providerId !== undefined) shape.providerId = value.providerId;
    if (value.retryable !== undefined) shape.retryable = value.retryable;
    if (value.details !== undefined) shape.details = value.details;
    return shape;
  }
  return { code: DEFAULT_SEARCH_ERROR_CODE, message: describeUnknownError(value) };
}

/** Best-effort message for a non-`SearchProviderError` throw. */
function describeUnknownError(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error && value.message) return value.message;
  return 'Unknown error';
}

/**
 * The knobs a runtime uses to choose and order providers.
 *
 * These are plan §11.3's query-egress controls: a query reaches a provider only
 * because policy allowed it, so "send this query to exactly one provider" is
 * expressible (`fallbackEnabled: false`, or a one-id `allowed`) rather than
 * implied. Every field is optional; the documented defaults are fallback on,
 * every registered provider allowed, and an unbounded number of attempts.
 */
export interface SearchPolicy {
  /** Try this provider first when the request pins none. Unknown ids are skipped, not errors. */
  preferred?: SearchProviderId;
  /** Restrict candidates to these ids. Omit to allow every registered provider. */
  allowed?: SearchProviderId[];
  /** Whether a failed candidate may be followed by another. Omit for `true`. */
  fallbackEnabled?: boolean;
  /** Upper bound on candidates attempted for one search. Omit for unbounded. */
  maxAttempts?: number;
}

/** How one provider attempt ended. Empty results are a `success`. */
export type SearchAttemptOutcome = 'success' | 'failed';

/**
 * One provider attempt, as recorded by the orchestrator.
 *
 * This is the structured record; it carries no query text and no result
 * content, so it is safe to log or return to a caller verbatim.
 */
export interface SearchAttempt {
  /** The provider that was attempted. */
  providerId: SearchProviderId;
  /** How the attempt ended. */
  outcome: SearchAttemptOutcome;
  /** Taxonomy code for a `failed` attempt. */
  errorCode?: SearchErrorCode;
  /** Results the attempt produced; `0` is a legitimate success. */
  resultCount?: number;
  /** Wall-clock duration of the attempt in milliseconds. */
  durationMs: number;
}

/**
 * A {@link SearchResponse} plus what the orchestrator did to produce it.
 *
 * `attempts` records provider EXECUTIONS in order; candidates that were never
 * attempted (skipped by policy, cut off by `maxAttempts`) do not appear.
 */
export interface OrchestratedSearchResponse extends SearchResponse {
  /** Every provider attempt, in the order they ran. */
  attempts: SearchAttempt[];
  /** Attempts beyond the first — `attempts.length - 1`, never negative. */
  fallbackCount: number;
}

/**
 * A registered provider as capability discovery sees it.
 *
 * Serializable by construction: the provider instance is deliberately absent,
 * so a descriptor can cross a wire, land in doctor output, or reach a renderer
 * without dragging an implementation (or its configuration) along.
 */
export interface SearchProviderDescriptor {
  /** The id the provider is registered under. */
  id: SearchProviderId;
  /** Declared origin. */
  source: SearchProviderSource;
  /** Declared transport. */
  kind: SearchTransportKind;
  /** Declared capabilities. */
  capabilities: SearchProviderCapabilities;
}

/**
 * Who is registering a contribution.
 *
 * Minimal on purpose: the parameter exists today so a Phase-2 host registering
 * its `local-*` providers does not force a signature change, and so registry
 * policy has somewhere to read a caller identity from when it needs one.
 */
export interface SearchContributionContext {
  /** Identifier of the embedding host making the registration. */
  hostId?: string;
}

/**
 * Fields every runtime event carries.
 *
 * `queryHash` — never the query — is the correlation key (plan §11.3). No
 * variant of {@link SearchRuntimeEvent} declares a field for query text, a URL,
 * or result content, and none ever should: these events are built to be logged.
 */
export interface SearchRuntimeEventBase {
  /** Correlates every event of one search. Random per search. */
  requestId: string;
  /** Short one-way hash of the query, computed by the runtime. */
  queryHash: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
}

/** One provider attempt, as observed. */
export interface SearchAttemptEvent extends SearchRuntimeEventBase {
  type: 'search_attempt';
  /** The provider attempted, or the one a policy skipped. */
  providerId: SearchProviderId;
  /** How the attempt ended. */
  outcome: SearchAttemptOutcome;
  /** Taxonomy code for a `failed` attempt. */
  errorCode?: SearchErrorCode;
  /** Results the attempt produced. */
  resultCount?: number;
}

/**
 * The single terminal event of a search, emitted for success and failure alike.
 *
 * `providerId` is present exactly when a provider produced the response — its
 * absence means no provider succeeded, which is what separates a failed search
 * from a provider that authoritatively found nothing (present id, zero results).
 */
export interface SearchCompleteEvent extends SearchRuntimeEventBase {
  type: 'search_complete';
  /** The provider that produced the response, when one did. */
  providerId?: SearchProviderId;
  /** Results returned to the caller; `0` for a failed search. */
  resultCount: number;
  /** Attempts beyond the first. */
  fallbackCount: number;
}

/** Everything a runtime observability listener can receive. */
export type SearchRuntimeEvent = SearchAttemptEvent | SearchCompleteEvent;

/**
 * Provider health as reported by doctor/diagnostics surfaces.
 *
 * `blocked` means an egress or policy decision stopped the provider — the
 * status that keeps `blocked` out of {@link SearchErrorCode}.
 */
export type SearchProviderHealthStatus =
  | 'healthy'
  | 'degraded'
  | 'unconfigured'
  | 'blocked'
  | 'failed';

/**
 * One provider's health.
 *
 * This type has no field for an API key, cookie, token, or raw request or
 * response header, and must never gain one. `reason` and any
 * `error.details` values MUST be pre-sanitized by the producer before they
 * reach this shape — diagnostics are displayed and logged.
 */
export interface SearchProviderDiagnostic {
  /** The provider this diagnostic describes. */
  providerId: SearchProviderId;
  /** Current status. */
  status: SearchProviderHealthStatus;
  /** ISO-8601 timestamp of the check. */
  checkedAt?: string;
  /** Short, pre-sanitized explanation of a non-healthy status. */
  reason?: string;
  /** The failure behind a `failed`/`degraded` status. */
  error?: SearchErrorShape;
}
