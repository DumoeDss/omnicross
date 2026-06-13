/**
 * PricingTable.tsx — the pricing entries table: provider / model / four
 * per-1M prices / source / user-edited badge / updated time, with per-row
 * edit (inline expanded editor row) and delete (confirm dialog). Empty cache
 * prices render as "—" and submit as null via the shared editor.
 */

import { Pencil, Trash2 } from 'lucide-react';
import React, { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import i18n from '@/i18n';
import { useTranslation } from '@/shared/state/LocaleContext';

import { conflictKey, draftFromEntry } from '../hooks/pricingLogic';
import { PricingEntryEditor } from './PricingEntryEditor';

import type { PricingEntry, PricingEntryInput, PricingSource } from '@/daemon/types-usage-pricing';

/** Localized labels for the source enum (never render the raw wire value). */
const SOURCE_LABEL_KEY: Record<PricingSource, string> = {
  builtin: 'pricing.sourceBuiltin',
  litellm: 'pricing.sourceLitellm',
  user: 'pricing.sourceUser',
};

interface PricingTableProps {
  entries: PricingEntry[];
  busy: boolean;
  onSave: (input: PricingEntryInput) => Promise<boolean>;
  onDelete: (providerId: string, modelId: string) => void;
}

const TH = 'px-3 py-2 text-left text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground';
const TH_NUM = 'px-3 py-2 text-right text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground';
const TD = 'px-3 py-2 text-sm text-foreground';
const TD_NUM = 'px-3 py-2 text-right text-sm tabular-nums text-foreground';

function formatPrice(value: number | null, locale: string): string {
  if (value === null) return '—';
  return new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value);
}

export function PricingTable({ entries, busy, onSave, onDelete }: PricingTableProps) {
  const t = useTranslation();
  const locale = i18n.language || 'en';
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PricingEntry | null>(null);

  const handleSave = async (input: PricingEntryInput) => {
    const ok = await onSave(input);
    if (ok) setEditingKey(null);
  };

  return (
    <div className="overflow-x-auto rounded-lg border border-border/70">
      <table className="w-full border-collapse bg-surface-1/40">
        <thead className="border-b border-border/60">
          <tr>
            <th className={TH}>{t('pricing.provider')}</th>
            <th className={TH}>{t('pricing.model')}</th>
            <th className={TH_NUM}>{t('pricing.inputPrice')}</th>
            <th className={TH_NUM}>{t('pricing.outputPrice')}</th>
            <th className={TH_NUM}>{t('pricing.cacheReadPrice')}</th>
            <th className={TH_NUM}>{t('pricing.cacheWritePrice')}</th>
            <th className={TH}>{t('pricing.source')}</th>
            <th className={TH}>{t('pricing.updated')}</th>
            <th className={TH} />
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const key = conflictKey(entry);
            const editing = editingKey === key;
            return (
              <React.Fragment key={key}>
                <tr className="border-b border-border/40 last:border-b-0">
                  <td className={TD}>{entry.providerId}</td>
                  <td className={`${TD} break-all`}>{entry.modelId}</td>
                  <td className={TD_NUM}>{formatPrice(entry.inputPricePer1m, locale)}</td>
                  <td className={TD_NUM}>{formatPrice(entry.outputPricePer1m, locale)}</td>
                  <td className={TD_NUM}>{formatPrice(entry.cacheReadPricePer1m, locale)}</td>
                  <td className={TD_NUM}>{formatPrice(entry.cacheWritePricePer1m, locale)}</td>
                  <td className={TD}>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">{t(SOURCE_LABEL_KEY[entry.source])}</span>
                      {entry.userEdited ? <Badge>{t('pricing.userEdited')}</Badge> : null}
                    </span>
                  </td>
                  <td className={`${TD} whitespace-nowrap text-xs text-muted-foreground`}>
                    {new Date(entry.updatedAt).toLocaleString(locale)}
                  </td>
                  <td className="px-2 py-2 text-right">
                    <span className="inline-flex items-center gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={t('pricing.edit')}
                        disabled={busy}
                        onClick={() => setEditingKey(editing ? null : key)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={t('common.delete')}
                        disabled={busy}
                        onClick={() => setDeleteTarget(entry)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </span>
                  </td>
                </tr>
                {editing ? (
                  <tr className="border-b border-border/40 bg-surface-2/30 last:border-b-0">
                    <td colSpan={9} className="px-4 py-3">
                      <PricingEntryEditor
                        initial={draftFromEntry(entry)}
                        idsLocked
                        busy={busy}
                        onSave={(input) => void handleSave(input)}
                        onCancel={() => setEditingKey(null)}
                      />
                    </td>
                  </tr>
                ) : null}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t('pricing.deleteTitle')}
        description={deleteTarget ? `${deleteTarget.providerId} / ${deleteTarget.modelId}` : undefined}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        onConfirm={() => {
          if (deleteTarget) onDelete(deleteTarget.providerId, deleteTarget.modelId);
        }}
      />
    </div>
  );
}
