/**
 * OAuthBearerAuthStrategy — Codex / Gemini subscription path.
 *
 * Reads the current access token from the injected `SubscriptionCredentialStore`, refreshing within
 * 60 seconds of expiry before applying it as `Authorization: Bearer`.
 * On 401 it triggers a refresh and asks the proxy to retry once. Concurrent
 * 401s collapse via a shared `RefreshMutex`.
 */

import type { SubscriptionStatusEntry } from '@omnicross/contracts/subscription-types';

import type { SubscriptionCredentialStore } from '../ports/credential-store';
import { refreshSelectedAccount, resolveSelectedToken } from '../scheduler/accountSelection';
import type { SubscriptionAccountSelector } from '../scheduler/SubscriptionAccountSelector';

import type { AuthApplyHints, AuthStrategy } from './AuthStrategy';
import type { RefreshMutex } from './RefreshMutex';

/** Refresh expiring tokens this many ms before they hit `expiresAt`. */
const REFRESH_LEAD_MS = 5 * 60_000;

type OAuthProviderKey = 'codex' | 'gemini';

export class OAuthBearerAuthStrategy implements AuthStrategy {
  readonly kind = 'oauth-bearer' as const;
  readonly providerId: OAuthProviderKey;

  constructor(
    providerId: OAuthProviderKey,
    private readonly tokens: SubscriptionCredentialStore,
    private readonly mutex: RefreshMutex<boolean>,
    /** Shared account-pool scheduler (subscription-account-scheduling). Absent ⇒
     *  the pre-change single-account active-mirror behavior. */
    private readonly selector?: SubscriptionAccountSelector,
  ) {
    this.providerId = providerId;
  }

  async applyHeaders(headers: Record<string, string>, hints?: AuthApplyHints): Promise<void> {
    // Account pool: a non-active pick resolves that account's token by id (with
    // the by-id near-expiry refresh inside `getAccessTokenForAccount`); otherwise
    // the active `resolveAccessToken()` path runs verbatim.
    const token = await resolveSelectedToken(this.selector, this.tokens, this.providerId, hints?.sessionKey, () =>
      this.resolveAccessToken(),
    );
    if (!token) {
      // Don't throw — let the upstream call surface the actual 401/403 with
      // its native body so the SDK can render a meaningful error.
      return;
    }
    headers['Authorization'] = `Bearer ${token}`;
  }

  async onUnauthorized(sessionKey?: string): Promise<boolean> {
    const byId = await refreshSelectedAccount(this.selector, this.tokens, this.mutex, this.providerId, sessionKey);
    if (byId !== null) return byId;
    return this.mutex.run(`${this.providerId}:refresh`, async () => {
      try {
        return this.providerId === 'codex'
          ? await this.tokens.refreshCodexToken()
          : await this.tokens.refreshGeminiToken();
      } catch (err) {
        console.warn(`[OAuthBearerAuthStrategy] ${this.providerId} refresh failed:`, err);
        return false;
      }
    });
  }

  async describeStatus(): Promise<SubscriptionStatusEntry> {
    const config = await this.tokens.getFullConfig();
    const entry = this.providerId === 'codex' ? config.codex : config.gemini;
    if (!entry?.accessToken) {
      return { providerId: this.providerId, ok: false, reason: 'missing-credential' };
    }
    if (entry.status === 'expired') {
      return {
        providerId: this.providerId,
        ok: false,
        reason: entry.refreshToken ? 'expired' : 'reauth-required',
        expiresAt: entry.expiresAt,
      };
    }
    return { providerId: this.providerId, ok: true, expiresAt: entry.expiresAt };
  }

  /** Read the current token, refreshing in-line if it's within the lead window. */
  private async resolveAccessToken(): Promise<string | null> {
    const config = await this.tokens.getFullConfig();
    const entry = this.providerId === 'codex' ? config.codex : config.gemini;
    if (!entry?.accessToken) return null;

    const expiresAtMs = entry.expiresAt ? new Date(entry.expiresAt).getTime() : 0;
    const expiringSoon = expiresAtMs > 0 && Date.now() >= expiresAtMs - REFRESH_LEAD_MS;

    if (expiringSoon && entry.refreshToken) {
      const refreshed = await this.mutex.run(`${this.providerId}:refresh`, async () => {
        return this.providerId === 'codex'
          ? await this.tokens.refreshCodexToken()
          : await this.tokens.refreshGeminiToken();
      });
      if (!refreshed) return null;
      const fresh = await this.tokens.getFullConfig();
      const freshEntry = this.providerId === 'codex' ? fresh.codex : fresh.gemini;
      return freshEntry?.accessToken ?? null;
    }

    if (entry.status === 'expired') return null;
    return entry.accessToken;
  }
}
