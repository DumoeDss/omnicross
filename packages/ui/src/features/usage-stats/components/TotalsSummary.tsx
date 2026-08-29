/**
 * TotalsSummary.tsx — summary cards over `UsageTotals`: total cost, cache
 * savings, event count, and the five token classes. Locale-aware number
 * formatting; constrained values use compact magnitudes with exact hover text.
 */

import React from 'react';

import i18n from '@/i18n';
import { useTranslation } from '@/shared/state/LocaleContext';

import {
  cacheHitRate,
  coldCacheRequestRate,
  formatCompactNumber,
  formatCompactUsd,
  formatPercent,
  formatTokens,
  formatUsd,
} from '../hooks/usageStatsLogic';

import type { UsageTotals } from '@/daemon/types-usage-pricing';

interface TotalsSummaryProps {
  totals: UsageTotals;
}

interface CardDef {
  labelKey: string;
  value: string;
  fullValue?: string;
  highlight?: boolean;
}

export function TotalsSummary({ totals }: TotalsSummaryProps) {
  const t = useTranslation();
  const locale = i18n.language || 'en';
  const weightedCacheHitRate = cacheHitRate(
    totals.inputTokens,
    totals.cacheReadTokens,
    totals.cacheCreationTokens,
  );
  const coldCacheRate = coldCacheRequestRate(
    totals.coldCacheEventCount,
    totals.cacheEligibleEventCount,
  );
  const percentOrDash = (ratio: number | null): string =>
    ratio === null ? '—' : formatPercent(ratio, locale);
  const compactCountCard = (labelKey: string, value: number): CardDef => ({
    labelKey,
    value: formatCompactNumber(value, locale),
    fullValue: formatTokens(value, locale),
  });

  const cards: CardDef[] = [
    {
      labelKey: 'usageStats.totalCost',
      value: formatCompactUsd(totals.costUsd, locale),
      fullValue: formatUsd(totals.costUsd, locale),
      highlight: true,
    },
    {
      labelKey: 'usageStats.cacheSavings',
      value: formatCompactUsd(totals.costSavedByCacheUsd, locale),
      fullValue: formatUsd(totals.costSavedByCacheUsd, locale),
    },
    compactCountCard('usageStats.events', totals.eventCount),
    compactCountCard('usageStats.inputTokens', totals.inputTokens),
    compactCountCard('usageStats.outputTokens', totals.outputTokens),
    compactCountCard('usageStats.cacheReadTokens', totals.cacheReadTokens),
    compactCountCard('usageStats.cacheWriteTokens', totals.cacheCreationTokens),
    compactCountCard('usageStats.reasoningTokens', totals.reasoningTokens),
    {
      labelKey: 'usageStats.weightedCacheHitRate',
      value: percentOrDash(weightedCacheHitRate),
    },
    {
      labelKey: 'usageStats.medianRequestCacheHitRate',
      value: percentOrDash(totals.medianCacheHitRate),
    },
    {
      labelKey: 'usageStats.coldCacheRequestRate',
      value: percentOrDash(coldCacheRate),
    },
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
                ? 'mt-1 truncate font-mono text-lg font-semibold tabular-nums text-primary'
                : 'mt-1 truncate font-mono text-lg font-semibold tabular-nums text-foreground'
            }
            title={card.fullValue}
            aria-label={card.fullValue ?? card.value}
          >
            {card.value}
          </p>
        </div>
      ))}
    </div>
  );
}
