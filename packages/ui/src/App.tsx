import React, { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';

import { DaemonStatusBanner } from '@/components/DaemonStatusBanner';
import { UpdateStatusBanner } from '@/components/UpdateStatusBanner';
import { NavRail } from '@/components/nav/NavRail';
import { ApiServicePage } from '@/features/api-service';
import type { ApiServiceTabId } from '@/features/api-service/apiServiceTabModel';
import { CodeCliPage } from '@/features/code-cli';
import { ChatGptWebPage } from '@/features/chatgpt-web';
import { ImagesPage } from '@/features/images';
import { OverviewPage } from '@/features/overview';
import { RouteActivityPage } from '@/features/route-activity/RouteActivityPage';
import { SearchPage } from '@/features/search';
import { OtherProvidersPage } from '@/features/provider-settings/OtherProvidersPage';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { UpstreamsPage } from '@/features/upstreams';
import type { SettingsTabId } from '@/features/settings/settingsTabModel';
import { UsageStatsPage } from '@/features/usage-stats';
import { exportDaemonLogs } from '@/shared/logExport';
import { useHashRoute, type AppRoute, type RouteNavigate } from '@/shared/state/hashRoute';
import { isDesktop } from '@/shared/tauri/uiSettings';

function renderPage(route: AppRoute, navigate: RouteNavigate) {
  switch (route.page) {
    case 'overview': return <OverviewPage onNavigate={navigate} />;
    case 'api-service': return <ApiServicePage activeTab={(route.tab as ApiServiceTabId | undefined) ?? 'overview'} onNavigate={navigate} />;
    case 'route-activity': return <RouteActivityPage />;
    case 'upstreams': return <UpstreamsPage route={route} onNavigate={navigate} />;
    case 'integrations': return <CodeCliPage />;
    case 'chatgpt-web': return <ChatGptWebPage />;
    case 'search': return <SearchPage />;
    case 'images': return <ImagesPage />;
    case 'other-providers': return <OtherProvidersPage />;
    case 'usage-stats': return <UsageStatsPage />;
    case 'settings': return <SettingsPage activeTab={(route.tab as SettingsTabId | undefined) ?? 'general'} onTabChange={(tab) => navigate({ page: 'settings', tab })} />;
    default: return <OverviewPage onNavigate={navigate} />;
  }
}

export default function App() {
  const [route, navigate] = useHashRoute();

  // Tray → "Export logs": the Rust tray item emits `tray-export-logs` (after
  // revealing the window); the export itself runs through the same daemon
  // endpoint + save path as the Settings button. Browser builds never listen.
  useEffect(() => {
    if (!isDesktop()) return undefined;
    const unlisten = listen('tray-export-logs', () => {
      void exportDaemonLogs();
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground md:flex-row">
      <NavRail route={route} onNavigate={navigate} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <DaemonStatusBanner />
        <UpdateStatusBanner />
        <main className="min-h-0 min-w-0 flex-1 overflow-hidden pb-[calc(4.5rem+env(safe-area-inset-bottom))] md:pb-0">{renderPage(route, navigate)}</main>
      </div>
    </div>
  );
}
