/**
 * FingerprintSection.tsx — the "Client fingerprint" settings card
 * (subscription-client-fingerprint #7).
 *
 * Edits the `server.fingerprint` segment: a master enable switch + an OPTIONAL
 * operator UA baseline (applied only to accounts with no captured identity —
 * never a fabricated stainless value). Opt-in, default OFF: disabled ⇒ the
 * claude-subscription outbound headers are byte-identical to before. A change
 * takes effect on daemon restart. Carries NO secret and never surfaces another
 * account's captured headers.
 */

import { Fingerprint } from 'lucide-react';
import React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingRow } from '@/components/ui/setting-row';
import { Switch } from '@/components/ui/switch';
import { useTranslation } from '@/shared/state/LocaleContext';

import type { FingerprintConfig, OutboundApiServerConfig } from '@/daemon/types';

const DEFAULT_FINGERPRINT: FingerprintConfig = { enabled: false };

interface FingerprintSectionProps {
  config: OutboundApiServerConfig;
  busy: boolean;
  onUpdate: (fingerprint: OutboundApiServerConfig['fingerprint'] | undefined) => Promise<void>;
}

export function FingerprintSection({ config, busy, onUpdate }: FingerprintSectionProps) {
  const t = useTranslation();
  const [draft, setDraft] = React.useState<FingerprintConfig>(config.fingerprint ?? DEFAULT_FINGERPRINT);

  React.useEffect(() => {
    setDraft(config.fingerprint ?? DEFAULT_FINGERPRINT);
  }, [config.fingerprint]);

  const patch = (p: Partial<FingerprintConfig>): void => setDraft((d) => ({ ...d, ...p }));
  const save = (): Promise<void> => onUpdate(draft);

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Fingerprint className="h-4 w-4 text-primary" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-foreground">{t('apiService.fingerprint.title')}</h3>
      </div>
      <p className="text-xs text-muted-foreground">{t('apiService.fingerprint.description')}</p>

      <SettingRow
        label={t('apiService.fingerprint.enable.label')}
        description={t('apiService.fingerprint.enable.description')}
      >
        <Switch
          checked={draft.enabled}
          disabled={busy}
          onCheckedChange={(checked) => patch({ enabled: checked })}
          aria-label={t('apiService.fingerprint.enable.label')}
        />
      </SettingRow>

      <SettingRow
        label={t('apiService.fingerprint.ua.label')}
        description={t('apiService.fingerprint.ua.description')}
      >
        <Input
          className="w-64"
          value={draft.ua ?? ''}
          disabled={busy || !draft.enabled}
          placeholder={t('apiService.fingerprint.ua.placeholder')}
          onChange={(e) => patch({ ua: e.target.value || undefined })}
          aria-label={t('apiService.fingerprint.ua.label')}
        />
      </SettingRow>

      <div className="flex items-center gap-2">
        <Button size="sm" disabled={busy} onClick={() => void save()}>
          {t('apiService.fingerprint.save')}
        </Button>
        <span className="text-[11px] text-muted-foreground">{t('apiService.fingerprint.restartHint')}</span>
      </div>
    </section>
  );
}

export default FingerprintSection;
