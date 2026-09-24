/**
 * Request Header Building Utilities
 *
 * Functions for building correct request headers based on provider format.
 */

import type { LLMProvider } from '@omnicross/contracts/llm-config';

import { applyOpenCodeUpstreamIdentity } from '../provider-proxy/identity/openCodeGoHeaders';
import { isOpenRouterProvider, OPENROUTER_APP_HEADERS } from '../openrouter';

import { resolveApiFormat } from './url-builder';

/**
 * Optional per-request inputs for {@link getProviderHeaders}'s opencode.ai
 * egress identity (opencodego-egress-identity, BYO half).
 */
export interface ProviderHeaderOptions {
  /**
   * The RESOLVED upstream URL for this request. Defaults to the provider row's
   * `api_base_url`. Only consulted for the opencode.ai host gate — a URL that
   * differs from the row base (an override) still gets the correct decision.
   */
  upstreamUrl?: string;
  /**
   * The preferred `x-opencode-session` value for an opencode.ai upstream: the
   * caller's own session id verbatim, or the relay's derived per-conversation
   * key. Absent/empty ⇒ the header is omitted (never an empty value).
   */
  openCodeSession?: string | null;
}

/**
 * Get request headers based on provider format
 */
export function getProviderHeaders(
  provider: LLMProvider,
  apiKey: string,
  opts?: ProviderHeaderOptions,
): Record<string, string> {
  const format = resolveApiFormat(provider);

  // Base headers by format
  let headers: Record<string, string>;
  switch (format) {
    case 'anthropic':
      headers = {
        'Content-Type': 'application/json',
        // Third-party Anthropic-Messages relays often gate on a Bearer token
        // rather than x-api-key; `provider.useBearer` opts into that.
        ...(provider.useBearer
          ? { Authorization: `Bearer ${apiKey}` }
          : { 'x-api-key': apiKey }),
        // Official documented version date (claude-api-protocol-fidelity, R5);
        // the former non-official future-dated value was removed. The BYO
        // same-format path additionally forwards the caller's own
        // `anthropic-version` verbatim when present (see `runSameFormatFetch`).
        'anthropic-version': '2023-06-01',
      };
      break;
    case 'google':
      headers = {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      };
      break;
    case 'azure-openai':
      headers = {
        'Content-Type': 'application/json',
        'api-key': apiKey,
      };
      break;
    case 'openai':
    case 'openai-response':
    default:
      headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      };
      break;
  }

  // Static per-provider identity headers (config-guarded — no auth/content
  // header names can appear here), then OpenRouter app attribution on top.
  const withExtra = mergeExtraHeaders(headers, provider.extraHeaders);
  const withOpenRouter = isOpenRouterProvider(provider)
    ? { ...withExtra, ...OPENROUTER_APP_HEADERS }
    : withExtra;

  // opencodego-egress-identity (BYO half): a provider row whose base URL points
  // at opencode.ai presents the same identity the OpenCodeGo relay does. Applied
  // AFTER the extraHeaders merge, fill-only, so a row-level `user-agent` /
  // `x-opencode-session` always wins; every other host is a strict no-op.
  applyOpenCodeUpstreamIdentity(
    withOpenRouter,
    opts?.upstreamUrl ?? provider.api_base_url,
    opts?.openCodeSession,
  );
  return withOpenRouter;
}

/**
 * Expand the `{{platform}}` placeholder in an extra-header value to the local
 * `process.platform` (a gateway may pin a per-OS identity header). The ONLY
 * supported placeholder — deliberately not a general template engine.
 */
export function expandHeaderPlaceholder(value: string): string {
  return value.includes('{{platform}}') ? value.replaceAll('{{platform}}', process.platform) : value;
}

/**
 * Header names an `extraHeaders` entry may NEVER take (matched
 * case-insensitively) — the SINGLE canonical list, shared with the daemon's
 * config write/load guards. Credentials come only from the key fields (the
 * masked secret spine), and body framing is the format funnel's job; the merge
 * below re-enforces the set so a value that bypassed a guard (hand-built
 * in-process row) still cannot override auth or framing.
 */
export const EXTRA_HEADER_RESERVED_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'api-key',
  'cookie',
  'content-type',
  'content-length',
]);

/**
 * Merge a provider's static `extraHeaders` over the format base, expanding
 * placeholders and re-enforcing the reserved-name set. `undefined`/empty (or a
 * fully-reserved map) returns the base unchanged.
 */
export function mergeExtraHeaders(
  base: Record<string, string>,
  extra: Record<string, string> | undefined,
): Record<string, string> {
  if (!extra) return base;
  const entries = Object.entries(extra);
  if (entries.length === 0) return base;
  const merged: Record<string, string> = { ...base };
  for (const [name, value] of entries) {
    if (EXTRA_HEADER_RESERVED_NAMES.has(name.toLowerCase())) continue;
    merged[name] = expandHeaderPlaceholder(value);
  }
  return merged;
}
