/**
 * accountsOAuth — the daemon admin API's INTERACTIVE OAuth login path
 * (`POST /admin/api/accounts/:providerId/oauth/{start,complete}`, app-parity
 * child 4, design D1/D2/D4).
 *
 * EXPOSES the existing `@omnicross/subscriptions/oauth` flow over admin HTTP as a
 * two-phase pair — it does NOT rebuild PKCE / token-exchange. `start` builds the
 * provider's authorize params and stashes the per-session `{ codeVerifier, state }`
 * in the `OAuthSessionStore` keyed by a minted opaque `sessionId`, returning ONLY
 * `{ authUrl, sessionId }` (the `authUrl` carries client_id + PKCE challenge +
 * state — all public). `complete` `peek`s the session, validates state (claude's
 * `code#state`), `exchangeCodeForTokens(...)`, then — and ONLY then — `consume`s
 * the session (single-use), persists the minted token through the encrypted
 * credential store (`appendProviderAccount`) + marks it active, and responds ONLY
 * the sanitized `SubscriptionListEntry`. A FAILED exchange leaves the session
 * intact so the user can retry within its TTL instead of being locked out by a 410.
 *
 * SECRET SPINE (the load-bearing invariant): the minted access/refresh token
 * NEVER appears in any response body or log; the `codeVerifier` / session map is
 * never serialized; error messages reference the session/provider, never a token.
 * At-rest encryption is inherited (the store's `SecretBox` → `enc:` envelope).
 *
 * OAuth-capable here = `claude` / `gemini` (code-paste). `codex` (loopback) is
 * DEFERRED (OQ1) and `opencodego` is manual-only — both are rejected by `start`
 * as oauth-unsupported (defensive; their app Sign-in stays `<Unbacked>`).
 *
 * @module @omnicross/daemon/admin/accountsOAuth
 */

import type {
  ClaudeTokenConfig,
  GeminiTokenConfig,
} from '@omnicross/contracts/account-tokens-types';
import type { SubscriptionProviderId } from '@omnicross/contracts/subscription-types';
import { claudeOAuth, type FetchLike, geminiOAuth } from '@omnicross/subscriptions';

import type { SubscriptionTokenBlock } from '../ports/JsonSubscriptionCredentialStore';

import type { AccountsStatusReader } from './accountsWrite';
import { statusEntryFor } from './accountsWrite';
import type { OAuthSessionStore } from './oauthSessions';

/**
 * NARROW append handle (design D2-a): the OAuth complete handler legitimately
 * needs `appendProviderAccount` (multi-account append + activate) — a method NOT
 * on the least-authority `SubscriptionTokenWriter`. Rather than widen that
 * deliberate security boundary, `AdminApiDeps` carries this minimal interface
 * (NOT the full read-capable store, so no token-returning read is reachable).
 * Structurally satisfied by the concrete `JsonSubscriptionCredentialStore`.
 */
export interface SubscriptionAccountAppender {
  appendProviderAccount(
    providerId: SubscriptionProviderId,
    config: SubscriptionTokenBlock,
    label?: string,
  ): Promise<{ id: string }>;
}

/** The deps the OAuth handlers need (a subset of `AdminApiDeps`). */
export interface AccountsOAuthDeps {
  readonly oauthSessions: OAuthSessionStore;
  /**
   * Per-provider token-exchange fetch factory. Built in `bootstrap.ts` so the
   * exchange routes through the proxy-aware egress seam WITH a `{ providerId }`
   * ctx — the per-provider proxy layer applies and the call lands in the upstream
   * trace (bodies redacted) instead of leaving no evidence when it fails.
   */
  readonly oauthExchangeFetch: (providerId: SubscriptionProviderId) => FetchLike;
  readonly subscriptionAccountAppender: SubscriptionAccountAppender;
  readonly subscriptionAccounts: AccountsStatusReader;
}

/** The result of a handler — a status code + a JSON-able body. */
export interface OAuthHandlerResult {
  status: number;
  body: unknown;
}

/** OAuth-capable providers backed over HTTP in this child (codex DEFERRED). */
const OAUTH_HTTP_PROVIDERS = new Set<SubscriptionProviderId>(['claude', 'gemini']);

function err(status: number, message: string): OAuthHandlerResult {
  return { status, body: { error: { type: 'admin_api_error', message } } };
}

/**
 * `start` — build the provider's authorize params, stash the pending session,
 * return ONLY `{ authUrl, sessionId }` (NO secret). Rejects providers with no
 * HTTP-backed OAuth flow (codex deferred / opencodego manual-only) as
 * oauth-unsupported.
 */
export function handleOAuthStart(
  providerId: SubscriptionProviderId,
  deps: AccountsOAuthDeps,
): OAuthHandlerResult {
  if (!OAUTH_HTTP_PROVIDERS.has(providerId)) {
    return err(400, `oauth not available for provider '${providerId}'`);
  }
  const flow = providerId === 'claude' ? claudeOAuth : geminiOAuth;
  const { authUrl, codeVerifier, state } = flow.generateAuthParams();
  // Stash the secret-ish PKCE material daemon-side; only the opaque id + the
  // public authUrl cross the wire.
  const sessionId = deps.oauthSessions.put({ providerId, codeVerifier, state });
  return { status: 200, body: { authUrl, sessionId } };
}

/**
 * `complete` — peek the pending session (410 if absent/expired/already used),
 * verify the path provider matches the session, validate state, exchange the
 * code, burn the session, persist through the encrypted store + activate, and
 * respond ONLY the sanitized status. The token is never logged or echoed.
 *
 * The session is consumed on SUCCESS ONLY: every recoverable failure (bad paste,
 * state mismatch, token-endpoint/proxy error) returns with the session still
 * pending, so a retry with a corrected code works.
 */
export async function handleOAuthComplete(
  providerId: SubscriptionProviderId,
  body: Record<string, unknown>,
  deps: AccountsOAuthDeps,
): Promise<OAuthHandlerResult> {
  if (!OAUTH_HTTP_PROVIDERS.has(providerId)) {
    return err(400, `oauth not available for provider '${providerId}'`);
  }
  const sessionId = typeof body['sessionId'] === 'string' ? body['sessionId'] : '';
  const rawCode = typeof body['code'] === 'string' ? body['code'] : '';
  if (!sessionId) return err(400, 'oauth complete requires { sessionId }');
  if (!rawCode) return err(400, 'oauth complete requires { code }');

  // PEEK, don't consume: the session is burned only after a token is actually
  // minted (below). Consuming here made every recoverable failure — a mistyped
  // or already-expired pasted code, a proxy/network hiccup on the token endpoint
  // — permanently destroy the pending login, so the user's natural "click again"
  // got a 410 and the flow could never be completed.
  const session = deps.oauthSessions.peek(sessionId);
  if (!session) return err(410, 'oauth session is unknown, expired, or already used');
  if (session.providerId !== providerId) {
    return err(400, `oauth session does not match provider '${providerId}'`);
  }

  // For claude the oob callback returns `code#state`: split + validate the state
  // against the pending session (CSRF guard; mirrors the login.ts logic). Gemini's
  // oob code carries no `#state` fragment.
  let code = rawCode.trim();
  if (providerId === 'claude') {
    const [splitCode, pastedState] = code.split('#');
    if (!splitCode) return err(400, 'no authorization code was provided');
    if (pastedState && pastedState !== session.state) {
      return err(400, 'oauth state did not match (possible CSRF) — aborting');
    }
    code = splitCode;
  }

  const exchangeFetch = deps.oauthExchangeFetch(providerId);
  let block: SubscriptionTokenBlock;
  try {
    block =
      providerId === 'claude'
        ? await exchangeClaude(code, session.codeVerifier, session.state, exchangeFetch)
        : await exchangeGemini(code, session.codeVerifier, exchangeFetch);
  } catch (exchangeError) {
    // The error from the token endpoint may itself be benign, but NEVER include a
    // token — reference only the provider + a generic exchange-failure reason.
    // The session SURVIVES (see the peek above) so the user can paste a fresh
    // code, or retry a transient network/proxy failure, within the session TTL.
    const reason = exchangeError instanceof Error ? exchangeError.message : 'token exchange failed';
    return err(502, `oauth token exchange failed for '${providerId}': ${reason}`);
  }

  // A token was minted — NOW burn the session so this `sessionId` (and the
  // authorization code bound to it) can never be replayed.
  deps.oauthSessions.consume(sessionId);

  // Persist through the encrypted store (D2-a narrow append handle) + activate.
  // An optional client-supplied label names the new account (else the store
  // auto-labels "Account N").
  const label = typeof body['label'] === 'string' && body['label'].trim() ? body['label'].trim() : undefined;
  await deps.subscriptionAccountAppender.appendProviderAccount(providerId, block, label);
  // STATUS-ONLY response — the token-free sanitized entry (never the token/block).
  const status = await statusEntryFor(deps.subscriptionAccounts, providerId);
  return { status: 200, body: status ? { account: status } : { ok: true } };
}

/** Exchange a claude code → the per-provider token block (reuse login.ts shape). */
async function exchangeClaude(
  code: string,
  codeVerifier: string,
  state: string,
  exchangeFetch: FetchLike,
): Promise<ClaudeTokenConfig> {
  const result = await claudeOAuth.exchangeCodeForTokens(
    { authorizationCode: code, codeVerifier, state },
    exchangeFetch,
  );
  const expiresAt = new Date(Date.now() + result.expiresIn * 1000).toISOString();
  return {
    authMethod: 'oauth',
    status: 'authorized',
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresAt,
    scopes: result.scopes,
    lastRefreshedAt: new Date().toISOString(),
  };
}

/** Exchange a gemini code → the per-provider token block (reuse login.ts shape). */
async function exchangeGemini(
  code: string,
  codeVerifier: string,
  exchangeFetch: FetchLike,
): Promise<GeminiTokenConfig> {
  const result = await geminiOAuth.exchangeCodeForTokens(code, codeVerifier, exchangeFetch);
  const expiresAt = new Date(Date.now() + result.expiresIn * 1000).toISOString();
  return {
    authMethod: 'oauth',
    status: 'authorized',
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresAt,
    lastRefreshedAt: new Date().toISOString(),
  };
}
