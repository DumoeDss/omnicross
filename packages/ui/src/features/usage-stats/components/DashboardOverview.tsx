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

import { formatTokens, formatUsd } from '../hooks/usageStatsLogic';

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
  lines?: string[];
  accent?: boolean;
}

function OverviewCard({ label, primary, lines, accent }: OverviewCardProps) {
  return (
    <div className="rounded-lg border border-border/70 bg-surface-1/60 px-3 py-2.5">
      <p className="truncate text-[11px] uppercase tracking-[0.06em] text-muted-foreground">{label}</p>
      <p
        className={
          accent ? 'mt-1 text-lg font-semibold text-primary' : 'mt-1 text-lg font-semibold text-foreground'
        }
      >
        {primary}
      </p>
      {lines?.length ? (
        <div className="mt-1 space-y-0.5">
          {lines.map((line) => (
            <p key={line} className="truncate text-xs text-muted-foreground">
              {line}
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
  const byProviderLines = Object.entries(summary.accounts.byProvider).map(
    ([provider, count]) => `${provider}: ${formatTokens(count, locale)}`,
  );

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <OverviewCard
        label={t('usageStats.today')}
        primary={formatUsd(summary.today.costUsd, locale)}
        accent
        lines={[
          `${formatTokens(summary.today.eventCount, locale)} ${t('usageStats.requests')}`,
          `${formatTokens(totalTokens(summary.today), locale)} ${tokensLabel.toLowerCase()}`,
        ]}
      />
      <OverviewCard
        label={t('usageStats.allTime')}
        primary={formatUsd(summary.total.costUsd, locale)}
        lines={[
          `${formatTokens(summary.total.eventCount, locale)} ${t('usageStats.requests')}`,
          `${formatTokens(totalTokens(summary.total), locale)} ${tokensLabel.toLowerCase()}`,
        ]}
      />
      <OverviewCard
        label={t('usageStats.providers')}
        primary={`${summary.providers.enabled} / ${summary.providers.total}`}
        lines={[t('usageStats.enabledOfTotal')]}
      />
      <OverviewCard
        label={t('usageStats.outboundKeys')}
        primary={`${summary.outboundKeys.active} / ${summary.outboundKeys.total}`}
        lines={[t('usageStats.activeOfTotal')]}
      />
      <OverviewCard
        label={t('usageStats.accounts')}
        primary={formatTokens(summary.accounts.total, locale)}
        lines={byProviderLines.length ? byProviderLines : undefined}
      />
      <OverviewCard
        label={t('usageStats.server')}
        primary={summary.server.running ? t('usageStats.serverRunning') : t('usageStats.serverStopped')}
        lines={[
          `${t('usageStats.port')}: ${summary.server.port}`,
          `${t('usageStats.uptime')}: ${formatUptime(summary.server.uptimeMs)}`,
        ]}
      />
    </div>
  );
}
