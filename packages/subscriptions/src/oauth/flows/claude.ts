/**
 * Claude OAuth flow — host-clean PKCE logic.
 *
 * Pure logic only: authorize-URL construction, PKCE generation, authorization-
 * code exchange, setup-token exchange, and refresh. Every network request goes
 * through an INJECTED `FetchLike` port — NO `electron`, NO `net`, NO host path
 * (a desktop host can inject an electron-net adapter; the daemon injects global
 * `fetch`). Claude `code=true`, `state` carried in exchange, setup-token has no
 * refresh_token. Reference: claude-relay-service `src/utils/oauthHelper.js`.
 *
 * @module @omnicross/subscriptions/oauth/flows/claude
 */

import crypto from 'node:crypto';

import type { OAuthParams, TokenExchangeRequest } from '@omnicross/contracts/account-tokens-types';

import type { FetchLike } from '../fetchPort';
import { postJson } from '../fetchPort';

/**
 * Headers the official Claude Code CLI sends on the OAuth token endpoint. The
 * endpoint is Cloudflare-fronted and rejects (403 "Request not allowed") any
 * request that doesn't present the `claude-cli` identity + claude.ai
 * Referer/Origin with a JSON body. Mirrors claude-relay-service
 * `src/utils/oauthHelper.js`. (Electron's `net.request` — the desktop fetch
 * adapter — sends these verbatim; browser `fetch` would strip Referer/Origin,
 * but the OAuth flow runs in a backend process / daemon, not a browser.)
 */
const CLAUDE_TOKEN_HEADERS: Record<string, string> = {
  'User-Agent': 'claude-cli/1.0.56 (external, cli)',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://claude.ai/',
  Origin: 'https://claude.ai',
};

/** Claude OAuth configuration (matches official Claude Code CLI). */
const CLAUDE_OAUTH_CONFIG = {
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authorizationEndpoint: 'https://claude.ai/oauth/authorize',
  // The token endpoint moved to platform.claude.com alongside the OAuth
  // callback (the old console.anthropic.com/v1/oauth/token now returns
  // Anthropic's standard 404 `{"error":{"type":"not_found_error","message":
  // "Not found"}}` — observed 2026-06). The redirect_uri MUST match what the
  // client is registered for AND match between authorize + token exchange.
  // Scopes mirror the live Claude Code authorize URL.
  tokenEndpoint: 'https://platform.claude.com/v1/oauth/token',
  redirectUri: 'https://platform.claude.com/oauth/code/callback',
  scopes: [
    'org:create_api_key',
    'user:profile',
    'user:inference',
    'user:sessions:claude_code',
    'user:mcp_servers',
    'user:file_upload',
  ],
};

/** Setup Token configuration — minimal permissions, longer expiry. */
const SETUP_TOKEN_CONFIG = {
  scopes: ['user:inference'], // Only inference permission, no API key creation
};

/** Build the PKCE pair + state shared by the auth + setup-token URL builders. */
function generatePkce(): { codeVerifier: string; codeChallenge: string; state: string } {
  // Generate code_verifier (32 bytes random Base64URL encoded)
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  // Calculate code_challenge = SHA256(code_verifier) Base64URL
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  // Generate random state
  const state = crypto.randomBytes(16).toString('hex');
  return { codeVerifier, codeChallenge, state };
}

/** Generate OAuth authorization parameters (PKCE). */
export function generateAuthParams(): OAuthParams {
  const { codeVerifier, codeChallenge, state } = generatePkce();

  const params = new URLSearchParams({
    code: 'true',
    client_id: CLAUDE_OAUTH_CONFIG.clientId,
    response_type: 'code',
    redirect_uri: CLAUDE_OAUTH_CONFIG.redirectUri,
    scope: CLAUDE_OAUTH_CONFIG.scopes.join(' '),
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });

  const authUrl = `${CLAUDE_OAUTH_CONFIG.authorizationEndpoint}?${params.toString()}`;
  return { authUrl, codeVerifier, state };
}

/**
 * Generate Setup Token authorization parameters (PKCE). Setup Token has minimal
 * permissions (user:inference only) but longer expiry; no refresh token is
 * returned — the user re-authorizes when it expires.
 */
export function generateSetupTokenParams(): OAuthParams {
  const { codeVerifier, codeChallenge, state } = generatePkce();

  const params = new URLSearchParams({
    code: 'true',
    client_id: CLAUDE_OAUTH_CONFIG.clientId,
    response_type: 'code',
    redirect_uri: CLAUDE_OAUTH_CONFIG.redirectUri,
    scope: SETUP_TOKEN_CONFIG.scopes.join(' '),
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });

  const authUrl = `${CLAUDE_OAUTH_CONFIG.authorizationEndpoint}?${params.toString()}`;
  return { authUrl, codeVerifier, state };
}

/** Exchange authorization code for tokens. */
export async function exchangeCodeForTokens(
  request: TokenExchangeRequest,
  fetchImpl: FetchLike,
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scopes: string[];
}> {
  const { authorizationCode, codeVerifier, state } = request;
  // Defensive: strip any leftover `#state` / `&...` fragment from the pasted code
  // (client paste-parsers already do this; mirrors the reference).
  const code = authorizationCode.split('#')[0]?.split('&')[0] ?? authorizationCode;

  const data = await postJson(
    fetchImpl,
    CLAUDE_OAUTH_CONFIG.tokenEndpoint,
    {
      grant_type: 'authorization_code',
      client_id: CLAUDE_OAUTH_CONFIG.clientId,
      code,
      code_verifier: codeVerifier,
      redirect_uri: CLAUDE_OAUTH_CONFIG.redirectUri,
      state,
    },
    'Failed to parse token response',
    CLAUDE_TOKEN_HEADERS,
  );

  return {
    accessToken: data.access_token,
    // The authorization_code grant always returns a refresh_token; the original
    // helper read it from an untyped `data` and declared the field `string`.
    refreshToken: data.refresh_token as string,
    expiresIn: data.expires_in,
    scopes: data.scope?.split(' ') || CLAUDE_OAUTH_CONFIG.scopes,
  };
}

/**
 * Exchange Setup Token authorization code for access token.
 * Note: Setup Token does NOT return refresh_token.
 */
export async function exchangeSetupTokenCode(
  request: TokenExchangeRequest,
  fetchImpl: FetchLike,
): Promise<{
  accessToken: string;
  expiresIn: number;
  scopes: string[];
}> {
  const { authorizationCode, codeVerifier, state } = request;
  const code = authorizationCode.split('#')[0]?.split('&')[0] ?? authorizationCode;

  const data = await postJson(
    fetchImpl,
    CLAUDE_OAUTH_CONFIG.tokenEndpoint,
    {
      grant_type: 'authorization_code',
      client_id: CLAUDE_OAUTH_CONFIG.clientId,
      code,
      code_verifier: codeVerifier,
      redirect_uri: CLAUDE_OAUTH_CONFIG.redirectUri,
      state,
    },
    'Failed to parse setup token response',
    CLAUDE_TOKEN_HEADERS,
  );

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
    scopes: data.scope?.split(' ') || SETUP_TOKEN_CONFIG.scopes,
  };
}

/** Refresh access token using refresh_token. */
export async function refreshAccessToken(
  refreshToken: string,
  fetchImpl: FetchLike,
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}> {
  const data = await postJson(
    fetchImpl,
    CLAUDE_OAUTH_CONFIG.tokenEndpoint,
    {
      grant_type: 'refresh_token',
      client_id: CLAUDE_OAUTH_CONFIG.clientId,
      refresh_token: refreshToken,
    },
    'Failed to parse refresh response',
    CLAUDE_TOKEN_HEADERS,
  );

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresIn: data.expires_in,
  };
}
