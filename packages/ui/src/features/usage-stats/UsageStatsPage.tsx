/**
 * UsageStatsPage.tsx — the Usage Stats page shell: header (title + range
 * picker), totals summary cards, then the by-model (primary cost view, first)
 * and by-api-key sections. Single loading/error state with retry; an empty
 * range shows an empty state (no zero-soup tables) while the picker stays
 * usable.
 */

import { BarChart3, RefreshCw } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import { useTranslation } from '@/shared/state/LocaleContext';

import { ByApiKeyTable } from './components/ByApiKeyTable';
import { ByModelTable } from './components/ByModelTable';
import { DashboardOverview } from './components/DashboardOverview';
import { DateRangePicker } from './components/DateRangePicker';
import { ModelDistributionChart } from './components/ModelDistributionChart';
import { TotalsSummary } from './components/TotalsSummary';
import { UsageTrendChart } from './components/UsageTrendChart';
import { useDashboardSummary } from './hooks/useDashboardSummary';
import { useUsageStats } from './hooks/useUsageStats';
import { useUsageTrend } from './hooks/useUsageTrend';

export function UsageStatsPage() {
  const t = useTranslation();
  const stats = useUsageStats();
  const { loading, error, data, range } = stats;
  const dashboard = useDashboardSummary();
  const trend = useUsageTrend(range);

  const hasEvents = (data?.totals.eventCount ?? 0) > 0;

  // Manual refresh + optional 30s auto-refresh. All three data sources share
  // one refresh; each hook already owns its loading/cancel-on-unmount, so this
  // just bumps their reload ticks in step. The reload fns are stable
  // (useCallback inside each hook), so `refreshAll` is stable too — the
  // interval effect won't tear down and reset every render.
  const [autoRefresh, setAutoRefresh] = useState(false);
  const reloadStats = stats.reload;
  const reloadDashboard = dashboard.reload;
  const reloadTrend = trend.reload;
  const refreshAll = useCallback(() => {
    reloadStats();
    reloadDashboard();
    reloadTrend();
  }, [reloadStats, reloadDashboard, reloadTrend]);
  useEffect(() => {
    if (!autoRefresh) return;
    const id = window.setInterval(refreshAll, 30_000);
    return () => window.clearInterval(id);
  }, [autoRefresh, refreshAll]);
  const refreshing = loading || dashboard.loading || trend.loading;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ScrollArea className="flex-1">
        <div className="mx-auto max-w-5xl space-y-6 px-6 py-6">
          {/* Header */}
          <section className="rounded-xl border border-border/70 bg-surface-1/60 p-4 md:p-5">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-2">
                <BarChart3 className="h-5 w-5 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-semibold text-foreground">{t('usageStats.dashboardTitle')}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{t('usageStats.dashboardDescription')}</p>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <DateRangePicker
                    preset={stats.preset}
                    customFrom={stats.customFrom}
                    customTo={stats.customTo}
                    onPresetChange={stats.setPreset}
                    onCustomFromChange={stats.setCustomFrom}
                    onCustomToChange={stats.setCustomTo}
                  />
                  <div className="ml-auto flex items-center gap-3">
                    <label className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Switch
                        checked={autoRefresh}
                        onCheckedChange={setAutoRefresh}
                        aria-label={t('usageStats.autoRefresh')}
                      />
                      {t('usageStats.autoRefresh')}
                    </label>
                    <Button variant="outline" size="sm" onClick={refreshAll} disabled={refreshing}>
                      <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
                      {t('usageStats.refresh')}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* Overview cards — own loading/error so a summary failure doesn't
              blank the range-driven views below. */}
          <DashboardOverview
            summary={dashboard.summary}
            preset={stats.preset}
            rangeTotals={!loading && !error && range !== null ? data?.totals ?? null : null}
            rangeLoading={loading}
            loading={dashboard.loading}
            error={dashboard.error}
            onReload={dashboard.reload}
          />

          {/* Distribution + trend charts — side-by-side on wide viewports; each
              carries its own empty/loading/error state. */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <ModelDistributionChart rows={data?.byModel ?? []} />
            <UsageTrendChart
              series={trend.series}
              bucket={trend.bucket}
              onBucketChange={trend.setBucket}
              loading={trend.loading}
              error={trend.error}
              onReload={trend.reload}
            />
          </div>

          {/* Error banner with retry (tables) */}
          {error ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/60 bg-destructive/10 px-4 py-3">
              <p className="text-sm text-destructive">{error}</p>
              <Button size="sm" variant="outline" onClick={stats.reload}>
                {t('common.retry')}
              </Button>
            </div>
          ) : null}

          {!error && loading ? (
            <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
          ) : null}

          {!error && !loading && range === null ? (
            <p className="text-sm text-muted-foreground">{t('usageStats.invalidRange')}</p>
          ) : null}

          {!error && !loading && range !== null && data && !hasEvents ? (
            <section className="rounded-xl border border-border/70 bg-surface-1/60 p-8 text-center">
              <p className="text-sm text-muted-foreground">{t('usageStats.empty')}</p>
            </section>
          ) : null}

          {!error && !loading && data && hasEvents ? (
            <>
              <TotalsSummary totals={data.totals} />

              <section className="space-y-2">
                <h3 className="text-sm font-semibold text-foreground">{t('usageStats.byModel')}</h3>
                <ByModelTable rows={data.byModel} />
              </section>

              <section className="space-y-2">
                <h3 className="text-sm font-semibold text-foreground">{t('usageStats.byApiKey')}</h3>
                <ByApiKeyTable rows={data.byApiKey} />
              </section>
            </>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}
