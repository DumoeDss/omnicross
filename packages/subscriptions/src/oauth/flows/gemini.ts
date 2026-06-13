/**
 * Gemini (Google) OAuth flow — host-clean logic.
 *
 * PKCE verifier = `randomBytes(32).base64url`, oob redirect_uri
 * (`urn:ietf:wg:oauth:2.0:oob`), authorize carries `access_type=offline` +
 * `prompt=consent`, the exchange + refresh bodies carry the public installed-app
 * `client_secret`, and the refresh response is NOT expected to return a new
 * refresh_token (the caller reuses the old one — see the store's
 * `refreshGeminiToken`). Network goes through the injected `FetchLike`.
 * NOTE: `exchangeCodeForTokens` keeps a POSITIONAL signature
 * `(authorizationCode, codeVerifier)`.
 * Reference: claude-relay-service `src/services/geminiAccountService.js`.
 *
 * @module @omnicross/subscriptions/oauth/flows/gemini
 */

import crypto from 'node:crypto';

import type { OAuthParams } from '@omnicross/contracts/account-tokens-types';

import type { FetchLike } from '../fetchPort';
import { postForm } from '../fetchPort';

/** Gemini CLI OAuth configuration (matches official Gemini CLI). */
const GEMINI_OAUTH_CONFIG = {
  clientId: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
  // The Gemini CLI's *public* installed-app OAuth client secret (mirrors the
  // upstream CLI). Per Google's OAuth docs, native-app client secrets are not
  // treated as confidential — not a leaked key.
  clientSecret: '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', // allowlist-secret
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  redirectUri: 'urn:ietf:wg:oauth:2.0:oob',
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
};

/** Generate OAuth authorization parameters. */
export function generateAuthParams(): OAuthParams {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('hex');

  const params = new URLSearchParams({
    client_id: GEMINI_OAUTH_CONFIG.clientId,
    redirect_uri: GEMINI_OAUTH_CONFIG.redirectUri,
    scope: GEMINI_OAUTH_CONFIG.scopes.join(' '),
    response_type: 'code',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    access_type: 'offline',
    prompt: 'consent',
  });

  const authUrl = `${GEMINI_OAUTH_CONFIG.authorizationEndpoint}?${params.toString()}`;
  return { authUrl, codeVerifier, state };
}

/** Exchange authorization code for tokens (positional args, mirrors the helper). */
export async function exchangeCodeForTokens(
  authorizationCode: string,
  codeVerifier: string,
  fetchImpl: FetchLike,
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: GEMINI_OAUTH_CONFIG.clientId,
    client_secret: GEMINI_OAUTH_CONFIG.clientSecret,
    code: authorizationCode,
    code_verifier: codeVerifier,
    redirect_uri: GEMINI_OAUTH_CONFIG.redirectUri,
  });

  const data = await postForm(
    fetchImpl,
    GEMINI_OAUTH_CONFIG.tokenEndpoint,
    params,
    'Failed to parse token response',
  );

  return {
    accessToken: data.access_token,
    // authorization_code grant returns a refresh_token; the original helper read
    // it from an untyped `data` and declared the field `string`.
    refreshToken: data.refresh_token as string,
    expiresIn: data.expires_in,
  };
}

/**
 * Refresh access token using refresh_token. The Google token endpoint does NOT
 * return a refresh_token on refresh — the result intentionally omits it (the
 * store reuses the old value).
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
    client_id: GEMINI_OAUTH_CONFIG.clientId,
    client_secret: GEMINI_OAUTH_CONFIG.clientSecret,
    refresh_token: refreshToken,
  });

  const data = await postForm(
    fetchImpl,
    GEMINI_OAUTH_CONFIG.tokenEndpoint,
    params,
    'Failed to parse refresh response',
  );

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
  };
}
