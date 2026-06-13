/**
 * PricingPage.tsx — the Pricing page shell: header (title + search + Fetch
 * latest + Add entry), notice banner, the pricing table, the add-entry
 * dialog, and the conflict-resolution dialog. First-run empty state (the
 * daemon ships no seed) CTAs to Fetch latest.
 */

import { CircleDollarSign, Plus, RefreshCw } from 'lucide-react';
import React, { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTranslation } from '@/shared/state/LocaleContext';
import { cn } from '@/shared/utils/utils';

import { ConflictDialog } from './components/ConflictDialog';
import { PricingEntryEditor } from './components/PricingEntryEditor';
import { PricingTable } from './components/PricingTable';
import { EMPTY_DRAFT } from './hooks/pricingLogic';
import { usePricing, type PricingNotice } from './hooks/usePricing';

import type { PricingEntryInput } from '@/daemon/types-usage-pricing';

const NOTICE_STYLES: Record<PricingNotice['kind'], string> = {
  success: 'border-success/60 bg-success/10 text-success',
  info: 'border-border bg-surface-2/60 text-foreground',
  warning: 'border-amber-500/60 bg-amber-500/10 text-amber-500',
  error: 'border-destructive/60 bg-destructive/10 text-destructive',
};

export function PricingPage() {
  const t = useTranslation();
  const pricing = usePricing();
  const [adding, setAdding] = useState(false);

  const handleAddSave = async (input: PricingEntryInput) => {
    const ok = await pricing.saveEntry(input);
    if (ok) setAdding(false);
  };

  const fetchLatestButton = (
    <Button size="sm" disabled={pricing.fetching || pricing.busy} onClick={() => void pricing.fetchLatest()}>
      <RefreshCw className={cn('h-3.5 w-3.5', pricing.fetching && 'animate-spin')} />
      {pricing.fetching ? t('pricing.fetching') : t('pricing.fetchLatest')}
    </Button>
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ScrollArea className="flex-1">
        <div className="mx-auto max-w-5xl space-y-4 px-6 py-6">
          {/* Header */}
          <section className="rounded-xl border border-border/70 bg-surface-1/60 p-4 md:p-5">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-2">
                <CircleDollarSign className="h-5 w-5 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-semibold text-foreground">{t('pricing.title')}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{t('pricing.description')}</p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Input
                    density="compact"
                    className="w-64"
                    placeholder={t('pricing.search')}
                    value={pricing.search}
                    onChange={(e) => pricing.setSearch(e.target.value)}
                  />
                  {fetchLatestButton}
                  <Button size="sm" variant="secondary" disabled={pricing.busy} onClick={() => setAdding(true)}>
                    <Plus className="h-3.5 w-3.5" />
                    {t('pricing.addEntry')}
                  </Button>
                </div>
              </div>
            </div>
          </section>

          {/* Notice banner */}
          {pricing.notice ? (
            <div
              className={cn(
                'flex items-center justify-between gap-3 rounded-lg border px-4 py-2.5',
                NOTICE_STYLES[pricing.notice.kind],
              )}
            >
              <p className="text-sm">{t(pricing.notice.messageKey, pricing.notice.params)}</p>
              <Button size="xs" variant="ghost" onClick={pricing.dismissNotice}>
                {t('common.dismiss')}
              </Button>
            </div>
          ) : null}

          {/* Load error with retry */}
          {pricing.error ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/60 bg-destructive/10 px-4 py-3">
              <p className="text-sm text-destructive">{pricing.error}</p>
              <Button size="sm" variant="outline" onClick={() => void pricing.reload()}>
                {t('common.retry')}
              </Button>
            </div>
          ) : null}

          {!pricing.error && pricing.loading ? (
            <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
          ) : null}

          {/* First-run empty state → Fetch latest CTA */}
          {!pricing.error && !pricing.loading && pricing.entries.length === 0 ? (
            <section className="rounded-xl border border-border/70 bg-surface-1/60 p-8 text-center">
              <p className="text-sm text-muted-foreground">{t('pricing.empty')}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t('pricing.emptyHint')}</p>
              <div className="mt-4 flex justify-center">{fetchLatestButton}</div>
            </section>
          ) : null}

          {!pricing.error && !pricing.loading && pricing.entries.length > 0 ? (
            pricing.filtered.length === 0 ? (
              <p className="px-1 text-sm text-muted-foreground">{t('pricing.noMatches')}</p>
            ) : (
              <PricingTable
                entries={pricing.filtered}
                busy={pricing.busy}
                onSave={pricing.saveEntry}
                onDelete={(providerId, modelId) => void pricing.removeEntry(providerId, modelId)}
              />
            )
          ) : null}
        </div>
      </ScrollArea>

      {/* Add-entry dialog */}
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{t('pricing.addEntry')}</DialogTitle>
          </DialogHeader>
          <PricingEntryEditor
            initial={EMPTY_DRAFT}
            busy={pricing.busy}
            onSave={(input) => void handleAddSave(input)}
            onCancel={() => setAdding(false)}
          />
        </DialogContent>
      </Dialog>

      {/* Conflict-resolution dialog */}
      {pricing.conflictDialog ? (
        <ConflictDialog
          state={pricing.conflictDialog}
          onDecision={pricing.setConflictDecision}
          onSetAll={pricing.setAllConflictDecisions}
          onSubmit={() => void pricing.submitConflicts()}
          onCancel={pricing.cancelConflicts}
        />
      ) : null}
    </div>
  );
}
