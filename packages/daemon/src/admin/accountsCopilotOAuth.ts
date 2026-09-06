/**
 * accountsCopilotOAuth — the daemon admin API's COPILOT device-code sign-in
 * path (`POST /accounts/copilot/oauth/start` +
 * `GET /accounts/copilot/oauth/:sessionId/status`).
 *
 * GitHub Copilot is a RFC 8628 DEVICE flow (official Copilot CLI app, scope
 * `read:user`): no loopback port, no code to paste. `start` requests a device
 * authorization (the one upstream round-trip it must await), returns ONLY
 * `{ authUrl, userCode, sessionId }`, then drives the token poll + identity
 * read + endpoint discovery + policy-enable sweep ASYNC. The app opens
 * `authUrl`, shows the code, and POLLS `status` until `done`/`error` — the
 * same token-free shape as the codex loopback flow.
 *
 * SECRET SPINE (same invariant as the other device flows): the minted ghu_
 * token NEVER crosses to the client — it lands ONLY in the encrypted store.
 * The post-approval async work (identity + endpoint + the ~44-model policy
 * sweep) runs before `settle('done')` so a completed session is a fully
 * usable account.
 *
 * @module @omnicross/daemon/admin/accountsCopilotOAuth
 */

import type { CopilotTokenConfig } from '@omnicross/contracts/account-tokens-types';
import { copilotOAuth, type FetchLike } from '@omnicross/subscriptions';

import type { OAuthHandlerResult, SubscriptionAccountAppender } from './accountsOAuth';
import { CodexOAuthSessionStore } from './accountsCodexOAuth';

export { CodexOAuthSessionStore as CopilotOAuthSessionStore };

/** The deps the copilot OAuth handlers need (a subset of `AdminApiDeps`). */
export interface CopilotOAuthDeps {
  readonly copilotSessions: CodexOAuthSessionStore;
  /** Per-provider token-exchange fetch factory (see `AccountsOAuthDeps`). */
  readonly oauthExchangeFetch: (providerId: 'copilot') => FetchLike;
  readonly subscriptionAccountAppender: SubscriptionAccountAppender;
}

function err(status: number, message: string): OAuthHandlerResult {
  return { status, body: { error: { type: 'admin_api_error', message } } };
}

/** Default device-flow TTL: poll window + the policy-enable sweep + slack. */
export const DEFAULT_COPILOT_OAUTH_TTL_MS = 15 * 60_000;

/**
 * `start` — request the device authorization, arm the async token poll,
 * return ONLY `{ authUrl, userCode, sessionId }`. Rejects (409) when a
 * copilot sign-in is already in flight; (502) when the device-authorization
 * request fails.
 */
export async function handleCopilotOAuthStart(deps: CopilotOAuthDeps): Promise<OAuthHandlerResult> {
  if (deps.copilotSessions.isBusy()) {
    return err(409, 'a copilot sign-in is already in progress — finish it in the browser or cancel it');
  }
  const fetchImpl = deps.oauthExchangeFetch('copilot');
  let authorization;
  try {
    authorization = await copilotOAuth.requestCopilotDeviceAuthorization(fetchImpl);
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'device authorization failed';
    return err(502, `copilot device authorization failed: ${reason}`);
  }
  const { sessionId, signal } = deps.copilotSessions.begin();
  // Poll ASYNC (fire-and-forget). The token NEVER crosses to the client —
  // captured + persisted entirely daemon-side; the app POLLS.
  void runCopilotDevicePoll(sessionId, authorization.deviceCode, signal, deps)
    .catch((e: unknown) => {
      const reason = e instanceof Error ? e.message : 'copilot sign-in failed';
      deps.copilotSessions.settle(sessionId, 'error', reason);
    });
  return {
    status: 200,
    body: {
      authUrl: authorization.verificationUri,
      userCode: authorization.userCode,
      sessionId,
    },
  };
}

async function runCopilotDevicePoll(
  sessionId: string,
  deviceCode: string,
  signal: AbortSignal,
  deps: CopilotOAuthDeps,
): Promise<void> {
  const fetchImpl = deps.oauthExchangeFetch('copilot');
  const result = await copilotOAuth.awaitCopilotDeviceToken(
    { userCode: '', deviceCode, verificationUri: '', interval: 5, expiresIn: 900 },
    fetchImpl,
    {
      deadlineMs: DEFAULT_COPILOT_OAUTH_TTL_MS,
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
  const identity = await copilotOAuth.fetchCopilotIdentity(result.accessToken, fetchImpl);
  const apiEndpoint = await copilotOAuth.discoverCopilotApiEndpoint(result.accessToken, fetchImpl);
  // Best-effort policy-enable sweep — failures are non-fatal to the sign-in.
  await copilotOAuth.enableAllCopilotModels(result.accessToken, { apiEndpoint }, fetchImpl);
  const block: CopilotTokenConfig = {
    authMethod: 'oauth',
    status: 'authorized',
    accessToken: result.accessToken,
    refreshToken: result.accessToken,
    expiresAt: new Date(Date.now() + copilotOAuth.COPILOT_FAR_FUTURE_MS).toISOString(),
    ...(identity.accountId ? { accountId: identity.accountId } : {}),
    ...(identity.email ? { email: identity.email } : {}),
    ...(apiEndpoint ? { apiEndpoint } : {}),
    lastRefreshedAt: new Date().toISOString(),
  };
  await deps.subscriptionAccountAppender.appendProviderAccount('copilot', block);
  deps.copilotSessions.settle(sessionId, 'done');
}

export function handleCopilotOAuthCancel(sessionId: string, deps: CopilotOAuthDeps): OAuthHandlerResult {
  if (!deps.copilotSessions.cancel(sessionId)) {
    return err(404, 'unknown or expired copilot sign-in session');
  }
  return { status: 200, body: { ok: true } };
}

/** `status` — token-free poll, identical shape to the codex flow. */
export function handleCopilotOAuthStatus(sessionId: string, deps: CopilotOAuthDeps): OAuthHandlerResult {
  const s = deps.copilotSessions.get(sessionId);
  if (!s) return err(404, 'unknown or expired copilot sign-in session');
  return { status: 200, body: { state: s.status, ...(s.error ? { message: s.error } : {}) } };
}
