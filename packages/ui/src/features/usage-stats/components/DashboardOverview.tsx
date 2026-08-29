/**
 * DashboardOverview.tsx — the top overview card grid over `DashboardSummary`:
 * today + all-time totals (requests/tokens/cost), provider/outbound-key/account
 * counts, and daemon server status/uptime. Range-independent (the summary hook
 * owns its own window); carries its own loading/error slot so a summary failure
 * doesn't blank the range-driven tables below.
 */

import React from 'react';

import { Button } from '@/components/ui/button';
import i18n from '@/i18n';
import { useTranslation } from '@/shared/state/LocaleContext';

import {
  formatCompactNumber,
  formatCompactUsd,
  formatTokens,
  formatUsd,
} from '../hooks/usageStatsLogic';

import type { DashboardSummary, UsageTotals } from '@/daemon/types-usage-pricing';

interface DashboardOverviewProps {
  summary: DashboardSummary | null;
  loading: boolean;
  error: string | null;
  onReload: () => void;
}

function totalTokens(t: UsageTotals): number {
  return t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheCreationTokens;
}

function formatUptime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

interface OverviewCardProps {
  label: string;
  primary: string;
  primaryTitle?: string;
  lines?: Array<{ value: string; title?: string }>;
  accent?: boolean;
}

function OverviewCard({ label, primary, primaryTitle, lines, accent }: OverviewCardProps) {
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-border/70 bg-surface-1/60 px-3 py-2.5">
      <p className="truncate text-[11px] uppercase tracking-[0.06em] text-muted-foreground">{label}</p>
      <p
        className={accent
          ? 'mt-1 truncate font-mono text-lg font-semibold tabular-nums text-primary'
          : 'mt-1 truncate font-mono text-lg font-semibold tabular-nums text-foreground'}
        title={primaryTitle}
        aria-label={primaryTitle ?? primary}
      >
        {primary}
      </p>
      {lines?.length ? (
        <div className="mt-1 space-y-0.5">
          {lines.map((line, index) => (
            <p
              key={`${line.value}:${index}`}
              className="truncate text-xs tabular-nums text-muted-foreground"
              title={line.title}
              aria-label={line.title ?? line.value}
            >
              {line.value}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function DashboardOverview({ summary, loading, error, onReload }: DashboardOverviewProps) {
  const t = useTranslation();
  const locale = i18n.language || 'en';

  if (error) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/60 bg-destructive/10 px-4 py-3">
        <p className="text-sm text-destructive">{error}</p>
        <Button size="sm" variant="outline" onClick={onReload}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }

  if (loading && !summary) {
    return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>;
  }

  if (!summary) return null;

  const tokensLabel = t('usageStats.inputTokens');
  const byProviderLines = Object.entries(summary.accounts.byProvider).map(([provider, count]) => ({
    value: `${provider}: ${formatCompactNumber(count, locale)}`,
    title: `${provider}: ${formatTokens(count, locale)}`,
  }));
  const compactCountLine = (value: number, suffix: string) => ({
    value: `${formatCompactNumber(value, locale)} ${suffix}`,
    title: `${formatTokens(value, locale)} ${suffix}`,
  });

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <OverviewCard
        label={t('usageStats.today')}
        primary={formatCompactUsd(summary.today.costUsd, locale)}
        primaryTitle={formatUsd(summary.today.costUsd, locale)}
        accent
        lines={[
          compactCountLine(summary.today.eventCount, t('usageStats.requests')),
          compactCountLine(totalTokens(summary.today), tokensLabel.toLowerCase()),
        ]}
      />
      <OverviewCard
        label={t('usageStats.allTime')}
        primary={formatCompactUsd(summary.total.costUsd, locale)}
        primaryTitle={formatUsd(summary.total.costUsd, locale)}
        lines={[
          compactCountLine(summary.total.eventCount, t('usageStats.requests')),
          compactCountLine(totalTokens(summary.total), tokensLabel.toLowerCase()),
        ]}
      />
      <OverviewCard
        label={t('usageStats.providers')}
        primary={`${summary.providers.enabled} / ${summary.providers.total}`}
        lines={[{ value: t('usageStats.enabledOfTotal') }]}
      />
      <OverviewCard
        label={t('usageStats.outboundKeys')}
        primary={`${summary.outboundKeys.active} / ${summary.outboundKeys.total}`}
        lines={[{ value: t('usageStats.activeOfTotal') }]}
      />
      <OverviewCard
        label={t('usageStats.accounts')}
        primary={formatCompactNumber(summary.accounts.total, locale)}
        primaryTitle={formatTokens(summary.accounts.total, locale)}
        lines={byProviderLines.length ? byProviderLines : undefined}
      />
      <OverviewCard
        label={t('usageStats.server')}
        primary={summary.server.running ? t('usageStats.serverRunning') : t('usageStats.serverStopped')}
        lines={[
          { value: `${t('usageStats.port')}: ${summary.server.port}` },
          { value: `${t('usageStats.uptime')}: ${formatUptime(summary.server.uptimeMs)}` },
        ]}
      />
    </div>
  );
}
