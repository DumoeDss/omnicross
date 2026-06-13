/**
 * UsageStatsPage.tsx — the Usage Stats page shell: header (title + range
 * picker), totals summary cards, then the by-model (primary cost view, first)
 * and by-api-key sections. Single loading/error state with retry; an empty
 * range shows an empty state (no zero-soup tables) while the picker stays
 * usable.
 */

import { BarChart3 } from 'lucide-react';
import React from 'react';

import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTranslation } from '@/shared/state/LocaleContext';

import { ByApiKeyTable } from './components/ByApiKeyTable';
import { ByModelTable } from './components/ByModelTable';
import { DateRangePicker } from './components/DateRangePicker';
import { TotalsSummary } from './components/TotalsSummary';
import { useUsageStats } from './hooks/useUsageStats';

export function UsageStatsPage() {
  const t = useTranslation();
  const stats = useUsageStats();
  const { loading, error, data, range } = stats;

  const hasEvents = (data?.totals.eventCount ?? 0) > 0;

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
                <h2 className="text-base font-semibold text-foreground">{t('usageStats.title')}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{t('usageStats.description')}</p>
                <div className="mt-3">
                  <DateRangePicker
                    preset={stats.preset}
                    customFrom={stats.customFrom}
                    customTo={stats.customTo}
                    onPresetChange={stats.setPreset}
                    onCustomFromChange={stats.setCustomFrom}
                    onCustomToChange={stats.setCustomTo}
                  />
                </div>
              </div>
            </div>
          </section>

          {/* Error banner with retry */}
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
