/**
 * openCodeGoHeaders — the outbound identity headers every OpenCodeGo
 * (`opencode.ai` zen/go) egress must carry.
 *
 * WHY THIS EXISTS: opencode.ai announced that tools hitting their API must (1)
 * identify themselves with a clear `user-agent` — a bare relay falls to Node's
 * default `node` UA, exactly the "too generic" shape their traffic monitoring
 * flags — and (2) send `x-opencode-session` so they can optimize prompt
 * caching. The OpenCodeGo relay previously sent neither: a downstream client's
 * own `x-opencode-session` was dropped at the ingress and nothing replaced it.
 *
 * The split this module draws (mirrors claudeCodeHeaders / codexCliHeaders):
 *  - `user-agent` is a LIBRARY-LEVEL identity, not a per-request client
 *    concern: an app embedding omnicross (elftia) configures it via the daemon
 *    config (`opencodego.userAgent`, wired at bootstrap through
 *    {@link setOpenCodeGoUserAgent}); absent a configuration the product
 *    default `omnicross/<version>` is sent. The downstream client's UA is
 *    deliberately NOT forwarded — every HTTP client sends one, so passthrough
 *    would relay generic `curl`/`node` values and hide the tool the
 *    announcement asks to identify.
 *  - `x-opencode-session` IS a per-request caller value: forwarded verbatim
 *    when the downstream client sent one (an OpenCode CLI does); otherwise the
 *    relay's own stable per-conversation session key stands in, so the
 *    upstream still sees a session-stable id for cache affinity.
 *
 * The header APPLICATION lives in the OpenCodeGo auth strategy
 * (`StaticBearerAuthStrategy`, the only consumer of these values' provider) —
 * the antigravity-User-Agent-in-applyHeaders precedent — plus the daemon's
 * usage collector for its background poll.
 *
 * @module provider-proxy/identity/openCodeGoHeaders
 */

import { flattenHeaderValue } from './headerMerge';

/**
 * Build-time injected workspace version (core tsup `define`, reading this
 * package's package.json — the `__DAEMON_VERSION__` pattern). A src run
 * (vitest / tsc) falls back to a dev sentinel.
 */
declare const __OMNICROSS_VERSION__: string | undefined;

/** The header opencode.ai reads to key prompt-cache session affinity. */
export const OPENCODE_SESSION_HEADER = 'x-opencode-session';

/** The configured library UA. `undefined` ⇒ the product default below. */
let configuredUserAgent: string | undefined;

/**
 * Set (or clear) the library-configured `user-agent` for OpenCodeGo egress.
 * Boot wiring only (the daemon's bootstrap passes the validated
 * `opencodego.userAgent` config field here); trimmed-empty / null / undefined
 * clears the slot back to the default. Idempotent — last write wins.
 */
export function setOpenCodeGoUserAgent(userAgent: string | null | undefined): void {
  const trimmed = typeof userAgent === 'string' ? userAgent.trim() : '';
  configuredUserAgent = trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The `user-agent` every OpenCodeGo egress carries: the configured value,
 * else `omnicross/<workspace version>`. Never returns an empty string.
 */
export function getOpenCodeGoUserAgent(): string {
  if (configuredUserAgent) return configuredUserAgent;
  const version = typeof __OMNICROSS_VERSION__ === 'string' ? __OMNICROSS_VERSION__ : '0.0.0-dev';
  return `omnicross/${version}`;
}

/**
 * Extract the caller's `x-opencode-session` from a raw request header bag
 * (case-insensitive key lookup; a duplicate header is flattened to one joined
 * value). Absent / empty / whitespace-only ⇒ `undefined` (treated as "the
 * client did not send one").
 */
export function extractOpenCodeSessionHeader(
  reqHeaders: Record<string, string | string[] | undefined>,
): string | undefined {
  // Node preserves the RAW header casing the client sent, so match
  // case-insensitively by iterating the bag (the extractClaudeClientHeaders
  // idiom), not by a fixed key lookup.
  for (const [rawKey, rawVal] of Object.entries(reqHeaders)) {
    if (rawKey.toLowerCase() !== OPENCODE_SESSION_HEADER) continue;
    const value = flattenHeaderValue(rawVal);
    if (value === undefined) continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

/**
 * Resolve the outbound `x-opencode-session` VALUE (not the header itself):
 * the caller-supplied session wins verbatim; otherwise the relay's stable
 * per-conversation session key stands in; neither present ⇒ `undefined`
 * (the header is omitted entirely — never send an empty value).
 *
 * NOTE the two session-key derivations that feed `sessionKey` on the live
 * paths: the Anthropic ingress hashes the body anchor (`system` + first user
 * message, FNV-1a 8-hex) and the Responses ingress hashes header-aware ids
 * (SHA-256 32-hex). Both are stable, non-sensitive per-conversation digests —
 * a conversation that crosses ingresses presents two values, which is
 * acceptable for the upstream's cache-affinity purpose.
 */
export function resolveOpenCodeSessionHeader(
  callerSession: string | null | undefined,
  sessionKey?: string,
): string | undefined {
  const caller = typeof callerSession === 'string' ? callerSession.trim() : '';
  if (caller.length > 0) return caller;
  if (typeof sessionKey === 'string' && sessionKey.trim().length > 0) return sessionKey;
  return undefined;
}

/** TEST SEAM — clear the configured UA slot so a suite starts from the default. */
export function __resetOpenCodeGoHeadersForTests(): void {
  configuredUserAgent = undefined;
}
