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
 *    id parsed out of the OAuth `id_token`. Guessing it wrong risks a 403 on a
 *    path that currently works, so it is left to a follow-up that can verify it.
 *  - forcing `store: false` on the body: a body mutation with its own regression
 *    surface, tracked separately.
 *
 * @module provider-proxy/identity/codexCliHeaders
 */

import {
  flattenHeaderValue,
  NEVER_FORWARD_HEADERS,
} from './headerMerge';

export { fillMissingHeaders } from './headerMerge';

/**
 * Client markers a real `codex` CLI invocation carries. Used ONLY to fill a slot
 * the caller left empty — a forwarded real value always wins, so a genuine Codex
 * CLI keeps its own identity and only a caller that sent nothing gets these.
 *
 * `originator` is the load-bearing one: it is how the backend tells the Codex
 * CLI apart from a generic Responses client, so compatible relays send it
 * unconditionally.
 */
export const DEFAULT_CODEX_CLI_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  originator: 'codex_cli_rs',
  'user-agent': 'codex_cli_rs/0.144.5',
  version: '0.144.5',
});

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
