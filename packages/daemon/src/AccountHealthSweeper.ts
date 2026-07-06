/**
 * AccountHealthSweeper — proactive account-health recovery tick
 * (subscription-account-health, design D6).
 *
 * The health tracker (`@omnicross/core` `SubscriptionAccountHealth`) already
 * self-heals LAZILY: an elapsed cooldown restores an account on the next
 * `isSchedulable` read, so CORRECTNESS never depends on this sweeper. What the
 * tick adds is PROACTIVITY for IDLE accounts (no traffic to trigger a lazy read):
 *   - it fires the tracker's recovery SIGNAL (the seam #5 webhooks + #8
 *     health-cron consume — this child only emits it), and
 *   - it optionally nudges a fresh token for a recovered OAuth account so it
 *     resumes instantly instead of paying refresh latency on its first request.
 *
 * Modeled EXACTLY on `TokenRefreshScheduler`: `start()` arms an `unref()`ed 60s
 * timer, `dispose()` clears it, and a single-sweep re-entrancy guard means a
 * long sweep never overlaps the next tick.
 *
 * @module @omnicross/daemon/AccountHealthSweeper
 */

import type { Logger } from '@omnicross/core';
import type { SubscriptionAccountHealth } from '@omnicross/core/pipeline/SubscriptionAccountHealth';

import * as accountMulti from './ports/account-multi';
import type { JsonSubscriptionCredentialStore } from './ports/JsonSubscriptionCredentialStore';

/** Refresh a recovered account whose token expires within this window. */
const REFRESH_LEAD_MS = 5 * 60_000;

/** Sweep cadence (mirrors `TokenRefreshScheduler`). */
const SWEEP_INTERVAL_MS = 60_000;

/** OAuth providers whose recovered accounts can be nudged to refresh by id. */
const OAUTH_PROVIDERS = ['claude', 'codex', 'gemini'] as const;
type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

function isOAuthProvider(providerId: string): providerId is OAuthProvider {
  return (OAUTH_PROVIDERS as readonly string[]).includes(providerId);
}

export class AccountHealthSweeper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  constructor(
    private readonly store: JsonSubscriptionCredentialStore,
    private readonly health: SubscriptionAccountHealth,
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

  /**
   * One sweep: surface accounts that just recovered (emits the recovery signal
   * through the tracker's hook) and nudge a fresh token for any recovered OAuth
   * account whose token is near expiry. Exposed for tests. Never throws.
   */
  async sweep(now: number = Date.now()): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const recovered = this.health.sweepRecoveries(now);
      if (recovered.length === 0) return;
      const config = await this.store.getFullConfig();
      for (const event of recovered) {
        if (!isOAuthProvider(event.providerId)) continue;
        const account = accountMulti.getAccountById(config, event.providerId, event.accountId);
        if (!account || !this.needsRefresh(account.tokens, now)) continue;
        await this.refreshOne(event.providerId, event.accountId);
      }
    } catch (error) {
      this.logger.warn('account-health sweep failed', {
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
    if (!t.expiresAt) return false;
    const expiresAt = Date.parse(t.expiresAt);
    return Number.isFinite(expiresAt) && now >= expiresAt - this.leadMs;
  }

  /** Refresh one recovered account by id; failures are logged, never thrown. */
  private async refreshOne(provider: OAuthProvider, id: string): Promise<void> {
    try {
      const ok = await this.store.refreshAccountById(provider, id);
      if (ok) this.logger.info('account-health recovery refresh succeeded', { provider, accountId: id });
      else this.logger.warn('account-health recovery refresh failed', { provider, accountId: id });
    } catch (error) {
      this.logger.warn('account-health recovery refresh threw', {
        provider,
        accountId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
