/**
 * accountsGrokOAuth — the daemon admin API's GROK device-code sign-in path
 * (`POST /accounts/grok/oauth/start` + `GET /accounts/grok/oauth/:sessionId/status`).
 *
 * Grok (xAI SuperGrok) is a RFC 8628 DEVICE flow: no loopback port, no code to
 * paste. `start` resolves the OIDC token endpoint (discovery, host-pinned to
 * `*.x.ai`) + requests a device authorization (the two upstream round-trips it
 * must await), returns ONLY `{ authUrl, userCode, sessionId }` (public — the
 * verification URL + the code the user enters), then drives the token poll +
 * persist ASYNC. The app opens `authUrl`, shows the code, and POLLS `status`
 * until `done`/`error` — the same token-free shape as the codex loopback flow,
 * so the client reuses the codex inline sign-in panel.
 *
 * SECRET SPINE (same invariant as accountsCodexOAuth): the minted access/
 * refresh token NEVER crosses to the client — it lands ONLY in the encrypted
 * store. Device-code flows have no port contention, but ONE sign-in at a time
 * keeps the surface simple (a second `start` → 409).
 *
 * @module @omnicross/daemon/admin/accountsGrokOAuth
 */

import type { GrokTokenConfig } from '@omnicross/contracts/account-tokens-types';
import { grokOAuth, type FetchLike } from '@omnicross/subscriptions';

import type { OAuthHandlerResult, SubscriptionAccountAppender } from './accountsOAuth';
import { CodexOAuthSessionStore } from './accountsCodexOAuth';

export { CodexOAuthSessionStore as GrokOAuthSessionStore };

/** The deps the grok OAuth handlers need (a subset of `AdminApiDeps`). */
export interface GrokOAuthDeps {
  readonly grokSessions: CodexOAuthSessionStore;
  /** Per-provider token-exchange fetch factory (see `AccountsOAuthDeps`). */
  readonly oauthExchangeFetch: (providerId: 'grok') => FetchLike;
  readonly subscriptionAccountAppender: SubscriptionAccountAppender;
}

function err(status: number, message: string): OAuthHandlerResult {
  return { status, body: { error: { type: 'admin_api_error', message } } };
}

/** Default device-flow TTL: poll window + slack (matches the CLI's 15min). */
export const DEFAULT_GROK_OAUTH_TTL_MS = 15 * 60_000;

/**
 * `start` — resolve the discovered token endpoint, request the device
 * authorization, arm the async token poll, return ONLY
 * `{ authUrl, userCode, sessionId }`. Rejects (409) when a grok sign-in is
 * already in flight; (502) when discovery or the device-authorization
 * request fails.
 */
export async function handleGrokOAuthStart(deps: GrokOAuthDeps): Promise<OAuthHandlerResult> {
  if (deps.grokSessions.isBusy()) {
    return err(409, 'a grok sign-in is already in progress — finish it in the browser or cancel it');
  }
  const fetchImpl = deps.oauthExchangeFetch('grok');
  let tokenEndpoint: string;
  try {
    tokenEndpoint = await grokOAuth.resolveGrokTokenEndpoint(fetchImpl);
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'OIDC discovery failed';
    return err(502, `grok token-endpoint discovery failed: ${reason}`);
  }
  let authorization;
  try {
    authorization = await grokOAuth.requestGrokDeviceAuthorization(fetchImpl);
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'device authorization failed';
    return err(502, `grok device authorization failed: ${reason}`);
  }
  const { sessionId, signal } = deps.grokSessions.begin();
  // Poll ASYNC (fire-and-forget). The token NEVER crosses to the client —
  // captured + persisted entirely daemon-side; the app POLLS.
  void runGrokDevicePoll(sessionId, tokenEndpoint, authorization.deviceCode, signal, deps)
    .catch((e: unknown) => {
      const reason = e instanceof Error ? e.message : 'grok sign-in failed';
      deps.grokSessions.settle(sessionId, 'error', reason);
    });
  return {
    status: 200,
    body: {
      authUrl: authorization.verificationUriComplete ?? authorization.verificationUri,
      userCode: authorization.userCode,
      sessionId,
    },
  };
}

async function runGrokDevicePoll(
  sessionId: string,
  tokenEndpoint: string,
  deviceCode: string,
  signal: AbortSignal,
  deps: GrokOAuthDeps,
): Promise<void> {
  const fetchImpl = deps.oauthExchangeFetch('grok');
  const result = await grokOAuth.awaitGrokDeviceToken(
    { userCode: '', deviceCode, verificationUri: '' },
    tokenEndpoint,
    fetchImpl,
    {
      deadlineMs: DEFAULT_GROK_OAUTH_TTL_MS,
      sleep: (ms) =>
        new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            clearTimeout(timer);
            reject(new Error('login: cancelled'));
          };
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          }, ms);
          signal.addEventListener('abort', onAbort, { once: true });
        }),
    },
  );
  const block: GrokTokenConfig = {
    authMethod: 'oauth',
    status: 'authorized',
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresAt: new Date(Date.now() + result.expiresIn * 1000).toISOString(),
    accountId: grokOAuth.grokAccountIdFromAccessToken(result.accessToken),
    lastRefreshedAt: new Date().toISOString(),
  };
  await deps.subscriptionAccountAppender.appendProviderAccount('grok', block);
  deps.grokSessions.settle(sessionId, 'done');
}

export function handleGrokOAuthCancel(sessionId: string, deps: GrokOAuthDeps): OAuthHandlerResult {
  if (!deps.grokSessions.cancel(sessionId)) return err(404, 'unknown or expired grok sign-in session');
  return { status: 200, body: { ok: true } };
}

/** `status` — token-free poll, identical shape to the codex flow. */
export function handleGrokOAuthStatus(sessionId: string, deps: GrokOAuthDeps): OAuthHandlerResult {
  const s = deps.grokSessions.get(sessionId);
  if (!s) return err(404, 'unknown or expired grok sign-in session');
  return { status: 200, body: { state: s.status, ...(s.error ? { message: s.error } : {}) } };
}
