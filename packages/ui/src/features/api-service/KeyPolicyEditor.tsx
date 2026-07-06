/**
 * KeyPolicyEditor.tsx — the per-key policy panel (outbound-key-policy): expiry /
 * first-use activation, daily/total/weekly USD cost caps, the per-key rate limit
 * (max requests + window), and the per-key model restriction (#6: enable toggle +
 * blacklist/allowlist mode + model-id list). Seeds its drafts from the key's
 * stored policy; on Save it builds an `OutboundKeyPolicyPatch` (blank field →
 * `null` = clear, a value → set) and calls `onSave`.
 *
 * Secret discipline: this panel only ever shows/edits the key's OWN non-secret
 * policy scalars (never a hash or plaintext).
 */

import React, { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTranslation } from '@/shared/state/LocaleContext';

import type { OutboundApiKeyInfo, OutboundKeyPolicyPatch } from '@/daemon/types';

type ExpiryMode = 'none' | 'fixed' | 'activation';
type RestrictionMode = 'blacklist' | 'allowlist';

/** Split a model-id textarea (newline- or comma-separated) into trimmed ids. */
function parseModelList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** epoch ms → the `datetime-local` input value (local time), or '' when unset. */
function toDateTimeLocal(ms: number | null | undefined): string {
  if (ms == null) return '';
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A `datetime-local` value → epoch ms, or null when blank/invalid. */
function fromDateTimeLocal(value: string): number | null {
  if (!value.trim()) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** A number-input string → a finite number, or null when blank/invalid. */
function numOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

export function KeyPolicyEditor({
  keyInfo,
  busy,
  onSave,
}: {
  keyInfo: OutboundApiKeyInfo;
  busy: boolean;
  onSave: (policy: OutboundKeyPolicyPatch) => Promise<void>;
}) {
  const t = useTranslation();

  const initialMode: ExpiryMode = useMemo(() => {
    if (keyInfo.activationMode === 'activation') return 'activation';
    if (keyInfo.expiresAt != null) return 'fixed';
    return 'none';
  }, [keyInfo.activationMode, keyInfo.expiresAt]);

  const [mode, setMode] = useState<ExpiryMode>(initialMode);
  const [expiresAt, setExpiresAt] = useState(toDateTimeLocal(keyInfo.expiresAt));
  const [activationDays, setActivationDays] = useState(
    keyInfo.activationDays != null ? String(keyInfo.activationDays) : '',
  );
  const [dailyCost, setDailyCost] = useState(
    keyInfo.dailyCostLimitUsd != null ? String(keyInfo.dailyCostLimitUsd) : '',
  );
  const [totalCost, setTotalCost] = useState(
    keyInfo.totalCostLimitUsd != null ? String(keyInfo.totalCostLimitUsd) : '',
  );
  const [weeklyCost, setWeeklyCost] = useState(
    keyInfo.weeklyCostLimitUsd != null ? String(keyInfo.weeklyCostLimitUsd) : '',
  );
  const [rateMax, setRateMax] = useState(
    keyInfo.rateLimitMaxRequests != null ? String(keyInfo.rateLimitMaxRequests) : '',
  );
  const [rateWindow, setRateWindow] = useState(
    keyInfo.rateLimitWindowMs != null ? String(keyInfo.rateLimitWindowMs) : '',
  );
  // Per-key model restriction (#6): enable toggle + mode + model-id list.
  const [modelRestrict, setModelRestrict] = useState(keyInfo.enableModelRestriction === true);
  const [restrictionMode, setRestrictionMode] = useState<RestrictionMode>(
    keyInfo.restrictionMode ?? 'blacklist',
  );
  const [restrictedModelsText, setRestrictedModelsText] = useState(
    (keyInfo.restrictedModels ?? []).join('\n'),
  );

  const parsedModels = parseModelList(restrictedModelsText);
  // An enabled allowlist with zero entries denies every request — warn the operator.
  const emptyAllowlistWarning =
    modelRestrict && restrictionMode === 'allowlist' && parsedModels.length === 0;

  const save = (): void => {
    // Build the three-way patch. Expiry mode drives which of the two expiry
    // shapes is set and clears the other, so switching modes never leaves a
    // stale field behind.
    const patch: OutboundKeyPolicyPatch = {
      dailyCostLimitUsd: numOrNull(dailyCost),
      totalCostLimitUsd: numOrNull(totalCost),
      weeklyCostLimitUsd: numOrNull(weeklyCost),
      rateLimitMaxRequests: numOrNull(rateMax),
      rateLimitWindowMs: numOrNull(rateWindow),
    };
    if (mode === 'fixed') {
      patch.activationMode = 'fixed';
      patch.expiresAt = fromDateTimeLocal(expiresAt);
      patch.activationDays = null;
    } else if (mode === 'activation') {
      patch.activationMode = 'activation';
      patch.activationDays = numOrNull(activationDays);
      patch.expiresAt = null;
    } else {
      patch.activationMode = 'fixed';
      patch.expiresAt = null;
      patch.activationDays = null;
    }
    // Model restriction (#6): always send the three fields explicitly. When the
    // toggle is off the list is kept but inert (the daemon only enforces when
    // `enableModelRestriction` is true), so the operator can re-enable without
    // retyping the list.
    patch.enableModelRestriction = modelRestrict;
    patch.restrictionMode = restrictionMode;
    patch.restrictedModels = parsedModels;
    void onSave(patch);
  };

  const field = (label: string, node: React.ReactNode): React.ReactNode => (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>
      {node}
    </label>
  );

  return (
    <div className="mt-2 space-y-3 border-t border-border/60 pt-3">
      {field(
        t('apiService.keys.policy.expiryMode'),
        <select
          className="h-8 rounded-md border border-border/60 bg-surface-0 px-2 text-sm text-foreground"
          value={mode}
          disabled={busy}
          onChange={(e) => setMode(e.target.value as ExpiryMode)}
        >
          <option value="none">{t('apiService.keys.policy.expiryNone')}</option>
          <option value="fixed">{t('apiService.keys.policy.expiryFixed')}</option>
          <option value="activation">{t('apiService.keys.policy.expiryActivation')}</option>
        </select>,
      )}

      {mode === 'fixed'
        ? field(
            t('apiService.keys.policy.expiresAt'),
            <Input
              type="datetime-local"
              density="compact"
              value={expiresAt}
              disabled={busy}
              onChange={(e) => setExpiresAt(e.target.value)}
            />,
          )
        : null}

      {mode === 'activation'
        ? field(
            t('apiService.keys.policy.activationDays'),
            <Input
              type="number"
              min={1}
              density="compact"
              value={activationDays}
              disabled={busy}
              onChange={(e) => setActivationDays(e.target.value)}
            />,
          )
        : null}

      {mode === 'activation' && keyInfo.activatedAt != null ? (
        <p className="text-[11px] text-muted-foreground">
          {t('apiService.keys.policy.activatedAt')}: {new Date(keyInfo.activatedAt).toLocaleString()}
        </p>
      ) : null}

      {keyInfo.spend ? (
        <p className="text-[11px] text-muted-foreground">
          {t('apiService.keys.policy.spent')}: {t('apiService.keys.policy.dailyCost')} $
          {keyInfo.spend.dailyUsd.toFixed(4)} · {t('apiService.keys.policy.weeklyCost')} $
          {keyInfo.spend.weeklyUsd.toFixed(4)} · {t('apiService.keys.policy.totalCost')} $
          {keyInfo.spend.totalUsd.toFixed(4)}
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {field(
          t('apiService.keys.policy.dailyCost'),
          <Input
            type="number"
            min={0}
            step="0.01"
            density="compact"
            placeholder={t('apiService.keys.policy.unlimitedHint')}
            value={dailyCost}
            disabled={busy}
            onChange={(e) => setDailyCost(e.target.value)}
          />,
        )}
        {field(
          t('apiService.keys.policy.weeklyCost'),
          <Input
            type="number"
            min={0}
            step="0.01"
            density="compact"
            placeholder={t('apiService.keys.policy.unlimitedHint')}
            value={weeklyCost}
            disabled={busy}
            onChange={(e) => setWeeklyCost(e.target.value)}
          />,
        )}
        {field(
          t('apiService.keys.policy.totalCost'),
          <Input
            type="number"
            min={0}
            step="0.01"
            density="compact"
            placeholder={t('apiService.keys.policy.unlimitedHint')}
            value={totalCost}
            disabled={busy}
            onChange={(e) => setTotalCost(e.target.value)}
          />,
        )}
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {field(
          t('apiService.keys.policy.rateMax'),
          <Input
            type="number"
            min={0}
            density="compact"
            placeholder={t('apiService.keys.policy.rateDefaultHint')}
            value={rateMax}
            disabled={busy}
            onChange={(e) => setRateMax(e.target.value)}
          />,
        )}
        {field(
          t('apiService.keys.policy.rateWindow'),
          <Input
            type="number"
            min={1}
            density="compact"
            placeholder={t('apiService.keys.policy.rateDefaultHint')}
            value={rateWindow}
            disabled={busy}
            onChange={(e) => setRateWindow(e.target.value)}
          />,
        )}
      </div>

      <div className="space-y-2 border-t border-border/60 pt-3">
        <label className="flex items-center justify-between gap-2">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {t('apiService.keys.policy.modelRestrictionTitle')}
          </span>
          <input
            type="checkbox"
            className="h-4 w-4 accent-primary"
            checked={modelRestrict}
            disabled={busy}
            onChange={(e) => setModelRestrict(e.target.checked)}
            aria-label={t('apiService.keys.policy.modelRestrictionEnable')}
          />
        </label>

        {modelRestrict ? (
          <>
            {field(
              t('apiService.keys.policy.modelRestrictionMode'),
              <select
                className="h-8 rounded-md border border-border/60 bg-surface-0 px-2 text-sm text-foreground"
                value={restrictionMode}
                disabled={busy}
                onChange={(e) => setRestrictionMode(e.target.value as RestrictionMode)}
              >
                <option value="blacklist">
                  {t('apiService.keys.policy.modelRestrictionBlacklist')}
                </option>
                <option value="allowlist">
                  {t('apiService.keys.policy.modelRestrictionAllowlist')}
                </option>
              </select>,
            )}
            {field(
              t('apiService.keys.policy.modelRestrictionList'),
              <textarea
                className="min-h-[64px] rounded-md border border-border/60 bg-surface-0 px-2 py-1.5 text-sm text-foreground"
                value={restrictedModelsText}
                disabled={busy}
                placeholder={t('apiService.keys.policy.modelRestrictionListHint')}
                onChange={(e) => setRestrictedModelsText(e.target.value)}
              />,
            )}
            {emptyAllowlistWarning ? (
              <p className="text-[11px] text-destructive">
                {t('apiService.keys.policy.modelRestrictionEmptyAllowlistWarning')}
              </p>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="flex justify-end">
        <Button variant="default" size="sm" disabled={busy} onClick={save}>
          {t('apiService.keys.policy.save')}
        </Button>
      </div>
    </div>
  );
}
