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
import {
  CodexAllowanceCollector,
  type CodexAllowanceCredentialReader,
} from './CodexAllowanceCollector';
import {
  KimiAllowanceCollector,
  type KimiAllowanceCredentialReader,
} from './KimiAllowanceCollector';
import {
  GrokAllowanceCollector,
  type GrokAllowanceCredentialReader,
} from './GrokAllowanceCollector';
import {
  OpenCodeGoAllowanceCollector,
  type OpenCodeGoAllowanceCredentialReader,
} from './OpenCodeGoAllowanceCollector';

/**
 * The credential surface the collectors share. Declared explicitly (not via
 * interface extension) because the collectors narrow
 * `getAccessTokenForAccount`/`refreshAccountToken` to different provider
 * literals — extending them all would make the overloads conflict.
 */
export interface AccountAllowanceCredentialReader {
  getAccessTokenForAccount(
    providerId: 'claude' | 'codex' | 'kimi' | 'opencodego' | 'grok',
    accountId: string,
  ): Promise<string | null>;
  refreshAccountToken(
    providerId: 'claude' | 'codex' | 'kimi' | 'grok',
    accountId: string,
  ): Promise<boolean>;
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
  readonly codexCollector: CodexAllowanceCollector;
  readonly kimiCollector: KimiAllowanceCollector;
  readonly grokCollector: GrokAllowanceCollector;
  readonly opencodegoCollector: OpenCodeGoAllowanceCollector;

  constructor(
    private readonly credentials: AccountAllowanceCredentialReader,
    private readonly store: AccountAllowanceStore = getSharedAccountAllowanceStore(),
    collector?: ClaudeAllowanceCollector,
    codexCollector?: CodexAllowanceCollector,
    kimiCollector?: KimiAllowanceCollector,
    opencodegoCollector?: OpenCodeGoAllowanceCollector,
    grokCollector?: GrokAllowanceCollector,
    private readonly now: () => number = Date.now,
  ) {
    this.claudeCollector = collector ?? new ClaudeAllowanceCollector(credentials, store);
    this.codexCollector = codexCollector ?? new CodexAllowanceCollector(credentials, store);
    this.kimiCollector = kimiCollector ?? new KimiAllowanceCollector(credentials, store);
    this.opencodegoCollector =
      opencodegoCollector ?? new OpenCodeGoAllowanceCollector(credentials, store);
    this.grokCollector = grokCollector ?? new GrokAllowanceCollector(credentials, store);
  }

  /**
   * Read all/filtered snapshots. Claude's and Codex's five-minute caches are
   * refreshed lazily on read (Codex polls `/backend-api/wham/usage`; the
   * passive `x-codex-*` header tap still feeds mid-flight updates).
   */
  async list(filter: AccountAllowanceFilter = {}): Promise<AccountAllowanceSnapshot[]> {
    const config = await this.credentials.getFullConfig();
    // Reconcile the durable cache against the current account registry before
    // projecting any rows. This removes deleted-account snapshots even when the
    // deleted account has never been refreshed again.
    this.store.pruneToKnownAccounts(this.knownAccounts(config));
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
      await this.codexCollector.collectMany(codexAccounts);
      for (const account of codexAccounts) {
        if (!this.store.get('codex', account.id)) this.store.set(codexUnavailable(account.id, this.now()));
      }
    }

    const wantsKimi = !filter.providerId || filter.providerId === 'kimi';
    const kimiAccounts = (config.kimiAccounts ?? []).filter(
      (account) => !filter.accountId || account.id === filter.accountId,
    );
    if (wantsKimi) await this.kimiCollector.collectMany(kimiAccounts);

    const wantsOpenCodeGo = !filter.providerId || filter.providerId === 'opencodego';
    const opencodegoAccounts = (config.opencodegoAccounts ?? []).filter(
      (account) => !filter.accountId || account.id === filter.accountId,
    );
    if (wantsOpenCodeGo) await this.opencodegoCollector.collectMany(opencodegoAccounts);

    const wantsGrok = !filter.providerId || filter.providerId === 'grok';
    const grokAccounts = (config.grokAccounts ?? []).filter(
      (account) => !filter.accountId || account.id === filter.accountId,
    );
    if (wantsGrok) await this.grokCollector.collectMany(grokAccounts);

    const known = new Set<string>();
    if (wantsClaude) for (const account of claudeAccounts) known.add(`claude\0${account.id}`);
    if (wantsCodex) for (const account of codexAccounts) known.add(`codex\0${account.id}`);
    if (wantsKimi) for (const account of kimiAccounts) known.add(`kimi\0${account.id}`);
    if (wantsOpenCodeGo) for (const account of opencodegoAccounts) known.add(`opencodego\0${account.id}`);
    if (wantsGrok) for (const account of grokAccounts) known.add(`grok\0${account.id}`);

    return this.store
      .list(filter)
      .filter((snapshot) => known.has(`${snapshot.providerId}\0${snapshot.accountId}`));
  }

  private knownAccounts(config: AccountTokensConfig) {
    return [
      ...(config.claudeAccounts ?? []).map((account) => ({ providerId: 'claude' as const, accountId: account.id })),
      ...(config.codexAccounts ?? []).map((account) => ({ providerId: 'codex' as const, accountId: account.id })),
      ...(config.kimiAccounts ?? []).map((account) => ({ providerId: 'kimi' as const, accountId: account.id })),
      ...(config.opencodegoAccounts ?? []).map((account) => ({ providerId: 'opencodego' as const, accountId: account.id })),
      ...(config.grokAccounts ?? []).map((account) => ({ providerId: 'grok' as const, accountId: account.id })),
    ];
  }

  /** Force-refresh Claude usage for one account or every stored Claude account. */
  async refreshClaude(accountId?: string): Promise<AccountAllowanceSnapshot[]> {
    const config = await this.credentials.getFullConfig();
    this.store.pruneToKnownAccounts(this.knownAccounts(config));
    const accounts = (config.claudeAccounts ?? []).filter(
      (account) => !accountId || account.id === accountId,
    );
    return this.claudeCollector.collectMany(accounts, { force: true });
  }

  /**
   * Force-refresh Codex usage (`/backend-api/wham/usage`) for one account or
   * every stored Codex account. Replaces the old probe-request workaround —
   * no quota is spent reading the usage endpoint.
   */
  async refreshCodex(accountId?: string): Promise<AccountAllowanceSnapshot[]> {
    const config = await this.credentials.getFullConfig();
    this.store.pruneToKnownAccounts(this.knownAccounts(config));
    const accounts = (config.codexAccounts ?? []).filter(
      (account) => !accountId || account.id === accountId,
    );
    return this.codexCollector.collectMany(accounts, { force: true });
  }

  /** Force-refresh OpenCodeGo usage (`{go}/v1/usage`) for one/all accounts. */
  async refreshOpenCodeGo(accountId?: string): Promise<AccountAllowanceSnapshot[]> {
    const config = await this.credentials.getFullConfig();
    this.store.pruneToKnownAccounts(this.knownAccounts(config));
    const accounts = (config.opencodegoAccounts ?? []).filter(
      (account) => !accountId || account.id === accountId,
    );
    return this.opencodegoCollector.collectMany(accounts, { force: true });
  }

  /** Force-refresh Kimi usage (`/coding/v1/usages`) for one/all accounts. */
  async refreshKimi(accountId?: string): Promise<AccountAllowanceSnapshot[]> {
    const config = await this.credentials.getFullConfig();
    this.store.pruneToKnownAccounts(this.knownAccounts(config));
    const accounts = (config.kimiAccounts ?? []).filter(
      (account) => !accountId || account.id === accountId,
    );
    return this.kimiCollector.collectMany(accounts, { force: true });
  }

  /** Force-refresh Grok usage (CLI billing proxy) for one/all accounts. */
  async refreshGrok(accountId?: string): Promise<AccountAllowanceSnapshot[]> {
    const config = await this.credentials.getFullConfig();
    this.store.pruneToKnownAccounts(this.knownAccounts(config));
    const accounts = (config.grokAccounts ?? []).filter(
      (account) => !accountId || account.id === accountId,
    );
    return this.grokCollector.collectMany(accounts, { force: true });
  }

  /**
   * Keep Claude + Codex + Kimi snapshots warm for allowance-aware routing. All
   * collectors preserve their cache + per-account in-flight coalescing; a tick
   * normally performs no network I/O. (Codex joined the warm path when it
   * gained an active `/wham/usage` collector — the passive `x-codex-*` header
   * tap alone could not keep the policy fed while idle.)
   */
  async maintainClaudeCache(refreshAheadMs: number): Promise<void> {
    const config = await this.credentials.getFullConfig();
    this.store.pruneToKnownAccounts(this.knownAccounts(config));
    await this.claudeCollector.collectMany(config.claudeAccounts ?? [], { refreshAheadMs });
    await this.codexCollector.collectMany(config.codexAccounts ?? [], { refreshAheadMs });
    await this.kimiCollector.collectMany(config.kimiAccounts ?? [], { refreshAheadMs });
    await this.opencodegoCollector.collectMany(config.opencodegoAccounts ?? [], { refreshAheadMs });
    await this.grokCollector.collectMany(config.grokAccounts ?? [], { refreshAheadMs });
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
