/**
 * oauthSessions — the in-memory pending-OAuth-session store for the admin HTTP
 * two-phase login (`POST /accounts/:providerId/oauth/{start,complete}`,
 * app-parity child 4, design D1).
 *
 * `start` mints a crypto-random `sessionId` and stashes the per-session PKCE
 * `{ providerId, codeVerifier, state }` here; `complete` does a SINGLE-USE
 * `take(sessionId)` (returns + deletes) and exchanges the code. The map is
 * NEVER serialized to the client — only the opaque `sessionId` + the public
 * `authUrl` cross the wire. Sessions are short-lived (OQ3 = 10-min TTL); a sweep
 * reaps abandoned sessions, and `take` re-checks the TTL so an expired-but-not-
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
   * SINGLE-USE consume: return + delete the session for `sessionId`, or `null`
   * when it is unknown, already used, or past its TTL (in which case it is
   * dropped). A `null` return means the completer must reject (no exchange, no
   * write).
   */
  take(sessionId: string): PendingOAuthSession | null {
    this.sweep();
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    this.sessions.delete(sessionId);
    if (Date.now() - session.createdAt > this.ttlMs) return null;
    return session;
  }

  /** Drop every session past its TTL. Called on each put/take. */
  private sweep(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.createdAt > this.ttlMs) this.sessions.delete(id);
    }
  }
}
