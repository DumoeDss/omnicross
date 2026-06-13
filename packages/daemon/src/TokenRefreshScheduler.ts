/**
 * TokenRefreshScheduler — proactive background OAuth token refresh
 * (external-cli-sync).
 *
 * The auth strategies already refresh LAZILY (lead-window check before each
 * request + 401 retry), but a daemon that sits idle past a token's lifetime
 * pays the refresh latency — or a dead rotated token — on the first request.
 * This scheduler sweeps every account of every OAuth provider on an interval
 * and refreshes any token entering the expiry lead window.
 *
 * Safety properties:
 *  - the store coalesces in-flight refreshes per account, so a sweep can never
 *    double-spend a single-use refresh token against a concurrent lazy refresh;
 *  - accounts already flagged `expired` are skipped (a dead refresh token is
 *    not retried every tick — recovery is the external-import fallback or a
 *    re-login);
 *  - the ACTIVE account routes through the provider's active refresher (which
 *    carries the external CLI import fallback); non-active accounts refresh
 *    by id;
 *  - one sweep runs at a time (a long sweep never overlaps the next tick).
 *
 * Modeled on `ApiKeyPoolService`'s interval lifecycle: `start()` arms an
 * `unref()`ed timer, `dispose()` clears it.
 *
 * @module @omnicross/daemon/TokenRefreshScheduler
 */

import type { Logger } from '@omnicross/core';

import * as accountMulti from './ports/account-multi';
import type { JsonSubscriptionCredentialStore } from './ports/JsonSubscriptionCredentialStore';

/** Refresh when a token expires within this window (mirrors the strategies). */
const REFRESH_LEAD_MS = 5 * 60_000;

/** Sweep cadence. */
const SWEEP_INTERVAL_MS = 60_000;

const OAUTH_PROVIDERS = ['claude', 'codex', 'gemini'] as const;
type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export class TokenRefreshScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  constructor(
    private readonly store: JsonSubscriptionCredentialStore,
    private readonly logger: Logger,
    private readonly intervalMs: number = SWEEP_INTERVAL_MS,
    private readonly leadMs: number = REFRESH_LEAD_MS,
  ) {}

  /** Arm the sweep interval. Idempotent. The timer never holds the loop open. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sweep(), this.intervalMs);
    this.timer.unref?.();
  }

  /** Clear the interval (daemon shutdown / test teardown). Idempotent. */
  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One sweep over every account of every OAuth provider. Exposed for tests. */
  async sweep(now: number = Date.now()): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const config = await this.store.getFullConfig();
      for (const provider of OAUTH_PROVIDERS) {
        const activeId = accountMulti.getActiveAccount(config, provider)?.id;
        for (const account of accountMulti.listAccounts(config, provider)) {
          if (!this.needsRefresh(account.tokens, now)) continue;
          await this.refreshOne(provider, account.id, account.id === activeId);
        }
      }
    } catch (error) {
      this.logger.warn('token-refresh sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.sweeping = false;
    }
  }

  /** Expiring within the lead window, refreshable, and not already dead. */
  private needsRefresh(tokens: accountMulti.AnyTokenConfig, now: number): boolean {
    const t = tokens as { refreshToken?: string; expiresAt?: string; status?: string };
    if (!t.refreshToken || t.status === 'expired' || t.status === 'error') return false;
    if (!t.expiresAt) return false; // non-expiring (or unknown) ⇒ nothing to do
    const expiresAt = Date.parse(t.expiresAt);
    return Number.isFinite(expiresAt) && now >= expiresAt - this.leadMs;
  }

  /** Refresh one account; failures are logged, never thrown (the store has
   *  already flagged the account `expired`). */
  private async refreshOne(provider: OAuthProvider, id: string, isActive: boolean): Promise<void> {
    try {
      // The ACTIVE account goes through the provider refresher so the external
      // CLI import fallback applies; others refresh by id.
      const ok = isActive
        ? await this.refreshActive(provider)
        : await this.store.refreshAccountById(provider, id);
      if (!ok) {
        this.logger.warn('background token refresh failed', { provider, accountId: id });
      } else {
        this.logger.info('background token refresh succeeded', { provider, accountId: id });
      }
    } catch (error) {
      this.logger.warn('background token refresh threw', {
        provider,
        accountId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private refreshActive(provider: OAuthProvider): Promise<boolean> {
    switch (provider) {
      case 'claude':
        return this.store.refreshClaudeToken();
      case 'codex':
        return this.store.refreshCodexToken();
      case 'gemini':
        return this.store.refreshGeminiToken();
    }
  }
}
