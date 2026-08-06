/**
 * oauthSessions — the in-memory pending-OAuth-session store for the admin HTTP
 * two-phase login (`POST /accounts/:providerId/oauth/{start,complete}`,
 * app-parity child 4, design D1).
 *
 * `start` mints a crypto-random `sessionId` and stashes the per-session PKCE
 * `{ providerId, codeVerifier, state }` here; `complete` `peek`s the session,
 * exchanges the code, and `consume`s it ONLY once a token was minted — so a
 * failed exchange leaves the session retryable instead of burning it. The map is
 * NEVER serialized to the client — only the opaque `sessionId` + the public
 * `authUrl` cross the wire. Sessions are short-lived (OQ3 = 10-min TTL); a sweep
 * reaps abandoned sessions, and `peek` re-checks the TTL so an expired-but-not-
 * yet-swept session is still rejected. A daemon restart simply drops in-flight
 * logins (correct fail-safe — no partial token is ever written).
 *
 * SECRET SPINE: the `codeVerifier` is a PKCE secret-ish value (useless without
 * the matching `code`); it never leaves this module. No token is ever stored
 * here — the exchanged token lands ONLY through the encrypted credential store.
 *
 * @module @omnicross/daemon/admin/oauthSessions
 */

import crypto from 'node:crypto';

import type { SubscriptionProviderId } from '@omnicross/contracts/subscription-types';

/** One pending OAuth session (NEVER serialized to the client). */
export interface PendingOAuthSession {
  readonly providerId: SubscriptionProviderId;
  /** PKCE verifier — secret-ish; stays daemon-side, never echoed. */
  readonly codeVerifier: string;
  /** CSRF state minted with the auth params (validated on complete). */
  readonly state: string;
  /** Epoch ms the session was created (for the TTL sweep + take re-check). */
  readonly createdAt: number;
}

/** Default single-use session TTL (OQ3 — matches the CLI loopback timeout). */
export const DEFAULT_OAUTH_SESSION_TTL_MS = 10 * 60 * 1000;

/**
 * Module-scoped store for pending OAuth sessions. A single instance is created
 * per daemon (in `bootstrap.ts`) and wired through `AdminApiDeps`. The TTL sweep
 * runs lazily on each `put`/`take` (no background timer to leak across tests).
 */
export class OAuthSessionStore {
  private readonly sessions = new Map<string, PendingOAuthSession>();

  constructor(private readonly ttlMs: number = DEFAULT_OAUTH_SESSION_TTL_MS) {}

  /**
   * Mint a fresh opaque `sessionId`, stash the pending session, and return the
   * id. Sweeps expired entries first so the map never grows unbounded.
   */
  put(session: Omit<PendingOAuthSession, 'createdAt'>): string {
    this.sweep();
    const sessionId = crypto.randomBytes(24).toString('base64url');
    this.sessions.set(sessionId, { ...session, createdAt: Date.now() });
    return sessionId;
  }

  /**
   * NON-DESTRUCTIVE lookup: return the session for `sessionId`, or `null` when
   * it is unknown, already consumed, or past its TTL (an expired entry is
   * dropped here). A `null` return means the completer must reject (no
   * exchange, no write).
   *
   * Deliberately NOT a consume: the completer peeks, runs the token exchange,
   * and only {@link consume}s once a token has actually been minted. Consuming
   * up-front burned the session on EVERY failed exchange (a mistyped/expired
   * pasted code, a proxy hiccup), so the user's natural retry hit
   * "session is unknown, expired, or already used" and the login became
   * unrecoverable without restarting the whole flow.
   */
  peek(sessionId: string): PendingOAuthSession | null {
    this.sweep();
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (Date.now() - session.createdAt > this.ttlMs) {
      this.sessions.delete(sessionId);
      return null;
    }
    return session;
  }

  /**
   * SINGLE-USE burn: drop the session so the same `sessionId` can never be
   * completed twice. Called ONLY after a successful token exchange.
   */
  consume(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Drop every session past its TTL. Called on each put/peek. */
  private sweep(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.createdAt > this.ttlMs) this.sessions.delete(id);
    }
  }
}
