import {
  Activity,
  Boxes,
  ChevronRight,
  CircleDot,
  KeyRound,
  Layers3,
  Plus,
  Route,
  Search,
  Server,
  UserRound,
  UsersRound,
} from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  accountSchedulingState,
  DEFAULT_ACCOUNT_FILTERS,
  filterAndSortAccounts,
  flattenAccounts,
  type ManagedAccountRow,
} from '@/features/accounts/accountManagementModel';
import { useAccounts } from '@/features/accounts/hooks/useAccounts';
import { useApiService } from '@/features/api-service/hooks/useApiService';
import { SUBSCRIPTION_MODEL_CATALOG } from '@/features/api-service/subscriptionModelCatalog';
import { ProviderSettings } from '@/features/provider-settings/ProviderSettings';
import type {
  GatewayBindingTarget,
  SubscriptionProviderId,
} from '@/daemon/types';
import { useTranslation } from '@/shared/state/LocaleContext';
import { useLlmProvidersData } from '@/shared/state/settingsStore';
import type { AppRoute, RouteNavigate, UpstreamKind } from '@/shared/state/hashRoute';
import { cn } from '@/shared/utils/utils';

import { AccountResourceDetails } from './AccountResourceDetails';
import { AccountRouteActivityView } from './AccountRouteActivityView';
import { AddAccountDialog } from './AddAccountDialog';
import {
  DownstreamRoutesWorkspace,
  type DownstreamResourceOption,
} from './DownstreamRoutesWorkspace';

import type { LLMProvider } from '@shared/llm-config';

interface UpstreamsPageProps {
  route: AppRoute;
  onNavigate: RouteNavigate;
}

type UpstreamResource =
  | { kind: 'account'; key: string; label: string; providerId: SubscriptionProviderId; account: ManagedAccountRow }
  | { kind: 'account-group'; key: string; label: string; providerId: SubscriptionProviderId; group: string; accounts: ManagedAccountRow[] }
  | { kind: 'account-pool'; key: string; label: string; providerId: SubscriptionProviderId; accounts: ManagedAccountRow[] }
  | { kind: 'provider'; key: string; label: string; providerId: string; provider: LLMProvider };

type AccountResource = Extract<UpstreamResource, { kind: 'account' }>;
type AccountGroupResource = Extract<UpstreamResource, { kind: 'account-group' }>;
type AccountPoolResource = Extract<UpstreamResource, { kind: 'account-pool' }>;
type ProviderResource = Extract<UpstreamResource, { kind: 'provider' }>;

interface AccountGroupBranch {
  resource: AccountGroupResource;
  accounts: AccountResource[];
}

interface AccountPoolBranch {
  resource: AccountPoolResource;
  groups: AccountGroupBranch[];
}

const resourceKey = {
  account: (providerId: string, accountId: string) => `account:${providerId}:${accountId}`,
  group: (providerId: string, group: string) => `group:${providerId}:${group}`,
  pool: (providerId: string) => `pool:${providerId}`,
  provider: (providerId: string) => `provider:${providerId}`,
};

function targetFor(resource: UpstreamResource): GatewayBindingTarget {
  if (resource.kind === 'account') {
    return { kind: 'account', providerId: resource.providerId, accountId: resource.account.id };
  }
  if (resource.kind === 'account-group') {
    return { kind: 'account-group', providerId: resource.providerId, group: resource.group };
  }
  if (resource.kind === 'account-pool') {
    return { kind: 'account-pool', providerId: resource.providerId };
  }
  return { kind: 'provider', providerId: resource.providerId };
}

/**
 * Is this resource live? A provider row is live when it is enabled (`enabled`
 * absent reads as enabled — the daemon's back-compat default); an account row
 * when the account itself is enabled, and a group/pool when ANY member is. Drives
 * the sidebar's enabled-only filter.
 */
function resourceIsEnabled(resource: UpstreamResource): boolean {
  if (resource.kind === 'provider') return resource.provider.enabled !== false;
  if (resource.kind === 'account') return resource.account.enabled !== false;
  return resource.accounts.some((account) => account.enabled !== false);
}

function resourceSearchText(resource: UpstreamResource): string {
  if (resource.kind === 'account') {
    return `${resource.label} ${resource.account.id} ${resource.account.group} ${resource.account.tags.join(' ')} ${resource.providerId}`;
  }
  return `${resource.label} ${resource.providerId}`;
}

function bindingTargetMatches(left: GatewayBindingTarget, right: GatewayBindingTarget): boolean {
  if (left.kind !== right.kind || left.providerId !== right.providerId) return false;
  if (left.kind === 'account' && right.kind === 'account') return left.accountId === right.accountId;
  if (left.kind === 'account-group' && right.kind === 'account-group') return left.group === right.group;
  return true;
}

function modelsFor(resource: UpstreamResource): string[] {
  if (resource.kind === 'provider') return resource.provider.models ?? [];
  const catalog = SUBSCRIPTION_MODEL_CATALOG[resource.providerId] ?? [];
  if (resource.kind === 'account') {
    const supported = resource.account.supportedModels;
    if (Array.isArray(supported)) return [...new Set([...catalog, ...supported])];
    if (supported && typeof supported === 'object') {
      return [...new Set([...catalog, ...Object.keys(supported), ...Object.values(supported)])];
    }
  }
  return catalog;
}

function egressProtocolFor(resource: UpstreamResource): string {
  if (resource.kind !== 'provider') {
    if (resource.providerId === 'claude') return 'Anthropic Messages';
    if (resource.providerId === 'codex') return 'OpenAI Responses';
    if (resource.providerId === 'gemini') return 'Gemini GenerateContent';
    return 'OpenAI Chat Completions';
  }
  if (resource.provider.apiFormat === 'anthropic') return 'Anthropic Messages';
  if (resource.provider.apiFormat === 'google') return 'Gemini GenerateContent';
  if (resource.provider.apiFormat === 'openai-response') return 'OpenAI Responses';
  return 'OpenAI Chat Completions';
}

export function UpstreamsPage({ route, onNavigate }: UpstreamsPageProps) {
  const t = useTranslation();
  const accountsApi = useAccounts();
  const gateway = useApiService();
  const providersApi = useLlmProvidersData();
  const [addAccountOpen, setAddAccountOpen] = useState(false);
  const [addProviderOpen, setAddProviderOpen] = useState(false);
  // Sidebar "enabled only" toggle — view state, deliberately NOT in the route:
  // it is a momentary lens on the list, not a location worth sharing/restoring.
  const [enabledOnly, setEnabledOnly] = useState(false);
  const [expandedResourceKeys, setExpandedResourceKeys] = useState<Set<string>>(() => new Set());
  const initializedAccountTree = useRef(false);
  const activeTab = route.upstreamTab ?? 'resources';

  const accountRows = useMemo(
    () => flattenAccounts(accountsApi.data, accountsApi.allowances),
    [accountsApi.allowances, accountsApi.data],
  );
  const visibleAccountRows = useMemo(
    () => route.accountFilters
      ? filterAndSortAccounts(accountRows, { ...DEFAULT_ACCOUNT_FILTERS, ...route.accountFilters })
      : accountRows,
    [accountRows, route.accountFilters],
  );

  const resources = useMemo<UpstreamResource[]>(() => {
    const rows: UpstreamResource[] = visibleAccountRows.map((account) => ({
      kind: 'account',
      key: resourceKey.account(account.providerId, account.id),
      label: account.label || account.id,
      providerId: account.providerId,
      account,
    }));
    const groups = new Map<string, ManagedAccountRow[]>();
    for (const account of visibleAccountRows) {
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
    // One pool resource per subscription provider: bind a route to every account
    // of that provider without pinning a preferred account or group.
    const byProvider = new Map<SubscriptionProviderId, ManagedAccountRow[]>();
    for (const account of visibleAccountRows) {
      byProvider.set(account.providerId, [...(byProvider.get(account.providerId) ?? []), account]);
    }
    for (const [providerId, members] of byProvider) {
      rows.push({
        kind: 'account-pool',
        key: resourceKey.pool(providerId),
        label: t('upstreams.accountPool', { provider: t(`accounts.provider.${providerId}.title`) }),
        providerId,
        accounts: members,
      });
    }
    for (const provider of providersApi.providers) {
      rows.push({
        kind: 'provider',
        key: resourceKey.provider(provider.id),
        label: provider.name || provider.id,
        providerId: provider.id,
        provider,
      });
    }
    const kindOrder: Record<UpstreamResource['kind'], number> = {
      'account-pool': 0,
      'account-group': 1,
      account: 2,
      provider: 3,
    };
    return rows.sort((left, right) => kindOrder[left.kind] - kindOrder[right.kind]
      || left.label.localeCompare(right.label));
  }, [providersApi.providers, t, visibleAccountRows]);

  const accountTree = useMemo<AccountPoolBranch[]>(() => {
    const pools: AccountPoolResource[] = [];
    const groups: AccountGroupResource[] = [];
    const accounts: AccountResource[] = [];
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

  const downstreamResources = useMemo<DownstreamResourceOption[]>(
    () => resources.map((resource) => ({
      key: resource.key,
      label: resource.label,
      detail: resource.providerId,
      target: targetFor(resource),
      egressProtocol: egressProtocolFor(resource),
      modelSuggestions: modelsFor(resource),
    })),
    [resources],
  );

  const selectedKey = useMemo(() => {
    if (route.upstreamKind === 'account' && route.accountProvider && route.accountId) {
      return resourceKey.account(route.accountProvider, route.accountId);
    }
    if (route.upstreamKind === 'account-group' && route.upstreamProviderId && route.upstreamGroup) {
      return resourceKey.group(route.upstreamProviderId, route.upstreamGroup);
    }
    if (route.upstreamKind === 'account-pool' && route.upstreamProviderId) {
      return resourceKey.pool(route.upstreamProviderId);
    }
    if (route.upstreamKind === 'provider' && route.upstreamProviderId) {
      return resourceKey.provider(route.upstreamProviderId);
    }
    return null;
  }, [route.accountId, route.accountProvider, route.upstreamGroup, route.upstreamKind, route.upstreamProviderId]);

  const query = route.upstreamQuery ?? '';
  const kindFilter = route.upstreamFilter ?? 'all';
  const eligibleResources = useMemo(() => resources
    .filter((resource) => kindFilter === 'all' || resource.kind === kindFilter)
    .filter((resource) => !enabledOnly || resourceIsEnabled(resource)), [enabledOnly, kindFilter, resources]);
  const filteredResources = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return eligibleResources
      .filter((resource) => !needle || resourceSearchText(resource).toLocaleLowerCase().includes(needle));
  }, [eligibleResources, query]);
  const eligibleResourceKeys = useMemo(
    () => new Set(eligibleResources.map((resource) => resource.key)),
    [eligibleResources],
  );
  const filteredResourceKeys = useMemo(
    () => new Set(filteredResources.map((resource) => resource.key)),
    [filteredResources],
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
    () => filteredResources.filter((resource): resource is ProviderResource => resource.kind === 'provider'),
    [filteredResources],
  );
  const selectedResource = resources.find((resource) => resource.key === selectedKey)
    ?? filteredResources[0]
    ?? resources[0]
    ?? null;

  const navigateSelection = (resource: UpstreamResource, replace = false) => {
    const next: AppRoute = {
      page: 'upstreams',
      upstreamFilter: kindFilter,
      upstreamQuery: query || undefined,
      upstreamKind: resource.kind,
    };
    if (resource.kind === 'account') {
      next.accountProvider = resource.providerId;
      next.accountId = resource.account.id;
    } else if (resource.kind === 'account-group') {
      next.upstreamProviderId = resource.providerId;
      next.upstreamGroup = resource.group;
    } else {
      next.upstreamProviderId = resource.providerId;
    }
    onNavigate(next, replace ? { replace: true } : undefined);
  };

  useEffect(() => {
    if (activeTab !== 'resources') return;
    if (!selectedResource || selectedKey === selectedResource.key) return;
    navigateSelection(selectedResource, true);
  // Selection is canonicalized only when resources/load state invalidates it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, selectedResource?.key, selectedKey]);

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
  }, [selectedResource?.key]);

  const toggleExpanded = (key: string) => {
    setExpandedResourceKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const filterForcesExpanded = Boolean(query.trim()) || kindFilter === 'account';
  const poolFilterForcesExpanded = filterForcesExpanded || kindFilter === 'account-group';
  const bindingCountFor = (resource: UpstreamResource) => (gateway.config?.bindings ?? [])
    .filter((binding) => bindingTargetMatches(binding.target, targetFor(resource))).length;

  const patchBrowse = (patch: { upstreamFilter?: UpstreamKind | 'all'; upstreamQuery?: string }) => {
    const next: AppRoute = {
      ...route,
      page: 'upstreams',
      ...patch,
    };
    onNavigate(next, { replace: true });
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b border-border/70 bg-surface-0/80 px-5 py-4 md:px-6">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <Boxes className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-foreground">{t('upstreams.title')}</h1>
              <p className="mt-0.5 text-sm text-muted-foreground">{t('upstreams.description')}</p>
            </div>
          </div>
          {activeTab === 'resources' ? (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => setAddAccountOpen(true)}>
                <Plus className="mr-1.5 h-4 w-4" />{t('upstreams.addAccount')}
              </Button>
              <Button size="sm" onClick={() => setAddProviderOpen(true)}>
                <Plus className="mr-1.5 h-4 w-4" />{t('upstreams.addProvider')}
              </Button>
            </div>
          ) : null}
        </div>
      </header>

      {gateway.error || accountsApi.error || providersApi.error ? (
        <div className="border-b border-destructive/30 bg-destructive/10 px-6 py-2 text-xs text-destructive">
          {gateway.error || accountsApi.error || providersApi.error}
        </div>
      ) : null}

      <nav className="flex shrink-0 items-end gap-1 border-b border-border/70 bg-surface-0 px-5 md:px-6" aria-label={t('upstreams.tabs.label')}>
        {(['resources', 'routes', 'activity'] as const).map((tab) => {
          const Icon = tab === 'resources' ? Server : tab === 'routes' ? Route : Activity;
          return (
            <button
              key={tab}
              type="button"
              className={cn(
                'flex min-h-10 items-center gap-2 border-b-2 px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                activeTab === tab ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
              onClick={() => onNavigate({
                ...route,
                page: 'upstreams',
                upstreamTab: tab === 'resources' ? undefined : tab,
                downstreamId: tab === 'routes' ? route.downstreamId : undefined,
              })}
            >
              <Icon className="h-3.5 w-3.5" />{t(`upstreams.tabs.${tab}`)}
            </button>
          );
        })}
      </nav>

      {activeTab === 'routes' ? (
        <DownstreamRoutesWorkspace
          bindings={gateway.config?.bindings ?? []}
          resources={downstreamResources}
          clientKeys={gateway.keys}
          selectedBindingId={route.downstreamId}
          busy={gateway.busy || !gateway.config}
          onSelectBinding={(downstreamId) => onNavigate({ page: 'upstreams', upstreamTab: 'routes', downstreamId }, { replace: true })}
          onOpenApiKeys={() => onNavigate({ page: 'api-service', tab: 'access' })}
          onChange={gateway.updateBindings}
        />
      ) : activeTab === 'activity' ? (
        <AccountRouteActivityView accounts={accountRows} />
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
                onChange={(event) => patchBrowse({ upstreamQuery: event.target.value })}
              />
            </div>
            <div className="flex items-center gap-2">
              <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
                {(['all', 'account', 'account-group', 'provider'] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    className={cn(
                      'shrink-0 rounded-md px-2.5 py-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      kindFilter === kind ? 'bg-primary/12 text-primary' : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground',
                    )}
                    onClick={() => patchBrowse({ upstreamFilter: kind })}
                  >
                    {t(`upstreams.filter.${kind}`)}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className={cn(
                  'flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  enabledOnly
                    ? 'border-primary text-primary bg-primary/10'
                    : 'border-border/40 text-muted-foreground hover:border-border hover:text-foreground',
                )}
                onClick={() => setEnabledOnly((prev) => !prev)}
                aria-pressed={enabledOnly}
                aria-label={enabledOnly ? t('providerSettings.showAll') : t('providerSettings.showEnabledOnly')}
                title={enabledOnly ? t('providerSettings.showAll') : t('providerSettings.showEnabledOnly')}
              >
                <CircleDot className="h-4 w-4" />
              </button>
            </div>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="p-2">
              <div className="space-y-1">
                {visibleAccountTree.map((pool) => {
                  const poolExpanded = poolFilterForcesExpanded || expandedResourceKeys.has(pool.resource.key);
                  const poolHasChildren = pool.groups.length > 0;
                  return (
                    <div key={pool.resource.key}>
                      <ResourceRow
                        resource={pool.resource}
                        selected={selectedResource?.key === pool.resource.key}
                        bindingCount={bindingCountFor(pool.resource)}
                        expanded={poolHasChildren ? poolExpanded : undefined}
                        onClick={() => {
                          navigateSelection(pool.resource);
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
                                <ResourceRow
                                  resource={group.resource}
                                  selected={selectedResource?.key === group.resource.key}
                                  bindingCount={bindingCountFor(group.resource)}
                                  expanded={groupHasChildren ? groupExpanded : undefined}
                                  onClick={() => {
                                    navigateSelection(group.resource);
                                    if (groupHasChildren) toggleExpanded(group.resource.key);
                                  }}
                                />
                                {groupHasChildren && groupExpanded ? (
                                  <div className="ml-4 border-l border-border/50 pl-2">
                                    {group.accounts.map((account) => (
                                      <ResourceRow
                                        key={account.key}
                                        resource={account}
                                        selected={selectedResource?.key === account.key}
                                        bindingCount={bindingCountFor(account)}
                                        onClick={() => navigateSelection(account)}
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
                  <ResourceRow
                    key={provider.key}
                    resource={provider}
                    selected={selectedResource?.key === provider.key}
                    bindingCount={bindingCountFor(provider)}
                    onClick={() => navigateSelection(provider)}
                  />
                ))}
              </div>

              {!visibleAccountTree.length && !visibleProviders.length ? (
                <div className="px-4 py-10 text-center text-sm text-muted-foreground">{t('upstreams.empty')}</div>
              ) : null}
            </div>
          </ScrollArea>
        </aside>

        <main className="min-h-0 min-w-0 flex-1 overflow-hidden bg-surface-0/30">
          {!selectedResource ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
              {t('upstreams.empty')}
            </div>
          ) : selectedResource.kind === 'provider' ? (
            <ProviderSettings
              embedded
              selectedProviderId={selectedResource.providerId}
              onSelectedProviderChange={(providerId) => {
                const next = resources.find((resource) => resource.kind === 'provider' && resource.providerId === providerId);
                if (next) navigateSelection(next);
              }}
            />
          ) : (
            <ScrollArea className="h-full">
              <div className="space-y-5 p-5 md:p-6">
                {selectedResource.kind === 'account'
                  ? (
                    <AccountResourceDetails
                      account={selectedResource.account}
                      busy={accountsApi.busy}
                      onPatch={(patch) => accountsApi.patchAccount(selectedResource.account.providerId, selectedResource.account.id, patch)}
                      onSetProxy={(proxy) => accountsApi.setAccountProxy(selectedResource.account.providerId, selectedResource.account.id, proxy)}
                      onSetSupportedModels={(models) => accountsApi.setAccountSupportedModels(selectedResource.account.providerId, selectedResource.account.id, models)}
                      onTest={() => accountsApi.testAccount(selectedResource.account.providerId, selectedResource.account.id)}
                      onLoadEvents={() => accountsApi.listAccountEvents(selectedResource.account.providerId, selectedResource.account.id)}
                      onRefreshAllowance={
                        selectedResource.account.providerId === 'claude'
                          ? () => accountsApi.refreshAccountAllowance(selectedResource.account.id)
                          : selectedResource.account.providerId === 'codex'
                            ? accountsApi.refreshAllowances
                            : undefined
                      }
                      onRemove={() => {
                        void accountsApi.removeAccount(selectedResource.account.providerId, selectedResource.account.id);
                        onNavigate({ page: 'upstreams', upstreamFilter: kindFilter, upstreamQuery: query || undefined }, { replace: true });
                      }}
                    />
                  )
                  : <GroupResourceDetails resource={selectedResource} />}
              </div>
            </ScrollArea>
          )}
        </main>
      </div>
      )}

      <AddAccountDialog open={addAccountOpen} onOpenChange={setAddAccountOpen} accountsApi={accountsApi} />
      <Dialog open={addProviderOpen} onOpenChange={setAddProviderOpen}>
        <DialogContent className="flex h-[88vh] max-w-4xl flex-col overflow-hidden p-0">
          <DialogHeader className="border-b border-border/70 px-6 py-4">
            <DialogTitle>{t('upstreams.addProvider')}</DialogTitle>
            <DialogDescription>{t('upstreams.addProviderDescription')}</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1"><ProviderSettings embedded mode="create" /></div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ResourceRow({ resource, selected, bindingCount, expanded, onClick }: {
  resource: UpstreamResource;
  selected: boolean;
  bindingCount: number;
  expanded?: boolean;
  onClick: () => void;
}) {
  const t = useTranslation();
  const Icon = resource.kind === 'account'
    ? UserRound
    : resource.kind === 'account-group'
      ? UsersRound
      : resource.kind === 'account-pool' ? Layers3 : Server;
  const status = resource.kind === 'account'
    ? t(`accounts.management.schedulingState.${accountSchedulingState(resource.account)}`)
    : resource.kind === 'account-group' || resource.kind === 'account-pool'
      ? t('upstreams.memberCount', { count: resource.accounts.length })
      : resource.provider.enabled === false
        ? t('upstreams.status.disabled')
        : resource.provider.hasKey === false
          ? t('upstreams.status.needsKey')
          : t('upstreams.status.ready');
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
        </span>
      </span>
      {bindingCount ? (
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
          title={t('upstreams.routeCount', { count: bindingCount })}
        >
          <KeyRound className="h-2.5 w-2.5" />{bindingCount}
        </span>
      ) : null}
      <span className={cn('h-5 w-0.5 shrink-0 rounded-full', selected ? 'bg-primary' : 'bg-transparent')} aria-hidden="true" />
    </button>
  );
}

function GroupResourceDetails({ resource }: { resource: Extract<UpstreamResource, { kind: 'account-group' | 'account-pool' }> }) {
  const t = useTranslation();
  const schedulable = resource.accounts.filter((account) => account.schedulable).length;
  return (
    <section className="rounded-xl border border-border/70 bg-surface-1/50 p-5">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10"><Layers3 className="h-5 w-5 text-primary" /></span>
        <div>
          <h2 className="text-lg font-semibold">{resource.kind === 'account-group' ? resource.group : resource.label}</h2>
          <p className="text-xs text-muted-foreground">{t(`accounts.provider.${resource.providerId}.title`)} · {t('upstreams.groupSummary', { total: resource.accounts.length, schedulable })}</p>
        </div>
      </div>
      <div className="mt-5 grid gap-2 sm:grid-cols-2">
        {resource.accounts.map((account) => (
          <div key={account.id} className="flex items-center justify-between gap-3 rounded-lg border border-border/70 px-3 py-2">
            <div className="min-w-0"><p className="truncate text-sm font-medium">{account.label || account.id}</p><p className="text-xs text-muted-foreground">{t(`accounts.status.${account.status}`)}</p></div>
            <Badge variant={account.schedulable ? 'success' : 'secondary'}>{t(`accounts.management.schedulingState.${accountSchedulingState(account)}`)}</Badge>
          </div>
        ))}
      </div>
    </section>
  );
}
