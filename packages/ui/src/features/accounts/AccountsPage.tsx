import { ArrowLeft, Plus, RefreshCw, UserCircle } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTranslation } from '@/shared/state/LocaleContext';

import { OAuthProviderCard } from './OAuthProviderCard';
import { OpenCodeGoAccountCard } from './OpenCodeGoAccountCard';
import { AccountManagementWorkspace } from './AccountManagementWorkspace';
import { useAccounts } from './hooks/useAccounts';

import type { SubscriptionListEntry, SubscriptionProviderId } from '@/daemon/types';
import type { AppRoute, RouteNavigate } from '@/shared/state/hashRoute';
import { selectedAccountFromRoute } from '@/shared/state/hashRoute';

interface AccountsPageProps {
  route: AppRoute;
  onNavigate: RouteNavigate;
}

export function AccountsPage({ route, onNavigate }: AccountsPageProps) {
  const t = useTranslation();
  const accountsApi = useAccounts();
  const { loading, data, allowanceLoading, allowanceError, refreshAllowances } = accountsApi;
  const [addOpen, setAddOpen] = useState(false);
  const [addProvider, setAddProvider] = useState<SubscriptionProviderId | null>(null);

  const totalAccounts = useMemo(
    () => Object.values(data.providerAccounts).reduce((total, accounts) => total + accounts.length, 0),
    [data.providerAccounts],
  );
  const activeProviders = useMemo(
    () => Object.values(data.providerAccounts).filter((accounts) => accounts.length > 0).length,
    [data.providerAccounts],
  );

  const selectedRouteAccount = selectedAccountFromRoute(route);

  useEffect(() => {
    // The first list response is the authority for whether a deep-linked
    // account still exists. Clear a stale selection with replace semantics so
    // a deleted/unknown id cannot leave an uncloseable empty drawer behind.
    if (loading || !selectedRouteAccount) return;
    const exists = data.providerAccounts[selectedRouteAccount.providerId]?.some(
      (account) => account.id === selectedRouteAccount.accountId,
    ) ?? false;
    if (!exists) {
      onNavigate({ page: 'upstreams', upstreamFilter: 'account', accountFilters: route.accountFilters }, { replace: true });
    }
  }, [data.providerAccounts, loading, onNavigate, route.accountFilters, route.accountId, route.accountProvider]);

  const openAdd = (providerId?: SubscriptionProviderId) => {
    setAddProvider(providerId ?? null);
    setAddOpen(true);
  };

  const closeAdd = () => {
    setAddOpen(false);
    setAddProvider(null);
  };

  const renderProvider = (entry: SubscriptionListEntry, mode: 'manage' | 'add') => {
    const accounts = data.providerAccounts[entry.providerId] ?? [];
    const common = {
      key: `${mode}:${entry.providerId}`,
      entry,
      accounts,
      accountsApi,
      mode,
      onAdded: closeAdd,
      onAddRequest: () => openAdd(entry.providerId),
    } as const;
    return entry.providerId === 'opencodego'
      ? <OpenCodeGoAccountCard {...common} />
      : <OAuthProviderCard {...common} />;
  };

  const selectedEntry = addProvider
    ? data.accounts.find((entry) => entry.providerId === addProvider)
    : undefined;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ScrollArea className="flex-1">
        <div className="mx-auto max-w-5xl space-y-5 px-6 py-6">
          <section className="rounded-xl border border-border/70 bg-surface-1/60 p-4 md:p-5">
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-2">
                  <UserCircle className="h-5 w-5 text-muted-foreground" />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-foreground">{t('accounts.title')}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">{t('accounts.managementDescription')}</p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t('accounts.summary', { accounts: totalAccounts, providers: activeProviders })}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={allowanceLoading}
                  onClick={() => void refreshAllowances()}
                >
                  <RefreshCw className={allowanceLoading ? 'mr-1.5 h-4 w-4 animate-spin' : 'mr-1.5 h-4 w-4'} />
                  {t('accounts.allowance.refreshAll')}
                </Button>
                <Button size="sm" disabled={loading} onClick={() => openAdd()}>
                  <Plus className="mr-1.5 h-4 w-4" />
                  {t('accounts.accounts.addAccount')}
                </Button>
              </div>
            </div>
          </section>

          {allowanceError ? (
            <section className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
              {t('accounts.allowance.loadFailed', { error: allowanceError })}
            </section>
          ) : null}

          {loading ? (
            <p className="text-sm text-muted-foreground">{t('accounts.loading')}</p>
          ) : data.accounts.length === 0 ? (
            <section className="rounded-xl border border-dashed border-border/70 px-6 py-12 text-center">
              <p className="text-sm text-muted-foreground">{t('accounts.empty')}</p>
            </section>
          ) : <AccountManagementWorkspace accountsApi={accountsApi} route={route} onNavigate={onNavigate} />}

          <p className="px-1 text-xs leading-5 text-muted-foreground">
            {t('accounts.info.description')}
          </p>
        </div>
      </ScrollArea>

      <Dialog
        open={addOpen}
        onOpenChange={(open) => {
          if (!open) closeAdd();
          else setAddOpen(true);
        }}
      >
        <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('accounts.addDialog.title')}</DialogTitle>
            <DialogDescription>{t('accounts.addDialog.description')}</DialogDescription>
          </DialogHeader>

          {selectedEntry ? (
            <div className="space-y-3">
              <Button size="sm" variant="ghost" className="px-1" onClick={() => setAddProvider(null)}>
                <ArrowLeft className="mr-1.5 h-4 w-4" />
                {t('accounts.addDialog.back')}
              </Button>
              {renderProvider(selectedEntry, 'add')}
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {data.accounts.map((entry) => {
                const count = data.providerAccounts[entry.providerId]?.length ?? 0;
                return (
                  <button
                    key={entry.providerId}
                    type="button"
                    className="rounded-lg border border-border bg-surface-1/50 p-4 text-left transition-colors hover:border-primary/50 hover:bg-surface-2/60"
                    onClick={() => setAddProvider(entry.providerId)}
                  >
                    <span className="block text-sm font-medium text-foreground">
                      {t(`accounts.provider.${entry.providerId}.title`)}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {t('accounts.addDialog.existingCount', { count })}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default AccountsPage;
