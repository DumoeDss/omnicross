/**
 * SubscriptionAccountService — the single resolver between the credential store and
 * the dispatch proxy for subscription-mode dispatch.
 *
 * Responsibilities:
 *   - Hold long-lived `AuthStrategy` instances for each subscription provider.
 *   - Share a single `RefreshMutex` across all strategies so concurrent 401s
 *     for the same provider collapse into one upstream refresh call.
 *   - Expose `listAll()` / `getStatus()` for the `subscription:status` and
 *     `subscription:list` IPC channels.
 */

import type {
  SubscriptionListEntry,
  SubscriptionProviderId,
  SubscriptionStatusEntry,
} from '@omnicross/contracts/subscription-types';

import {
  type AuthStrategy,
  OAuthBearerAuthStrategy,
  PassThroughAuthStrategy,
  RefreshMutex,
  StaticBearerAuthStrategy,
} from './auth';
import type { SubscriptionCredentialStore } from './ports/credential-store';

const DISPLAY_NAMES: Record<SubscriptionProviderId, string> = {
  claude: 'Claude (Anthropic OAuth)',
  codex: 'Codex (ChatGPT OAuth)',
  gemini: 'Gemini (Google OAuth)',
  opencodego: 'OpenCodeGo (Bearer key)',
};

export class SubscriptionAccountService {
  private readonly mutex = new RefreshMutex<boolean>();
  private readonly strategies: Map<SubscriptionProviderId, AuthStrategy>;

  constructor(tokens: SubscriptionCredentialStore) {
    this.strategies = new Map<SubscriptionProviderId, AuthStrategy>([
      ['claude', new PassThroughAuthStrategy(tokens, this.mutex)],
      ['codex', new OAuthBearerAuthStrategy('codex', tokens, this.mutex)],
      ['gemini', new OAuthBearerAuthStrategy('gemini', tokens, this.mutex)],
      ['opencodego', new StaticBearerAuthStrategy(tokens)],
    ]);
  }

  /** Returns the strategy bound to a subscription provider, or `null` for unknown ids. */
  getStrategy(providerId: SubscriptionProviderId): AuthStrategy | null {
    return this.strategies.get(providerId) ?? null;
  }

  /** Diagnostic for the `subscription:status` IPC. */
  async getStatus(providerId: SubscriptionProviderId): Promise<SubscriptionStatusEntry> {
    const strategy = this.strategies.get(providerId);
    if (!strategy) {
      return { providerId, ok: false, reason: 'unknown' };
    }
    return strategy.describeStatus();
  }

  /** Catalog entry list for the `subscription:list` IPC. */
  async listAll(): Promise<SubscriptionListEntry[]> {
    const entries: SubscriptionListEntry[] = [];
    for (const [providerId, strategy] of this.strategies.entries()) {
      entries.push({
        providerId,
        displayName: DISPLAY_NAMES[providerId],
        kind: strategy.kind,
        credentialStatus: await strategy.describeStatus(),
      });
    }
    return entries;
  }
}

let _moduleSingleton: SubscriptionAccountService | null = null;

/** Set once at host bootstrap; consumed by the host's router + engine wiring. */
export function setSubscriptionAccountService(svc: SubscriptionAccountService): void {
  _moduleSingleton = svc;
}

/** Returns the singleton if it has been set, else `null` (don't throw — callers
 *  may run before main wiring on early-boot diagnostics). */
export function getSubscriptionAccountService(): SubscriptionAccountService | null {
  return _moduleSingleton;
}
