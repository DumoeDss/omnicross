/**
 * ApiServicePage.tsx — the API Service page shell. Composes the status banner,
 * the enable / network-binding toggles (with the LAN/subscription exposure
 * warning), the named-key management section, and the four per-endpoint routing
 * cards (folding in "Default Models").
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

import { AuditSection } from './AuditSection';
import { EndpointRoutingCard } from './EndpointRoutingCard';
import { missingKindsByEndpoint } from './endpointKinds';
import { useApiService } from './hooks/useApiService';
import { KeyManagementSection } from './KeyManagementSection';
import { ProxySection } from './ProxySection';
import { QueueStatusView } from './QueueStatusView';
import { RequestQueueSection } from './RequestQueueSection';
import { ServerStatusBanner } from './ServerStatusBanner';
import { WebhookSection } from './WebhookSection';

export function ApiServicePage() {
  const t = useTranslation();
  const {
    loading,
    config,
    status,
    keys,
    modelOptions,
    busy,
    error,
    createdKey,
    dismissCreatedKey,
    setEnabled,
    setNetworkBinding,
    updateEndpoint,
    createKey,
    revokeKey,
    setKeyEnabled,
    setKeyMaxConcurrency,
    setKeyPolicy,
    updateQueueConfig,
    updateProxyConfig,
    updateWebhookConfig,
    testWebhook,
    updateAuditConfig,
    queryAudit,
    queueStatus,
  } = useApiService();

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b border-border/60 px-6 py-4">
        <div className="flex items-center gap-2">
          <ServerCog className="h-5 w-5 text-primary" aria-hidden="true" />
          <h2 className="text-lg font-semibold text-foreground">{t('apiService.title')}</h2>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{t('apiService.description')}</p>
      </header>

      <ScrollArea className="flex-1">
        <div className="mx-auto max-w-3xl space-y-5 px-6 py-5">
          {loading ? (
            <p className="text-sm text-muted-foreground">{t('apiService.loading')}</p>
          ) : !config ? (
            <p className="text-sm text-destructive">{t('apiService.loadError')}</p>
          ) : (
            <>
              <ServerStatusBanner status={status} />

              <QueueStatusView queueStatus={queueStatus} />

              {error ? (
                <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {error}
                </p>
              ) : null}

              {(() => {
                // Client-side "service can't start" prompt: when the server is
                // enabled but a kind-mapped endpoint is missing required
                // mappings, the daemon's startup gate refuses to bind. Mirror
                // that here (identifying each endpoint + its missing kinds).
                const incomplete = missingKindsByEndpoint(config.endpoints);
                if (!config.enabled || incomplete.length === 0) return null;
                return (
                  <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
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
                );
              })()}

              <div className="space-y-2">
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
                <SettingRow
                  label={t('apiService.networkBinding.label')}
                  description={t('apiService.networkBinding.description')}
                >
                  <Switch
                    checked={config.networkBinding}
                    disabled={busy}
                    onCheckedChange={(checked) => void setNetworkBinding(checked)}
                    aria-label={t('apiService.networkBinding.label')}
                  />
                </SettingRow>
              </div>

              {config.networkBinding ? (
                <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
                  <span>{t('apiService.networkBinding.warning')}</span>
                </div>
              ) : null}

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

              <RequestQueueSection config={config} busy={busy} onUpdate={updateQueueConfig} />

              <ProxySection config={config} busy={busy} onUpdate={updateProxyConfig} />

              <WebhookSection config={config} busy={busy} onUpdate={updateWebhookConfig} onTest={testWebhook} />

              <AuditSection config={config} busy={busy} onUpdate={updateAuditConfig} onQuery={queryAudit} />

              <section className="space-y-3">
                <h3 className="text-sm font-semibold text-foreground">{t('apiService.endpoints.title')}</h3>
                <p className="text-xs text-muted-foreground">{t('apiService.endpoints.description')}</p>
                <div className="space-y-3">
                  {config.endpoints.map((ep) => (
                    <EndpointRoutingCard
                      key={ep.endpoint}
                      endpoint={ep}
                      modelOptions={modelOptions}
                      busy={busy}
                      onChange={(next) => void updateEndpoint(next)}
                    />
                  ))}
                </div>
              </section>
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

export default ApiServicePage;
