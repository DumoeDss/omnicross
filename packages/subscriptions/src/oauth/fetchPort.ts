/**
 * OAuth fetch port — the injected HTTP boundary for the host-clean OAuth flows.
 *
 * The flow modules NEVER touch a concrete HTTP client. They receive a
 * `FetchLike` and run every request through `postForm`, which implements
 * standard OAuth POST-form semantics:
 *   - `POST` with `Content-Type: application/x-www-form-urlencoded`,
 *   - body = the `URLSearchParams` string,
 *   - accumulate the response body as UTF-8 text and `JSON.parse` it,
 *   - if the parsed body carries `error` → reject with
 *     `error_description || error`,
 *   - if the body is not parseable → reject with the caller-supplied parse-error
 *     string (e.g. `'Failed to parse token response'`).
 *
 * `FetchLike` is re-exported from `@omnicross/core` so the flow modules + barrel
 * have a single import source and stay decoupled from the resolver module's path.
 *
 * @module @omnicross/subscriptions/oauth/fetchPort
 */

import type { FetchLike } from '@omnicross/core/auth/GeminiCodeAssistProjectResolver';

export type { FetchLike };

/**
 * The token-endpoint JSON body the flows read. On the SUCCESS path (no `error`),
 * the OAuth providers always return `access_token` + `expires_in`.
 * `refresh_token` / `id_token` / `scope` are genuinely optional
 * (gemini refresh omits `refresh_token`; only codex returns `id_token`). The
 * `error` branch is handled inside `postForm` before any field is read.
 */
interface TokenResponseBody {
  /**
   * OAuth error code. Most providers return a STRING (`"invalid_grant"`), but
   * Anthropic's token endpoint returns an OBJECT (`{ type, message }`). Typed as
   * `unknown` so the message extraction stays object-safe (see `errorMessage`).
   */
  error?: unknown;
  error_description?: string;
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
  scope?: string;
  [key: string]: unknown;
}

/**
 * Extract a human-readable message from a token-endpoint `error` field, which is
 * a STRING for most providers but an OBJECT (`{ type, message }`) for Anthropic.
 * Prefers a top-level `error_description`, then for an object error its `message`
 * (or nested `error_description`), then the string itself, finally a JSON dump —
 * so the Error message is never the useless `"[object Object]"`.
 */
function errorMessage(error: unknown, errorDescription: string | undefined): string {
  if (errorDescription) return errorDescription;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const e = error as { message?: unknown; error_description?: unknown };
    if (typeof e.message === 'string' && e.message) return e.message;
    if (typeof e.error_description === 'string' && e.error_description) {
      return e.error_description;
    }
    return JSON.stringify(error);
  }
  return String(error);
}

/**
 * POST a `x-www-form-urlencoded` body and parse the JSON response (UTF-8 body
 * accumulation → `JSON.parse` → `data.error` reject → parse-failure reject) over
 * an injected `FetchLike`. `parseErrorMessage` is the per-method catch string.
 */
export async function postForm(
  fetchImpl: FetchLike,
  url: string,
  params: URLSearchParams,
  parseErrorMessage: string,
): Promise<TokenResponseBody> {
  // Mirror `net.request({ method:'POST' })` + `setHeader('Content-Type', …)` +
  // `req.write(params.toString())`. The response body is read as a single UTF-8
  // string (parity with `responseData += chunk.toString()`), then parsed.
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const responseData = await response.text();

  let data: TokenResponseBody;
  try {
    data = JSON.parse(responseData) as TokenResponseBody;
  } catch {
    // Matches the helper's `catch { reject(new Error('Failed to parse …')) }`.
    throw new Error(parseErrorMessage);
  }

  if (data.error) {
    // Object-safe: string errors → `error_description || error` (verbatim legacy
    // behavior); object errors (Anthropic `{ type, message }`) → the real message
    // instead of `"[object Object]"`.
    throw new Error(errorMessage(data.error, data.error_description));
  }

  return data;
}

/**
 * POST a JSON body and parse the JSON response. Same response-parse + object-safe
 * error semantics as `postForm`, but sends `Content-Type: application/json` with a
 * JSON-serialized body and any caller-supplied `extraHeaders`.
 *
 * Claude's OAuth token endpoint is fronted by Cloudflare and rejects requests
 * that don't look like the official `claude-cli` (it expects a JSON body +
 * `claude-cli` User-Agent + claude.ai Referer/Origin — see the claude flow's
 * `CLAUDE_TOKEN_HEADERS`). The shared `postForm` (form-encoded, no UA) gets a 403
 * "Request not allowed". The other providers (codex/gemini) keep using `postForm`.
 */
export async function postJson(
  fetchImpl: FetchLike,
  url: string,
  body: Record<string, unknown>,
  parseErrorMessage: string,
  extraHeaders: Record<string, string> = {},
): Promise<TokenResponseBody> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });

  const responseData = await response.text();

  let data: TokenResponseBody;
  try {
    data = JSON.parse(responseData) as TokenResponseBody;
  } catch {
    throw new Error(parseErrorMessage);
  }

  if (data.error) {
    throw new Error(errorMessage(data.error, data.error_description));
  }

  return data;
}
