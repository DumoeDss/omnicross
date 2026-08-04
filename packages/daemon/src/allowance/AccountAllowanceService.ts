/** Secret-free account allowance query/refresh facade used by the admin API. */

import type { AccountAllowanceSnapshot } from '@omnicross/contracts/account-allowance-types';
import type { AccountTokensConfig } from '@omnicross/contracts/account-tokens-types';
import type { SubscriptionProviderId } from '@omnicross/contracts/subscription-types';
import {
  AccountAllowanceStore,
  getSharedAccountAllowanceStore,
} from '@omnicross/core/pipeline/AccountAllowanceStore';
import {
  getSharedAccountAllowanceScheduling,
  type AllowanceSchedulingDecision,
} from '@omnicross/core/pipeline/AccountAllowanceScheduling';
import type { AllowanceSchedulingConfig } from '@omnicross/core/outbound-api';

import {
  ClaudeAllowanceCollector,
  type ClaudeAllowanceCredentialReader,
} from './ClaudeAllowanceCollector';

export interface AccountAllowanceCredentialReader extends ClaudeAllowanceCredentialReader {
  getFullConfig(): Promise<AccountTokensConfig>;
}

export interface AccountAllowanceFilter {
  providerId?: SubscriptionProviderId;
  accountId?: string;
}

export interface AccountAllowanceSchedulingStatus {
  config: AllowanceSchedulingConfig;
  history: AllowanceSchedulingDecision[];
}

function codexUnavailable(accountId: string, now: number): AccountAllowanceSnapshot {
  return {
    providerId: 'codex',
    accountId,
    source: 'response-headers',
    observedAt: new Date(now).toISOString(),
    windows: [
      { id: 'primary', label: 'Primary', scope: 'all', usedPercent: null, state: 'unavailable' },
      { id: 'secondary', label: 'Secondary', scope: 'all', usedPercent: null, state: 'unavailable' },
    ],
    lastErrorCode: 'codex_allowance_not_observed',
  };
}

export class AccountAllowanceService {
  readonly claudeCollector: ClaudeAllowanceCollector;

  constructor(
    private readonly credentials: AccountAllowanceCredentialReader,
    private readonly store: AccountAllowanceStore = getSharedAccountAllowanceStore(),
    collector?: ClaudeAllowanceCollector,
    private readonly now: () => number = Date.now,
  ) {
    this.claudeCollector = collector ?? new ClaudeAllowanceCollector(credentials, store);
  }

  /**
   * Read all/filtered snapshots. Claude's five-minute cache is refreshed lazily;
   * Codex remains passive and reports not-observed until a real model response.
   */
  async list(filter: AccountAllowanceFilter = {}): Promise<AccountAllowanceSnapshot[]> {
    const config = await this.credentials.getFullConfig();
    // Reconcile the durable cache against the current account registry before
    // projecting any rows. This removes deleted-account snapshots even when the
    // deleted account has never been refreshed again.
    this.store.pruneToKnownAccounts([
      ...(config.claudeAccounts ?? []).map((account) => ({ providerId: 'claude' as const, accountId: account.id })),
      ...(config.codexAccounts ?? []).map((account) => ({ providerId: 'codex' as const, accountId: account.id })),
    ]);
    const wantsClaude = !filter.providerId || filter.providerId === 'claude';
    const claudeAccounts = (config.claudeAccounts ?? []).filter(
      (account) => !filter.accountId || account.id === filter.accountId,
    );
    if (wantsClaude) await this.claudeCollector.collectMany(claudeAccounts);

    const wantsCodex = !filter.providerId || filter.providerId === 'codex';
    const codexAccounts = (config.codexAccounts ?? []).filter(
      (account) => !filter.accountId || account.id === filter.accountId,
    );
    if (wantsCodex) {
      for (const account of codexAccounts) {
        if (!this.store.get('codex', account.id)) this.store.set(codexUnavailable(account.id, this.now()));
      }
    }

    const known = new Set<string>();
    if (wantsClaude) for (const account of claudeAccounts) known.add(`claude\0${account.id}`);
    if (wantsCodex) for (const account of codexAccounts) known.add(`codex\0${account.id}`);

    return this.store
      .list(filter)
      .filter((snapshot) => known.has(`${snapshot.providerId}\0${snapshot.accountId}`));
  }

  /** Force-refresh Claude usage for one account or every stored Claude account. */
  async refreshClaude(accountId?: string): Promise<AccountAllowanceSnapshot[]> {
    const config = await this.credentials.getFullConfig();
    this.store.pruneToKnownAccounts([
      ...(config.claudeAccounts ?? []).map((account) => ({ providerId: 'claude' as const, accountId: account.id })),
      ...(config.codexAccounts ?? []).map((account) => ({ providerId: 'codex' as const, accountId: account.id })),
    ]);
    const accounts = (config.claudeAccounts ?? []).filter(
      (account) => !accountId || account.id === accountId,
    );
    return this.claudeCollector.collectMany(accounts, { force: true });
  }

  /**
   * Keep Claude snapshots warm for allowance-aware routing. This deliberately
   * excludes Codex (whose quota is learned from real response headers) and
   * preserves the collector's cache + per-account in-flight coalescing.
   */
  async maintainClaudeCache(refreshAheadMs: number): Promise<void> {
    const config = await this.credentials.getFullConfig();
    this.store.pruneToKnownAccounts([
      ...(config.claudeAccounts ?? []).map((account) => ({ providerId: 'claude' as const, accountId: account.id })),
      ...(config.codexAccounts ?? []).map((account) => ({ providerId: 'codex' as const, accountId: account.id })),
    ]);
    await this.claudeCollector.collectMany(config.claudeAccounts ?? [], { refreshAheadMs });
  }

  /** Remove a cache row as soon as an account is deleted by the admin path. */
  removeAccountSnapshot(providerId: SubscriptionProviderId, accountId: string): void {
    this.store.delete(providerId, accountId);
  }

  /** Remove all allowance rows for a provider block that was deleted. */
  removeProviderSnapshots(providerId: SubscriptionProviderId): void {
    for (const snapshot of this.store.list({ providerId })) {
      this.store.delete(snapshot.providerId, snapshot.accountId);
    }
  }

  /** Secret-free policy diagnostics for the settings/accounts UI. */
  getSchedulingStatus(): AccountAllowanceSchedulingStatus {
    const scheduling = getSharedAccountAllowanceScheduling();
    return { config: scheduling.getConfig(), history: scheduling.getHistory() };
  }
}
