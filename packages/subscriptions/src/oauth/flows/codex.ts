/**
 * Codex (ChatGPT) OAuth flow — host-clean PKCE logic.
 *
 * PKCE verifier = `randomBytes(64).hex` (NOT base64url like claude/gemini),
 * loopback redirect_uri, scope `openid profile email offline_access`, NO state in
 * the exchange body, refresh carries `scope=openid profile email`, and the refresh
 * defaults `expiresIn` to 3600 + returns an `idToken`. Network goes through the
 * injected `FetchLike`.
 * Reference: claude-relay-service `src/services/openaiAccountService.js`.
 *
 * @module @omnicross/subscriptions/oauth/flows/codex
 */

import crypto from 'node:crypto';

import type { OAuthParams, TokenExchangeRequest } from '@omnicross/contracts/account-tokens-types';

import type { FetchLike } from '../fetchPort';
import { postForm } from '../fetchPort';

/** Codex CLI OAuth configuration (matches official Codex CLI). */
const CODEX_OAUTH_CONFIG = {
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  authorizationEndpoint: 'https://auth.openai.com/oauth/authorize',
  tokenEndpoint: 'https://auth.openai.com/oauth/token',
  redirectUri: 'http://localhost:1455/auth/callback',
  scopes: ['openid', 'profile', 'email', 'offline_access'],
};

/** Generate OAuth authorization parameters (PKCE). */
export function generateAuthParams(): OAuthParams {
  // Generate code_verifier (64 bytes random hex encoded)
  const codeVerifier = crypto.randomBytes(64).toString('hex');
  // Calculate code_challenge = SHA256(code_verifier) Base64URL
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  // Generate random state
  const state = crypto.randomBytes(16).toString('hex');

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CODEX_OAUTH_CONFIG.clientId,
    redirect_uri: CODEX_OAUTH_CONFIG.redirectUri,
    scope: CODEX_OAUTH_CONFIG.scopes.join(' '),
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });

  const authUrl = `${CODEX_OAUTH_CONFIG.authorizationEndpoint}?${params.toString()}`;
  return { authUrl, codeVerifier, state };
}

/** Exchange authorization code for tokens (codex carries NO state in the body). */
export async function exchangeCodeForTokens(
  request: TokenExchangeRequest,
  fetchImpl: FetchLike,
): Promise<{
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresIn: number;
}> {
  const { authorizationCode, codeVerifier } = request;

  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CODEX_OAUTH_CONFIG.clientId,
    code: authorizationCode,
    code_verifier: codeVerifier,
    redirect_uri: CODEX_OAUTH_CONFIG.redirectUri,
  });

  const data = await postForm(
    fetchImpl,
    CODEX_OAUTH_CONFIG.tokenEndpoint,
    params,
    'Failed to parse token response',
  );

  return {
    accessToken: data.access_token,
    // authorization_code grant returns both; the original helper read them from
    // an untyped `data` and declared the fields `string`.
    refreshToken: data.refresh_token as string,
    idToken: data.id_token as string,
    expiresIn: data.expires_in,
  };
}

/** Refresh access token using refresh_token. */
export async function refreshAccessToken(
  refreshToken: string,
  fetchImpl: FetchLike,
): Promise<{
  accessToken: string;
  idToken: string;
  refreshToken: string;
  expiresIn: number;
}> {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CODEX_OAUTH_CONFIG.clientId,
    refresh_token: refreshToken,
    scope: 'openid profile email',
  });

  const data = await postForm(
    fetchImpl,
    CODEX_OAUTH_CONFIG.tokenEndpoint,
    params,
    'Failed to parse refresh response',
  );

  return {
    accessToken: data.access_token,
    idToken: data.id_token as string,
    refreshToken: data.refresh_token || refreshToken,
    expiresIn: data.expires_in || 3600,
  };
}
