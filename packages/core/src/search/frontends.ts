/**
 * Per-frontend search execution modes (plan 阶段5, hard constraint 6).
 *
 * Three protocol frontends can reach search — Codex `/v1/alpha/search`, OpenAI
 * Responses, and Anthropic Messages — and each of them independently answers
 * ONE question: who executes the search?
 *
 * - `native`   — the UPSTREAM executes it. Omnicross injects/relays and touches
 *                nothing else; the wire stays whatever the provider produced.
 * - `managed`  — OMNICROSS executes it through {@link SearchRuntime} and
 *                synthesizes protocol-compatible output.
 * - `off`      — the capability is not offered: a structured
 *                `unsupported_capability` error, never a bare 404 (plan §15).
 *
 * **Native and managed are never mixed on one wire exchange.** That is a plan
 * hard constraint, and this module is how it is made structural rather than
 * conventional: a request resolves its mode ONCE, before any wire bytes, and
 * the two lanes downstream share no emission code. A helper that "falls back
 * from native to managed" (or the reverse) would defeat the whole arrangement,
 * so no such helper exists here and none should be added.
 *
 * The defaults preserve today's behavior exactly: Responses and Anthropic keep
 * their existing native relay, and Codex is `off` — which is the one deliberate
 * visible change in this change set, since `off` answers with a structured
 * error where the router previously answered a generic 404.
 *
 * Pure vocabulary: no IO, no provider imports, no runtime. That is what lets
 * `outbound-api` and `provider-proxy` both import it without dragging jsdom or
 * undici into their module graphs.
 *
 * @module search/frontends
 */

import type { SearchErrorCode } from '@omnicross/contracts/search-types';

/** Who executes a search for one protocol frontend. */
export type SearchFrontendMode = 'native' | 'managed' | 'off';

/** The protocol frontends that can reach search. */
export type SearchFrontendName = 'codex' | 'responses' | 'anthropic';

/** The resolved mode of every frontend. Total — every frontend always has one. */
export type SearchFrontendModes = {
  readonly [K in SearchFrontendName]: SearchFrontendMode;
};

/** Every frontend name, in the order configuration and doctor print them. */
export const SEARCH_FRONTEND_NAMES: readonly SearchFrontendName[] = Object.freeze([
  'codex',
  'responses',
  'anthropic',
]);

/** Every mode value, for validation messages and exhaustiveness. */
export const SEARCH_FRONTEND_MODES: readonly SearchFrontendMode[] = Object.freeze([
  'native',
  'managed',
  'off',
]);

/**
 * The behavior-preserving defaults.
 *
 * `codex: 'off'` is not "search disabled" — the route exists and answers with a
 * structured `unsupported_capability`. It is off because the Codex request and
 * response schemas are UNVERIFIED (see `docs/design/search-baseline/wire-baseline.md`
 * §1.2/§1.3); enabling it is a deliberate operator decision.
 */
export const DEFAULT_SEARCH_FRONTEND_MODES: SearchFrontendModes = Object.freeze({
  codex: 'off',
  responses: 'native',
  anthropic: 'native',
});

/**
 * The stable error code every frontend uses when its mode is `off`.
 *
 * Plan §15: a frontend may close managed search, but it must then say
 * `unsupported_capability` — it must never keep exposing an unimplemented route
 * as a 404. The string is shared so the three frontends cannot drift apart.
 */
export const SEARCH_UNSUPPORTED_CAPABILITY_CODE = 'unsupported_capability';

/**
 * HTTP status for a search-taxonomy failure surfaced by a protocol frontend.
 *
 * The mapping answers "whose problem is it?" rather than "which code is it?":
 * a client can act on 429 and 504; everything that failed on OUR side of the
 * wire — a provider that broke, a policy that refused, a config we lack — is a
 * 502-class fact about the gateway's upstream, not a fault in the request the
 * client sent. The one 4xx here is `cancelled`, which is 499 because the client
 * itself hung up.
 */
export function searchErrorHttpStatus(code: SearchErrorCode): number {
  switch (code) {
    case 'rate_limited':
      return 429;
    case 'timeout':
      return 504;
    case 'cancelled':
      return 499;
    case 'config_missing':
      // Nothing was even attempted because nothing is configured — the gateway
      // is not ready to serve this, which is what 503 means.
      return 503;
    case 'auth_failed':
    case 'upstream_unavailable':
    case 'parse_failed':
    case 'policy_denied':
      return 502;
    default:
      return 502;
  }
}

/** Whether `value` is one of the three modes. */
export function isSearchFrontendMode(value: unknown): value is SearchFrontendMode {
  return typeof value === 'string' &&
    (SEARCH_FRONTEND_MODES as readonly string[]).includes(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Read modes tolerantly: an unusable member falls back to its default rather
 * than throwing, so a malformed config never takes the daemon down.
 *
 * Use {@link validateSearchFrontendModes} to REPORT what was unusable — the two
 * run side by side exactly as the images config's tolerant read and strict
 * validation do.
 */
export function normalizeSearchFrontendModes(value: unknown): SearchFrontendModes {
  const raw = record(value) ?? {};
  const modes: { -readonly [K in SearchFrontendName]: SearchFrontendMode } = {
    ...DEFAULT_SEARCH_FRONTEND_MODES,
  };
  for (const name of SEARCH_FRONTEND_NAMES) {
    const candidate = raw[name];
    if (isSearchFrontendMode(candidate)) modes[name] = candidate;
  }
  return Object.freeze(modes);
}

/**
 * Structured validation errors, naming the offending FIELD.
 *
 * The rejected VALUE is never echoed, only its type. A mode is not a secret,
 * but a secret pasted into the wrong field is still a secret, and a validator
 * that quotes whatever it was handed is one misconfiguration away from putting
 * it in a log. Same no-echo rule as the images config validator.
 */
export function validateSearchFrontendModes(value: unknown, path = '$.search.modes'): string[] {
  if (value === undefined) return [];
  const raw = record(value);
  if (!raw) return [`${path}: expected an object`];
  const errors: string[] = [];
  for (const [key, candidate] of Object.entries(raw)) {
    if (!(SEARCH_FRONTEND_NAMES as readonly string[]).includes(key)) {
      errors.push(`${path}.${key}: unknown frontend (expected ${SEARCH_FRONTEND_NAMES.join(', ')})`);
      continue;
    }
    if (isSearchFrontendMode(candidate)) continue;
    errors.push(
      `${path}.${key}: not a mode (got ${typeof candidate}; expected ${SEARCH_FRONTEND_MODES.join(', ')})`,
    );
  }
  return errors;
}
