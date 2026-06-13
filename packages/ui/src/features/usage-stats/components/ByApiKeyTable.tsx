/**
 * ByApiKeyTable.tsx — the per-API-key usage breakdown. The null-`apiKeyId`
 * group is rendered with a UI-LOCALIZED unattributed label (the daemon's
 * sentinel label string is tolerated but never displayed), muted styling, and
 * an explanatory tooltip — an EXPECTED state (attribution is sparse until
 * upstream key stamping lands), never an error.
 */

import { Info } from 'lucide-react';
import React, { useMemo } from 'react';

import Tooltip from '@/components/ui/tooltip';
import i18n from '@/i18n';
import { useTranslation } from '@/shared/state/LocaleContext';

import { formatTokens, formatUsd, partitionApiKeyRows } from '../hooks/usageStatsLogic';

import type { ApiKeyUsageRow } from '@/daemon/types-usage-pricing';

interface ByApiKeyTableProps {
  rows: ApiKeyUsageRow[];
}

const TH = 'px-3 py-2 text-left text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground';
const TH_NUM = 'px-3 py-2 text-right text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground';
const TD = 'px-3 py-2 text-sm text-foreground';
const TD_NUM = 'px-3 py-2 text-right text-sm tabular-nums text-foreground';
const TD_MUTED = 'px-3 py-2 text-sm text-muted-foreground';
const TD_NUM_MUTED = 'px-3 py-2 text-right text-sm tabular-nums text-muted-foreground';

export function ByApiKeyTable({ rows }: ByApiKeyTableProps) {
  const t = useTranslation();
  const locale = i18n.language || 'en';
  const { attributed, unattributed } = useMemo(() => partitionApiKeyRows(rows), [rows]);

  const numCells = (row: ApiKeyUsageRow, muted: boolean) => {
    const cls = muted ? TD_NUM_MUTED : TD_NUM;
    return (
      <>
        <td className={cls}>{formatTokens(row.eventCount, locale)}</td>
        <td className={cls}>{formatTokens(row.inputTokens, locale)}</td>
        <td className={cls}>{formatTokens(row.outputTokens, locale)}</td>
        <td className={cls}>{formatUsd(row.costUsd, locale)}</td>
      </>
    );
  };

  return (
    <div className="overflow-x-auto rounded-lg border border-border/70">
      <table className="w-full border-collapse bg-surface-1/40">
        <thead className="border-b border-border/60">
          <tr>
            <th className={TH}>{t('usageStats.apiKey')}</th>
            <th className={TH}>{t('usageStats.provider')}</th>
            <th className={TH_NUM}>{t('usageStats.events')}</th>
            <th className={TH_NUM}>{t('usageStats.inputTokens')}</th>
            <th className={TH_NUM}>{t('usageStats.outputTokens')}</th>
            <th className={TH_NUM}>{t('usageStats.cost')}</th>
          </tr>
        </thead>
        <tbody>
          {attributed.map((row) => (
            <tr key={row.apiKeyId} className="border-b border-border/40 last:border-b-0">
              <td className={TD}>{row.label}</td>
              <td className={TD}>{row.providerId ?? '—'}</td>
              {numCells(row, false)}
            </tr>
          ))}
          {unattributed ? (
            <tr className="border-b border-border/40 last:border-b-0">
              <td className={TD_MUTED}>
                <span className="inline-flex items-center gap-1.5">
                  <span className="italic">{t('usageStats.unattributed')}</span>
                  <Tooltip content={t('usageStats.unattributedHint')}>
                    <Info className="h-3.5 w-3.5 text-muted-foreground/70" aria-label={t('usageStats.unattributedHint')} />
                  </Tooltip>
                </span>
              </td>
              <td className={TD_MUTED}>—</td>
              {numCells(unattributed, true)}
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
