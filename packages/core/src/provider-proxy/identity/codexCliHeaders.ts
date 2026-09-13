/**
 * codexCliHeaders — the Codex CLI client headers the CODEX SUBSCRIPTION relay
 * puts on every `chatgpt.com/backend-api/codex/responses` request.
 *
 * WHY THIS EXISTS: like the claude relay, this path sent exactly `content-type`
 * + `Authorization` (verified against a live `upstream-trace.jsonl`). Unlike the
 * claude one it still got a 200 — ChatGPT's Codex backend does not currently
 * reject a bare request — but the relayed call carried NONE of the markers a
 * real `codex` CLI sends (`originator`, its UA, `version`, `openai-beta`,
 * `session_id`), which is exactly the shape risk-control looks at.
 *
 * SCOPE: applied ONLY to the codex SUBSCRIPTION plan (`proxyProviderId ===
 * 'codex'`, i.e. an OAuth ChatGPT account). A BYO OpenAI-compatible endpoint
 * shares this relay and must stay byte-identical — sending it `originator:
 * codex_cli_rs` would be wrong and could trip its own checks.
 *
 * Modeled on observed Codex CLI-compatible relay behavior.
 *
 * NOT DONE HERE (deliberate, see the relay call site):
 *  - `chatgpt-account-id`: compatible implementations send the ChatGPT account
 *    id parsed out of the OAuth `id_token`. Verified 2026-09-12 against the
 *    live backend: the header is NOT required (a request without it authorizes
 *    fine), so it stays omitted — sending a guessed id risks a 403.
 *  - forcing `store: false` on the body: DONE since 2026-09-12 in the driver's
 *    `applyPlanAuth` — the backend now 400s any /codex/responses call without
 *    it (`{"detail":"Store must be set to false"}`).
 *
 * @module provider-proxy/identity/codexCliHeaders
 */

import {
  fillMissingHeaders,
  flattenHeaderValue,
  NEVER_FORWARD_HEADERS,
} from './headerMerge';

export { fillMissingHeaders };

/**
 * Client markers a real `codex` CLI invocation carries. This is the COMPLETE
 * synthetic persona spread onto a caller that brought NO identity of its own
 * (no `user-agent`) — originator + a coherent (user-agent, version) pair.
 *
 * NEVER applied under a caller's own `user-agent`: see
 * `fillMissingCodexCliIdentity` for why a fabricated `version` there is not
 * merely cosmetic but a hard failure.
 *
 * The pinned version is a floor for anonymous traffic only and WILL drift from
 * the real CLI — acceptable because the backend's per-model minimum-version
 * gate is the one place it matters, and an absent `version` passes that gate.
 */
export const DEFAULT_CODEX_CLI_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  originator: 'codex_cli_rs',
  'user-agent': 'codex_cli_rs/0.153.4',
  version: '0.153.4',
});

/**
 * The always-safe marker: how the backend tells the Codex CLI apart from a
 * generic Responses client. Filled for EVERY codex-subscription caller, real
 * client or not — compatible relays send it unconditionally.
 */
export const CODEX_ORIGINATOR_MARKER: Readonly<Record<string, string>> = Object.freeze({
  originator: 'codex_cli_rs',
});

/**
 * Fill the codex client-identity markers a caller left empty — WITHOUT ever
 * fabricating a `version` under a caller that brought its own `user-agent`.
 *
 * WHY THE SPLIT (2026-09 incident): the ChatGPT backend gates newer models on
 * the request's client `version` header — `gpt-6-astra` answered a relayed
 * `version: 0.144.5` with
 *   `The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade…`
 * even though the caller WAS the latest CLI (0.153.4): the Codex CLI only
 * attaches its `version` header to the BUILT-IN openai provider, so a custom
 * provider (this relay) arrives without one, and the old unconditional fill
 * pinned a stale number under the caller's real UA. A caller that omits
 * `version` goes WITHOUT one — the exact shape compatible relays send and the
 * anthropic-path egress has always used, which the backend accepts.
 *
 * So: real client (own `user-agent`) ⇒ originator only; anonymous caller ⇒
 * the full coherent persona above.
 */
export function fillMissingCodexCliIdentity(headers: Record<string, string>): void {
  const callerHasUserAgent = Object.keys(headers).some(
    (key) => key.toLowerCase() === 'user-agent',
  );
  fillMissingHeaders(headers, callerHasUserAgent ? CODEX_ORIGINATOR_MARKER : DEFAULT_CODEX_CLI_HEADERS);
}

/**
 * Caller headers forwarded verbatim to the Codex backend (positive allow-list,
 * matching the verified Codex relay allow-list plus the client identity markers).
 * Auth/cookie/host are excluded BY CONSTRUCTION.
 */
const CODEX_FORWARD_ALLOWLIST: ReadonlySet<string> = new Set([
  'version',
  'openai-beta',
  'session_id',
  'originator',
  'user-agent',
]);

/**
 * Extract the caller's forwardable Codex CLI headers (lowercased keys). Ungated:
 * passing along what the client actually sent is not fingerprint synthesis.
 */
export function extractCodexClientHeaders(
  reqHeaders: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawKey, rawVal] of Object.entries(reqHeaders)) {
    const key = rawKey.toLowerCase();
    if (NEVER_FORWARD_HEADERS.has(key)) continue;
    if (!CODEX_FORWARD_ALLOWLIST.has(key)) continue;
    const value = flattenHeaderValue(rawVal);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** The `accept` a Codex CLI sends, which differs by streaming mode. */
export function codexAcceptHeader(isStream: boolean): string {
  return isStream ? 'text/event-stream' : 'application/json';
}
