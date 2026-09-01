/**
 * The shared HTTP transport both keyless search providers run on.
 *
 * Ported from Elftia's `webFetchHttp.fetchWebResource` + `nodeWebFetchTransport`
 * (baselined in `docs/design/search-baseline/elftia-search-baseline.md` §3.3),
 * with the failure channel replaced: instead of bare `Error` strings, every
 * failure is a `SearchProviderError` carrying `details.transport` and
 * `details.stage`.
 *
 * Fixed semantics:
 * - undici `fetch`, with an `EnvHttpProxyAgent` dispatcher when the environment
 *   configures a proxy (cached per proxy signature).
 * - The pinned browser navigation header profile (see `./headers`).
 * - `redirect: 'manual'`, at most {@link MAX_REDIRECTS} hops.
 * - A byte cap enforced WHILE the body streams — an oversized page fails, it is
 *   never silently truncated (this diverges from Elftia, which truncates and
 *   parses the fragment; the spec requires a `body-cap` failure).
 * - One deadline per attempt; caller aborts surface as `cancelled`, the deadline
 *   as `timeout`, never conflated.
 * - Compression is undici's business: it negotiates `Accept-Encoding` and
 *   decodes the response.
 *
 * `impit` is NOT used. undici is the sole Phase-1 transport; the injection seam
 * below is the only future-proofing.
 *
 * @module search/http/transport
 */

import type { SearchProviderId } from '@omnicross/contracts/search-types';
import { fetch as undiciFetch } from 'undici';

import { decodeSearchBody } from './body-decode';
import { asSearchProviderError, hostOf, searchHttpError } from './errors';
import { searchBrowserHeaders } from './headers';
import { getSearchProxyDispatcher, resolveSearchProxySettings, type ProxyEnvironment } from './proxy';
import type {
  SearchHttpFetch,
  SearchHttpRequest,
  SearchHttpResource,
  SearchHttpTransport,
} from './types';

/** Fetch-layer defaults, matching the baselined Elftia values. */
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/** Redirect hop cap. */
export const MAX_REDIRECTS = 5;

/** Statuses that mean "the engine refused this browser-shaped request". */
const REFUSED_STATUSES = new Set([401, 403, 407, 429]);

/** Knobs for {@link createSearchHttpTransport}. */
export interface SearchHttpTransportOptions {
  /** The fetch primitive to drive. Defaults to undici's `fetch`. */
  fetch?: SearchHttpFetch;
  /** Environment to read proxy variables from. Defaults to `process.env`. */
  env?: ProxyEnvironment;
  /** Redirect hop cap. Defaults to {@link MAX_REDIRECTS}. */
  maxRedirects?: number;
}

/** Build a transport. Tests inject `fetch`; production takes the default. */
export function createSearchHttpTransport(
  options: SearchHttpTransportOptions = {},
): SearchHttpTransport {
  const fetchImpl = options.fetch ?? createUndiciFetch(options.env);
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;

  return async (url, request) => {
    const context: AttemptContext = {
      providerId: request.providerId,
      host: hostOf(url),
    };

    const controller = new AbortController();
    const onAbort = (): void => controller.abort(request.signal?.reason);
    request.signal?.addEventListener('abort', onAbort, { once: true });
    if (request.signal?.aborted) onAbort();

    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let deadlineExpired = false;
    const timer = setTimeout(() => {
      deadlineExpired = true;
      controller.abort();
    }, timeoutMs);

    try {
      const { response, finalUrl } = await fetchWithRedirectLimit(
        fetchImpl,
        url,
        controller.signal,
        maxRedirects,
        context,
      );
      context.host = hostOf(finalUrl);

      const contentType = response.headers.get('content-type') ?? '';
      const rawText = await readBodyWithLimit(
        response,
        request.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
        context,
      );

      assertStatusUsable(response.status, context);
      assertNoBotChallenge(rawText, context);
      return { finalUrl, status: response.status, contentType, rawText } satisfies SearchHttpResource;
    } catch (error) {
      // Abort provenance first: it is the ground truth about why an in-flight
      // request died, and the fetch primitive reports both the same way.
      if (request.signal?.aborted) {
        throw searchHttpError('cancelled', 'search request was cancelled by the caller', {
          stage: 'fetch',
          providerId: context.providerId,
          retryable: false,
          cause: error,
          details: { host: context.host },
        });
      }
      if (deadlineExpired) {
        throw searchHttpError('timeout', `search request exceeded its ${timeoutMs}ms budget`, {
          stage: 'fetch',
          providerId: context.providerId,
          retryable: true,
          cause: error,
          details: { host: context.host },
        });
      }
      throw asSearchProviderError(error, context.providerId, 'fetch');
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
    }
  };
}

/** The production transport: undici, reading proxy settings from `process.env`. */
export const defaultSearchHttpTransport: SearchHttpTransport = createSearchHttpTransport();

/** Per-attempt context carried into error construction (hostnames only). */
interface AttemptContext {
  providerId?: SearchProviderId;
  host: string;
}

/** undici `fetch`, with a proxy dispatcher when the environment asks for one. */
function createUndiciFetch(env?: ProxyEnvironment): SearchHttpFetch {
  return async (url, init) => {
    const proxy = resolveSearchProxySettings(env);
    const dispatcher = proxy ? getSearchProxyDispatcher(proxy) : undefined;
    const requestInit = dispatcher ? { ...init, dispatcher } : init;
    return (await undiciFetch(
      url,
      requestInit as Parameters<typeof undiciFetch>[1],
    )) as unknown as Response;
  };
}

async function fetchWithRedirectLimit(
  fetchImpl: SearchHttpFetch,
  url: string,
  signal: AbortSignal,
  maxRedirects: number,
  context: AttemptContext,
): Promise<{ response: Response; finalUrl: string }> {
  let currentUrl = url;

  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    let response: Response;
    context.host = hostOf(currentUrl);
    try {
      response = await fetchImpl(currentUrl, {
        signal,
        redirect: 'manual',
        headers: searchBrowserHeaders(),
      });
    } catch (error) {
      // Aborts are classified by the caller (cancel vs deadline) — never here.
      if (isAbortError(error)) throw error;
      throw searchHttpError('upstream_unavailable', networkFailureMessage(error), {
        stage: 'connect',
        providerId: context.providerId,
        retryable: true,
        cause: error,
        details: { host: context.host },
      });
    }

    if (response.status < 300 || response.status >= 400) {
      return { response, finalUrl: response.url || currentUrl };
    }

    const location = response.headers.get('location');
    if (!location) return { response, finalUrl: currentUrl };

    // Nobody will ever read this hop's body. Cancel it so undici returns the
    // connection to its pool now, rather than at GC finalization.
    void response.body?.cancel().catch(() => undefined);

    if (redirects === maxRedirects) throw tooManyRedirects(maxRedirects, context);
    currentUrl = new URL(location, currentUrl).href;
  }

  throw tooManyRedirects(maxRedirects, context);
}

function tooManyRedirects(maxRedirects: number, context: AttemptContext): Error {
  return searchHttpError('upstream_unavailable', `too many redirects (>${maxRedirects})`, {
    stage: 'redirect',
    providerId: context.providerId,
    retryable: false,
    details: { host: context.host, maxRedirects: String(maxRedirects) },
  });
}

/**
 * Read the body, failing the moment it outgrows the cap.
 *
 * Elftia stops reading and parses what it got; here an oversized page is a
 * `body-cap` failure, because a truncated SERP parses into a plausible-looking
 * partial result set that no caller can distinguish from a real one.
 */
async function readBodyWithLimit(
  response: Response,
  maxResponseBytes: number,
  context: AttemptContext,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxResponseBytes) {
      await reader.cancel().catch(() => undefined);
      throw searchHttpError(
        'upstream_unavailable',
        `search response exceeded the ${maxResponseBytes} byte cap`,
        {
          stage: 'body-cap',
          providerId: context.providerId,
          retryable: false,
          details: { host: context.host, maxResponseBytes: String(maxResponseBytes) },
        },
      );
    }
    chunks.push(value);
  }

  const rawBytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    rawBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decodeSearchBody(rawBytes, response.headers.get('content-type') ?? '');
}

/** A status the engine uses to refuse a browser-shaped request outright. */
function assertStatusUsable(status: number, context: AttemptContext): void {
  if (!REFUSED_STATUSES.has(status)) return;
  // No `rate_limited`/`auth_failed` here on purpose: these providers are
  // keyless and fixed-host, so a refusal is an upstream availability fact, not
  // a credential or quota one the caller could act on.
  throw searchHttpError(
    'upstream_unavailable',
    `server refused the browser-shaped request (HTTP ${status})`,
    {
      stage: 'fetch',
      providerId: context.providerId,
      retryable: false,
      details: { host: context.host, status: String(status) },
    },
  );
}

/** Generic bot-challenge shells (Cloudflare, PerimeterX, DuckDuckGo copy). */
function assertNoBotChallenge(html: string, context: AttemptContext): void {
  if (!/<(?:html|body|title|script)\b/i.test(html)) return;

  const title = html
    .match(/<title[^>]*>(.*?)<\/title>/is)?.[1]
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const challengeTitle =
    /^(?:just a moment|attention required|access denied|robot check|security check)/i.test(
      title ?? '',
    );
  const challengeInfrastructure =
    /cdn-cgi\/challenge-platform|cf-chl-|cf-turnstile|px-captcha|hcaptcha-container/i.test(html);
  const challengeCopy =
    /verify (?:you are|that you are) human|unusual traffic from your computer|enable javascript and cookies to continue/i.test(
      html,
    );
  const duckDuckGoChallenge =
    /unfortunately, bots use duckduckgo too|complete the following challenge to confirm this search was made by a human/i.test(
      html,
    );

  if (challengeTitle || duckDuckGoChallenge || (challengeInfrastructure && challengeCopy)) {
    throw searchHttpError(
      'upstream_unavailable',
      'server returned a bot-challenge page instead of the requested content',
      {
        stage: 'challenge',
        providerId: context.providerId,
        retryable: false,
        details: { host: context.host },
      },
    );
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/**
 * Describe a connect-layer failure by its error code only.
 *
 * undici nests the real cause a few levels deep; the code (`ENOTFOUND`,
 * `ECONNREFUSED`, …) is the useful part and carries no host or credential.
 */
function networkFailureMessage(error: unknown): string {
  const code = nestedErrorCode(error);
  return code ? `network request failed (${code})` : 'network request failed';
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
