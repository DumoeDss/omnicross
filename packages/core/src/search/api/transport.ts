/**
 * The shared transport every API search adapter runs on.
 *
 * Elftia's four adapters each call global `fetch` directly, each build their
 * own `<label> search failed: <status> - <responseText>` string, and each
 * follow redirects silently. Porting that shape four times would mean writing
 * the SSRF check and the secret redaction four times — so the ported adapters
 * share this one transport instead, and it owns everything that must not be
 * re-implemented per provider:
 *
 * - **Egress validation** of the initial URL and of EVERY redirect hop.
 * - **A manual redirect walk** (cap {@link API_MAX_REDIRECTS}). This is a
 *   deliberate divergence from Elftia's `redirect: 'follow'`, recorded for
 *   阶段5's comparison report: per-hop validation is impossible without it, and
 *   a JSON API that redirects now gets checked instead of silently followed.
 * - **The guarded dispatcher** on direct connections, so a hostname that
 *   resolves into a denied class cannot be connected to. Proxied connections
 *   take the proxy dispatcher and keep URL-level checks only — see
 *   {@link selectApiDispatcher}.
 * - **Status mapping** onto the eight-code taxonomy.
 * - **Redaction**, through one sanitizer every error message passes. Tavily
 *   sends its API key in the request BODY, so an upstream 4xx that quotes the
 *   request is a direct path from a credential to a log file. This is the only
 *   thing standing in that path.
 *
 * @module search/api/transport
 */

import type { SearchProviderId } from '@omnicross/contracts/search-types';
import { SearchProviderError } from '@omnicross/contracts/search-types';
import { fetch as undiciFetch, type Dispatcher } from 'undici';

import {
  createEgressGuardedDispatcher,
  findEgressDenial,
  validateEgressUrl,
  type SearchEgressPolicy,
} from '../egress';
import {
  getSearchProxyDispatcher,
  resolveSearchProxySettings,
  type ProxyEnvironment,
} from '../http/proxy';
import {
  SEARCH_API_TRANSPORT_ID,
  type SearchApiFetch,
  type SearchApiRequest,
  type SearchApiStage,
  type SearchApiTransport,
} from './types';

/** Redirect hop cap, matching the HTTP slice. */
export const API_MAX_REDIRECTS = 5;

/** Default per-request budget, matching the search layer's HTTP budget. */
export const DEFAULT_API_TIMEOUT_MS = 15_000;

/** Sanity cap on a JSON response body. Search payloads are kilobytes. */
export const API_RESPONSE_BYTES = 2 * 1024 * 1024;

/** How much upstream error text may survive into a message. */
const MAX_UPSTREAM_TEXT = 300;

/** Knobs for {@link createSearchApiTransport}. */
export interface SearchApiTransportOptions {
  /** The fetch primitive to drive. Defaults to undici's `fetch`. */
  fetch?: SearchApiFetch;
  /** Environment to read proxy variables from. Defaults to `process.env`. */
  env?: ProxyEnvironment;
  /**
   * Layered proxy-dispatcher override for one request URL, AHEAD of the env
   * layer (the daemon's `fetchUpstream` resolver, so search follows
   * `server.proxy`). When it yields a dispatcher the connection is proxied —
   * URL and per-hop egress validation still apply, address-level validation
   * does not, the same documented limitation as the env proxy. When it yields
   * `undefined` the env layer and then the egress-guarded dispatcher apply,
   * exactly as before.
   */
  resolveProxyDispatcher?: (url: string) => Dispatcher | undefined;
  /** Egress policy. Defaults to public-only. */
  egressPolicy?: SearchEgressPolicy;
  /** Redirect hop cap. Defaults to {@link API_MAX_REDIRECTS}. */
  maxRedirects?: number;
}

/** Build an API transport. Tests inject `fetch`; production takes the default. */
export function createSearchApiTransport(
  options: SearchApiTransportOptions = {},
): SearchApiTransport {
  const policy = options.egressPolicy;
  const fetchImpl =
    options.fetch ?? createUndiciApiFetch(options.env, policy, options.resolveProxyDispatcher);
  const maxRedirects = options.maxRedirects ?? API_MAX_REDIRECTS;

  return async (request) => {
    const context: ApiContext = {
      providerId: request.providerId,
      label: request.label,
      secrets: request.secrets ?? [],
      host: 'unknown-host',
    };

    // Before anything else, and outside the try: an egress denial is a verdict,
    // not a failure to classify.
    const initialUrl = assertEgressAllowed(request.url, policy, context);
    context.host = initialUrl.hostname;

    const controller = new AbortController();
    const onAbort = (): void => controller.abort(request.signal?.reason);
    request.signal?.addEventListener('abort', onAbort, { once: true });
    if (request.signal?.aborted) onAbort();

    const timeoutMs = request.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
    let deadlineExpired = false;
    const timer = setTimeout(() => {
      deadlineExpired = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetchWithValidatedRedirects(
        fetchImpl,
        initialUrl,
        request,
        controller.signal,
        maxRedirects,
        policy,
        context,
      );

      const rawText = await readJsonBodyWithLimit(response, context);
      assertStatusOk(response.status, rawText, context);
      return parseJsonPayload(rawText, context);
    } catch (error) {
      // A denial outranks even cancellation: it is a statement about what this
      // process REFUSED to do, and that stays true whether or not the caller
      // also happened to cancel. Relabelling it `cancelled` would erase the
      // only record that an SSRF attempt was blocked.
      const denial = findEgressDenial(error);
      if (denial) throw denial;
      // Then abort provenance: it is the ground truth about why an in-flight
      // request died, and the fetch primitive reports both the same way.
      if (request.signal?.aborted) {
        throw apiError('cancelled', `${context.label} search was cancelled by the caller`, {
          stage: 'fetch',
          context,
          retryable: false,
          cause: error,
        });
      }
      if (deadlineExpired) {
        throw apiError(
          'timeout',
          `${context.label} search exceeded its ${timeoutMs}ms budget`,
          { stage: 'fetch', context, retryable: true, cause: error },
        );
      }
      throw asApiError(error, context, 'connect');
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
    }
  };
}

/** The production transport: undici, proxy from `process.env`, default policy. */
export const defaultSearchApiTransport: SearchApiTransport = createSearchApiTransport();

/** Per-request context carried into error construction. Hostnames only. */
interface ApiContext {
  providerId: SearchProviderId;
  label: string;
  secrets: ReadonlyArray<string | undefined>;
  host: string;
}

/**
 * Which dispatcher a direct or proxied connection gets, and why.
 *
 * Exported so the precedence is ASSERTED by a test rather than left implicit:
 * when a proxy is configured it resolves DNS itself, so the guarded lookup
 * cannot run and address-level validation is unavailable on that path. URL and
 * per-hop validation still apply. This is the documented limitation of the
 * egress policy, and this function is where it is decided.
 */
export function selectApiDispatcher(
  env?: ProxyEnvironment,
  policy?: SearchEgressPolicy,
  override?: {
    /** The request's own URL — the layered resolver's loopback/`NO_PROXY` input. */
    url: string;
    resolveProxyDispatcher?: (url: string) => Dispatcher | undefined;
  },
): { dispatcher: Dispatcher; proxied: boolean } {
  if (override?.resolveProxyDispatcher) {
    const dispatcher = override.resolveProxyDispatcher(override.url);
    if (dispatcher) return { dispatcher, proxied: true };
  }
  const proxy = resolveSearchProxySettings(env);
  if (proxy) return { dispatcher: getSearchProxyDispatcher(proxy), proxied: true };
  return { dispatcher: createEgressGuardedDispatcher(policy), proxied: false };
}

/** undici `fetch` with the dispatcher {@link selectApiDispatcher} chooses. */
function createUndiciApiFetch(
  env?: ProxyEnvironment,
  policy?: SearchEgressPolicy,
  resolveProxyDispatcher?: (url: string) => Dispatcher | undefined,
): SearchApiFetch {
  return async (url, init) => {
    const { dispatcher } = selectApiDispatcher(env, policy, { url, resolveProxyDispatcher });
    return (await undiciFetch(
      url,
      { ...init, dispatcher } as Parameters<typeof undiciFetch>[1],
    )) as unknown as Response;
  };
}

/**
 * Walk redirects manually, validating every hop's target before following it.
 *
 * Method and body handling follows the fetch standard, so the observable
 * behavior matches the `redirect: 'follow'` Elftia relied on: 303 always
 * becomes GET, 301/302 downgrade POST to GET, and 307/308 preserve both.
 */
async function fetchWithValidatedRedirects(
  fetchImpl: SearchApiFetch,
  initialUrl: URL,
  request: SearchApiRequest,
  signal: AbortSignal,
  maxRedirects: number,
  policy: SearchEgressPolicy | undefined,
  context: ApiContext,
): Promise<Response> {
  let currentUrl = initialUrl;
  let method = request.method;
  let body = request.jsonBody === undefined ? undefined : JSON.stringify(request.jsonBody);
  // No default `Accept`: each adapter sends exactly the headers its Elftia
  // original sent, so the ported wire contract stays checkable header by
  // header. Carried ACROSS iterations rather than rebuilt, because a
  // credential stripped on a cross-origin hop must stay stripped.
  const carriedHeaders: Record<string, string> = { ...request.headers };

  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    context.host = currentUrl.hostname;

    // `Content-Type` is the transport's to add, because the transport is what
    // serialized the body — and to drop when a downgrade removed it.
    const headers: Record<string, string> = { ...carriedHeaders };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await fetchImpl(currentUrl.href, {
        method,
        headers,
        body,
        signal,
        redirect: 'manual',
      });
    } catch (error) {
      // A denial raised inside the guarded dispatcher's lookup arrives wrapped
      // in undici's `fetch failed`; without this it would read as a transport
      // fault and hide the fact that a rebinding attempt was blocked.
      const denial = findEgressDenial(error);
      if (denial) throw denial;
      if (isAbortError(error)) throw error;
      throw apiError('upstream_unavailable', networkFailureMessage(error, context), {
        stage: 'connect',
        context,
        retryable: true,
        cause: error,
      });
    }

    if (response.status < 300 || response.status >= 400) return response;

    const location = response.headers.get('location');
    if (!location) return response;

    // Nobody reads a redirect body; cancel it so undici returns the connection
    // to its pool now rather than at GC finalization.
    void response.body?.cancel().catch(() => undefined);

    if (redirects === maxRedirects) throw tooManyRedirects(maxRedirects, context);

    let nextUrl: URL;
    try {
      nextUrl = new URL(location, currentUrl);
    } catch {
      throw apiError('upstream_unavailable', `${context.label} sent an unusable redirect target`, {
        stage: 'redirect',
        context,
        retryable: false,
      });
    }

    // The whole point of the manual walk. A redirect target is upstream-
    // controlled input, so it is validated exactly like the initial URL.
    assertEgressAllowed(nextUrl, policy, context);

    // The other half of what `redirect: 'follow'` did for free. The fetch
    // standard removes `Authorization`, `Cookie` and `Proxy-Authorization` when
    // a redirect crosses origins, and undici implements that; hand-rolling the
    // walk to get per-hop egress validation silently dropped it. Without this a
    // hostile — or, over plain http, merely MITM'd — upstream answers
    // `302 Location: https://collector.attacker.example/` and the next request
    // carries the provider's Bearer or Basic credential straight to it. Egress
    // validation does not help: that target is a perfectly ordinary public host.
    //
    // Removal is permanent for the rest of the walk, as in the standard: a
    // redirect back to the original origin does not restore the credential.
    if (nextUrl.origin !== currentUrl.origin) stripCredentialHeaders(carriedHeaders);

    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
    }
    currentUrl = nextUrl;
  }

  throw tooManyRedirects(maxRedirects, context);
}

/**
 * Headers the fetch standard removes on a cross-origin redirect.
 *
 * Compared case-insensitively: HTTP header names are case-insensitive, and an
 * adapter (or a future caller) writing `authorization` in any casing must get
 * the same protection as the `Authorization` these adapters happen to send.
 */
const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
]);

/** Remove every credential-bearing header, in place. */
function stripCredentialHeaders(headers: Record<string, string>): void {
  for (const name of Object.keys(headers)) {
    if (CREDENTIAL_HEADERS.has(name.toLowerCase())) delete headers[name];
  }
}

/**
 * Run the egress policy over one URL, restamped into this slice's error shape.
 *
 * The denial keeps its `policy_denied` code and its hostname-only message and
 * gains the `transport`/`stage`/`host` fields every failure here carries. Plan
 * §11.4 wants transport identity and failure stage observable on EVERY failure,
 * and a denial is the one a reader most needs to place: without this it reaches
 * `doctor search` as `transport=unknown, stage=unknown`.
 */
function assertEgressAllowed(
  url: string | URL,
  policy: SearchEgressPolicy | undefined,
  context: ApiContext,
): URL {
  try {
    return validateEgressUrl(url, policy, context.providerId);
  } catch (error) {
    if (!(error instanceof SearchProviderError) && !isTaxonomyError(error)) throw error;
    const denial = error as SearchProviderError;
    throw apiError(denial.code, denial.message, {
      stage: 'egress',
      context: { ...context, host: denial.details?.host ?? context.host },
      retryable: false,
      cause: denial,
      details: denial.details,
    });
  }
}

function tooManyRedirects(maxRedirects: number, context: ApiContext): SearchProviderError {
  return apiError('upstream_unavailable', `too many redirects (>${maxRedirects})`, {
    stage: 'redirect',
    context,
    retryable: false,
    details: { maxRedirects: String(maxRedirects) },
  });
}

/** Read the body as text, failing the moment it outgrows the cap. */
async function readJsonBodyWithLimit(response: Response, context: ApiContext): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > API_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw apiError(
        'upstream_unavailable',
        `${context.label} response exceeded the ${API_RESPONSE_BYTES} byte cap`,
        {
          stage: 'body-cap',
          context,
          retryable: false,
          details: { maxResponseBytes: String(API_RESPONSE_BYTES) },
        },
      );
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(merged);
}

/**
 * Map an unusable status onto the taxonomy.
 *
 * The upstream body is the one piece of attacker- or credential-adjacent text
 * that reaches a message, so it passes the sanitizer on the way.
 */
function assertStatusOk(status: number, rawText: string, context: ApiContext): void {
  if (status >= 200 && status < 300) return;

  const detail = sanitizeUpstreamText(rawText, context.secrets);
  const suffix = detail ? ` - ${detail}` : '';
  const details = { status: String(status) };

  if (status === 401 || status === 403) {
    throw apiError(
      'auth_failed',
      `${context.label} rejected the credentials (HTTP ${status})${suffix}`,
      { stage: 'fetch', context, retryable: false, details },
    );
  }
  if (status === 429) {
    throw apiError('rate_limited', `${context.label} rate limited the request (HTTP ${status})${suffix}`, {
      stage: 'fetch',
      context,
      retryable: true,
      details,
    });
  }
  throw apiError('upstream_unavailable', `${context.label} search failed: ${status}${suffix}`, {
    stage: 'fetch',
    context,
    // 5xx may pass on a retry; a 4xx that is not auth or quota will not.
    retryable: status >= 500,
    details,
  });
}

/** Parse the body as JSON, or fail as `parse_failed`. */
function parseJsonPayload(rawText: string, context: ApiContext): unknown {
  try {
    return JSON.parse(rawText) as unknown;
  } catch (error) {
    throw apiError('parse_failed', `${context.label} returned a body that is not valid JSON`, {
      stage: 'parse',
      context,
      retryable: false,
      cause: error,
    });
  }
}

/**
 * Require an array at `field` on a JSON payload.
 *
 * Elftia tolerates a missing array on three of the four adapters
 * (`data.results || []`), which turns a changed response shape into an
 * empty-but-successful search. That re-conflates exactly what 阶段2 separated:
 * a missing array is drift, not "the engine found nothing". All four adapters
 * now require the array and raise `parse_failed` — a recorded divergence for
 * 阶段5's comparison report. An array that is PRESENT and empty stays a
 * legitimate zero-result success.
 */
export function requireResultArray(
  payload: unknown,
  field: string,
  providerId: SearchProviderId,
  label: string,
): unknown[] {
  const value =
    typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)[field]
      : undefined;
  if (Array.isArray(value)) return value;

  throw new SearchProviderError(
    'parse_failed',
    `${label} response is missing its "${field}" array`,
    {
      providerId,
      retryable: false,
      details: { transport: SEARCH_API_TRANSPORT_ID, stage: 'parse' satisfies SearchApiStage },
    },
  );
}

/**
 * One payload field as a string.
 *
 * Upstream JSON is untrusted input: a field the API documents as a string may
 * be absent, null, or a number. Elftia's adapters let `undefined` through into
 * a typed `string` field; coercing here keeps the contract honest without
 * changing which results survive normalization.
 */
export function payloadText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A pre-flight configuration failure. Thrown before any network IO. */
export function apiConfigMissing(
  providerId: SearchProviderId,
  message: string,
): SearchProviderError {
  return new SearchProviderError('config_missing', message, {
    providerId,
    retryable: false,
    details: { transport: SEARCH_API_TRANSPORT_ID, stage: 'config' satisfies SearchApiStage },
  });
}

interface ApiErrorInit {
  stage: SearchApiStage;
  context: ApiContext;
  retryable?: boolean;
  cause?: unknown;
  details?: Record<string, string>;
}

/** Build a taxonomy-coded API failure with transport, stage and host attached. */
function apiError(
  code: SearchProviderError['code'],
  message: string,
  init: ApiErrorInit,
): SearchProviderError {
  return new SearchProviderError(code, message, {
    providerId: init.context.providerId,
    retryable: init.retryable,
    cause: init.cause,
    // transport/stage/host last so a caller-supplied `details` cannot shadow them.
    details: {
      ...init.details,
      host: init.context.host,
      transport: SEARCH_API_TRANSPORT_ID,
      stage: init.stage,
    },
  });
}

/** Normalize anything thrown inside the slice into a taxonomy error. */
function asApiError(
  value: unknown,
  context: ApiContext,
  fallbackStage: SearchApiStage,
): SearchProviderError {
  const denial = findEgressDenial(value);
  if (denial) return denial;
  if (value instanceof SearchProviderError) return value;
  if (isTaxonomyError(value)) return value;

  return apiError('upstream_unavailable', describeError(value, context), {
    stage: fallbackStage,
    context,
    retryable: true,
    cause: value,
  });
}

/** Structural check, so an error crossing an ESM/CJS copy boundary still counts. */
function isTaxonomyError(value: unknown): value is SearchProviderError {
  return (
    value instanceof Error &&
    typeof (value as { code?: unknown }).code === 'string' &&
    value.name === 'SearchProviderError'
  );
}

function describeError(value: unknown, context: ApiContext): string {
  const raw = value instanceof Error && value.message ? value.message : `${context.label} search failed`;
  return sanitizeUpstreamText(raw, context.secrets) || `${context.label} search failed`;
}

/**
 * Describe a connect-layer failure by its error code only.
 *
 * undici nests the real cause a few levels deep; the code (`ENOTFOUND`,
 * `ECONNREFUSED`, …) is the useful part and carries no host or credential.
 *
 * The depth cap assumes that nesting stays shallow. Exceeding it costs only the
 * errno in the message — the failure is still reported and still classified —
 * unlike the equivalent cap in `findEgressDenial`, which guards a security
 * signal.
 */
function networkFailureMessage(error: unknown, context: ApiContext): string {
  const code = nestedErrorCode(error);
  const suffix = code ? ` (${code})` : '';
  return `${context.label} request failed${suffix}`;
}

function nestedErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(code)) return code;
    current = current.cause;
  }
  return undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/** Field names whose VALUE is a credential, whatever that value happens to be. */
const CREDENTIAL_NAMES =
  'api_?key|access_?token|refresh_?token|token|password|passwd|secret|authorization';

/** `"api_key": "…"` in ordinary JSON. */
const CREDENTIAL_FIELD = new RegExp(`("(?:${CREDENTIAL_NAMES})"\\s*:\\s*")(?:[^"\\\\]|\\\\.)*(")`, 'gi');

/**
 * `\"api_key\": \"…\"` — the same field inside a JSON string.
 *
 * This variant is not a curiosity: an API that reports "here is the request I
 * received" serializes it, so the echoed credential arrives with every quote
 * escaped and the plain pattern above matches nothing. Caught by the leak gate
 * against a SearXNG error quoting a Tavily request — the case where value-level
 * redaction cannot help, because that key was never in THIS provider's config.
 */
const ESCAPED_CREDENTIAL_FIELD = new RegExp(
  `(\\\\"(?:${CREDENTIAL_NAMES})\\\\"\\s*:\\s*\\\\")(?:(?!\\\\").)*(\\\\")`,
  'gi',
);

/** `Bearer <token>` / `Basic <base64>`, wherever they appear in free text. */
const AUTH_SCHEME_VALUE = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi;

/** Any absolute URL — it may carry a key in a query parameter or userinfo. */
const ABSOLUTE_URL = /[a-z][a-z0-9+.-]*:\/\/\S+/gi;

/**
 * Make upstream text safe to put in an error message.
 *
 * Four passes, in this order because each depends on the last not having run:
 * credential-valued JSON fields go first (they survive even for a key this
 * process never held), then the configured secret VALUES, then bare
 * `Bearer`/`Basic` tokens, then whole URLs. Whitespace collapse and the length
 * cap come last, so the cap can never bisect a secret into a surviving half.
 *
 * Exported for the leak gate, which greps the output of every produced error.
 */
export function sanitizeUpstreamText(
  text: string,
  secrets: ReadonlyArray<string | undefined> = [],
): string {
  if (!text) return '';

  let out = text.replace(ESCAPED_CREDENTIAL_FIELD, '$1[redacted]$2');
  out = out.replace(CREDENTIAL_FIELD, '$1[redacted]$2');
  out = redactSecretValues(out, secrets);
  out = out.replace(AUTH_SCHEME_VALUE, '$1 [redacted]');
  out = out.replace(ABSOLUTE_URL, '[url]');
  out = out.replace(/\s+/g, ' ').trim();

  return out.length > MAX_UPSTREAM_TEXT ? `${out.slice(0, MAX_UPSTREAM_TEXT)}…` : out;
}

/**
 * Strip every configured credential value.
 *
 * Length is deliberately NOT a threshold for skipping: a short secret that
 * mangles a diagnostic is a bad message, while a short secret that survives is
 * a leaked credential, and only one of those is a security problem.
 */
function redactSecretValues(text: string, secrets: ReadonlyArray<string | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join('[redacted]');
    // Also the form a URL-encoded echo would use.
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) out = out.split(encoded).join('[redacted]');
  }
  return out;
}
