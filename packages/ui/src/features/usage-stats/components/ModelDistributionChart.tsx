/**
 * ModelDistributionChart.tsx — a Recharts doughnut over `modelShares(rows)`:
 * the top-N models as slices plus a folded "other" slice, with a legend list
 * showing model, cost, and share %. Empty rows render a localized empty state
 * (no chart). Colors come from the theme vars (`chartTheme`) so both light and
 * dark palettes read correctly.
 */

import React, { useMemo } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts';

import i18n from '@/i18n';
import { useTranslation } from '@/shared/state/LocaleContext';

import { formatUsd, modelShares, type ModelShare } from '../hooks/usageStatsLogic';
import { getChartTheme } from './chartTheme';

import type { ModelUsageRow } from '@/daemon/types-usage-pricing';

interface ModelDistributionChartProps {
  rows: ModelUsageRow[];
}

const TOP_N = 6;

/** Fold everything past the top-N into a single "other" slice. */
function foldTopN(shares: ModelShare[]): ModelShare[] {
  if (shares.length <= TOP_N) return shares;
  const head = shares.slice(0, TOP_N);
  const tail = shares.slice(TOP_N);
  const other: ModelShare = {
    providerId: '',
    model: '__other__',
    costUsd: tail.reduce((sum, s) => sum + s.costUsd, 0),
    share: tail.reduce((sum, s) => sum + s.share, 0),
  };
  return [...head, other];
}

export function ModelDistributionChart({ rows }: ModelDistributionChartProps) {
  const t = useTranslation();
  const locale = i18n.language || 'en';

  const slices = useMemo(() => foldTopN(modelShares(rows)), [rows]);
  const theme = getChartTheme();
  const colors = theme.categorical(slices.length);

  const hasData = slices.length > 0 && slices.some((s) => s.share > 0 || s.costUsd > 0);

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-foreground">{t('usageStats.modelDistribution')}</h3>
      <div className="rounded-xl border border-border/70 bg-surface-1/60 p-4">
        {!hasData ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t('usageStats.empty')}</p>
        ) : (
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <div className="h-48 w-full sm:w-48 sm:shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={slices}
                    dataKey="share"
                    nameKey="model"
                    innerRadius="58%"
                    outerRadius="90%"
                    paddingAngle={1}
                    stroke={theme.border}
                    strokeWidth={1}
                    isAnimationActive={false}
                  >
                    {slices.map((s, i) => (
                      <Cell key={`${s.providerId} ${s.model}`} fill={colors[i]} />
                    ))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
            </div>
            <ul className="min-w-0 flex-1 space-y-1.5">
              {slices.map((s, i) => {
                const label = s.model === '__other__' ? t('usageStats.other') : s.model;
                return (
                  <li key={`${s.providerId} ${s.model}`} className="flex items-center gap-2 text-xs">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-sm"
                      style={{ backgroundColor: colors[i] }}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate text-foreground" title={label}>
                      {label}
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {formatUsd(s.costUsd, locale)}
                    </span>
                    <span className="w-12 shrink-0 text-right tabular-nums text-muted-foreground">
                      {(s.share * 100).toFixed(1)}%
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
