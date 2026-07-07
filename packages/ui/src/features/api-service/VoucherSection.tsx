/**
 * VoucherSection.tsx — the "Redemption cards" settings card (voucher-redemption
 * #9). Edits the `server.voucher` segment (a master enable switch) and, when
 * enabled, generates / lists / revokes cards.
 *
 * SECRET DISCIPLINE: the generated `CC_…` code is returned exactly ONCE (a
 * dismissible copy-to-clipboard reveal that makes clear it will not be shown
 * again); the list shows only the display prefix + status (never the code hash).
 * Redemption itself is key-self-serve on the outbound server (`POST /redeem`) —
 * documented here, not performed from the admin panel.
 */

import { Check, Copy, Ticket, Trash2 } from 'lucide-react';
import React, { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { SettingRow } from '@/components/ui/setting-row';
import { Switch } from '@/components/ui/switch';
import { useTranslation } from '@/shared/state/LocaleContext';

import type {
  OutboundApiServerConfig,
  VoucherCreated,
  VoucherGenerateInput,
  VoucherInfo,
  VoucherType,
} from '@/daemon/types';

interface VoucherSectionProps {
  config: OutboundApiServerConfig;
  vouchers: VoucherInfo[];
  busy: boolean;
  createdVoucher: VoucherCreated | null;
  onUpdateConfig: (voucher: OutboundApiServerConfig['voucher'] | undefined) => Promise<void>;
  onGenerate: (input: VoucherGenerateInput) => Promise<boolean>;
  onRevoke: (id: string) => Promise<void>;
  onDismissCreated: () => void;
}

/** The one-time plaintext-code reveal — shown once, never re-fetchable. */
function CreatedVoucherReveal({
  created,
  onDismiss,
}: {
  created: VoucherCreated;
  onDismiss: () => void;
}) {
  const t = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(created.plaintextOnce).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="rounded-md border border-primary/50 bg-primary-soft/20 p-3 space-y-2" role="status">
      <div className="text-sm font-medium text-foreground">{t('apiService.voucher.created.title')}</div>
      <p className="text-xs text-muted-foreground">{t('apiService.voucher.created.warning')}</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-surface-2/70 px-2 py-1.5 text-xs text-foreground">
          {created.plaintextOnce}
        </code>
        <Button variant="outline" size="sm" onClick={copy}>
          {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? t('apiService.voucher.created.copied') : t('apiService.voucher.created.copy')}
        </Button>
      </div>
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          {t('apiService.voucher.created.dismiss')}
        </Button>
      </div>
    </div>
  );
}

/** Parse a positive number from a draft string, or undefined when blank/invalid. */
function parsePositive(draft: string): number | undefined {
  const trimmed = draft.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function statusVariant(status: VoucherInfo['status']): 'success' | 'secondary' | 'destructive' {
  if (status === 'unredeemed') return 'success';
  if (status === 'redeemed') return 'secondary';
  return 'destructive';
}

export function VoucherSection({
  config,
  vouchers,
  busy,
  createdVoucher,
  onUpdateConfig,
  onGenerate,
  onRevoke,
  onDismissCreated,
}: VoucherSectionProps) {
  const t = useTranslation();
  const enabled = config.voucher?.enabled === true;
  const [type, setType] = useState<VoucherType>('credit');
  const [value, setValue] = useState(''); // creditUsd or renewalDays
  const [maxTotal, setMaxTotal] = useState('');
  const [maxDays, setMaxDays] = useState('');
  const [revokeTarget, setRevokeTarget] = useState<VoucherInfo | null>(null);

  const primaryValue = parsePositive(value);
  const canGenerate = enabled && !busy && primaryValue !== undefined;

  const handleGenerate = async () => {
    if (primaryValue === undefined) return;
    const input: VoucherGenerateInput = { type };
    if (type === 'credit') input.creditUsd = primaryValue;
    else input.renewalDays = Math.round(primaryValue);
    const mt = parsePositive(maxTotal);
    if (mt !== undefined) input.maxTotalCostLimitUsd = mt;
    const md = parsePositive(maxDays);
    if (md !== undefined) input.maxExpiryDays = Math.round(md);
    const ok = await onGenerate(input);
    if (ok) {
      setValue('');
      setMaxTotal('');
      setMaxDays('');
    }
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Ticket className="h-4 w-4 text-primary" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-foreground">{t('apiService.voucher.title')}</h3>
      </div>
      <p className="text-xs text-muted-foreground">{t('apiService.voucher.description')}</p>

      <SettingRow
        label={t('apiService.voucher.enable.label')}
        description={t('apiService.voucher.enable.description')}
      >
        <Switch
          checked={enabled}
          disabled={busy}
          onCheckedChange={(checked) => void onUpdateConfig({ enabled: checked })}
          aria-label={t('apiService.voucher.enable.label')}
        />
      </SettingRow>

      {createdVoucher ? (
        <CreatedVoucherReveal created={createdVoucher} onDismiss={onDismissCreated} />
      ) : null}

      {/* Generate form */}
      <div className="space-y-2 rounded-md border border-border/60 bg-surface-0/60 p-3">
        <div className="flex items-center gap-2">
          <Button
            variant={type === 'credit' ? 'secondary' : 'ghost'}
            size="sm"
            disabled={busy || !enabled}
            onClick={() => setType('credit')}
          >
            {t('apiService.voucher.type.credit')}
          </Button>
          <Button
            variant={type === 'renewal' ? 'secondary' : 'ghost'}
            size="sm"
            disabled={busy || !enabled}
            onClick={() => setType('renewal')}
          >
            {t('apiService.voucher.type.renewal')}
          </Button>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Input
            type="number"
            min={0}
            density="compact"
            value={value}
            disabled={busy || !enabled}
            placeholder={
              type === 'credit'
                ? t('apiService.voucher.creditUsd.placeholder')
                : t('apiService.voucher.renewalDays.placeholder')
            }
            aria-label={
              type === 'credit'
                ? t('apiService.voucher.creditUsd.label')
                : t('apiService.voucher.renewalDays.label')
            }
            onChange={(e) => setValue(e.target.value)}
          />
          <Input
            type="number"
            min={0}
            density="compact"
            value={maxTotal}
            disabled={busy || !enabled}
            placeholder={t('apiService.voucher.maxTotal.placeholder')}
            aria-label={t('apiService.voucher.maxTotal.label')}
            onChange={(e) => setMaxTotal(e.target.value)}
          />
          <Input
            type="number"
            min={0}
            density="compact"
            value={maxDays}
            disabled={busy || !enabled}
            placeholder={t('apiService.voucher.maxDays.placeholder')}
            aria-label={t('apiService.voucher.maxDays.label')}
            onChange={(e) => setMaxDays(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={!canGenerate} onClick={() => void handleGenerate()}>
            {t('apiService.voucher.generate')}
          </Button>
          {!enabled ? (
            <span className="text-[11px] text-muted-foreground">{t('apiService.voucher.disabledHint')}</span>
          ) : null}
        </div>
      </div>

      {/* Card list */}
      {vouchers.length === 0 ? (
        <p className="rounded-md border border-dashed border-border/60 px-3 py-4 text-center text-xs text-muted-foreground">
          {t('apiService.voucher.empty')}
        </p>
      ) : (
        <ul className="space-y-2">
          {vouchers.map((v) => (
            <li
              key={v.id}
              className="flex items-center gap-3 rounded-md border border-border/60 bg-surface-0/60 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <code className="text-xs text-muted-foreground">{v.codePrefix}…</code>
                  <Badge variant={statusVariant(v.status)}>
                    {t(`apiService.voucher.status.${v.status}`)}
                  </Badge>
                </div>
                <span className="text-[11px] text-muted-foreground">
                  {v.type === 'credit'
                    ? t('apiService.voucher.value.credit', { amount: v.creditUsd ?? 0 })
                    : t('apiService.voucher.value.renewal', { days: v.renewalDays ?? 0 })}
                </span>
              </div>
              {v.status === 'unredeemed' ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  disabled={busy}
                  onClick={() => setRevokeTarget(v)}
                  aria-label={t('apiService.voucher.revoke')}
                >
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {/* Redeem endpoint documentation (key-self-serve) */}
      <div className="rounded-md border border-border/50 bg-surface-1/40 px-3 py-2 text-xs text-muted-foreground">
        <div className="font-medium text-foreground">{t('apiService.voucher.redeemInfo.title')}</div>
        <p className="mt-0.5">{t('apiService.voucher.redeemInfo.description')}</p>
        <code className="mt-1 block rounded bg-surface-2/70 px-2 py-1 text-foreground">
          POST /redeem {'{ "code": "CC_…" }'}
        </code>
      </div>

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        title={t('apiService.voucher.revokeConfirmTitle')}
        description={
          revokeTarget
            ? t('apiService.voucher.revokeConfirmDesc', { prefix: revokeTarget.codePrefix })
            : undefined
        }
        confirmLabel={t('apiService.voucher.revoke')}
        cancelLabel={t('common.cancel')}
        variant="destructive"
        onConfirm={() => {
          if (revokeTarget) void onRevoke(revokeTarget.id);
          setRevokeTarget(null);
        }}
      />
    </section>
  );
}

export default VoucherSection;
