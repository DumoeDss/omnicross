/**
 * accountsAntigravityOAuth — the daemon admin API's ANTIGRAVITY interactive
 * OAuth path (`POST /accounts/antigravity/oauth/start` +
 * `GET /accounts/antigravity/oauth/:sessionId/status`).
 *
 * Modeled on the codex loopback flow (`accountsCodexOAuth`): antigravity's
 * redirect is a FIXED loopback `http://127.0.0.1:51121/oauth-callback`, so the
 * flow is ASYNC + POLLED — `start` arms the one-shot loopback listener, kicks
 * the capture→exchange→email→project-handshake→persist chain off ASYNC, and
 * returns ONLY `{ authUrl, sessionId }` (public — client_id + state). The app
 * opens `authUrl`; the browser redirects to the loopback; the daemon captures
 * the `code`, validates `state`, exchanges it, resolves the userinfo email and
 * the Code Assist project (the antigravity dialect of the shared resolver),
 * and persists the minted token through the encrypted credential store. The
 * app POLLS `status` until `done`/`error`.
 *
 * SECRET SPINE (same invariant as codex/grok): the minted access/refresh token
 * NEVER crosses to the client — it lands ONLY in the encrypted store. The
 * poll `status` body is TOKEN-FREE (`{ state, message? }`). Port 51121 is a
 * single resource → only ONE antigravity sign-in may be in flight (409).
 *
 * REUSES the `@omnicross/subscriptions` antigravity flow + the CLI's
 * `awaitLoopbackCode` listener (parameterized binding) — it does NOT rebuild
 * the authorize/exchange/handshake logic.
 *
 * @module @omnicross/daemon/admin/accountsAntigravityOAuth
 */

import type { AntigravityTokenConfig } from '@omnicross/contracts/account-tokens-types';
import { getAntigravityProjectResolver } from '@omnicross/core/auth/GeminiCodeAssistProjectResolver';
import { antigravityOAuth, type FetchLike } from '@omnicross/subscriptions';

import type { OAuthHandlerResult, SubscriptionAccountAppender } from './accountsOAuth';
import { CodexOAuthSessionStore } from './accountsCodexOAuth';

export { CodexOAuthSessionStore as AntigravityOAuthSessionStore };

/** The loopback-listener fn (injected so tests need not bind a real port). */
export type AntigravityLoopbackFn = (
  state: string,
  timeoutMs?: number,
  signal?: AbortSignal,
) => Promise<string>;

/** The deps the antigravity OAuth handlers need (a subset of `AdminApiDeps`). */
export interface AntigravityOAuthDeps {
  readonly antigravitySessions: CodexOAuthSessionStore;
  readonly antigravityAwaitLoopback: AntigravityLoopbackFn;
  /** Per-provider token-exchange fetch factory (see `AccountsOAuthDeps`). */
  readonly oauthExchangeFetch: (providerId: 'antigravity') => FetchLike;
  readonly subscriptionAccountAppender: SubscriptionAccountAppender;
}

function err(status: number, message: string): OAuthHandlerResult {
  return { status, body: { error: { type: 'admin_api_error', message } } };
}

/** Default flow TTL (matches the loopback listener's 5-min wait + slack). */
export const DEFAULT_ANTIGRAVITY_OAUTH_TTL_MS = 10 * 60_000;

/**
 * `start` — build the antigravity authorize params, arm the loopback listener
 * async, return ONLY `{ authUrl, sessionId }`. Rejects (409) when an
 * antigravity sign-in is already in flight (the single loopback port is held).
 */
export function handleAntigravityOAuthStart(deps: AntigravityOAuthDeps): OAuthHandlerResult {
  if (deps.antigravitySessions.isBusy()) {
    return err(
      409,
      'an antigravity sign-in is already in progress (loopback 127.0.0.1:51121 is held) — finish it in the browser or wait for it to time out',
    );
  }
  const { authUrl, state } = antigravityOAuth.generateAuthParams();
  const { sessionId, signal } = deps.antigravitySessions.begin();
  // Arm the loopback ASYNC (fire-and-forget). The token NEVER crosses to the
  // client — captured + exchanged + persisted entirely daemon-side; the app POLLS.
  void runAntigravityLoopback(sessionId, state, signal, deps);
  return { status: 200, body: { authUrl, sessionId } };
}

/** The async capture→exchange→email→project-handshake→persist chain. */
async function runAntigravityLoopback(
  sessionId: string,
  state: string,
  signal: AbortSignal,
  deps: AntigravityOAuthDeps,
): Promise<void> {
  const isPending = () => !signal.aborted && deps.antigravitySessions.get(sessionId)?.status === 'pending';
  try {
    const code = await deps.antigravityAwaitLoopback(state, undefined, signal);
    if (!isPending()) return;
    const exchangeFetch = deps.oauthExchangeFetch('antigravity');
    const result = await antigravityOAuth.exchangeCodeForTokens(code, exchangeFetch);
    if (!isPending()) return;
    const expiresAt = new Date(Date.now() + result.expiresIn * 1000).toISOString();
    // Best-effort display email — a failed userinfo read never fails the login.
    const email = await antigravityOAuth.fetchUserEmail(result.accessToken, exchangeFetch);
    // The antigravity project handshake (required — its envelope always carries
    // a project). A failed handshake settles the flow as an error.
    if (!isPending()) return;
    const projectId = await getAntigravityProjectResolver().resolveProject(result.accessToken);
    if (!isPending()) return;
    const block: AntigravityTokenConfig = {
      authMethod: 'oauth',
      status: 'authorized',
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresAt,
      ...(email ? { email } : {}),
      ...(projectId ? { projectId } : {}),
      lastRefreshedAt: new Date().toISOString(),
    };
    await deps.subscriptionAccountAppender.appendProviderAccount('antigravity', block);
    if (isPending()) deps.antigravitySessions.settle(sessionId, 'done');
  } catch (e) {
    if (!isPending()) return;
    // NEVER include a token — reference only the loopback/exchange/handshake failure.
    const reason = e instanceof Error ? e.message : 'antigravity sign-in failed';
    deps.antigravitySessions.settle(sessionId, 'error', reason);
  }
}

export function handleAntigravityOAuthCancel(
  sessionId: string,
  deps: AntigravityOAuthDeps,
): OAuthHandlerResult {
  if (!deps.antigravitySessions.cancel(sessionId)) {
    return err(404, 'unknown or expired antigravity sign-in session');
  }
  return { status: 200, body: { ok: true } };
}

/** `status` — token-free poll, identical shape to the codex flow. */
export function handleAntigravityOAuthStatus(
  sessionId: string,
  deps: AntigravityOAuthDeps,
): OAuthHandlerResult {
  const s = deps.antigravitySessions.get(sessionId);
  if (!s) return err(404, 'unknown or expired antigravity sign-in session');
  return { status: 200, body: { state: s.status, ...(s.error ? { message: s.error } : {}) } };
}
