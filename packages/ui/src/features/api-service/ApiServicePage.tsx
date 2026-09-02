/**
 * ApiServicePage.tsx — the API Service page shell. The page keeps the complete
 * daemon-backed feature set, but groups it into focused tabs so server status
 * and critical controls no longer compete with every advanced setting.
 *
 * All primary controls are daemon-backed; edits drive off `GET /server`'s
 * editable config, never off the read-only `/status` projection.
 */

import { Cable, KeyRound, Route, ServerCog } from 'lucide-react';
import React from 'react';

import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SettingRow } from '@/components/ui/setting-row';
import { Switch } from '@/components/ui/switch';
import { useTranslation } from '@/shared/state/LocaleContext';
import type { RouteNavigate } from '@/shared/state/hashRoute';
import type { GatewayBinding } from '@/daemon/types';

import { normalizeApiServiceTab, type ApiServiceTabId } from './apiServiceTabModel';
import { routeForBinding, summarizeBindingCoverage } from './gatewayBindingUiModel';
import { useApiService } from './hooks/useApiService';
import { useCliIntegrations } from '../code-cli/hooks/useCliIntegrations';
import { ImagesSection } from './ImagesSection';
import { KeyManagementSection } from './KeyManagementSection';
import { QueueStatusSummary } from './QueueStatusSummary';
import { SearchSection } from './SearchSection';
import { ServerStatusBanner } from './ServerStatusBanner';
import { VoucherSection } from './VoucherSection';

interface ApiServicePageProps {
  activeTab?: ApiServiceTabId;
  onNavigate?: RouteNavigate;
}

export function ApiServicePage({ activeTab: controlledTab, onNavigate }: ApiServicePageProps) {
  const t = useTranslation();
  // The two gateway destinations (overview + access) are fully separated — each
  // is reached only via the NavRail, with no in-page tab switcher between them.
  const activeTab = normalizeApiServiceTab(controlledTab ?? 'overview');
  const scrollAreaRef = React.useRef<HTMLDivElement>(null);
  const cliIntegrations = useCliIntegrations();
  const {
    loading,
    config,
    status,
    imageCapability,
    keys,
    accounts,
    busy,
    error,
    createdKey,
    dismissCreatedKey,
    setEnabled,
    updateBindings,
    createKey,
    revealKey,
    revokeKey,
    deleteKey,
    setKeyEnabled,
    setKeyMaxConcurrency,
    setKeyPermissions,
    setKeyPolicy,
    updateImagesConfig,
    searchDiagnostics,
    updateSearchConfig,
    testSearchProvider,
    queueStatus,
    vouchers,
    createdVoucher,
    dismissCreatedVoucher,
    updateVoucherConfig,
    generateVoucher,
    revokeVoucher,
  } = useApiService();

  React.useEffect(() => {
    scrollAreaRef.current
      ?.querySelector<HTMLElement>('[data-scroll-container]')
      ?.scrollTo({ top: 0 });
  }, [activeTab]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b border-border/60 px-6 py-4">
        <div className="flex items-center gap-2">
          {activeTab === 'access'
            ? <KeyRound className="h-5 w-5 text-primary" aria-hidden="true" />
            : <ServerCog className="h-5 w-5 text-primary" aria-hidden="true" />}
          <h2 className="text-lg font-semibold text-foreground">
            {activeTab === 'access' ? t('nav.accessKeys') : t('apiService.gatewayTitle')}
          </h2>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {activeTab === 'access' ? t('apiService.accessDescription') : t('apiService.gatewayDescription')}
        </p>
      </header>

      <ScrollArea ref={scrollAreaRef} className="flex-1">
        <div className="mx-auto max-w-5xl space-y-5 px-6 py-5">
          {loading ? (
            <p className="text-sm text-muted-foreground">{t('apiService.loading')}</p>
          ) : !config ? (
            <p className="text-sm text-destructive">{t('apiService.loadError')}</p>
          ) : (
            <>
              {error || cliIntegrations.error ? (
                <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {error ?? cliIntegrations.error}
                </p>
              ) : null}

              <div
                id="api-service-panel-overview"
                role="tabpanel"
                aria-labelledby="api-service-tab-overview"
                tabIndex={0}
                hidden={activeTab !== 'overview'}
                className="space-y-5"
              >
                <ServerStatusBanner status={status} />

                <QueueStatusSummary
                  queueStatus={queueStatus}
                  running={status?.running ?? false}
                  onOpenLiveTraffic={() => onNavigate?.({ page: 'route-activity' })}
                />

                <BindingCoverage
                  bindings={config.bindings ?? []}
                  keyCount={keys.filter((key) => key.enabled && !key.revoked).length}
                  onOpenUpstreams={onNavigate ? () => onNavigate({ page: 'upstreams' }) : undefined}
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

                <ImagesSection
                  config={config.images}
                  capability={imageCapability}
                  status={status}
                  accounts={accounts.providerAccounts.codex}
                  busy={busy}
                  onUpdate={updateImagesConfig}
                />

                <SearchSection
                  config={config.search}
                  diagnostics={searchDiagnostics}
                  busy={busy}
                  onUpdate={updateSearchConfig}
                  onTest={testSearchProvider}
                />
              </div>

              <div
                id="api-service-panel-access"
                role="tabpanel"
                aria-labelledby="api-service-tab-access"
                tabIndex={0}
                hidden={activeTab !== 'access'}
                className="space-y-6"
              >
                <KeyManagementSection
                  keys={keys}
                  busy={busy}
                  createdKey={createdKey}
                  onCreate={createKey}
                  onReveal={revealKey}
                  onRevoke={revokeKey}
                  onDelete={deleteKey}
                  onToggle={setKeyEnabled}
                  onSetMaxConcurrency={setKeyMaxConcurrency}
                  onSetPermissions={setKeyPermissions}
                  onSetPolicy={setKeyPolicy}
                  onDismissCreated={dismissCreatedKey}
                  integrations={cliIntegrations.overview?.integrations ?? []}
                  onBindIntegration={cliIntegrations.bindKey}
                  bindings={config.bindings ?? []}
                  onOpenBinding={onNavigate ? (binding) => onNavigate(routeForBinding(binding)) : undefined}
                  onChangeBindings={updateBindings}
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

            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

export default ApiServicePage;

function BindingCoverage({ bindings, keyCount, onOpenUpstreams }: { bindings: GatewayBinding[]; keyCount: number; onOpenUpstreams?: () => void }) {
  const t = useTranslation();
  const coverage = summarizeBindingCoverage(bindings);
  return (
    <section className="rounded-xl border border-border/70 bg-surface-1/50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10"><Cable className="h-4 w-4 text-primary" /></span>
          <div>
            <h3 className="text-sm font-semibold">{t('apiService.bindingCoverage.title')}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{t('apiService.bindingCoverage.description')}</p>
          </div>
        </div>
        {onOpenUpstreams ? <Button size="sm" variant="outline" onClick={onOpenUpstreams}>{t('apiService.bindingCoverage.manage')}</Button> : null}
      </div>
      <div className="mt-4 grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3">
        <CoverageCell icon={Route} label={t('apiService.bindingCoverage.bindings')} value={coverage.enabled} />
        <CoverageCell icon={Cable} label={t('apiService.bindingCoverage.endpoints')} value={`${coverage.endpoints}/4`} />
        <CoverageCell icon={KeyRound} label={t('apiService.bindingCoverage.keyScoped')} value={`${coverage.keyScoped}/${Math.max(keyCount, 0)}`} />
      </div>
    </section>
  );
}

function CoverageCell({ icon: Icon, label, value }: { icon: typeof Route; label: string; value: string | number }) {
  return <div className="flex items-center gap-3 bg-surface-0 px-3 py-3"><Icon className="h-4 w-4 text-primary" /><div><p className="text-lg font-semibold leading-none">{value}</p><p className="mt-1 text-[11px] text-muted-foreground">{label}</p></div></div>;
}
