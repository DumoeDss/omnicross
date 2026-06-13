import React, { useState } from 'react';

import { DaemonStatusBanner } from '@/components/DaemonStatusBanner';
import { NavRail, type PageId } from '@/components/nav/NavRail';
import { AccountsPage } from '@/features/accounts';
import { ApiServicePage } from '@/features/api-service';
import { CodeCliPage } from '@/features/code-cli';
import { PricingPage } from '@/features/pricing';
import { ProviderSettings } from '@/features/provider-settings/ProviderSettings';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { UsageStatsPage } from '@/features/usage-stats';

/**
 * App shell — a multi-page settings shell over the daemon admin API. Navigation
 * is lightweight local state (no router lib, design D4): `activePage` selects
 * the rendered page via a `switch`; `NavRail` owns the rail markup. Language is
 * managed on the Settings page; each component re-renders on language change via
 * its own `useTranslation` subscription.
 */
function renderPage(page: PageId) {
  switch (page) {
    case 'api-service':
      return <ApiServicePage />;
    case 'accounts':
      return <AccountsPage />;
    case 'code-cli':
      return <CodeCliPage />;
    case 'usage-stats':
      return <UsageStatsPage />;
    case 'pricing':
      return <PricingPage />;
    case 'settings':
      return <SettingsPage />;
    case 'providers':
    default:
      return <ProviderSettings />;
  }
}

export default function App() {
  const [activePage, setActivePage] = useState<PageId>('providers');

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <NavRail activePage={activePage} onNavigate={setActivePage} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <DaemonStatusBanner />
        <main className="min-w-0 flex-1 overflow-hidden">{renderPage(activePage)}</main>
      </div>
    </div>
  );
}
