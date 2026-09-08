/**
 * @omnicross/subscriptions/oauth — host-clean OAuth flow logic, usable by a
 * desktop host (a thin wrapper injecting an electron-net fetch) or the daemon
 * (`omnicross login` + real token refresh, injecting global `fetch`).
 *
 * Each provider's pure flow functions live in `flows/<provider>.ts`; this barrel
 * re-exports them under per-provider namespaces so consumers do
 * `claudeOAuth.exchangeCodeForTokens(req, fetch)`. The injected `FetchLike` port
 * (reused from `@omnicross/core`) is re-exported here as the single import
 * source. NO `electron` / host imports anywhere under `oauth/`.
 *
 * @module @omnicross/subscriptions/oauth
 */

export type { FetchLike } from './fetchPort';
export { COPILOT_GITHUB_HEADERS } from './flows/copilot';
export { kimiFingerprintHeaders } from './flows/kimi';
export * as antigravityOAuth from './flows/antigravity';
export * as claudeOAuth from './flows/claude';
export * as codexOAuth from './flows/codex';
export * as geminiOAuth from './flows/gemini';
export * as kimiOAuth from './flows/kimi';
export * as grokOAuth from './flows/grok';
export * as copilotOAuth from './flows/copilot';
