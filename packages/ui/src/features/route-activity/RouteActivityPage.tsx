/**
 * RouteActivityPage — the Run-group home for live routing operations.
 *
 * Focused on the routing stream itself: which credential actually served each
 * request — subscription pool accounts AND BYO provider API keys on one
 * timeline — plus the server-overload trend. The request queue and
 * recent-errors views used to share this surface but crowded out the routing
 * records; the queue is summarized on the Gateway overview and the aggregate
 * error rate lives on the Overview page. All of this is metadata only — no
 * prompts, headers, tokens or key strings are collected.
 */

import { Activity } from 'lucide-react';
import React from 'react';

import { useAccounts } from '@/features/accounts/hooks/useAccounts';
import { flattenAccounts } from '@/features/accounts/accountManagementModel';
import { AccountRouteActivityView } from '@/features/upstreams/AccountRouteActivityView';
import { OverloadTrendView } from '@/features/upstreams/OverloadTrendView';
import { useLlmProvidersData } from '@/shared/state/settingsStore';
import { useTranslation } from '@/shared/state/LocaleContext';

export function RouteActivityPage() {
  const t = useTranslation();
  const accountsApi = useAccounts();
  const providersApi = useLlmProvidersData();

  const accountRows = React.useMemo(
    () => flattenAccounts(accountsApi.data, accountsApi.allowances),
    [accountsApi.allowances, accountsApi.data],
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b border-border/70 bg-surface-0/80 px-5 py-4 md:px-6">
        <div className="mx-auto flex max-w-7xl items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
            <Activity className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-foreground">{t('routeActivity.title')}</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">{t('routeActivity.description')}</p>
          </div>
        </div>
      </header>

      {accountsApi.error ? (
        <div className="border-b border-destructive/30 bg-destructive/10 px-6 py-2 text-xs text-destructive">
          {accountsApi.error}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col">
        <OverloadTrendView accounts={accountRows} />
        <AccountRouteActivityView accounts={accountRows} providers={providersApi.providers} />
      </div>
    </div>
  );
}

export default RouteActivityPage;
