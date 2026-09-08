/**
 * Antigravity (Google) OAuth flow — host-clean logic.
 *
 * Authorization-code grant with the Antigravity-dedicated Google client
 * (client_secret included, NO PKCE — the upstream client is an installed app
 * whose secret is public by design, same posture as the gemini-cli client).
 * The redirect is the client's FIXED loopback `http://127.0.0.1:51121/oauth-callback`;
 * authorize carries `access_type=offline` + `prompt=consent` and the five
 * Antigravity scopes. Token exchange + refresh go to `oauth2.googleapis.com`
 * as form posts; like gemini, the refresh response does NOT return a new
 * refresh_token (the caller reuses the old one). The account's display email
 * comes from `oauth2/v1/userinfo`.
 *
 * This is a SEPARATE credential domain from `gemini` (different client,
 * different scopes, different refresh semantics — the post-refresh project
 * handshake is driven by the daemon's refresh scheduler, not here).
 *
 * Network goes through the injected `FetchLike`.
 *
 * @module @omnicross/subscriptions/oauth/flows/antigravity
 */

import crypto from 'node:crypto';

import type { OAuthParams } from '@omnicross/contracts/account-tokens-types';

import type { FetchLike } from '../fetchPort';
import { postForm } from '../fetchPort';

/** Antigravity OAuth configuration (public installed-app client, mirrors the upstream client). */
export const ANTIGRAVITY_OAUTH_CONFIG = {
  clientId: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
  // The Antigravity client's *public* installed-app OAuth secret (mirrors the
  // upstream client). Per Google's OAuth docs, native-app client secrets are
  // not treated as confidential — not a leaked key.
  clientSecret: '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', // allowlist-secret
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  userinfoEndpoint: 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json',
  redirectUri: 'http://127.0.0.1:51121/oauth-callback',
  scopes: [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/cclog',
    'https://www.googleapis.com/auth/experimentsandconfigs',
  ],
} as const;

/**
 * Generate OAuth authorization parameters. NO PKCE — the `codeVerifier` field
 * of `OAuthParams` is an empty string (the shape is shared with the PKCE
 * flows; the exchange ignores it).
 */
export function generateAuthParams(): OAuthParams {
  const state = crypto.randomUUID().replace(/-/g, '');

  const params = new URLSearchParams({
    client_id: ANTIGRAVITY_OAUTH_CONFIG.clientId,
    redirect_uri: ANTIGRAVITY_OAUTH_CONFIG.redirectUri,
    scope: ANTIGRAVITY_OAUTH_CONFIG.scopes.join(' '),
    response_type: 'code',
    state,
    access_type: 'offline',
    prompt: 'consent',
  });

  const authUrl = `${ANTIGRAVITY_OAUTH_CONFIG.authorizationEndpoint}?${params.toString()}`;
  return { authUrl, codeVerifier: '', state };
}

/**
 * Exchange the loopback authorization code for tokens. The code is issued for
 * the FIXED loopback redirect_uri — the same value must accompany the exchange
 * (Google validates the match), including on the paste-fallback path where the
 * code was copied out of the browser's failed redirect.
 */
export async function exchangeCodeForTokens(
  authorizationCode: string,
  fetchImpl: FetchLike,
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: ANTIGRAVITY_OAUTH_CONFIG.clientId,
    client_secret: ANTIGRAVITY_OAUTH_CONFIG.clientSecret,
    code: authorizationCode,
    redirect_uri: ANTIGRAVITY_OAUTH_CONFIG.redirectUri,
  });

  const data = await postForm(
    fetchImpl,
    ANTIGRAVITY_OAUTH_CONFIG.tokenEndpoint,
    params,
    'Failed to parse antigravity token response',
  );

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token as string,
    expiresIn: data.expires_in,
  };
}

/**
 * Refresh the access token. The Google token endpoint does NOT return a
 * refresh_token on refresh — the result intentionally omits it (the caller
 * reuses the stored one, exactly like the gemini flow).
 */
export async function refreshAccessToken(
  refreshToken: string,
  fetchImpl: FetchLike,
): Promise<{
  accessToken: string;
  expiresIn: number;
}> {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: ANTIGRAVITY_OAUTH_CONFIG.clientId,
    client_secret: ANTIGRAVITY_OAUTH_CONFIG.clientSecret,
    refresh_token: refreshToken,
  });

  const data = await postForm(
    fetchImpl,
    ANTIGRAVITY_OAUTH_CONFIG.tokenEndpoint,
    params,
    'Failed to parse antigravity refresh response',
  );

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
  };
}

/**
 * Fetch the account's email from `oauth2/v1/userinfo` (the display identifier
 * for the account list). Best-effort shape guard: a non-2xx or an unparseable
 * body resolves `undefined` — login proceeds without an email rather than
 * failing (the project handshake is the load-bearing step).
 */
export async function fetchUserEmail(
  accessToken: string,
  fetchImpl: FetchLike,
): Promise<string | undefined> {
  try {
    const response = await fetchImpl(ANTIGRAVITY_OAUTH_CONFIG.userinfoEndpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (!response.ok) return undefined;
    const payload = (await response.json()) as { email?: unknown };
    return typeof payload.email === 'string' && payload.email.length > 0
      ? payload.email
      : undefined;
  } catch {
    return undefined;
  }
}
