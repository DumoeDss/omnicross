/**
 * accountsKimiOAuth — the daemon admin API's KIMI device-code sign-in path
 * (`POST /accounts/kimi/oauth/start` + `GET /accounts/kimi/oauth/:sessionId/status`).
 *
 * Kimi is a RFC 8628 DEVICE flow: no loopback port, no code to paste. `start`
 * requests a device authorization (the one upstream round-trip it must await),
 * returns ONLY `{ authUrl, userCode, sessionId }` (public — the verification
 * URL + the code the user enters), then drives the token poll + persist
 * ASYNC. The app opens `authUrl`, shows the code, and POLLS `status` until
 * `done`/`error` — the same token-free shape as the codex loopback flow, so
 * the client reuses the codex inline sign-in panel.
 *
 * SECRET SPINE (same invariant as accountsCodexOAuth): the minted access/
 * refresh token NEVER crosses to the client — it lands ONLY in the encrypted
 * store. Device-code flows have no port contention, but ONE sign-in at a time
 * keeps the surface simple (a second `start` → 409).
 *
 * @module @omnicross/daemon/admin/accountsKimiOAuth
 */

import type { KimiTokenConfig } from '@omnicross/contracts/account-tokens-types';
import { kimiOAuth, type FetchLike } from '@omnicross/subscriptions';

import type { OAuthHandlerResult, SubscriptionAccountAppender } from './accountsOAuth';
import { CodexOAuthSessionStore } from './accountsCodexOAuth';

export { CodexOAuthSessionStore as KimiOAuthSessionStore };

/** The deps the kimi OAuth handlers need (a subset of `AdminApiDeps`). */
export interface KimiOAuthDeps {
  readonly kimiSessions: CodexOAuthSessionStore;
  /** Per-provider token-exchange fetch factory (see `AccountsOAuthDeps`). */
  readonly oauthExchangeFetch: (providerId: 'kimi') => FetchLike;
  readonly subscriptionAccountAppender: SubscriptionAccountAppender;
}

function err(status: number, message: string): OAuthHandlerResult {
  return { status, body: { error: { type: 'admin_api_error', message } } };
}

/** Default device-flow TTL: poll window + slack (matches the CLI's 15min). */
export const DEFAULT_KIMI_OAUTH_TTL_MS = 15 * 60_000;

/**
 * `start` — request the device authorization, arm the async token poll, return
 * ONLY `{ authUrl, userCode, sessionId }`. Rejects (409) when a kimi sign-in
 * is already in flight; (502) when the device-authorization request fails.
 */
export async function handleKimiOAuthStart(deps: KimiOAuthDeps): Promise<OAuthHandlerResult> {
  if (deps.kimiSessions.isBusy()) {
    return err(409, 'a kimi sign-in is already in progress — finish it in the browser or cancel it');
  }
  const fetchImpl = deps.oauthExchangeFetch('kimi');
  const deviceId = kimiOAuth.generateKimiDeviceId();
  const fingerprint = kimiOAuth.kimiFingerprintHeaders(deviceId);
  let authorization;
  try {
    authorization = await kimiOAuth.requestDeviceAuthorization(fetchImpl, fingerprint);
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'device authorization failed';
    return err(502, `kimi device authorization failed: ${reason}`);
  }
  const { sessionId, signal } = deps.kimiSessions.begin();
  // Poll ASYNC (fire-and-forget). The token NEVER crosses to the client —
  // captured + persisted entirely daemon-side; the app POLLS.
  void runKimiDevicePoll(sessionId, authorization.deviceCode, deviceId, fingerprint, signal, deps)
    .catch(() => deps.kimiSessions.settle(sessionId, 'error', 'kimi sign-in failed'));
  return {
    status: 200,
    body: {
      authUrl: authorization.verificationUriComplete ?? authorization.verificationUri,
      userCode: authorization.userCode,
      sessionId,
    },
  };
}

async function runKimiDevicePoll(
  sessionId: string,
  deviceCode: string,
  deviceId: string,
  fingerprint: Record<string, string>,
  signal: AbortSignal,
  deps: KimiOAuthDeps,
): Promise<void> {
  const fetchImpl = deps.oauthExchangeFetch('kimi');
  const result = await kimiOAuth.awaitDeviceToken(
    { userCode: '', deviceCode, verificationUri: '' },
    fetchImpl,
    {
      fingerprint,
      deadlineMs: DEFAULT_KIMI_OAUTH_TTL_MS,
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
  const block: KimiTokenConfig = {
    authMethod: 'oauth',
    status: 'authorized',
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresAt: new Date(Date.now() + result.expiresIn * 1000).toISOString(),
    accountId: kimiOAuth.kimiAccountIdFromAccessToken(result.accessToken),
    deviceId,
    lastRefreshedAt: new Date().toISOString(),
  };
  await deps.subscriptionAccountAppender.appendProviderAccount('kimi', block);
  deps.kimiSessions.settle(sessionId, 'done');
}

export function handleKimiOAuthCancel(sessionId: string, deps: KimiOAuthDeps): OAuthHandlerResult {
  if (!deps.kimiSessions.cancel(sessionId)) return err(404, 'unknown or expired kimi sign-in session');
  return { status: 200, body: { ok: true } };
}

/** `status` — token-free poll, identical shape to the codex flow. */
export function handleKimiOAuthStatus(sessionId: string, deps: KimiOAuthDeps): OAuthHandlerResult {
  const s = deps.kimiSessions.get(sessionId);
  if (!s) return err(404, 'unknown or expired kimi sign-in session');
  return { status: 200, body: { state: s.status, ...(s.error ? { message: s.error } : {}) } };
}
