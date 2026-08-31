/**
 * claudeCodeHeaders — the Anthropic wire-protocol + Claude Code client headers
 * the CLAUDE SUBSCRIPTION relay must put on every upstream request.
 *
 * WHY THIS EXISTS: the subscription same-format relay used to send exactly
 * `content-type` + `Authorization`. Everything else was expected to arrive via
 * `applyFingerprint`, which is a strict no-op unless the (default-OFF)
 * subscription-client-fingerprint feature is enabled. So a stock install relayed
 * a Claude Code request to `api.anthropic.com` with NO `anthropic-version` — a
 * header the Messages API REQUIRES — and Anthropic answered
 * `400 anthropic-version: header is required`. `anthropic-beta` was missing too,
 * including `oauth-2025-04-20`, which an OAuth (subscription) token needs.
 *
 * The split this module draws:
 *  - PROTOCOL headers (`anthropic-version`, `anthropic-beta`) are NOT a
 *    fingerprint concern. They are required for the request to work at all, so
 *    they are applied UNCONDITIONALLY, independent of any feature flag.
 *  - CLIENT headers (UA / `x-app` / `x-stainless-*` / accept*) make the relayed
 *    request look like the real Claude Code client it came from. The caller's
 *    OWN values are forwarded when present; {@link DEFAULT_CLAUDE_CODE_HEADERS}
 *    fills what the caller did not send.
 *
 * Modeled on observed Claude Code-compatible proxy behavior.
 *
 * NOTE ON `sanitizeFrozenHeaders`/`applyFingerprint`: those own the per-account
 * FROZEN identity and still take precedence — this module only ever fills a slot
 * nothing else set (see `fillMissingHeaders`), so enabling the fingerprint
 * feature keeps behaving exactly as before.
 *
 * @module provider-proxy/identity/claudeCodeHeaders
 */

import {
  flattenHeaderValue,
  NEVER_FORWARD_HEADERS,
} from './headerMerge';

// Re-exported so the relay imports its whole header toolkit from one place.
export { fillMissingHeaders } from './headerMerge';

/**
 * The `anthropic-version` used when the caller sent none. Matches the value the
 * real Claude Code CLI sends.
 */
export const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';

/** Stable `anthropic-beta` flags used by Claude Code-compatible requests. */
const OAUTH_BETA = 'oauth-2025-04-20';
const CLAUDE_CODE_BETA = 'claude-code-20250219';
const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14';
const TOOL_STREAMING_BETA = 'fine-grained-tool-streaming-2025-05-14';

/**
 * Client headers a real Claude Code invocation carries. Used ONLY to fill a slot
 * the caller (and the frozen fingerprint) left empty — a forwarded real value
 * always wins. Mirrors `claudeCodeHeadersService.defaultHeaders`.
 *
 * `accept-encoding` is deliberately absent: it is forced to `identity` by the
 * relay (see `FORCED_ACCEPT_ENCODING`).
 */
export const DEFAULT_CLAUDE_CODE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'user-agent': 'claude-cli/1.0.119 (external, cli)',
  'x-app': 'cli',
  accept: 'application/json',
  'accept-language': '*',
  'sec-fetch-mode': 'cors',
  'anthropic-dangerous-direct-browser-access': 'true',
  'x-stainless-lang': 'js',
  'x-stainless-package-version': '0.55.1',
  'x-stainless-os': 'Windows',
  'x-stainless-arch': 'x64',
  'x-stainless-runtime': 'node',
  'x-stainless-runtime-version': 'v20.19.2',
  'x-stainless-retry-count': '0',
  'x-stainless-timeout': '60',
});

/**
 * Force `identity` so the upstream (Cloudflare) cannot answer with a
 * gzip/zstd-compressed body that carries no `Content-Encoding`. That case
 * silently corrupts a streamed response when the bytes are decoded as UTF-8
 * text. Known compatible relays avoid the ambiguity by forcing the same value.
 */
export const FORCED_ACCEPT_ENCODING = 'identity';

/**
 * Caller headers forwarded verbatim to Anthropic (positive allow-list, mirroring
 * `headerFilter.filterForClaude`). Auth/cookie/host/transport headers are absent
 * BY CONSTRUCTION — a name not listed here is never forwarded.
 *
 * `accept-encoding` is intentionally NOT forwarded: a client may ask for `zstd`,
 * which the relay cannot decode.
 */
const CLAUDE_FORWARD_ALLOWLIST: ReadonlySet<string> = new Set([
  'accept',
  'accept-language',
  'sec-fetch-mode',
  'user-agent',
  'x-app',
  'anthropic-dangerous-direct-browser-access',
  'anthropic-version',
]);

/** Header-name prefix carrying the SDK-runtime fingerprint (forwarded wholesale). */
const STAINLESS_PREFIX = 'x-stainless-';

/**
 * Extract the caller's forwardable Claude Code client headers (lowercased keys).
 * UNGATED — unlike `captureCallerIdentity` this does not consult the fingerprint
 * feature flag, because forwarding the client's OWN headers is not fingerprint
 * synthesis: it is passing along what the client actually sent.
 */
export function extractClaudeClientHeaders(
  reqHeaders: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawKey, rawVal] of Object.entries(reqHeaders)) {
    const key = rawKey.toLowerCase();
    if (NEVER_FORWARD_HEADERS.has(key)) continue;
    if (!CLAUDE_FORWARD_ALLOWLIST.has(key) && !key.startsWith(STAINLESS_PREFIX)) continue;
    const value = flattenHeaderValue(rawVal);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Build the outbound `anthropic-beta`: the model-appropriate baseline plus every
 * flag the caller asked for, de-duplicated, order-stable.
 *
 * `oauth-2025-04-20` is the load-bearing one on this path — the relay
 * authenticates with a subscription OAuth token, not an API key. Haiku gets a
 * reduced baseline (no claude-code / tool-streaming flags), matching observed
 * CLI-compatible behavior.
 */
export function buildAnthropicBeta(
  model: string | undefined,
  callerBeta: string | null | undefined,
): string {
  const isHaiku = typeof model === 'string' && model.toLowerCase().includes('haiku');
  const baseline = isHaiku
    ? [OAUTH_BETA, INTERLEAVED_THINKING_BETA]
    : [CLAUDE_CODE_BETA, OAUTH_BETA, INTERLEAVED_THINKING_BETA, TOOL_STREAMING_BETA];

  const seen = new Set<string>();
  const out: string[] = [];
  const add = (flag: string): void => {
    const trimmed = flag.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };

  baseline.forEach(add);
  if (callerBeta) callerBeta.split(',').forEach(add);
  return out.join(',');
}
