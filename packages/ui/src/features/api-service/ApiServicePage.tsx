/**
 * ApiServicePage.tsx — the API Service page shell. The page keeps the complete
 * daemon-backed feature set, but groups it into focused tabs so server status
 * and critical controls no longer compete with every advanced setting.
 *
 * All primary controls are daemon-backed; edits drive off `GET /server`'s
 * editable config, never off the read-only `/status` projection.
 */

import { AlertTriangle, ServerCog } from 'lucide-react';
import React from 'react';

import { ScrollArea } from '@/components/ui/scroll-area';
import { SettingRow } from '@/components/ui/setting-row';
import { Switch } from '@/components/ui/switch';
import { useTranslation } from '@/shared/state/LocaleContext';

import { ApiServiceTabs } from './ApiServiceTabs';
import { API_SERVICE_TABS, normalizeApiServiceTab, type ApiServiceTabId } from './apiServiceTabModel';
import { EndpointRoutingCard } from './EndpointRoutingCard';
import { missingKindsByEndpoint } from './endpointKinds';
import { useApiService } from './hooks/useApiService';
import { KeyManagementSection } from './KeyManagementSection';
import { QueueStatusSummary } from './QueueStatusSummary';
import { QueueStatusView } from './QueueStatusView';
import { RecentErrorsView } from './RecentErrorsView';
import { ServerStatusBanner } from './ServerStatusBanner';
import { VoucherSection } from './VoucherSection';

interface ApiServicePageProps {
  activeTab?: ApiServiceTabId;
  onTabChange?: (tab: ApiServiceTabId) => void;
}

export function ApiServicePage({ activeTab: controlledTab, onTabChange }: ApiServicePageProps) {
  const t = useTranslation();
  const [localTab, setLocalTab] = React.useState<ApiServiceTabId>('status');
  const activeTab = normalizeApiServiceTab(controlledTab ?? localTab);
  const setActiveTab = onTabChange ?? setLocalTab;
  const scrollAreaRef = React.useRef<HTMLDivElement>(null);
  const {
    loading,
    config,
    status,
    keys,
    modelOptions,
    accounts,
    busy,
    error,
    createdKey,
    dismissCreatedKey,
    setEnabled,
    updateEndpoint,
    createKey,
    revokeKey,
    setKeyEnabled,
    setKeyMaxConcurrency,
    setKeyPolicy,
    queryAudit,
    queueStatus,
    vouchers,
    createdVoucher,
    dismissCreatedVoucher,
    updateVoucherConfig,
    generateVoucher,
    revokeVoucher,
  } = useApiService();
  const incomplete = config ? missingKindsByEndpoint(config.endpoints) : [];
  const tabLabels = Object.fromEntries(
    API_SERVICE_TABS.map((tab) => [tab.id, t(tab.labelKey)]),
  ) as Record<ApiServiceTabId, string>;

  React.useEffect(() => {
    scrollAreaRef.current
      ?.querySelector<HTMLElement>('[data-scroll-container]')
      ?.scrollTo({ top: 0 });
  }, [activeTab]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b border-border/60 px-6 py-4">
        <div className="flex items-center gap-2">
          <ServerCog className="h-5 w-5 text-primary" aria-hidden="true" />
          <h2 className="text-lg font-semibold text-foreground">{t('apiService.gatewayTitle')}</h2>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{t('apiService.gatewayDescription')}</p>
      </header>

      {!loading && config ? (
        <ApiServiceTabs
          activeTab={activeTab}
          ariaLabel={t('apiService.gatewayTitle')}
          labels={tabLabels}
          onChange={setActiveTab}
        />
      ) : null}

      <ScrollArea ref={scrollAreaRef} className="flex-1">
        <div className="mx-auto max-w-5xl space-y-5 px-6 py-5">
          {loading ? (
            <p className="text-sm text-muted-foreground">{t('apiService.loading')}</p>
          ) : !config ? (
            <p className="text-sm text-destructive">{t('apiService.loadError')}</p>
          ) : (
            <>
              {error ? (
                <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {error}
                </p>
              ) : null}

              <div
                id="api-service-panel-status"
                role="tabpanel"
                aria-labelledby="api-service-tab-status"
                tabIndex={0}
                hidden={activeTab !== 'status'}
                className="space-y-5"
              >
                <ServerStatusBanner status={status} />

                <QueueStatusSummary
                  queueStatus={queueStatus}
                  running={status?.running ?? false}
                  onOpenLiveTraffic={() => setActiveTab('live-traffic')}
                />

                <SettingRow
                  label={t('apiService.enable.label')}
                  description={t('apiService.enable.description')}
                >
                  <Switch
                    checked={config.enabled}
                    disabled={busy}
                    onCheckedChange={(checked) => void setEnabled(checked)}
                    aria-label={t('apiService.enable.label')}
                  />
                </SettingRow>
              </div>

              <div
                id="api-service-panel-routes"
                role="tabpanel"
                aria-labelledby="api-service-tab-routes"
                tabIndex={0}
                hidden={activeTab !== 'routes'}
              >
                {config.enabled && incomplete.length > 0 ? (
                  <div className="mb-4 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <div className="space-y-1">
                      <p className="font-medium">{t('apiService.endpoint.cannotStart')}</p>
                      <ul className="space-y-0.5">
                        {incomplete.map((e) => (
                          <li key={e.endpoint}>
                            {t(`apiService.endpoint.name.${e.endpoint}`)}:{' '}
                            {e.missingKinds.map((k) => t(`apiService.endpoint.kind.${k}`)).join(', ')}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                ) : null}
                <section className="space-y-3">
                  <h3 className="text-sm font-semibold text-foreground">{t('apiService.endpoints.title')}</h3>
                  <p className="text-xs text-muted-foreground">{t('apiService.endpoints.description')}</p>
                  {config.endpoints.length > 0 ? (
                    <div className="space-y-3">
                      {config.endpoints.map((ep) => (
                        <EndpointRoutingCard
                          key={ep.endpoint}
                          endpoint={ep}
                          modelOptions={modelOptions}
                          accounts={accounts}
                          busy={busy}
                          onChange={(next) => void updateEndpoint(next)}
                        />
                      ))}
                    </div>
                  ) : (
                    <p className="rounded-md border border-dashed border-border/60 px-3 py-4 text-center text-xs text-muted-foreground">
                      {t('apiService.endpoints.empty')}
                    </p>
                  )}
                </section>
              </div>

              <div
                id="api-service-panel-access-keys"
                role="tabpanel"
                aria-labelledby="api-service-tab-access-keys"
                tabIndex={0}
                hidden={activeTab !== 'access-keys'}
                className="space-y-6"
              >
                <KeyManagementSection
                  keys={keys}
                  busy={busy}
                  createdKey={createdKey}
                  onCreate={createKey}
                  onRevoke={revokeKey}
                  onToggle={setKeyEnabled}
                  onSetMaxConcurrency={setKeyMaxConcurrency}
                  onSetPolicy={setKeyPolicy}
                  onDismissCreated={dismissCreatedKey}
                />

                <VoucherSection
                  config={config}
                  vouchers={vouchers}
                  busy={busy}
                  createdVoucher={createdVoucher}
                  onUpdateConfig={updateVoucherConfig}
                  onGenerate={generateVoucher}
                  onRevoke={revokeVoucher}
                  onDismissCreated={dismissCreatedVoucher}
                />
              </div>

              <div
                id="api-service-panel-live-traffic"
                role="tabpanel"
                aria-labelledby="api-service-tab-live-traffic"
                tabIndex={0}
                hidden={activeTab !== 'live-traffic'}
                className="space-y-6"
              >
                <div>
                  <h3 className="text-sm font-semibold text-foreground">{t('apiService.liveTraffic.title')}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">{t('apiService.liveTraffic.description')}</p>
                </div>
                <QueueStatusView queueStatus={queueStatus} running={status?.running ?? false} />
                <RecentErrorsView
                  active={activeTab === 'live-traffic'}
                  auditEnabled={config.audit?.enabled === true}
                  onQuery={queryAudit}
                />
              </div>

            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

export default ApiServicePage;
