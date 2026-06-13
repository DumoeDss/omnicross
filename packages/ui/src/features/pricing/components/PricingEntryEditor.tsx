/**
 * PricingEntryEditor.tsx — the shared add/edit form over a `PricingDraft`.
 * Validation is client-side via `validateDraft` (mirrors the daemon's PUT
 * rules); field-level errors render under the inputs and BLOCK the save —
 * no request is sent for an invalid draft. Empty cache prices submit null.
 */

import React, { useId, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTranslation } from '@/shared/state/LocaleContext';

import { validateDraft, type DraftField, type PricingDraft } from '../hooks/pricingLogic';

import type { PricingEntryInput } from '@/daemon/types-usage-pricing';

interface PricingEntryEditorProps {
  initial: PricingDraft;
  /** Edit mode locks the identity fields. */
  idsLocked?: boolean;
  busy: boolean;
  onSave: (input: PricingEntryInput) => void;
  onCancel: () => void;
}

const PRICE_FIELDS: Array<{ field: DraftField; labelKey: string }> = [
  { field: 'inputPricePer1m', labelKey: 'pricing.inputPrice' },
  { field: 'outputPricePer1m', labelKey: 'pricing.outputPrice' },
  { field: 'cacheReadPricePer1m', labelKey: 'pricing.cacheReadPrice' },
  { field: 'cacheWritePricePer1m', labelKey: 'pricing.cacheWritePrice' },
];

export function PricingEntryEditor({ initial, idsLocked, busy, onSave, onCancel }: PricingEntryEditorProps) {
  const t = useTranslation();
  // Stable per-instance prefix so every visible label is wired to its input.
  const idPrefix = useId();
  const fieldId = (field: DraftField) => `${idPrefix}-${field}`;
  const [draft, setDraft] = useState<PricingDraft>(initial);
  const [errors, setErrors] = useState<Partial<Record<DraftField, string>>>({});

  const set = (field: DraftField) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setDraft((d) => ({ ...d, [field]: e.target.value }));
    setErrors((errs) => ({ ...errs, [field]: undefined }));
  };

  const handleSave = () => {
    const result = validateDraft(draft);
    if (!result.ok || !result.input) {
      setErrors(result.errors);
      return;
    }
    onSave(result.input);
  };

  const fieldError = (field: DraftField) =>
    errors[field] ? <p className="mt-0.5 text-xs text-destructive">{t(errors[field]!)}</p> : null;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor={fieldId('providerId')} className="mb-1 block text-xs text-muted-foreground">
            {t('pricing.provider')}
          </label>
          <Input
            id={fieldId('providerId')}
            density="compact"
            value={draft.providerId}
            disabled={Boolean(idsLocked)}
            onChange={set('providerId')}
          />
          {fieldError('providerId')}
        </div>
        <div>
          <label htmlFor={fieldId('modelId')} className="mb-1 block text-xs text-muted-foreground">
            {t('pricing.model')}
          </label>
          <Input
            id={fieldId('modelId')}
            density="compact"
            value={draft.modelId}
            disabled={Boolean(idsLocked)}
            onChange={set('modelId')}
          />
          {fieldError('modelId')}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {PRICE_FIELDS.map(({ field, labelKey }) => (
          <div key={field}>
            <label htmlFor={fieldId(field)} className="mb-1 block text-xs text-muted-foreground">
              {t(labelKey)}
            </label>
            <Input
              id={fieldId(field)}
              density="compact"
              inputMode="decimal"
              placeholder={field.startsWith('cache') ? t('common.optional') : undefined}
              value={draft[field]}
              onChange={set(field)}
            />
            {fieldError(field)}
          </div>
        ))}
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="secondary" onClick={onCancel} disabled={busy}>
          {t('common.cancel')}
        </Button>
        <Button size="sm" onClick={handleSave} disabled={busy}>
          {t('common.save')}
        </Button>
      </div>
    </div>
  );
}
