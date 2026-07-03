/**
 * UsageTrendChart.tsx — a Recharts ComposedChart of the usage trend: token
 * lines (input/output/cacheRead/cacheCreation) on the left axis, `costUsd` on
 * a right axis, and a subtle `requests` line; `label` on the X axis. A
 * granularity toggle (hour/day/month) drives `onBucketChange`. Zero-filled
 * buckets render at 0 (continuous line). Colors come from the theme vars so the
 * chart is legible in both light and dark. Carries its own loading/error/empty
 * slots so a trend failure doesn't blank the rest of the page.
 */

import React from 'react';
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from 'recharts';

import { Button } from '@/components/ui/button';
import i18n from '@/i18n';
import { useTranslation } from '@/shared/state/LocaleContext';

import { formatTokens, formatUsd } from '../hooks/usageStatsLogic';
import { getChartTheme } from './chartTheme';

import type { UsageTimeBucket, UsageTimeSeriesBucket } from '@/daemon/types-usage-pricing';

interface UsageTrendChartProps {
  series: UsageTimeSeriesBucket[] | null;
  bucket: UsageTimeBucket;
  onBucketChange: (bucket: UsageTimeBucket) => void;
  loading: boolean;
  error: string | null;
  onReload: () => void;
}

const BUCKETS: UsageTimeBucket[] = ['hour', 'day', 'month'];

function TrendTooltip({ active, payload, label }: TooltipProps<number, string>) {
  const t = useTranslation();
  const locale = i18n.language || 'en';
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md">
      <p className="mb-1 font-medium text-foreground">{label}</p>
      <ul className="space-y-0.5">
        {payload.map((entry) => {
          const value = typeof entry.value === 'number' ? entry.value : 0;
          const isCost = entry.dataKey === 'costUsd';
          return (
            <li key={String(entry.dataKey)} className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: entry.color }} aria-hidden="true" />
              <span className="text-muted-foreground">{entry.name}</span>
              <span className="ml-auto tabular-nums text-foreground">
                {isCost ? formatUsd(value, locale) : formatTokens(value, locale)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function UsageTrendChart({
  series,
  bucket,
  onBucketChange,
  loading,
  error,
  onReload,
}: UsageTrendChartProps) {
  const t = useTranslation();
  const locale = i18n.language || 'en';
  const theme = getChartTheme();

  const hasData = (series?.length ?? 0) > 0 && (series ?? []).some((b) => b.requests > 0);

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">{t('usageStats.usageTrend')}</h3>
        <div className="flex items-center gap-1">
          <span className="mr-1 text-[11px] uppercase tracking-[0.06em] text-muted-foreground">
            {t('usageStats.granularity')}
          </span>
          {BUCKETS.map((b) => (
            <Button
              key={b}
              size="sm"
              variant={bucket === b ? 'default' : 'secondary'}
              onClick={() => onBucketChange(b)}
            >
              {t(`usageStats.${b}`)}
            </Button>
          ))}
        </div>
      </div>
      <div className="rounded-xl border border-border/70 bg-surface-1/60 p-4">
        {error ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-destructive">{error}</p>
            <Button size="sm" variant="outline" onClick={onReload}>
              {t('common.retry')}
            </Button>
          </div>
        ) : loading && !series ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : !hasData ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t('usageStats.empty')}</p>
        ) : (
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={series ?? []} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={theme.grid} strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fill: theme.muted, fontSize: 11 }}
                  stroke={theme.border}
                  minTickGap={24}
                />
                <YAxis
                  yAxisId="tokens"
                  tick={{ fill: theme.muted, fontSize: 11 }}
                  stroke={theme.border}
                  width={48}
                  tickFormatter={(v: number) => formatTokens(v, locale)}
                />
                <YAxis
                  yAxisId="cost"
                  orientation="right"
                  tick={{ fill: theme.muted, fontSize: 11 }}
                  stroke={theme.border}
                  width={56}
                  tickFormatter={(v: number) => formatUsd(v, locale)}
                />
                <Tooltip content={<TrendTooltip />} />
                <Line
                  yAxisId="tokens"
                  type="monotone"
                  dataKey="inputTokens"
                  name={t('usageStats.inputTokens')}
                  stroke={theme.accent}
                  dot={false}
                  strokeWidth={2}
                  isAnimationActive={false}
                />
                <Line
                  yAxisId="tokens"
                  type="monotone"
                  dataKey="outputTokens"
                  name={t('usageStats.outputTokens')}
                  stroke={theme.success}
                  dot={false}
                  strokeWidth={2}
                  isAnimationActive={false}
                />
                <Line
                  yAxisId="tokens"
                  type="monotone"
                  dataKey="cacheReadTokens"
                  name={t('usageStats.cacheReadTokens')}
                  stroke={theme.warning}
                  dot={false}
                  strokeWidth={1.5}
                  isAnimationActive={false}
                />
                <Line
                  yAxisId="tokens"
                  type="monotone"
                  dataKey="cacheCreationTokens"
                  name={t('usageStats.cacheWriteTokens')}
                  stroke={theme.muted}
                  dot={false}
                  strokeWidth={1.5}
                  isAnimationActive={false}
                />
                <Line
                  yAxisId="cost"
                  type="monotone"
                  dataKey="costUsd"
                  name={t('usageStats.cost')}
                  stroke={theme.danger}
                  dot={false}
                  strokeWidth={2}
                  strokeDasharray="4 2"
                  isAnimationActive={false}
                />
                <Line
                  yAxisId="tokens"
                  type="monotone"
                  dataKey="requests"
                  name={t('usageStats.requests')}
                  stroke={theme.foreground}
                  dot={false}
                  strokeWidth={1}
                  strokeOpacity={0.5}
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </section>
  );
}
