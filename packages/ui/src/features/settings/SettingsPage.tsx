import { MinusSquare, Power, Settings as SettingsIcon } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import { ScrollArea } from '@/components/ui/scroll-area';
import { Select } from '@/components/ui/select';
import { SettingRow } from '@/components/ui/setting-row';
import { Switch } from '@/components/ui/switch';
import { AuditSection } from '@/features/api-service/AuditSection';
import { BillingSection } from '@/features/api-service/BillingSection';
import { FingerprintSection } from '@/features/api-service/FingerprintSection';
import { useApiService } from '@/features/api-service/hooks/useApiService';
import { RequestQueueSection } from '@/features/api-service/RequestQueueSection';
import { WebhookSection } from '@/features/api-service/WebhookSection';
import { DataMigrationSection } from '@/features/provider-settings/DataMigrationSection';
import { PricingPage } from '@/features/pricing';
import i18n, { isLanguage, setLanguage, SUPPORTED_LANGUAGES, type Language } from '@/i18n';
import { useTranslation } from '@/shared/state/LocaleContext';
import { getUiSettings, isDesktop, setUiSettings, type UiSettings } from '@/shared/tauri/uiSettings';

import { AllowanceSchedulingSection } from './AllowanceSchedulingSection';
import { NetworkSettingsSection } from './NetworkSettingsSection';
import { normalizeSettingsTab, SETTINGS_TABS, type SettingsTabId } from './settingsTabModel';
import { SettingsTabs } from './SettingsTabs';

function currentLang(): Language {
  const lang = i18n.language ?? 'en';
  if (isLanguage(lang)) return lang;
  const base = lang.split('-')[0];
  return isLanguage(base) ? base : 'en';
}

interface SettingsPageProps {
  activeTab?: SettingsTabId;
  onTabChange?: (tab: SettingsTabId) => void;
}

type OperationalTab = Exclude<SettingsTabId, 'general' | 'pricing'>;

function OperationalSettingsPanel({ tab }: { tab: OperationalTab }) {
  const t = useTranslation();
  const service = useApiService();
  let content: React.ReactNode = null;
  if (service.config) {
    if (tab === 'network') {
      content = (
        <NetworkSettingsSection
          config={service.config}
          busy={service.busy}
          onSetNetworkBinding={service.setNetworkBinding}
          onUpdateProxy={service.updateProxyConfig}
        />
      );
    } else if (tab === 'security') {
      content = (
        <div className="space-y-5">
          <section className="rounded-xl border border-border/70 bg-surface-1/60 p-4 md:p-5">
            <h3 className="text-sm font-semibold text-foreground">{t('settings.security.title')}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{t('settings.security.description')}</p>
          </section>
          <FingerprintSection config={service.config} busy={service.busy} onUpdate={service.updateFingerprintConfig} />
        </div>
      );
    } else if (tab === 'data') {
      content = (
        <div className="space-y-5">
          <DataMigrationSection />
          <AuditSection config={service.config} busy={service.busy} onUpdate={service.updateAuditConfig} onQuery={service.queryAudit} />
        </div>
      );
    } else if (tab === 'notifications') {
      content = <WebhookSection config={service.config} busy={service.busy} onUpdate={service.updateWebhookConfig} onTest={service.testWebhook} />;
    } else if (tab === 'advanced') {
      content = (
        <div className="space-y-5">
          <AllowanceSchedulingSection config={service.config.allowanceScheduling} busy={service.busy} onUpdate={service.updateAllowanceSchedulingConfig} onLoadStatus={service.getAllowanceSchedulingStatus} />
          <RequestQueueSection config={service.config} busy={service.busy} onUpdate={service.updateQueueConfig} />
        </div>
      );
    } else if (tab === 'billing') {
      content = <BillingSection config={service.config} busy={service.busy} onUpdate={service.updateBillingConfig} onQueryStatus={service.queryBillingStatus} />;
    }
  }

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-5xl px-4 py-5 md:px-6">
        {service.loading ? <p className="text-sm text-muted-foreground">{t('apiService.loading')}</p> : null}
        {service.error ? <p className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{service.error}</p> : null}
        {!service.loading && service.config ? content : null}
        {!service.loading && !service.config ? <p className="text-sm text-destructive">{t('apiService.loadError')}</p> : null}
      </div>
    </ScrollArea>
  );
}

export function SettingsPage({ activeTab: controlledTab, onTabChange }: SettingsPageProps) {
  const t = useTranslation();
  const desktop = isDesktop();
  const [localTab, setLocalTab] = useState<SettingsTabId>('general');
  const activeTab = normalizeSettingsTab(controlledTab ?? localTab);
  const setActiveTab = onTabChange ?? setLocalTab;
  const [lang, setLang] = useState<Language>(currentLang());
  const [settings, setSettings] = useState<UiSettings>({
    closeToTray: false,
    startMinimized: false,
    autoStart: false,
    language: currentLang(),
  });
  const labels = Object.fromEntries(SETTINGS_TABS.map((tab) => [tab.id, t(tab.labelKey)])) as Record<SettingsTabId, string>;

  useEffect(() => {
    let cancelled = false;
    void getUiSettings().then((fresh) => { if (fresh && !cancelled) setSettings(fresh); });
    return () => { cancelled = true; };
  }, []);

  const update = async (patch: Partial<UiSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
    await setUiSettings(patch);
    const fresh = await getUiSettings();
    if (fresh) setSettings(fresh);
  };

  const handleLanguage = (value: string) => {
    const next: Language = isLanguage(value) ? value : 'en';
    setLanguage(next);
    setLang(next);
    void setUiSettings({ language: next });
  };

  const panel = (tab: SettingsTabId, content: React.ReactNode) => (
    <div
      id={`settings-panel-${tab}`}
      role="tabpanel"
      aria-labelledby={`settings-tab-${tab}`}
      tabIndex={0}
      hidden={activeTab !== tab}
      className="h-full"
    >
      {content}
    </div>
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b border-border/60 px-4 py-4 md:px-6">
        <div className="mx-auto flex max-w-5xl items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2">
            <SettingsIcon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-foreground">{t('settings.title')}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{t('settings.description')}</p>
          </div>
        </div>
      </header>

      <SettingsTabs activeTab={activeTab} labels={labels} onChange={setActiveTab} ariaLabel={t('settings.title')} />

      <div className="min-h-0 flex-1">
        {panel('general', (
          <ScrollArea className="h-full">
            <div className="mx-auto max-w-3xl space-y-5 px-4 py-5 md:px-6">
              {!desktop ? <div className="rounded-md border border-border/60 bg-surface-2/40 px-4 py-3 text-sm text-muted-foreground">{t('settings.desktopOnly')}</div> : null}
              <section className="space-y-3 rounded-xl border border-border/70 bg-surface-1/60 p-4 md:p-5">
                <h3 className="text-sm font-semibold text-foreground">{t('settings.language.title')}</h3>
                <SettingRow label={t('settings.language.label')}>
                  <Select value={lang} options={SUPPORTED_LANGUAGES.map(({ code, nativeName }) => ({ value: code, label: nativeName }))} onChange={handleLanguage} size="sm" className="w-32" />
                </SettingRow>
              </section>
              <section className="space-y-3 rounded-xl border border-border/70 bg-surface-1/60 p-4 md:p-5">
                <h3 className="text-sm font-semibold text-foreground">{t('settings.startup.title')}</h3>
                <SettingRow icon={Power} label={t('settings.startup.autoLaunch')} description={t('settings.startup.autoLaunchHint')}>
                  <Switch checked={settings.autoStart} disabled={!desktop} onCheckedChange={(value) => void update({ autoStart: value })} />
                </SettingRow>
                <SettingRow label={t('settings.startup.startMinimized')} description={t('settings.startup.startMinimizedHint')}>
                  <Switch checked={settings.startMinimized} disabled={!desktop} onCheckedChange={(value) => void update({ startMinimized: value })} />
                </SettingRow>
                <SettingRow icon={MinusSquare} label={t('settings.tray.minimizeOnClose')} description={t('settings.tray.minimizeOnCloseHint')}>
                  <Switch checked={settings.closeToTray} disabled={!desktop} onCheckedChange={(value) => void update({ closeToTray: value })} />
                </SettingRow>
              </section>
            </div>
          </ScrollArea>
        ))}
        {panel('network', activeTab === 'network' ? <OperationalSettingsPanel tab="network" /> : null)}
        {panel('security', activeTab === 'security' ? <OperationalSettingsPanel tab="security" /> : null)}
        {panel('data', activeTab === 'data' ? <OperationalSettingsPanel tab="data" /> : null)}
        {panel('notifications', activeTab === 'notifications' ? <OperationalSettingsPanel tab="notifications" /> : null)}
        {panel('advanced', activeTab === 'advanced' ? <OperationalSettingsPanel tab="advanced" /> : null)}
        {panel('billing', activeTab === 'billing' ? <OperationalSettingsPanel tab="billing" /> : null)}
        {panel('pricing', activeTab === 'pricing' ? <PricingPage /> : null)}
      </div>
    </div>
  );
}

export default SettingsPage;
