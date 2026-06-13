/**
 * ConflictDialog.tsx — the fetch-latest conflict-resolution dialog. Each
 * conflict shows the current (user-edited) vs incoming prices side by side
 * with a per-row Overwrite/Skip toggle (defaulted to SKIP by the hook) plus
 * overwrite-all / skip-all bulk actions. Pure presentation: all state lives
 * in `usePricing` so a failed submit keeps every decision intact.
 */

import React from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import i18n from '@/i18n';
import { useTranslation } from '@/shared/state/LocaleContext';
import { cn } from '@/shared/utils/utils';

import { conflictKey, type ConflictAction } from '../hooks/pricingLogic';

import type { ConflictDialogState } from '../hooks/usePricing';
import type { PricingConflict } from '@/daemon/types-usage-pricing';

interface ConflictDialogProps {
  state: ConflictDialogState;
  onDecision: (key: string, action: ConflictAction) => void;
  onSetAll: (action: ConflictAction) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

function priceList(p: {
  inputPricePer1m: number;
  outputPricePer1m: number;
  cacheReadPricePer1m?: number | null;
  cacheWritePricePer1m?: number | null;
}, locale: string): string {
  const fmt = (v: number | null | undefined) =>
    v === null || v === undefined
      ? '—'
      : new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(v);
  return `${fmt(p.inputPricePer1m)} / ${fmt(p.outputPricePer1m)} / ${fmt(p.cacheReadPricePer1m)} / ${fmt(p.cacheWritePricePer1m)}`;
}

export function ConflictDialog({ state, onDecision, onSetAll, onSubmit, onCancel }: ConflictDialogProps) {
  const t = useTranslation();
  const locale = i18n.language || 'en';

  const toggle = (conflict: PricingConflict) => {
    const key = conflictKey(conflict);
    const action = state.decisions[key] ?? 'skip';
    const btn = (value: ConflictAction, labelKey: string) => (
      <button
        type="button"
        aria-pressed={action === value}
        disabled={state.submitting}
        onClick={() => onDecision(key, value)}
        className={cn(
          'rounded-md border px-2 py-1 text-xs transition-colors',
          action === value
            ? 'border-primary bg-primary-soft/40 text-primary'
            : 'border-border text-muted-foreground hover:text-foreground',
        )}
      >
        {t(labelKey)}
      </button>
    );
    return (
      <span className="inline-flex items-center gap-1">
        {btn('skip', 'pricing.skip')}
        {btn('overwrite', 'pricing.overwrite')}
      </span>
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !state.submitting) onCancel();
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('pricing.conflictTitle')}</DialogTitle>
          <DialogDescription>{t('pricing.conflictHint')}</DialogDescription>
        </DialogHeader>

        <div className="mb-2 flex items-center gap-2">
          <Button size="xs" variant="secondary" disabled={state.submitting} onClick={() => onSetAll('overwrite')}>
            {t('pricing.overwriteAll')}
          </Button>
          <Button size="xs" variant="secondary" disabled={state.submitting} onClick={() => onSetAll('skip')}>
            {t('pricing.skipAll')}
          </Button>
        </div>

        <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
          {state.conflicts.map((conflict) => {
            const key = conflictKey(conflict);
            return (
              <div key={key} className="rounded-lg border border-border/70 bg-surface-1/60 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="min-w-0 break-all text-sm font-medium text-foreground">
                    {conflict.providerId} / {conflict.modelId}
                  </p>
                  {toggle(conflict)}
                </div>
                <div className="mt-1.5 grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
                  <p className="text-muted-foreground">
                    <span className="font-medium">{t('pricing.current')}:</span>{' '}
                    <span className="tabular-nums">{priceList(conflict.current, locale)}</span>
                  </p>
                  <p className="text-muted-foreground">
                    <span className="font-medium">{t('pricing.incoming')}:</span>{' '}
                    <span className="tabular-nums">{priceList(conflict.incoming, locale)}</span>
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        {state.submitError ? (
          <p className="mt-2 text-sm text-destructive">{state.submitError}</p>
        ) : null}

        <DialogFooter className="gap-2">
          <Button variant="secondary" disabled={state.submitting} onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button disabled={state.submitting} onClick={onSubmit}>
            {t('pricing.applyResolutions')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
