/**
 * BillingSection.tsx — the "Billing event stream" settings card
 * (billing-event-stream, Phase 2).
 *
 * Edits the `server.billing` segment: a master enable switch, the optional POST
 * endpoint (absent ⇒ ledger-only mode), the optional HMAC signing secret
 * (write-only, masked on read), and the retry-age bound. Edits are held in a
 * local draft; Save PUTs the WHOLE segment (the daemon preserves the write-only
 * secret when the field is left masked). A delivery-status indicator reads the
 * secret-free total/delivered/pending counts.
 */

import { Receipt, RefreshCw } from 'lucide-react';
import React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RevealableInput } from '@/components/ui/revealable-input';
import { SettingRow } from '@/components/ui/setting-row';
import { Switch } from '@/components/ui/switch';
import { useTranslation } from '@/shared/state/LocaleContext';

import type { BillingConfig, BillingDeliveryStatus, OutboundApiServerConfig } from '@/daemon/types';

const DEFAULT_BILLING: BillingConfig = { enabled: false, maxRetryAgeMs: 24 * 60 * 60_000 };

interface BillingSectionProps {
  config: OutboundApiServerConfig;
  busy: boolean;
  onUpdate: (billing: OutboundApiServerConfig['billing'] | undefined) => Promise<void>;
  onQueryStatus: () => Promise<BillingDeliveryStatus>;
}

export function BillingSection({ config, busy, onUpdate, onQueryStatus }: BillingSectionProps) {
  const t = useTranslation();
  const seeded: BillingConfig = config.billing ?? DEFAULT_BILLING;
  const [draft, setDraft] = React.useState<BillingConfig>(seeded);
  const [status, setStatus] = React.useState<BillingDeliveryStatus | null>(null);
  const [querying, setQuerying] = React.useState(false);

  React.useEffect(() => {
    setDraft(config.billing ?? DEFAULT_BILLING);
  }, [config.billing]);

  const patch = (p: Partial<BillingConfig>): void => setDraft((d) => ({ ...d, ...p }));
  const save = (): Promise<void> => onUpdate(draft);

  const refreshStatus = async (): Promise<void> => {
    setQuerying(true);
    try {
      setStatus(await onQueryStatus());
    } finally {
      setQuerying(false);
    }
  };

  // Retry age is edited in hours for readability; stored as ms.
  const retryHours = Math.round((draft.maxRetryAgeMs / 3_600_000) * 10) / 10;

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Receipt className="h-4 w-4 text-primary" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-foreground">{t('apiService.billing.title')}</h3>
      </div>
      <p className="text-xs text-muted-foreground">{t('apiService.billing.description')}</p>

      <SettingRow
        label={t('apiService.billing.enable.label')}
        description={t('apiService.billing.enable.description')}
      >
        <Switch
          checked={draft.enabled}
          disabled={busy}
          onCheckedChange={(checked) => patch({ enabled: checked })}
          aria-label={t('apiService.billing.enable.label')}
        />
      </SettingRow>

      <SettingRow
        label={t('apiService.billing.endpoint.label')}
        description={t('apiService.billing.endpoint.description')}
      >
        <Input
          className="w-64"
          value={draft.endpoint ?? ''}
          disabled={busy || !draft.enabled}
          placeholder={t('apiService.billing.endpoint.placeholder')}
          onChange={(e) => patch({ endpoint: e.target.value || undefined })}
          aria-label={t('apiService.billing.endpoint.label')}
        />
      </SettingRow>

      <SettingRow
        label={t('apiService.billing.secret.label')}
        description={t('apiService.billing.secret.description')}
      >
        <RevealableInput
          className="w-64"
          value={draft.secret ?? ''}
          disabled={busy || !draft.enabled || !draft.endpoint}
          placeholder={t('apiService.billing.secret.placeholder')}
          onChange={(e) => patch({ secret: e.target.value || undefined })}
          aria-label={t('apiService.billing.secret.label')}
        />
      </SettingRow>

      <SettingRow
        label={t('apiService.billing.maxRetryAge.label')}
        description={t('apiService.billing.maxRetryAge.description')}
      >
        <Input
          type="number"
          className="w-32"
          value={String(retryHours)}
          disabled={busy || !draft.enabled}
          onChange={(e) => patch({ maxRetryAgeMs: Math.max(0, Number(e.target.value) || 0) * 3_600_000 })}
          aria-label={t('apiService.billing.maxRetryAge.label')}
        />
      </SettingRow>

      <div className="flex items-center gap-2">
        <Button size="sm" disabled={busy} onClick={() => void save()}>
          {t('apiService.billing.save')}
        </Button>
      </div>

      {/* Delivery status — secret-free counts of the durable ledger. */}
      <div className="space-y-2 rounded-md border border-border/60 p-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-muted-foreground">{t('apiService.billing.status.title')}</p>
          <Button variant="outline" size="sm" disabled={querying} onClick={() => void refreshStatus()}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            {t('apiService.billing.status.refresh')}
          </Button>
        </div>
        {status === null ? (
          <p className="text-[11px] text-muted-foreground">{t('apiService.billing.status.hint')}</p>
        ) : (
          <div className="flex gap-4 text-[11px] text-foreground">
            <span>
              {t('apiService.billing.status.total')}: <strong>{status.total}</strong>
            </span>
            <span>
              {t('apiService.billing.status.delivered')}: <strong>{status.delivered}</strong>
            </span>
            <span>
              {t('apiService.billing.status.pending')}: <strong>{status.pending}</strong>
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

export default BillingSection;
