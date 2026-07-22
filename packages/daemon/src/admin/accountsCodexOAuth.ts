/**
 * accountsCodexOAuth — the daemon admin API's CODEX interactive OAuth path
 * (`POST /accounts/codex/oauth/start` + `GET /accounts/codex/oauth/:sessionId/status`,
 * app-parity-2 child 5).
 *
 * Codex differs from claude/gemini (which are CODE-PASTE, handled by
 * `accountsOAuth.ts`): its redirect is a LOOPBACK to `http://localhost:1455/auth/callback`,
 * so there is no code to paste — the browser hits the daemon's loopback listener
 * directly. This makes the flow ASYNC + POLLED rather than two-phase paste:
 *   - `start` builds the codex authorize params, ARMS the one-shot loopback
 *     listener (`awaitLoopbackCode`, injected for tests), kicks the
 *     capture→exchange→persist off ASYNC (fire-and-forget), and returns ONLY
 *     `{ authUrl, sessionId }` (public — client_id + PKCE challenge + state).
 *   - the app opens `authUrl`; the browser redirects to the loopback; the daemon
 *     captures the `code`, validates `state`, `exchangeCodeForTokens`, and persists
 *     the minted token through the encrypted credential store (`appendProviderAccount`).
 *   - the app POLLS `status` until `done` / `error`, then refreshes `/accounts`.
 *
 * SECRET SPINE (the load-bearing invariant): the minted access/refresh/id token
 * NEVER crosses to the client — it lands ONLY in the encrypted store. The poll
 * `status` body is TOKEN-FREE (`{ state, message? }`); error messages reference the
 * loopback/exchange failure, never a token. The PKCE `codeVerifier` stays in this
 * module's closure (never serialized). Port 1455 is a single resource → only ONE
 * codex sign-in may be in flight at a time (a second `start` → 409).
 *
 * REUSES the existing `@omnicross/subscriptions` codex flow + the CLI's
 * `awaitLoopbackCode` listener — it does NOT rebuild PKCE / token-exchange / the
 * loopback server.
 *
 * @module @omnicross/daemon/admin/accountsCodexOAuth
 */

import crypto from 'node:crypto';

import type { CodexTokenConfig } from '@omnicross/contracts/account-tokens-types';
import { codexOAuth, type FetchLike } from '@omnicross/subscriptions';

import type { OAuthHandlerResult, SubscriptionAccountAppender } from './accountsOAuth';

/** The loopback-listener fn (injected so tests need not bind a real port). */
export type CodexLoopbackFn = (state: string, timeoutMs?: number, signal?: AbortSignal) => Promise<string>;

/** One codex sign-in flow's polled status (NEVER carries a token). */
interface CodexFlowState {
  status: 'pending' | 'done' | 'error';
  /** Loopback/exchange failure reason (NEVER a token). Present only on 'error'. */
  error?: string;
  createdAt: number;
}

/** Default flow TTL (matches the loopback listener's 5-min wait + slack). */
export const DEFAULT_CODEX_OAUTH_TTL_MS = 10 * 60 * 1000;

/**
 * In-memory store for the async codex sign-in flows. A single instance per daemon
 * (wired in `bootstrap.ts`). Tracks per-session status for the poll + a single
 * `activeSessionId` (port 1455 is one resource → one in-flight login at a time).
 * Never serialized; a daemon restart drops in-flight logins (fail-safe).
 */
export class CodexOAuthSessionStore {
  private readonly sessions = new Map<string, CodexFlowState>();
  private activeSessionId: string | null = null;
  private readonly aborters = new Map<string, AbortController>();

  constructor(private readonly ttlMs: number = DEFAULT_CODEX_OAUTH_TTL_MS) {}

  /** Whether a codex sign-in is currently in flight (port 1455 held). */
  isBusy(): boolean {
    this.sweep();
    return this.activeSessionId !== null;
  }

  /** Mint a fresh sessionId, mark it pending + active, return the id. */
  begin(): { sessionId: string; signal: AbortSignal } {
    this.sweep();
    const sessionId = crypto.randomBytes(24).toString('base64url');
    this.sessions.set(sessionId, { status: 'pending', createdAt: Date.now() });
    this.activeSessionId = sessionId;
    const controller = new AbortController();
    this.aborters.set(sessionId, controller);
    return { sessionId, signal: controller.signal };
  }

  /** Settle a flow (done/error) + free the active slot. */
  settle(sessionId: string, status: 'done' | 'error', error?: string): void {
    const prior = this.sessions.get(sessionId);
    this.sessions.set(sessionId, { status, error, createdAt: prior?.createdAt ?? Date.now() });
    if (this.activeSessionId === sessionId) this.activeSessionId = null;
    this.aborters.delete(sessionId);
  }

  cancel(sessionId: string): boolean {
    if (!this.sessions.has(sessionId)) return false;
    this.aborters.get(sessionId)?.abort();
    this.settle(sessionId, 'error', 'login: cancelled');
    return true;
  }

  /** Read a flow's status (token-free), or null when unknown/expired. */
  get(sessionId: string): CodexFlowState | null {
    this.sweep();
    return this.sessions.get(sessionId) ?? null;
  }

  /** Drop expired flows; free the active slot if the active flow expired. */
  private sweep(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now - s.createdAt > this.ttlMs) {
        this.sessions.delete(id);
        if (this.activeSessionId === id) this.activeSessionId = null;
      }
    }
  }
}

/** The deps the codex OAuth handlers need (a subset of `AdminApiDeps`). */
export interface CodexOAuthDeps {
  readonly codexSessions: CodexOAuthSessionStore;
  readonly codexAwaitLoopback: CodexLoopbackFn;
  readonly oauthExchangeFetch: FetchLike;
  readonly subscriptionAccountAppender: SubscriptionAccountAppender;
}

function err(status: number, message: string): OAuthHandlerResult {
  return { status, body: { error: { type: 'admin_api_error', message } } };
}

/**
 * `start` — build codex authorize params, arm the loopback listener async, return
 * ONLY `{ authUrl, sessionId }`. Rejects (409) when a codex sign-in is already in
 * flight (the single loopback port is held).
 */
export function handleCodexOAuthStart(deps: CodexOAuthDeps): OAuthHandlerResult {
  if (deps.codexSessions.isBusy()) {
    return err(
      409,
      'a codex sign-in is already in progress (loopback 127.0.0.1:1455 is held) — finish it in the browser or wait for it to time out',
    );
  }
  const { authUrl, codeVerifier, state } = codexOAuth.generateAuthParams();
  const { sessionId, signal } = deps.codexSessions.begin();
  // Arm the loopback ASYNC (fire-and-forget). The token NEVER crosses to the
  // client — captured + exchanged + persisted entirely daemon-side; the app POLLS.
  void runCodexLoopback(sessionId, codeVerifier, state, signal, deps);
  return { status: 200, body: { authUrl, sessionId } };
}

/** The async capture→exchange→persist, settling the flow's polled status. */
async function runCodexLoopback(
  sessionId: string,
  codeVerifier: string,
  state: string,
  signal: AbortSignal,
  deps: CodexOAuthDeps,
): Promise<void> {
  try {
    const code = await deps.codexAwaitLoopback(state, undefined, signal);
    const result = await codexOAuth.exchangeCodeForTokens(
      { authorizationCode: code, codeVerifier, state },
      deps.oauthExchangeFetch,
    );
    const expiresAt = new Date(Date.now() + result.expiresIn * 1000).toISOString();
    const block: CodexTokenConfig = {
      authMethod: 'oauth',
      status: 'authorized',
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      idToken: result.idToken,
      expiresAt,
      lastRefreshedAt: new Date().toISOString(),
    };
    await deps.subscriptionAccountAppender.appendProviderAccount('codex', block);
    deps.codexSessions.settle(sessionId, 'done');
  } catch (e) {
    // NEVER include a token — reference only the loopback/exchange failure.
    const reason = e instanceof Error ? e.message : 'codex sign-in failed';
    deps.codexSessions.settle(sessionId, 'error', reason);
  }
}

export function handleCodexOAuthCancel(sessionId: string, deps: CodexOAuthDeps): OAuthHandlerResult {
  if (!deps.codexSessions.cancel(sessionId)) return err(404, 'unknown or expired codex sign-in session');
  return { status: 200, body: { ok: true } };
}

/**
 * `status` — token-free poll for a codex sign-in flow. Returns `{ state, message? }`
 * (404 when the session is unknown/expired). NEVER carries a token.
 */
export function handleCodexOAuthStatus(sessionId: string, deps: CodexOAuthDeps): OAuthHandlerResult {
  const s = deps.codexSessions.get(sessionId);
  if (!s) return err(404, 'unknown or expired codex sign-in session');
  return { status: 200, body: { state: s.status, ...(s.error ? { message: s.error } : {}) } };
}
