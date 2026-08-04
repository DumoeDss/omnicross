import React from 'react';

import { DaemonStatusBanner } from '@/components/DaemonStatusBanner';
import { NavRail } from '@/components/nav/NavRail';
import { AccountsPage } from '@/features/accounts';
import { ApiServicePage } from '@/features/api-service';
import type { ApiServiceTabId } from '@/features/api-service/apiServiceTabModel';
import { CodeCliPage } from '@/features/code-cli';
import { OverviewPage } from '@/features/overview';
import { ProviderSettings } from '@/features/provider-settings/ProviderSettings';
import { SettingsPage } from '@/features/settings/SettingsPage';
import type { SettingsTabId } from '@/features/settings/settingsTabModel';
import { UsageStatsPage } from '@/features/usage-stats';
import { useHashRoute, type AppRoute, type RouteNavigate } from '@/shared/state/hashRoute';

function renderPage(route: AppRoute, navigate: RouteNavigate) {
  switch (route.page) {
    case 'overview': return <OverviewPage onNavigate={navigate} />;
    case 'api-service': return <ApiServicePage activeTab={(route.tab as ApiServiceTabId | undefined) ?? 'overview'} onTabChange={(tab) => navigate({ page: 'api-service', tab })} />;
    case 'accounts': return <AccountsPage route={route} onNavigate={navigate} />;
    case 'integrations': return <CodeCliPage />;
    case 'usage-stats': return <UsageStatsPage />;
    case 'settings': return <SettingsPage activeTab={(route.tab as SettingsTabId | undefined) ?? 'general'} onTabChange={(tab) => navigate({ page: 'settings', tab })} />;
    case 'providers':
    default: return <ProviderSettings />;
  }
}

export default function App() {
  const [route, navigate] = useHashRoute();
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground md:flex-row">
      <NavRail activePage={route.page} onNavigate={(page) => navigate({ page })} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <DaemonStatusBanner />
        <main className="min-h-0 min-w-0 flex-1 overflow-hidden pb-[calc(4.5rem+env(safe-area-inset-bottom))] md:pb-0">{renderPage(route, navigate)}</main>
      </div>
    </div>
  );
}
