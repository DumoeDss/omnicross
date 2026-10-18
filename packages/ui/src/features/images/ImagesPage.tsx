/** Image instances and subscription accounts share the model-service layout. */

import {
  ChevronRight,
  Image as ImageIcon,
  Layers3,
  Plus,
  Search,
  UserRound,
  UsersRound,
} from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  accountSchedulingState,
  type ManagedAccountRow,
} from '@/features/accounts/accountManagementModel';
import { useAccounts } from '@/features/accounts/hooks/useAccounts';
import { AccountResourceDetails } from '@/features/upstreams/AccountResourceDetails';
import { AddAccountDialog } from '@/features/upstreams/AddAccountDialog';
import type { ImageApiProviderConfig, SubscriptionProviderId } from '@/daemon/types';
import type { LLMProvider } from '@shared/llm-config';
import { useTranslation } from '@/shared/state/LocaleContext';
import { useLlmProvidersData } from '@/shared/state/settingsStore';
import { useProviderKeyQuotaSummaries, type KeyQuotaSummaryWindow } from '@/features/upstreams/useProviderKeyQuota';
import { cn } from '@/shared/utils/utils';

import { ImagesSection } from './ImagesSection';
import { ImageProviderDetails } from './ImageProviderDetails';
import { ImageProviderDialog } from './ImageProviderDialog';
import { useImagesSettings } from './hooks/useImagesSettings';

export type ImagesTab = 'accounts' | 'advanced';

interface ImagesPageProps {
  imagesTab?: ImagesTab;
  onTabChange?: (tab: ImagesTab) => void;
}

/** Subscription pools whose accounts can serve image generation. */
const IMAGE_ACCOUNT_PROVIDERS = ['codex', 'antigravity'] as const;

type ImageResource =
  | { kind: 'account'; key: string; label: string; providerId: SubscriptionProviderId; account: ManagedAccountRow }
  | { kind: 'account-group'; key: string; label: string; providerId: SubscriptionProviderId; group: string; accounts: ManagedAccountRow[] }
  | { kind: 'account-pool'; key: string; label: string; providerId: SubscriptionProviderId; accounts: ManagedAccountRow[] }
  | { kind: 'provider'; key: string; label: string; providerId: string; provider: ImageApiProviderConfig; source?: LLMProvider };

interface AccountGroupBranch {
  resource: Extract<ImageResource, { kind: 'account-group' }>;
  accounts: Extract<ImageResource, { kind: 'account' }>[];
}

interface AccountPoolBranch {
  resource: Extract<ImageResource, { kind: 'account-pool' }>;
  groups: AccountGroupBranch[];
}

const resourceKey = {
  account: (providerId: string, accountId: string) => `account:${providerId}:${accountId}`,
  group: (providerId: string, group: string) => `group:${providerId}:${group}`,
  pool: (providerId: string) => `pool:${providerId}`,
  provider: (providerId: string) => `provider:${providerId}`,
};

function resourceSearchText(resource: ImageResource): string {
  if (resource.kind === 'account') {
    return `${resource.label} ${resource.account.id} ${resource.account.group} ${resource.providerId}`;
  }
  return `${resource.label} ${resource.providerId}`;
}

function resourceIsEnabled(resource: ImageResource): boolean {
  if (resource.kind === 'provider') return resource.provider.enabled !== false && resource.source?.enabled !== false;
  if (resource.kind === 'account') return resource.account.enabled !== false;
  return resource.accounts.some((account) => account.enabled !== false);
}

export function ImagesPage({ imagesTab, onTabChange }: ImagesPageProps) {
  const t = useTranslation();
  const activeTab: ImagesTab = imagesTab ?? 'accounts';
  const {
    loading,
    config,
    busy,
    error,
    updateImagesConfig,
    refresh,
  } = useImagesSettings();

  const accountsApi = useAccounts();
  const providersApi = useLlmProvidersData();

  const [addAccountOpen, setAddAccountOpen] = useState(false);
  const [addProviderOpen, setAddProviderOpen] = useState(false);

  // ── Resource tree (accounts tab) ────────────────────────────────
  const imageAccountRows = useMemo<ManagedAccountRow[]>(() => {
    const rows: ManagedAccountRow[] = [];
    for (const providerId of IMAGE_ACCOUNT_PROVIDERS) {
      for (const account of accountsApi.data.providerAccounts[providerId] ?? []) {
        const allowance = accountsApi.allowances.find(
          (snapshot) => snapshot.providerId === providerId && snapshot.accountId === account.id,
        );
        rows.push({
          ...account,
          providerId,
          enabled: account.enabled !== false,
          schedulable: account.schedulable ?? account.enabled !== false,
          group: account.group || providerId,
          tags: account.tags ?? [],
          allowance,
        });
      }
    }
    return rows;
  }, [accountsApi.allowances, accountsApi.data]);

  const resources = useMemo<ImageResource[]>(() => {
    const rows: ImageResource[] = imageAccountRows.map((account) => ({
      kind: 'account' as const,
      key: resourceKey.account(account.providerId, account.id),
      label: account.label || account.id,
      providerId: account.providerId,
      account,
    }));
    const groups = new Map<string, ManagedAccountRow[]>();
    for (const account of imageAccountRows) {
      const key = `${account.providerId}\0${account.group}`;
      groups.set(key, [...(groups.get(key) ?? []), account]);
    }
    for (const [key, members] of groups) {
      const [providerId, group] = key.split('\0') as [SubscriptionProviderId, string];
      rows.push({
        kind: 'account-group',
        key: resourceKey.group(providerId, group),
        label: group,
        providerId,
        group,
        accounts: members,
      });
    }
    const byProvider = new Map<SubscriptionProviderId, ManagedAccountRow[]>();
    for (const account of imageAccountRows) {
      byProvider.set(account.providerId, [...(byProvider.get(account.providerId) ?? []), account]);
    }
    for (const [providerId, members] of byProvider) {
      rows.push({
        kind: 'account-pool',
        key: resourceKey.pool(providerId),
        label: t(`accounts.provider.${providerId}.title`),
        providerId,
        accounts: members,
      });
    }
    // Shared storage supplies credentials only; it does not define image resources.
    for (const [id, provider] of Object.entries(config?.providers ?? {})) {
      const source = providersApi.providers.find((value) => value.id === provider.sourceProviderId);
      rows.push({
        kind: 'provider',
        key: resourceKey.provider(id),
        label: source?.name || id,
        providerId: id,
        provider,
        source,
      });
    }
    const kindOrder: Record<ImageResource['kind'], number> = {
      'account-pool': 0,
      'account-group': 1,
      account: 2,
      provider: 3,
    };
    return rows.sort((left, right) => kindOrder[left.kind] - kindOrder[right.kind]
      || left.label.localeCompare(right.label));
  }, [config?.providers, imageAccountRows, providersApi.providers, t]);

  const accountTree = useMemo<AccountPoolBranch[]>(() => {
    const pools: Array<Extract<ImageResource, { kind: 'account-pool' }>> = [];
    const groups: Array<Extract<ImageResource, { kind: 'account-group' }>> = [];
    const accounts: Array<Extract<ImageResource, { kind: 'account' }>> = [];
    for (const resource of resources) {
      if (resource.kind === 'account-pool') pools.push(resource);
      else if (resource.kind === 'account-group') groups.push(resource);
      else if (resource.kind === 'account') accounts.push(resource);
    }
    return pools.map((pool) => ({
      resource: pool,
      groups: groups
        .filter((group) => group.providerId === pool.providerId)
        .map((group) => ({
          resource: group,
          accounts: accounts
            .filter((account) => account.providerId === pool.providerId && account.account.group === group.group)
            .sort((left, right) => left.label.localeCompare(right.label)),
        }))
        .sort((left, right) => left.resource.label.localeCompare(right.resource.label)),
    }));
  }, [resources]);

  const keyQuotaSummaries = useProviderKeyQuotaSummaries(
    useMemo(() => [...new Set(Object.values(config?.providers ?? {}).map((provider) => provider.sourceProviderId))], [config?.providers]),
  );

  const [query, setQuery] = useState('');
  const [enabledOnly, setEnabledOnly] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [expandedResourceKeys, setExpandedResourceKeys] = useState<Set<string>>(() => new Set());
  const initializedAccountTree = useRef(false);

  const eligibleResources = useMemo(
    () => resources.filter((resource) => !enabledOnly || resourceIsEnabled(resource)),
    [enabledOnly, resources],
  );
  const filteredResources = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return eligibleResources
      .filter((resource) => !needle || resourceSearchText(resource).toLocaleLowerCase().includes(needle));
  }, [eligibleResources, query]);
  const filteredResourceKeys = useMemo(
    () => new Set(filteredResources.map((resource) => resource.key)),
    [filteredResources],
  );
  const eligibleResourceKeys = useMemo(
    () => new Set(eligibleResources.map((resource) => resource.key)),
    [eligibleResources],
  );
  const visibleAccountTree = useMemo<AccountPoolBranch[]>(() => accountTree.flatMap((pool) => {
    const poolMatchesQuery = filteredResourceKeys.has(pool.resource.key);
    const groups = pool.groups.flatMap((group) => {
      const groupMatchesQuery = filteredResourceKeys.has(group.resource.key);
      const revealDescendants = Boolean(query.trim()) && (poolMatchesQuery || groupMatchesQuery);
      const accounts = group.accounts.filter((account) => filteredResourceKeys.has(account.key)
        || (revealDescendants && eligibleResourceKeys.has(account.key)));
      const groupVisible = groupMatchesQuery
        || accounts.length
        || (poolMatchesQuery && eligibleResourceKeys.has(group.resource.key));
      return groupVisible
        ? [{ ...group, accounts }]
        : [];
    });
    return poolMatchesQuery || groups.length
      ? [{ ...pool, groups }]
      : [];
  }), [accountTree, eligibleResourceKeys, filteredResourceKeys, query]);
  const visibleProviders = useMemo(
    () => filteredResources.filter((resource): resource is Extract<ImageResource, { kind: 'provider' }> => resource.kind === 'provider'),
    [filteredResources],
  );

  const selectedResource = resources.find((resource) => resource.key === selectedKey)
    ?? filteredResources[0]
    ?? resources[0]
    ?? null;

  const selectResource = (resource: ImageResource) => {
    setSelectedKey(resource.key);
  };

  useEffect(() => {
    if (!selectedResource || selectedKey === selectedResource.key) return;
    setSelectedKey(selectedResource.key);
  }, [selectedKey, selectedResource]);

  useEffect(() => {
    if (initializedAccountTree.current || !accountTree.length) return;
    initializedAccountTree.current = true;
    setExpandedResourceKeys(new Set(accountTree.map((pool) => pool.resource.key)));
  }, [accountTree]);

  useEffect(() => {
    if (!selectedResource || selectedResource.kind === 'provider' || selectedResource.kind === 'account-pool') return;
    const ancestorKeys = [resourceKey.pool(selectedResource.providerId)];
    if (selectedResource.kind === 'account') {
      ancestorKeys.push(resourceKey.group(selectedResource.providerId, selectedResource.account.group));
    }
    setExpandedResourceKeys((current) => {
      if (ancestorKeys.every((key) => current.has(key))) return current;
      const next = new Set(current);
      ancestorKeys.forEach((key) => next.add(key));
      return next;
    });
  }, [selectedResource]);

  const toggleExpanded = (key: string) => {
    setExpandedResourceKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const filterForcesExpanded = Boolean(query.trim());

  const advancedContent = config ? (
    <div className="mx-auto max-w-3xl px-6 py-5">
      <ImagesSection
        key={JSON.stringify(config)}
        config={config}
        accounts={accountsApi.data.providerAccounts.codex ?? []}
        antigravityAccounts={accountsApi.data.providerAccounts.antigravity ?? []}
        sources={providersApi.providers}
        busy={busy}
        onUpdate={updateImagesConfig}
      />
    </div>
  ) : (
    <div className="mx-auto max-w-5xl px-6 py-5">
      <section className="rounded-xl border border-dashed border-border/70 p-4">
        <p className="text-sm font-semibold text-foreground">{t('images.page.title')}</p>
        <p className="mt-1 text-xs text-muted-foreground">{loading ? t('images.page.loading') : t('images.unsupportedDaemon')}</p>
      </section>
    </div>
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b border-border/70 bg-surface-0/80 px-5 py-4 md:px-6">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <ImageIcon className="h-5 w-5 text-primary" aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-foreground">{t('images.page.title')}</h1>
            </div>
          </div>
          {activeTab === 'accounts' ? (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => setAddAccountOpen(true)}>
                <Plus className="mr-1.5 h-4 w-4" />{t('upstreams.addAccount')}
              </Button>
              <Button size="sm" disabled={!config || loading} onClick={() => setAddProviderOpen(true)}>
                <Plus className="mr-1.5 h-4 w-4" />{t('upstreams.addProvider')}
              </Button>
            </div>
          ) : null}
        </div>
        <div className="mx-auto mt-1 flex max-w-7xl gap-1 overflow-x-auto" role="tablist" aria-label={t('images.page.title')}>
          {(['accounts', 'advanced'] as const).map((tab) => {
            const selected = activeTab === tab;
            return (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                data-images-tab={tab}
                className={cn(
                  'relative shrink-0 px-3 py-3 text-sm font-medium text-muted-foreground transition-colors',
                  'hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                  selected && 'text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-primary',
                )}
                onClick={() => onTabChange?.(tab)}
              >
                {tab === 'accounts' ? t('images.tabs.accounts') : t('images.tabs.advanced')}
              </button>
            );
          })}
        </div>
      </header>

      {accountsApi.error || providersApi.error || error ? (
        <p role="alert" className="border-b border-destructive/30 bg-destructive/10 px-6 py-2 text-xs text-destructive">
          {accountsApi.error || providersApi.error || error}
        </p>
      ) : null}

      {activeTab === 'advanced' ? (
        <ScrollArea className="flex-1">
          {advancedContent}
        </ScrollArea>
      ) : (
        <div className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col overflow-hidden md:flex-row">
          <aside className="flex h-[42%] min-h-64 shrink-0 flex-col border-b border-border/70 bg-surface-1/40 md:h-full md:w-80 md:border-b-0 md:border-r">
            <div className="space-y-3 border-b border-border/70 p-3">
              <div className="relative">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  className="pl-9"
                  value={query}
                  placeholder={t('upstreams.searchPlaceholder')}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <button
                type="button"
                className={cn(
                  'flex h-7 items-center gap-1.5 rounded-md px-2 text-xs transition-colors',
                  enabledOnly
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground',
                )}
                onClick={() => setEnabledOnly((prev) => !prev)}
                aria-pressed={enabledOnly}
              >
                <span className={cn('h-2 w-2 rounded-full', enabledOnly ? 'bg-primary' : 'bg-muted-foreground/40')} />
                {enabledOnly ? t('providerSettings.showEnabledOnly') : t('providerSettings.showAll')}
              </button>
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="p-2">
                <div className="space-y-1">
                  {visibleAccountTree.map((pool) => {
                    const poolExpanded = filterForcesExpanded || expandedResourceKeys.has(pool.resource.key);
                    const poolHasChildren = pool.groups.length > 0;
                    return (
                      <div key={pool.resource.key}>
                        <ImageResourceRow
                          resource={pool.resource}
                          selected={selectedResource?.key === pool.resource.key}
                          expanded={poolHasChildren ? poolExpanded : undefined}
                          onClick={() => {
                            selectResource(pool.resource);
                            if (poolHasChildren) toggleExpanded(pool.resource.key);
                          }}
                        />
                        {poolHasChildren && poolExpanded ? (
                          <div className="ml-4 border-l border-border/70 pl-2">
                            {pool.groups.map((group) => {
                              const groupExpanded = filterForcesExpanded || expandedResourceKeys.has(group.resource.key);
                              const groupHasChildren = group.accounts.length > 0;
                              return (
                                <div key={group.resource.key}>
                                  <ImageResourceRow
                                    resource={group.resource}
                                    selected={selectedResource?.key === group.resource.key}
                                    expanded={groupHasChildren ? groupExpanded : undefined}
                                    onClick={() => {
                                      selectResource(group.resource);
                                      if (groupHasChildren) toggleExpanded(group.resource.key);
                                    }}
                                  />
                                  {groupHasChildren && groupExpanded ? (
                                    <div className="ml-4 border-l border-border/50 pl-2">
                                      {group.accounts.map((account) => (
                                        <ImageResourceRow
                                          key={account.key}
                                          resource={account}
                                          selected={selectedResource?.key === account.key}
                                          onClick={() => selectResource(account)}
                                        />
                                      ))}
                                    </div>
                                  ) : null}
                                </div>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>

                {visibleProviders.length && visibleAccountTree.length ? (
                  <div className="mx-2 mb-1 mt-3 border-t border-border/70 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {t('upstreams.filter.provider')}
                  </div>
                ) : null}
                <div className="space-y-1">
                  {visibleProviders.map((provider) => (
                    <ImageResourceRow
                      key={provider.key}
                      resource={provider}
                      selected={selectedResource?.key === provider.key}
                      quotaWindows={keyQuotaSummaries.get(provider.provider.sourceProviderId)}
                      onClick={() => selectResource(provider)}
                    />
                  ))}
                </div>

                {!visibleAccountTree.length && !visibleProviders.length ? (
                  <div className="px-4 py-10 text-center text-sm text-muted-foreground">{t(loading || accountsApi.loading || providersApi.loading ? 'images.page.loading' : 'images.api.empty')}</div>
                ) : null}
              </div>
            </ScrollArea>
          </aside>

          <main className="min-h-0 min-w-0 flex-1 overflow-hidden bg-surface-0/30">
            {!selectedResource ? (
              <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
                {t(loading || accountsApi.loading || providersApi.loading ? 'images.page.loading' : 'images.api.empty')}
              </div>
            ) : selectedResource.kind === 'provider' ? (
              <ScrollArea className="h-full">
                <div className="p-5 md:p-6">
                  {config ? <ImageProviderDetails key={selectedResource.providerId} id={selectedResource.providerId}
                    config={config} sources={providersApi.providers} busy={busy} onUpdate={updateImagesConfig}
                    onCredentialsChanged={providersApi.refresh} onRemoved={() => setSelectedKey(null)} /> : null}
                </div>
              </ScrollArea>
            ) : (
              <ScrollArea className="h-full">
                <div className="space-y-5 p-5 md:p-6">
                  {selectedResource.kind === 'account' ? (
                    <AccountResourceDetails
                      account={selectedResource.account}
                      busy={accountsApi.busy}
                      onPatch={(patch) => accountsApi.patchAccount(selectedResource.account.providerId, selectedResource.account.id, patch)}
                      onSetProxy={(proxy) => accountsApi.setAccountProxy(selectedResource.account.providerId, selectedResource.account.id, proxy)}
                      onSetSupportedModels={(models) => accountsApi.setAccountSupportedModels(selectedResource.account.providerId, selectedResource.account.id, models)}
                      onTest={() => accountsApi.testAccount(selectedResource.account.providerId, selectedResource.account.id)}
                      onLoadEvents={() => accountsApi.listAccountEvents(selectedResource.account.providerId, selectedResource.account.id)}
                      onRefreshAllowance={
                        selectedResource.account.providerId === 'codex'
                          ? () => accountsApi.refreshCodexAccountAllowance(selectedResource.account.id)
                          : selectedResource.account.providerId === 'antigravity'
                            ? () => accountsApi.refreshAntigravityAccountAllowance(selectedResource.account.id)
                            : undefined
                      }
                      onRemove={() => {
                        void accountsApi.removeAccount(selectedResource.account.providerId, selectedResource.account.id);
                        setSelectedKey(null);
                      }}
                    />
                  ) : (
                    <ImageGroupResourceDetails resource={selectedResource} />
                  )}
                </div>
              </ScrollArea>
            )}
          </main>
        </div>
      )}

      <AddAccountDialog open={addAccountOpen} onOpenChange={setAddAccountOpen} accountsApi={accountsApi} providerIds={IMAGE_ACCOUNT_PROVIDERS} />
      {addProviderOpen && config ? <ImageProviderDialog config={config} sources={providersApi.providers} busy={busy}
        onUpdate={updateImagesConfig} onCredentialsChanged={providersApi.refresh}
        onSaved={(id) => { setSelectedKey(resourceKey.provider(id)); setAddProviderOpen(false); }}
        onClose={() => setAddProviderOpen(false)} /> : null}

    </div>
  );
}

function ImageResourceRow({ resource, selected, expanded, quotaWindows, onClick }: {
  resource: ImageResource;
  selected: boolean;
  expanded?: boolean;
  quotaWindows?: KeyQuotaSummaryWindow[];
  onClick: () => void;
}) {
  const t = useTranslation();
  const Icon = resource.kind === 'account'
    ? UserRound
    : resource.kind === 'account-group'
      ? UsersRound
      : resource.kind === 'account-pool' ? Layers3 : ImageIcon;
  const status = resource.kind === 'account'
    ? t(`accounts.management.schedulingState.${accountSchedulingState(resource.account)}`)
    : resource.kind === 'account-group' || resource.kind === 'account-pool'
      ? t('upstreams.memberCount', { count: resource.accounts.length })
      : resource.provider.enabled === false || resource.source?.enabled === false
        ? t('upstreams.status.disabled')
        : !resource.source || resource.source.hasKey === false
          ? t('upstreams.status.needsKey')
          : resource.provider.protocol;
  return (
    <button
      type="button"
      className={cn(
        'group flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected ? 'bg-primary/10 text-foreground' : 'text-foreground hover:bg-surface-2/70',
      )}
      onClick={onClick}
      aria-expanded={expanded}
    >
      {expanded === undefined ? (
        <span className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <ChevronRight className={cn(
          'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
          expanded && 'rotate-90 text-foreground',
        )} />
      )}
      <span className={cn(
        'flex h-7 w-7 shrink-0 items-center justify-center rounded-md border',
        selected ? 'border-primary/30 bg-primary/10 text-primary' : 'border-border bg-surface-0 text-muted-foreground',
      )}>
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate text-sm', resource.kind === 'account-pool' ? 'font-semibold' : 'font-medium')}>{resource.label}</span>
        <span className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
          <span>{t(`upstreams.kind.${resource.kind}`)}</span><span>·</span><span>{status}</span>
          {quotaWindows?.map((window) => (
            <React.Fragment key={window.id}>
              <span>·</span>
              <span
                title={window.resetsAt ? `${window.label} · ${new Date(window.resetsAt).toLocaleString()}` : window.label}
                className={(window.usedPercent ?? 0) >= 80 ? 'font-medium text-foreground' : undefined}
              >
                {window.usedPercent}%
              </span>
            </React.Fragment>
          ))}
        </span>
      </span>
      <span className={cn('h-5 w-0.5 shrink-0 rounded-full', selected ? 'bg-primary' : 'bg-transparent')} aria-hidden="true" />
    </button>
  );
}

function ImageGroupResourceDetails({ resource }: {
  resource: Extract<ImageResource, { kind: 'account-group' | 'account-pool' }>;
}) {
  const t = useTranslation();
  const schedulable = resource.accounts.filter((account) => account.schedulable).length;
  return (
    <section className="space-y-5">
      <div className="rounded-xl border border-border/70 bg-surface-1/50 p-5">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
            <Layers3 className="h-5 w-5 text-primary" />
          </span>
          <div>
            <h2 className="text-lg font-semibold">
              {resource.kind === 'account-group' ? resource.group : resource.label}
            </h2>
            <p className="text-xs text-muted-foreground">
              {t(`accounts.provider.${resource.providerId}.title`)} · {t('upstreams.groupSummary', { total: resource.accounts.length, schedulable })}
            </p>
          </div>
        </div>
        <div className="mt-5 grid gap-2 sm:grid-cols-2">
          {resource.accounts.map((account) => (
            <div key={account.id} className="flex items-center justify-between gap-3 rounded-lg border border-border/70 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{account.label || account.id}</p>
                <p className="text-xs text-muted-foreground">{t(`accounts.status.${account.status}`)}</p>
              </div>
              <Badge variant={account.schedulable ? 'success' : 'secondary'}>
                {t(`accounts.management.schedulingState.${accountSchedulingState(account)}`)}
              </Badge>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
