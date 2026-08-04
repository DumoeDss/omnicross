import { AlertTriangle, Globe2 } from 'lucide-react';

import { SettingRow } from '@/components/ui/setting-row';
import { Switch } from '@/components/ui/switch';
import type { OutboundApiServerConfig } from '@/daemon/types';
import { useTranslation } from '@/shared/state/LocaleContext';

import { ProxySection } from '@/features/api-service/ProxySection';

interface NetworkSettingsSectionProps {
  config: OutboundApiServerConfig;
  busy: boolean;
  onSetNetworkBinding: (enabled: boolean) => Promise<void>;
  onUpdateProxy: (proxy: OutboundApiServerConfig['proxy'] | undefined) => Promise<void>;
}

export function NetworkSettingsSection({
  config,
  busy,
  onSetNetworkBinding,
  onUpdateProxy,
}: NetworkSettingsSectionProps) {
  const t = useTranslation();

  return (
    <div className="space-y-5">
      <section className="space-y-3 rounded-xl border border-border/70 bg-surface-1/60 p-4 md:p-5">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2">
            <Globe2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground">{t('settings.network.title')}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{t('settings.network.description')}</p>
          </div>
        </div>

        <SettingRow
          label={t('apiService.networkBinding.label')}
          description={t('apiService.networkBinding.description')}
        >
          <Switch
            checked={config.networkBinding}
            disabled={busy}
            onCheckedChange={(enabled) => void onSetNetworkBinding(enabled)}
            aria-label={t('apiService.networkBinding.label')}
          />
        </SettingRow>

        {config.networkBinding ? (
          <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
            <span>{t('apiService.networkBinding.warning')}</span>
          </div>
        ) : null}
      </section>

      <ProxySection config={config} busy={busy} onUpdate={onUpdateProxy} />
    </div>
  );
}
