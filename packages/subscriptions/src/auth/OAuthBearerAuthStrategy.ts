/**
 * OAuthBearerAuthStrategy — Codex / Gemini subscription path.
 *
 * Reads the current access token from the injected `SubscriptionCredentialStore`, refreshing within
 * 60 seconds of expiry before applying it as `Authorization: Bearer`.
 * On 401 it triggers a refresh and asks the proxy to retry once. Concurrent
 * 401s collapse via a shared `RefreshMutex`.
 */

import type { SubscriptionStatusEntry } from '@omnicross/contracts/subscription-types';
import type { SubscriptionAccountHealth } from '@omnicross/core/pipeline/SubscriptionAccountHealth';

import type { SubscriptionCredentialStore } from '../ports/credential-store';
import { COPILOT_API_HEADERS } from '../oauth/flows/copilot';
import { kimiFingerprintHeaders } from '../oauth/flows/kimi';
import { refreshSelectedAccount, resolveSelectedToken } from '../scheduler/accountSelection';
import type { SubscriptionAccountSelector } from '../scheduler/SubscriptionAccountSelector';

import type { AuthApplyHints, AuthStrategy } from './AuthStrategy';
import type { RefreshMutex } from './RefreshMutex';

/** Refresh expiring tokens this many ms before they hit `expiresAt`. */
const REFRESH_LEAD_MS = 5 * 60_000;

type OAuthProviderKey = 'codex' | 'gemini' | 'kimi' | 'grok' | 'copilot';

/** The per-provider token config block each strategy branch reads. */
type OAuthTokenBlock = { accessToken?: string; refreshToken?: string; expiresAt?: string; status?: string };

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
    /** Shared account health tracker (subscription-account-health). Absent ⇒ no
     *  health gating (all accounts schedulable). */
    private readonly health?: SubscriptionAccountHealth,
  ) {
    this.providerId = providerId;
  }

  async applyHeaders(headers: Record<string, string>, hints?: AuthApplyHints): Promise<void> {
    // Account pool: a non-active pick resolves that account's token by id (with
    // the by-id near-expiry refresh inside `getAccessTokenForAccount`); otherwise
    // the active `resolveAccessToken()` path runs verbatim.
    const token = await resolveSelectedToken(
      this.selector,
      this.tokens,
      this.providerId,
      hints?.sessionKey,
      () => this.resolveAccessToken(),
      {
        health: this.health,
        reportSelection: hints?.reportSelection,
        resolvedModel: hints?.resolvedModel,
        preferredAccountId: hints?.preferredAccountId,
        preferredAccountGroup: hints?.preferredAccountGroup,
        boundAccountFallbackPolicy: hints?.boundAccountFallbackPolicy,
      },
    );
    if (!token) {
      // Don't throw — let the upstream call surface the actual 401/403 with
      // its native body so the SDK can render a meaningful error.
      return;
    }
    headers['Authorization'] = `Bearer ${token}`;
    // Kimi expects the CLI fingerprint headers on every call; the device id is
    // the selected account's own (fall back to the active block's).
    if (this.providerId === 'kimi') {
      const deviceId = await this.resolveKimiDeviceId(hints?.sessionKey);
      Object.assign(headers, kimiFingerprintHeaders(deviceId));
    }
    // The Copilot API hard-gates on the mirrored CLI identity set (the API
    // version header also unlocks long-context tier limits).
    if (this.providerId === 'copilot') {
      Object.assign(headers, COPILOT_API_HEADERS);
    }
  }

  async onUnauthorized(sessionKey?: string): Promise<boolean> {
    const byId = await refreshSelectedAccount(this.selector, this.tokens, this.mutex, this.providerId, sessionKey);
    if (byId !== null) return byId;
    return this.mutex.run(`${this.providerId}:refresh`, async () => {
      try {
        return this.refreshActive();
      } catch (err) {
        console.warn(`[OAuthBearerAuthStrategy] ${this.providerId} refresh failed:`, err);
        return false;
      }
    });
  }

  async describeStatus(): Promise<SubscriptionStatusEntry> {
    const config = await this.tokens.getFullConfig();
    const entry = this.tokenBlock(config);
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
    const entry = this.tokenBlock(config);
    if (!entry?.accessToken) return null;

    const expiresAtMs = entry.expiresAt ? new Date(entry.expiresAt).getTime() : 0;
    const expiringSoon = expiresAtMs > 0 && Date.now() >= expiresAtMs - REFRESH_LEAD_MS;

    if (expiringSoon && entry.refreshToken) {
      const refreshed = await this.mutex.run(`${this.providerId}:refresh`, async () => {
        return this.refreshActive();
      });
      if (!refreshed) return null;
      const fresh = await this.tokens.getFullConfig();
      return this.tokenBlock(fresh)?.accessToken ?? null;
    }

    if (entry.status === 'expired') return null;
    return entry.accessToken;
  }

  /** The active account's refresh, dispatched per provider. */
  private refreshActive(): Promise<boolean> {
    switch (this.providerId) {
      case 'codex':
        return this.tokens.refreshCodexToken();
      case 'gemini':
        return this.tokens.refreshGeminiToken();
      case 'kimi':
        // Optional on the port (lightweight test doubles); absent = failed.
        return this.tokens.refreshKimiToken ? this.tokens.refreshKimiToken() : Promise.resolve(false);
      case 'grok':
        return this.tokens.refreshGrokToken ? this.tokens.refreshGrokToken() : Promise.resolve(false);
      case 'copilot':
        return this.tokens.refreshCopilotToken ? this.tokens.refreshCopilotToken() : Promise.resolve(false);
    }
  }

  private tokenBlock(config: Awaited<ReturnType<SubscriptionCredentialStore['getFullConfig']>>): OAuthTokenBlock | undefined {
    switch (this.providerId) {
      case 'codex':
        return config.codex;
      case 'gemini':
        return config.gemini;
      case 'kimi':
        return config.kimi;
      case 'grok':
        return config.grok;
      case 'copilot':
        return config.copilot;
    }
  }

  /**
   * Best-effort device id for the fingerprint header. Selection already ran in
   * `applyHeaders`; rather than re-deriving it, read the active block's id (a
   * pool-served non-active account momentarily reports the active id — the
   * header is per-INSTALL identity, so this is cosmetic, not auth).
   */
  private async resolveKimiDeviceId(_sessionKey: string | undefined): Promise<string | undefined> {
    void _sessionKey;
    const config = await this.tokens.getFullConfig();
    return config.kimi?.deviceId ?? config.kimiAccounts?.[0]?.tokens.deviceId;
  }
}
