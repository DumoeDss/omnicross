/**
 * TotalsSummary.tsx — summary cards over `UsageTotals`: total cost, cache
 * savings, event count, and the five token classes. Locale-aware number
 * formatting; USD with 2–4 fraction digits (small costs need the precision).
 */

import React from 'react';

import i18n from '@/i18n';
import { useTranslation } from '@/shared/state/LocaleContext';

import { formatTokens, formatUsd } from '../hooks/usageStatsLogic';

import type { UsageTotals } from '@/daemon/types-usage-pricing';

interface TotalsSummaryProps {
  totals: UsageTotals;
}

interface CardDef {
  labelKey: string;
  value: string;
  highlight?: boolean;
}

export function TotalsSummary({ totals }: TotalsSummaryProps) {
  const t = useTranslation();
  const locale = i18n.language || 'en';

  const cards: CardDef[] = [
    { labelKey: 'usageStats.totalCost', value: formatUsd(totals.costUsd, locale), highlight: true },
    { labelKey: 'usageStats.cacheSavings', value: formatUsd(totals.costSavedByCacheUsd, locale) },
    { labelKey: 'usageStats.events', value: formatTokens(totals.eventCount, locale) },
    { labelKey: 'usageStats.inputTokens', value: formatTokens(totals.inputTokens, locale) },
    { labelKey: 'usageStats.outputTokens', value: formatTokens(totals.outputTokens, locale) },
    { labelKey: 'usageStats.cacheReadTokens', value: formatTokens(totals.cacheReadTokens, locale) },
    { labelKey: 'usageStats.cacheWriteTokens', value: formatTokens(totals.cacheCreationTokens, locale) },
    { labelKey: 'usageStats.reasoningTokens', value: formatTokens(totals.reasoningTokens, locale) },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {cards.map((card) => (
        <div
          key={card.labelKey}
          className="rounded-lg border border-border/70 bg-surface-1/60 px-3 py-2.5"
        >
          <p className="truncate text-[11px] uppercase tracking-[0.06em] text-muted-foreground">
            {t(card.labelKey)}
          </p>
          <p
            className={
              card.highlight
                ? 'mt-1 text-lg font-semibold text-primary'
                : 'mt-1 text-lg font-semibold text-foreground'
            }
          >
            {card.value}
          </p>
        </div>
      ))}
    </div>
  );
}
