/**
 * fingerprintHeaders — the PURE half of subscription client-fingerprint replay
 * (subscription-client-fingerprint #7, design D2/D3/D4/D7).
 *
 * Holds ONLY pure functions (no state, no store): the capture WHITELIST
 * (`extractFingerprintHeaders`), the store-normalizer (`sanitizeFrozenHeaders`),
 * the TTL refresh split (`refreshNonStainless`), the outbound merge
 * (`mergeFrozenIdentity`), and the one composition entrypoint the relay calls
 * (`applyFingerprint`, which takes the store INSTANCE as a parameter so this file
 * never imports the store at runtime — no cycle).
 *
 * SAFETY CORE (non-negotiable):
 *  - The capture whitelist is POSITIVE (`x-stainless-*` + a small set of
 *    Claude-Code / Anthropic-SDK header names) AND has an explicit EXCLUSION of
 *    `authorization` / `x-api-key` / `cookie` (the token/secret) — belt AND
 *    suspenders, so widening the whitelist can never leak auth.
 *  - The outbound merge NEVER overwrites `authorization` / `content-type`
 *    (the auth strategy owns auth; content-type is fixed) and never overwrites a
 *    header the outbound build already set (case-insensitive).
 *  - Values are only ever REAL captured client headers — nothing here fabricates
 *    a `x-stainless-*` value. The only synthesizable pieces are the operator-set
 *    UA baseline, applied in `applyFingerprint` ONLY when NOTHING was captured,
 *    and the claude-cli version FLOOR (`floorClaudeCliUserAgent`): on replay a
 *    `claude-cli/X.Y.Z` UA strictly older than the floor has its version segment
 *    raised (never lowered, never a non-claude-cli UA) — the ONE deliberate
 *    departure from byte-honest replay, because Anthropic's per-model
 *    client-version gates would otherwise reject a stale frozen identity forever.
 *
 * @module provider-proxy/identity/fingerprintHeaders
 */

import type { SubscriptionIdentityStore } from './SubscriptionIdentityStore';

/** Header-name prefix that marks a stainless (SDK-runtime) fingerprint header. */
export const STAINLESS_PREFIX = 'x-stainless-';

/**
 * The built-in `claude-cli` version floor applied to REPLAYED identity
 * user-agents (claude-cli-version-floor). Anthropic enforces PER-MODEL
 * client-version minimums keyed off the relayed `user-agent` (e.g. a model
 * requiring `claude-cli >= 2.1.280` answers
 * `Claude Code X.Y.Z does not support this model; version A.B.C or newer is
 * required` — surfaced by the CLI as an "upgrade required" prompt). A frozen
 * fingerprint captured with an older CLI would fail that gate FOREVER (the
 * 7-day TTL refresh only helps once a newer client actually flows through the
 * account), so on replay the claude-cli version is RAISED to this floor —
 * never lowered. Operator-raisable via `fingerprint.minCliVersion`.
 */
export const DEFAULT_CLAUDE_CLI_VERSION_FLOOR = '2.1.280';

/** `claude-cli/2.1.280 (external, cli)` — product, three-part version, suffix. */
const CLAUDE_CLI_UA_REGEX = /^claude-cli\/(\d+)\.(\d+)\.(\d+)(.*)$/;

/**
 * Strict three-part numeric semver ("2.1.280"): no `v` prefix, no omitted
 * segments, no prerelease/build suffix. The SAME predicate gates the operator
 * `fingerprint.minCliVersion` override at config-normalize AND at store
 * configure, so an invalid value can never become the replay floor (a floor
 * like "2.1.x" would rewrite every frozen UA to a nonexistent client version).
 */
export function isValidCliSemver(version: string | undefined | null): boolean {
  return typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version.trim());
}

/** Numeric triple compare: -1 / 0 / +1. An unparsable value compares as 0.0.0. */
export function compareCliSemver(a: string, b: string): number {
  const parse = (v: string): [number, number, number] => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  };
  const [a1, a2, a3] = parse(a);
  const [b1, b2, b3] = parse(b);
  return a1 - b1 || a2 - b2 || a3 - b3;
}

/**
 * Raise a `claude-cli/X.Y.Z` user-agent's version to `floor` when it is
 * strictly older — NEVER lower, and never touch a non-claude-cli UA (the
 * operator baseline may name another product) or an absent one. The product
 * name and suffix (` (external, cli)` etc.) are preserved verbatim, so the
 * rewritten UA stays a shape the real client plausibly sent. Returns
 * `undefined` for a UA the floor does not apply to.
 */
export function floorClaudeCliUserAgent(
  ua: string | undefined,
  floor: string,
): { ua: string; changed: boolean } | undefined {
  if (typeof ua !== 'string') return undefined;
  const match = CLAUDE_CLI_UA_REGEX.exec(ua);
  if (!match) return undefined;
  const [, maj, min, patch, suffix] = match;
  if (compareCliSemver(`${maj}.${min}.${patch}`, floor) >= 0) {
    return { ua, changed: false };
  }
  return { ua: `claude-cli/${floor}${suffix}`, changed: true };
}

/**
 * Floor the `user-agent` in an outbound header bag IN PLACE (case-insensitive
 * lookup; the original key spelling is preserved). No-op for a bag with no
 * user-agent or a non-claude-cli one.
 */
function applyUserAgentFloor(headers: Record<string, string>, floor: string): void {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'user-agent');
  if (!key) return;
  const floored = floorClaudeCliUserAgent(headers[key], floor);
  if (floored?.changed) headers[key] = floored.ua;
}

/**
 * Positive whitelist of NON-stainless fingerprint header names a real Claude Code
 * / Anthropic-SDK client sends (all lowercased). `x-stainless-*` is matched by
 * PREFIX separately. Deliberately excludes anything token-bearing.
 */
const FINGERPRINT_HEADER_NAMES = new Set<string>([
  'user-agent',
  'anthropic-beta',
  'anthropic-version',
  'anthropic-dangerous-direct-browser-access',
  'x-app',
]);

/**
 * Headers that must NEVER be captured/frozen/replayed — the token/secret set.
 * Enforced at BOTH capture (`extractFingerprintHeaders`) and store-normalize
 * (`sanitizeFrozenHeaders`), so a value in this set can never enter the store no
 * matter how it arrived.
 */
const EXCLUDED_HEADER_NAMES = new Set<string>([
  'authorization',
  'x-api-key',
  'cookie',
  'proxy-authorization',
  'set-cookie',
]);

/**
 * Outbound headers the identity merge must NEVER overwrite — the auth strategy
 * owns `authorization`; `content-type` is fixed for the relay body.
 */
const PROTECTED_OUTBOUND = new Set<string>(['authorization', 'content-type']);

/** Whether a header name (any case) is a stainless fingerprint header. */
export function isStainless(name: string): boolean {
  return name.toLowerCase().startsWith(STAINLESS_PREFIX);
}

/**
 * Capture: extract the WHITELISTED fingerprint headers from an incoming client
 * request's header bag (`http.IncomingHttpHeaders`-shaped). Array values (rare —
 * duplicate headers) are joined with `, `. Keys are lowercased. The auth/secret
 * exclusion is applied FIRST so it wins over any whitelist entry. Never throws.
 */
export function extractFingerprintHeaders(
  reqHeaders: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawKey, rawVal] of Object.entries(reqHeaders)) {
    if (rawVal === undefined) continue;
    const key = rawKey.toLowerCase();
    if (EXCLUDED_HEADER_NAMES.has(key)) continue;
    const whitelisted = FINGERPRINT_HEADER_NAMES.has(key) || key.startsWith(STAINLESS_PREFIX);
    if (!whitelisted) continue;
    const value = Array.isArray(rawVal) ? rawVal.filter((v) => typeof v === 'string').join(', ') : rawVal;
    if (typeof value === 'string' && value.length > 0) out[key] = value;
  }
  return out;
}

/**
 * Ingress capture gate (subscription-client-fingerprint #7): extract the caller's
 * fingerprint headers ONLY when replay is enabled — returns `undefined` when
 * disabled so the ingress does NO extraction work on the default/BYO path (and
 * threads nothing to the relay). Behavior when enabled is identical to calling
 * `extractFingerprintHeaders` directly.
 */
export function captureCallerIdentity(
  store: SubscriptionIdentityStore,
  reqHeaders: Record<string, string | string[] | undefined>,
): Record<string, string> | undefined {
  if (!store.isEnabled()) return undefined;
  return extractFingerprintHeaders(reqHeaders);
}

/**
 * Store-normalize a header bag before freezing/seeding: lowercase keys, drop
 * empty/non-string values, and HARD-EXCLUDE the auth/secret + protected-outbound
 * sets. This is the second line of defense (after the capture whitelist) so a
 * persisted/seeded identity can never carry a token even if a bad bag was handed
 * in. Idempotent.
 */
export function sanitizeFrozenHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v !== 'string' || v.length === 0) continue;
    const lower = k.toLowerCase();
    if (EXCLUDED_HEADER_NAMES.has(lower) || PROTECTED_OUTBOUND.has(lower)) continue;
    out[lower] = v;
  }
  return out;
}

/**
 * TTL refresh split (P2, piece 2): produce the refreshed frozen set when a newer
 * real capture is observed after the CC-header TTL. The STAINLESS set stays
 * frozen-stable (only the original values survive — a real client keeps a stable
 * stainless identity); the NON-stainless headers (user-agent / anthropic-beta /
 * x-app / …) are refreshed from the newer observation, falling back to the frozen
 * value when the new bag omits one. New stainless headers in the incoming bag are
 * IGNORED (stainless never grows/changes after the first freeze).
 */
export function refreshNonStainless(
  frozen: Record<string, string>,
  incoming: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  // Stainless: keep the original frozen values verbatim.
  for (const [k, v] of Object.entries(frozen)) {
    if (isStainless(k)) out[k] = v;
  }
  // Non-stainless: prefer the fresh observation, else the frozen value.
  const nonStainlessKeys = new Set<string>();
  for (const k of Object.keys(frozen)) if (!isStainless(k)) nonStainlessKeys.add(k);
  for (const k of Object.keys(incoming)) if (!isStainless(k)) nonStainlessKeys.add(k);
  for (const k of nonStainlessKeys) {
    const v = incoming[k] ?? frozen[k];
    if (typeof v === 'string' && v.length > 0) out[k] = v;
  }
  return out;
}

/**
 * Merge a frozen identity into the outbound `headers` in place. NEVER overwrites
 * `authorization` / `content-type`, and never overwrites a header already present
 * (case-insensitive) — so a header the auth strategy or the relay already set
 * always wins. The identity keys are already lowercased (`sanitizeFrozenHeaders`).
 */
export function mergeFrozenIdentity(
  headers: Record<string, string>,
  identity: Record<string, string>,
): void {
  const present = new Set(Object.keys(headers).map((k) => k.toLowerCase()));
  for (const [k, v] of Object.entries(identity)) {
    const lower = k.toLowerCase();
    if (PROTECTED_OUTBOUND.has(lower)) continue;
    if (present.has(lower)) continue;
    headers[k] = v;
  }
}

/**
 * The ONE composition entrypoint the claude same-format relay calls, AFTER
 * `applyHeaders` reported the selected account and BEFORE `fetchUpstream`.
 *
 * Disabled (default) OR no account id ⇒ a strict no-op — the `headers` object is
 * left BYTE-IDENTICAL (the zero-regression guarantee). When enabled:
 *  1. capture the caller's real fingerprint headers for this account (first-seen
 *     freeze; P2 TTL refresh) — per-account, keyed by the reported account id;
 *  2. replay the frozen identity for the account into `headers` (never
 *     overwriting auth/content-type). On the FIRST request this is the client's
 *     own just-captured headers (honest); later requests replay the frozen set;
 *  3. if NOTHING is captured for the account, apply ONLY the operator-configured
 *     UA baseline (never a fabricated stainless value).
 */
export function applyFingerprint(
  store: SubscriptionIdentityStore,
  headers: Record<string, string>,
  providerId: string,
  accountId: string | undefined,
  callerIdentity: Record<string, string> | undefined,
  now?: number,
): void {
  if (!store.isEnabled() || !accountId) return;
  if (callerIdentity) store.capture(providerId, accountId, callerIdentity, now);
  const identity = store.replay(providerId, accountId);
  if (identity) {
    mergeFrozenIdentity(headers, identity);
    // claude-cli-version-floor: raise a stale frozen UA past Anthropic's
    // per-model client-version gates (never lowered; see the constant).
    applyUserAgentFloor(headers, store.cliVersionFloor());
    return;
  }
  // Never captured → NO fabricated stainless. The ONLY synthesizable piece is the
  // operator UA baseline (a plausible stable UA is safer than a bare one).
  const ua = store.uaBaseline();
  if (ua) {
    mergeFrozenIdentity(headers, { 'user-agent': ua });
    applyUserAgentFloor(headers, store.cliVersionFloor());
  }
}
