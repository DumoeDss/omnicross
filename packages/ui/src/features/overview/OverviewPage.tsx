import {
  Activity,
  Check,
  CircleDot,
  Gauge,
  Loader2,
  PlugZap,
  RefreshCw,
  Rocket,
  Users,
  Zap,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTranslation } from '@/shared/state/LocaleContext';
import type { AppRoute } from '@/shared/state/hashRoute';
import { cn } from '@/shared/utils/utils';

import { useOverviewData } from './useOverviewData';
import { useLiveThroughput, THROUGHPUT_POLL_MS } from './useLiveThroughput';
import {
  buildThroughputView,
  sparklinePoints,
  throughputProviderTabs,
  DEFAULT_THROUGHPUT_WINDOW_MS,
  THROUGHPUT_WINDOW_OPTIONS,
  type ThroughputView,
  type ThroughputWindowMs,
} from './throughputModel';
import type { UsageThroughputProviderSlice } from '@/daemon/types-usage-pricing';
import {
  buildOverviewModel,
  type AllowanceWeeklyItem,
  type DataSourceState,
  type KeyQuotaDisplayItem,
  type OverviewMetric,
  type PathState,
} from './overviewModel';
import type {
  AllowanceWindowState,
  CliIntegrationClient,
  CliIntegrationStatusKind,
} from '@/daemon/types';
import { useCliIntegrations, type UseCliIntegrationsResult } from '../code-cli/hooks/useCliIntegrations';
import { localizedQuotaWindowLabel } from '../upstreams/useProviderKeyQuota';

const STATE_CLASS: Record<PathState, string> = {
  ready: 'border-success/50 bg-success/10 text-success',
  attention: 'border-warning/50 bg-warning/10 text-warning',
  inactive: 'border-border bg-surface-2/50 text-muted-foreground',
  loading: 'border-primary/40 bg-primary-soft/20 text-primary',
  unavailable: 'border-destructive/40 bg-destructive/10 text-destructive',
};

function sourceText(
  state: DataSourceState,
  t: ReturnType<typeof useTranslation>,
): string {
  return state === 'loading' ? t('overview.source.loading') : t('overview.source.unavailable');
}

function metricText<T>(
  metric: OverviewMetric<T>,
  t: ReturnType<typeof useTranslation>,
  format: (value: T) => string,
): string {
  return metric.state === 'ready' && metric.value !== undefined
    ? format(metric.value)
    : sourceText(metric.state, t);
}

function formatCount(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value);
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 }).format(value);
}

/**
 * A per-minute rate. Sub-10 rates keep a decimal — "0 req/min" would read as
 * "idle" when the truth is "one request every few minutes".
 */
function formatRate(value: number): string {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: value > 0 && value < 10 ? 1 : 0,
  }).format(value);
}

const THROUGHPUT_WINDOW_KEY: Record<number, string> = {
  60_000: 'overview.throughput.window1m',
  300_000: 'overview.throughput.window5m',
  900_000: 'overview.throughput.window15m',
};

function SectionHeading({
  icon: Icon,
  title,
  description,
  action,
  titleId,
}: {
  icon: typeof Activity;
  title: string;
  description: string;
  action?: ReactNode;
  /** Set it to match the section's `aria-labelledby`, so the reference resolves. */
  titleId?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-2 text-primary">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <h2 id={titleId} className="text-sm font-semibold text-foreground">{title}</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
        </div>
      </div>
      {action}
    </div>
  );
}

function EvidenceRow({
  label,
  value,
  detail,
  valueClassName,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="grid gap-1 border-t border-border/60 py-3 sm:grid-cols-[minmax(8rem,0.8fr)_minmax(0,1.2fr)] sm:items-center sm:gap-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className={cn('min-w-0 text-sm text-foreground', valueClassName)}>
        <div className="truncate" title={typeof value === 'string' ? value : undefined}>{value}</div>
        {detail ? <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{detail}</div> : null}
      </div>
    </div>
  );
}

/** One labeled quota bar (5h or weekly) — label + percent, bar, reset time. */
function AllowanceWindowBar({
  label,
  usedPercent,
  state,
  resetsAt,
  threshold,
}: {
  label: string;
  usedPercent?: number;
  state: AllowanceWindowState;
  resetsAt?: string;
  threshold: number;
}) {
  const t = useTranslation();
  const hasData = typeof usedPercent === 'number';
  const percent = hasData ? usedPercent : 0;
  const nearLimit = hasData && (usedPercent as number) >= threshold;
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="truncate text-muted-foreground">{label}</span>
        <span className={cn('shrink-0 font-mono tabular-nums', nearLimit ? 'text-warning' : 'text-foreground')}>
          {hasData ? t('accounts.allowance.used', { percent: Math.round(percent) }) : t(`accounts.allowance.state.${state}`)}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
        <div
          className={cn(
            'h-full rounded-full transition-[width]',
            !hasData || state !== 'fresh'
              ? 'bg-muted-foreground/50'
              : nearLimit
                ? 'bg-warning'
                : 'bg-primary',
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
      {resetsAt ? (
        <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
          {t('accounts.allowance.resetsAt', { time: new Date(resetsAt).toLocaleString() })}
        </p>
      ) : null}
    </div>
  );
}

function WeeklyAllowanceList({
  items,
  threshold,
  heading,
}: {
  items: AllowanceWeeklyItem[];
  threshold: number;
  /** Row label; defaults to the account-quota wording. */
  heading?: string;
}) {
  const t = useTranslation();
  if (!items.length) return null;
  return (
    <div className="grid gap-2 border-t border-border/60 py-3 sm:grid-cols-[minmax(8rem,0.8fr)_minmax(0,1.2fr)] sm:items-start sm:gap-4">
      <span className="text-xs text-muted-foreground">{heading ?? t('overview.accounts.accountQuota')}</span>
      <div className="space-y-2.5">
        {items.map((item) => (
          // One account per row: its 5h rolling and weekly quota bars side by side.
          <div key={`${item.providerId}:${item.accountId}`} className="min-w-0">
            <p className="truncate text-[11px] font-medium text-foreground" title={item.label}>{item.label}</p>
            <div className="mt-1 grid gap-3 sm:grid-cols-2">
              {item.fiveHour ? (
                <AllowanceWindowBar
                  label={t('accounts.allowance.fiveHour')}
                  usedPercent={item.fiveHour.usedPercent}
                  state={item.fiveHour.state}
                  resetsAt={item.fiveHour.resetsAt}
                  threshold={threshold}
                />
              ) : null}
              <AllowanceWindowBar
                label={t('accounts.allowance.weekly')}
                usedPercent={item.usedPercent}
                state={item.state}
                resetsAt={item.resetsAt}
                threshold={threshold}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** BYO provider-key plan quotas (z.ai / MiniMax Token Plan / …) in the same
 * row-and-bar shape as the subscription weekly list. */
function KeyQuotaList({ items, threshold }: { items: KeyQuotaDisplayItem[]; threshold: number }) {
  const t = useTranslation();
  if (!items.length) return null;
  return (
    <div className="grid gap-2 border-t border-border/60 py-3 sm:grid-cols-[minmax(8rem,0.8fr)_minmax(0,1.2fr)] sm:items-start sm:gap-4">
      <span className="text-xs text-muted-foreground">{t('overview.accounts.keyQuota')}</span>
      <div className="space-y-2">
        {items.map((item) => {
          const hasData = typeof item.usedPercent === 'number';
          const percent = hasData ? (item.usedPercent as number) : 0;
          const nearLimit = hasData && (item.usedPercent as number) >= threshold;
          const label = `${item.providerLabel} · ${localizedQuotaWindowLabel({ id: item.windowId, label: item.windowLabel }, t)}`;
          return (
            <div key={item.key} className="min-w-0">
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <span className="truncate text-muted-foreground" title={label}>{label}</span>
                <span className={cn('shrink-0 font-mono tabular-nums', nearLimit ? 'text-warning' : 'text-foreground')}>
                  {hasData ? t('accounts.allowance.used', { percent: Math.round(item.usedPercent as number) }) : t(`accounts.allowance.state.${item.state}`)}
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
                <div
                  className={cn(
                    'h-full rounded-full transition-[width]',
                    !hasData || item.state !== 'fresh'
                      ? 'bg-muted-foreground/50'
                      : nearLimit
                        ? 'bg-warning'
                        : 'bg-primary',
                  )}
                  style={{ width: `${percent}%` }}
                />
              </div>
              {item.resetsAt ? (
                <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                  {t('accounts.allowance.resetsAt', { time: new Date(item.resetsAt).toLocaleString() })}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Token-throughput trend, oldest → newest. Purely decorative for the headline. */
function ThroughputSparkline({ points, label }: { points: number[]; label: string }) {
  const line = sparklinePoints(points, 100, 28);
  if (!line) return null;
  const flat = points.every((value) => value === 0);
  return (
    <svg
      viewBox="0 0 100 28"
      preserveAspectRatio="none"
      className={cn('h-10 w-full', flat ? 'text-border' : 'text-primary')}
      role="img"
      aria-label={label}
    >
      <polyline
        points={line}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function LiveThroughputEvidence({
  view,
  windowMs,
  onWindowChange,
  providers,
  providerFilter,
  onProviderChange,
  onNavigate,
}: {
  view: ThroughputView;
  windowMs: ThroughputWindowMs;
  onWindowChange: (next: ThroughputWindowMs) => void;
  /** Providers with traffic inside retention, most-recently-active first. */
  providers: UsageThroughputProviderSlice[];
  /** Selected provider id; null = 全部 (the default). */
  providerFilter: string | null;
  onProviderChange: (next: string | null) => void;
  onNavigate: (route: AppRoute) => void;
}) {
  const t = useTranslation();
  const ready = view.state === 'ready';
  const windowLabel = t('overview.throughput.windowLabel', {
    window: t(THROUGHPUT_WINDOW_KEY[view.windowMs] ?? THROUGHPUT_WINDOW_KEY[windowMs]!),
  });
  // The headline is OUTPUT tokens only: the all-in TPM is dominated by cache
  // reads (easily 95% of agentic traffic), which read as a runaway counter.
  // Cache volume gets its own place in the breakdown line below instead.
  const headline = ready && view.outputTokensPerMinute !== undefined
    ? formatRate(view.outputTokensPerMinute)
    : sourceText(view.state, t);

  // One hint line, most consequential caveat first: a read we cannot trust beats
  // a partial count, which beats a short observation, which beats plain idle.
  const hint = !ready
    ? view.state === 'unavailable' ? t('overview.throughput.unavailableHint') : undefined
    : !view.complete
      ? t('overview.throughput.incomplete')
      : view.warmingUp
        ? t('overview.throughput.warmingUp')
        : view.idle
          ? t('overview.throughput.idle')
          : t('overview.throughput.hint', { seconds: Math.round(THROUGHPUT_POLL_MS / 1000) });

  return (
    <section className="rounded-xl border border-border/70 bg-surface-1/60 p-4 md:p-5" aria-labelledby="throughput-title">
      <SectionHeading
        icon={Zap}
        titleId="throughput-title"
        title={t('overview.throughput.title')}
        description={t('overview.throughput.description')}
        action={
          <div className="flex shrink-0 items-center gap-1 rounded-md border border-border/70 bg-surface-2/40 p-0.5" role="group" aria-label={t('overview.throughput.windowAria')}>
            {THROUGHPUT_WINDOW_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => onWindowChange(option)}
                aria-pressed={option === windowMs}
                className={cn(
                  'rounded px-2 py-1 font-mono text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  option === windowMs
                    ? 'bg-surface-0 text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t(THROUGHPUT_WINDOW_KEY[option]!)}
              </button>
            ))}
          </div>
        }
      />
      {providers.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5" role="group" aria-label={t('overview.throughput.providerAria')}>
          <button
            type="button"
            onClick={() => onProviderChange(null)}
            aria-pressed={providerFilter === null}
            className={cn(
              'rounded-full border px-2.5 py-1 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              providerFilter === null
                ? 'border-primary/50 bg-primary-soft/30 text-foreground'
                : 'border-border/70 bg-surface-2/40 text-muted-foreground hover:text-foreground',
            )}
          >
            {t('overview.throughput.providerAll')}
          </button>
          {providers.map((provider) => (
            <button
              key={provider.providerId}
              type="button"
              onClick={() => onProviderChange(provider.providerId)}
              aria-pressed={providerFilter === provider.providerId}
              className={cn(
                'max-w-44 truncate rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                providerFilter === provider.providerId
                  ? 'border-primary/50 bg-primary-soft/30 text-foreground'
                  : 'border-border/70 bg-surface-2/40 text-muted-foreground hover:text-foreground',
              )}
              title={provider.providerId}
            >
              {provider.providerId}
            </button>
          ))}
        </div>
      ) : null}
      <div className="mt-4 grid gap-4 border-t border-border/60 pt-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:items-center">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span
              className={cn(
                'font-mono text-3xl font-semibold tabular-nums tracking-tight',
                ready ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              {headline}
            </span>
            {ready ? (
              <span className="text-xs text-muted-foreground">{t('overview.throughput.outputTokensPerMinute')}</span>
            ) : null}
            <span className="font-mono text-[11px] text-muted-foreground">{windowLabel}</span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs tabular-nums text-muted-foreground">
            {ready && view.requestsPerMinute !== undefined ? (
              <span>{t('overview.throughput.requestsPerMinute', { value: formatRate(view.requestsPerMinute) })}</span>
            ) : null}
            {ready && view.inputTokensPerMinute !== undefined && view.outputTokensPerMinute !== undefined ? (
              <span>
                {view.cacheTokensPerMinute !== undefined
                  ? t('overview.throughput.inputOutputCache', {
                      input: formatRate(view.inputTokensPerMinute),
                      output: formatRate(view.outputTokensPerMinute),
                      cache: formatRate(view.cacheTokensPerMinute),
                    })
                  : t('overview.throughput.inputOutput', {
                      input: formatRate(view.inputTokensPerMinute),
                      output: formatRate(view.outputTokensPerMinute),
                    })}
              </span>
            ) : null}
            {ready && view.costUsdPerMinute !== undefined ? (
              <span>{t('overview.throughput.costPerMinute', { value: formatUsd(view.costUsdPerMinute) })}</span>
            ) : null}
          </div>
          {hint ? <p className="mt-2 text-[11px] leading-5 text-muted-foreground">{hint}</p> : null}
        </div>
        <div className="min-w-0">
          {ready ? <ThroughputSparkline points={view.points} label={t('overview.throughput.trendLabel')} /> : null}
          <div className="mt-1 flex justify-end">
            <Button variant="ghost" size="sm" onClick={() => onNavigate({ page: 'usage-stats' })}>
              {t('overview.throughput.open')}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

function GatewayEvidence({
  view,
  onNavigate,
}: {
  view: ReturnType<typeof buildOverviewModel>;
  onNavigate: (route: AppRoute) => void;
}) {
  const t = useTranslation();
  const statusLabel = view.gateway.status.state === 'ready' && view.gateway.status.value
    ? view.gateway.status.value === 'running' ? t('overview.gateway.running') : t('overview.gateway.stopped')
    : sourceText(view.gateway.status.state, t);
  const statusTone = view.gateway.status.state === 'ready' && view.gateway.status.value === 'running'
    ? 'text-success'
    : view.gateway.status.state === 'unavailable' ? 'text-destructive' : 'text-warning';
  return (
    <section className="rounded-xl border border-border/70 bg-surface-1/60 p-4 md:p-5" aria-labelledby="gateway-evidence-title">
      <SectionHeading
        icon={Gauge}
        title={t('overview.gateway.title')}
        description={t('overview.gateway.description')}
        action={<Button variant="ghost" size="sm" onClick={() => onNavigate({ page: 'api-service', tab: 'status' })}>{t('overview.gateway.open')}</Button>}
      />
      <div className="mt-4">
        <EvidenceRow
          label={t('overview.gateway.status')}
          value={<span className={cn('inline-flex items-center gap-2 font-medium', statusTone)}><CircleDot className="h-3.5 w-3.5" aria-hidden="true" />{statusLabel}</span>}
          detail={view.gateway.port.state === 'ready' && view.gateway.port.value !== undefined ? t('overview.gateway.port', { port: view.gateway.port.value }) : undefined}
        />
        <EvidenceRow
          label={t('overview.gateway.address')}
          value={view.gateway.address.state === 'ready' && view.gateway.address.value ? <code className="font-mono text-xs">{view.gateway.address.value}</code> : sourceText(view.gateway.address.state, t)}
          valueClassName="font-mono"
        />
        <EvidenceRow
          label={t('overview.gateway.version')}
          value={view.gateway.version.state === 'ready' && view.gateway.version.value ? <code className="font-mono text-xs">{view.gateway.version.value}</code> : sourceText(view.gateway.version.state, t)}
          detail={view.gateway.version.state === 'unavailable' ? t('overview.gateway.versionHint') : undefined}
        />
      </div>
    </section>
  );
}

function AccountsEvidence({
  view,
  onNavigate,
}: {
  view: ReturnType<typeof buildOverviewModel>;
  onNavigate: (route: AppRoute) => void;
}) {
  const t = useTranslation();
  const allowanceValue = view.allowance.sourceState === 'ready'
    ? t('overview.accounts.allowanceValue', { near: view.allowance.nearLimit.length, stale: view.allowance.stale.length })
    : sourceText(view.allowance.sourceState, t);
  const allowanceDetail = view.allowance.sourceState !== 'ready'
    ? undefined
    : view.allowance.unavailableCount > 0
      ? t('overview.accounts.allowanceUnavailable', { count: view.allowance.unavailableCount })
      : view.allowance.unobservedCount > 0
        ? t('overview.accounts.allowanceUnobserved', { count: view.allowance.unobservedCount })
        : t('overview.accounts.allowanceThreshold', { threshold: view.allowance.threshold });
  const showAbnormal = view.accounts.abnormal.state !== 'ready' || (view.accounts.abnormal.value ?? 0) > 0;
  const showExpiringSoon = view.accounts.expiringSoon.state !== 'ready' || (view.accounts.expiringSoon.value ?? 0) > 0;
  return (
    <section className="rounded-xl border border-border/70 bg-surface-1/60 p-4 md:p-5" aria-labelledby="account-evidence-title">
      <SectionHeading
        icon={Users}
        title={t('overview.accounts.title')}
        description={t('overview.accounts.description')}
        action={<Button variant="ghost" size="sm" onClick={() => onNavigate({ page: 'upstreams', upstreamFilter: 'account' })}>{t('overview.accounts.open')}</Button>}
      />
      <div className="mt-4">
        <EvidenceRow
          label={t('overview.accounts.schedulable')}
          value={view.accounts.schedulable.state === 'ready' && view.accounts.total.state === 'ready'
            ? t('overview.accounts.countOfTotal', { count: view.accounts.schedulable.value, total: view.accounts.total.value })
            : metricText(view.accounts.schedulable, t, formatCount)}
          detail={view.accounts.total.state === 'ready' ? t('overview.accounts.total', { count: view.accounts.total.value }) : undefined}
          valueClassName="font-mono tabular-nums"
        />
        <WeeklyAllowanceList items={view.allowance.weeklyTop} threshold={view.allowance.threshold} />
        <KeyQuotaList items={view.allowance.keyQuotaItems} threshold={view.allowance.threshold} />
        {showAbnormal ? (
          <EvidenceRow
            label={t('overview.accounts.abnormal')}
            value={metricText(view.accounts.abnormal, t, formatCount)}
            valueClassName={view.accounts.abnormal.state === 'ready' ? 'font-mono tabular-nums text-warning' : 'font-mono tabular-nums'}
          />
        ) : null}
        <EvidenceRow
          label={t('overview.accounts.allowance')}
          value={allowanceValue}
          detail={allowanceDetail}
          valueClassName="font-mono tabular-nums"
        />
        {showExpiringSoon ? (
          <EvidenceRow
            label={t('overview.accounts.expiringSoon')}
            value={metricText(view.accounts.expiringSoon, t, formatCount)}
            detail={view.accounts.expiringSoon.state === 'ready' ? t('overview.accounts.expiringSoonHint') : undefined}
            valueClassName="font-mono tabular-nums text-warning"
          />
        ) : null}
      </div>
    </section>
  );
}

function TodayEvidence({
  view,
  onNavigate,
}: {
  view: ReturnType<typeof buildOverviewModel>;
  onNavigate: (route: AppRoute) => void;
}) {
  const t = useTranslation();
  const errorDetail = view.today.errorRate.state === 'ready' && view.today.auditedRequestCount !== undefined
    ? t('overview.today.auditSource', { count: view.today.auditedRequestCount })
    : view.today.errorRateReason === 'audit-disabled'
      ? t('overview.today.auditDisabled')
      : view.today.errorRateReason === 'audit-incomplete'
        ? t('overview.today.auditIncomplete')
        : view.today.errorRateReason === 'no-audited-requests'
          ? t('overview.today.noAuditedRequests')
          : view.today.errorRateReason === 'audit-unavailable'
            ? t('overview.today.auditUnavailable')
            : undefined;
  return (
    <section className="rounded-xl border border-border/70 bg-surface-1/60 p-4 md:p-5" aria-labelledby="today-evidence-title">
      <SectionHeading
        icon={Activity}
        title={t('overview.today.title')}
        description={t('overview.today.description')}
        action={<Button variant="ghost" size="sm" onClick={() => onNavigate({ page: 'usage-stats' })}>{t('overview.today.openUsage')}</Button>}
      />
      <div className="mt-4">
        <EvidenceRow
          label={t('overview.today.requests')}
          value={metricText(view.today.requests, t, formatCount)}
          valueClassName="font-mono tabular-nums"
        />
        <EvidenceRow
          label={t('overview.today.errorRate')}
          value={view.today.errorRate.state === 'ready' && view.today.errorRate.value !== undefined
            ? formatPercent(view.today.errorRate.value)
            : sourceText(view.today.errorRate.state, t)}
          detail={errorDetail}
          valueClassName={view.today.errorRate.state === 'ready' ? 'font-mono tabular-nums' : 'font-mono tabular-nums text-muted-foreground'}
        />
        <EvidenceRow
          label={t('overview.today.cost')}
          value={metricText(view.today.costUsd, t, formatUsd)}
          detail={t('overview.today.source')}
          valueClassName="font-mono tabular-nums"
        />
      </div>
    </section>
  );
}

// ── CLI 接入：状态 → 快捷动作 ────────────────────────────────────────────────

/** The one-click action a client's status admits: enable, repair, or none. */
function clientQuickAction(status: CliIntegrationStatusKind): 'install' | 'repair' | null {
  if (status === 'not-installed') return 'install';
  if (status === 'configuration-drift' || status === 'configuration-missing' || status === 'key-missing') {
    return 'repair';
  }
  return null; // enabled — nothing to do
}

/** One client's quick-action button (启用 / 修复), wired to the integrations hook. */
function ClientActionButton({
  client,
  status,
  integrations,
  installLabel,
  repairLabel,
}: {
  client: CliIntegrationClient;
  status: CliIntegrationStatusKind;
  integrations: UseCliIntegrationsResult;
  /** Optional label overrides (the wizard prefixes the client name). */
  installLabel?: string;
  repairLabel?: string;
}) {
  const t = useTranslation();
  const action = clientQuickAction(status);
  if (!action) return null;
  const busy = integrations.busyTarget === client;
  return (
    <Button
      size="sm"
      variant={action === 'install' ? 'default' : 'outline'}
      disabled={integrations.busyTarget !== null}
      onClick={() => {
        void (action === 'install'
          ? integrations.install(client)
          : integrations.repair(client));
      }}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
      {busy
        ? (action === 'install' ? t('overview.integrations.enabling') : t('overview.integrations.repairing'))
        : (action === 'install'
          ? (installLabel ?? t('overview.integrations.enable'))
          : (repairLabel ?? t('overview.integrations.repair')))}
    </Button>
  );
}

/**
 * 快速开始 — the setup checklist shown while the deployment is not fully
 * configured (not first-run-only: it reappears whenever an upstream or a CLI
 * integration is missing, and hides itself once both steps are green).
 */
function QuickStartCard({
  view,
  integrations,
  onNavigate,
}: {
  view: ReturnType<typeof buildOverviewModel>;
  integrations: UseCliIntegrationsResult;
  onNavigate: (route: AppRoute) => void;
}) {
  const t = useTranslation();
  // An upstream is "configured" when subscription accounts exist or any
  // enabled route carries a target — the same bar the model's noUpstream
  // issue uses, just expressed positively.
  const upstreamReady = (view.accounts.total.state === 'ready' && (view.accounts.total.value ?? 0) > 0)
    || view.configuredTargetCount > 0;
  const rows = integrations.overview?.integrations ?? [];
  const integrationReady = rows.some((row) => row.status === 'enabled');
  const usedOnce = view.today.requests.state === 'ready' && (view.today.requests.value ?? 0) > 0;
  if (upstreamReady && integrationReady) return null;

  const pendingClients = rows.filter((row) => clientQuickAction(row.status) !== null);
  const steps: Array<{ done: boolean; title: string; hint: string; action?: ReactNode }> = [
    {
      done: upstreamReady,
      title: t('overview.quickStart.step1.title'),
      hint: t('overview.quickStart.step1.hint'),
      action: upstreamReady ? undefined : (
        <Button size="sm" onClick={() => onNavigate({ page: 'upstreams' })}>
          {t('overview.quickStart.step1.action')}
        </Button>
      ),
    },
    {
      done: integrationReady,
      title: t('overview.quickStart.step2.title'),
      hint: t('overview.quickStart.step2.hint'),
      action: integrationReady || rows.length === 0 ? undefined : (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {pendingClients.map((row) => (
            <ClientActionButton
              key={row.client}
              client={row.client}
              status={row.status}
              integrations={integrations}
              installLabel={t('overview.quickStart.connect', { client: t(`overview.integrations.${row.client}`) })}
              repairLabel={t('overview.quickStart.repairClient', { client: t(`overview.integrations.${row.client}`) })}
            />
          ))}
        </div>
      ),
    },
    {
      done: usedOnce,
      title: t('overview.quickStart.step3.title'),
      hint: t('overview.quickStart.step3.hint'),
    },
  ];

  return (
    <section className="rounded-xl border border-primary/30 bg-primary-soft/10 p-4 md:p-5" aria-labelledby="quickstart-title">
      <SectionHeading
        icon={Rocket}
        titleId="quickstart-title"
        title={t('overview.quickStart.title')}
        description={t('overview.quickStart.description')}
      />
      <ol className="mt-4 space-y-2">
        {steps.map((step, index) => (
          <li
            key={step.title}
            className={cn(
              'flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2.5',
              step.done ? 'border-success/30 bg-success/5' : 'border-border/70 bg-surface-1/70',
            )}
          >
            <span
              className={cn(
                'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border font-mono text-[11px]',
                step.done ? 'border-success/50 bg-success/10 text-success' : 'border-border bg-surface-2 text-muted-foreground',
              )}
              aria-hidden="true"
            >
              {step.done ? <Check className="h-3.5 w-3.5" /> : index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-foreground">{step.title}</p>
              <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{step.hint}</p>
            </div>
            {step.action ? <div className="shrink-0">{step.action}</div> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** CLI 接入 actionable card — per-client status + one-click 启用/修复. */
function IntegrationActionsCard({
  integrations,
  onNavigate,
}: {
  integrations: UseCliIntegrationsResult;
  onNavigate: (route: AppRoute) => void;
}) {
  const t = useTranslation();
  const overview = integrations.overview;
  const rows = overview?.integrations ?? [];
  return (
    <section className="rounded-xl border border-border/70 bg-surface-1/60 p-4 md:p-5" aria-labelledby="integrations-evidence-title">
      <SectionHeading
        icon={PlugZap}
        title={t('overview.integrations.title')}
        description={t('overview.integrations.description')}
        action={<Button variant="ghost" size="sm" onClick={() => onNavigate({ page: 'integrations' })}>{t('overview.integrations.open')}</Button>}
      />
      {integrations.error ? (
        <div className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{integrations.error}</div>
      ) : null}
      {overview && !overview.gateway.running ? (
        <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {t('codeCli.persistent.gatewayStoppedHint')}
        </div>
      ) : null}
      <div className="mt-4 divide-y divide-border/60 border-y border-border/60">
        {integrations.loading && rows.length === 0 ? (
          <p className="py-3 text-xs text-muted-foreground">{t('overview.source.loading')}</p>
        ) : null}
        {rows.map((row) => {
          const label = t(`overview.integrations.${row.client}`);
          const needsAttention = clientQuickAction(row.status) === 'repair';
          const variant = row.status === 'enabled' ? 'success' : needsAttention ? 'destructive' : 'secondary';
          return (
            <div key={row.client} className="flex min-w-0 flex-wrap items-center gap-3 py-3">
              <div className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-md', needsAttention ? 'bg-warning/15 text-warning' : 'bg-surface-2 text-muted-foreground')}>
                <PlugZap className="h-3.5 w-3.5" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{label}</p>
                <p className="truncate text-[11px] text-muted-foreground" title={row.message ?? undefined}>
                  {row.message ?? row.gatewayBaseUrl ?? t('overview.integrations.persistentHint')}
                </p>
              </div>
              <Badge variant={variant}>{t(`overview.integrations.status.${row.status}`)}</Badge>
              <ClientActionButton client={row.client} status={row.status} integrations={integrations} />
            </div>
          );
        })}
      </div>
    </section>
  );
}

interface OverviewPageProps {
  onNavigate: (route: AppRoute) => void;
}

export function OverviewPage({ onNavigate }: OverviewPageProps) {
  const t = useTranslation();
  const data = useOverviewData();
  const view = buildOverviewModel(data.sources);
  const throughput = useLiveThroughput();
  const integrations = useCliIntegrations();
  // Window + provider selection is client-side: one poll carries all three
  // windows and every provider slice, so switching re-reads the response
  // already in hand rather than hitting the daemon again.
  const [throughputWindowMs, setThroughputWindowMs] = useState<ThroughputWindowMs>(
    DEFAULT_THROUGHPUT_WINDOW_MS,
  );
  const [throughputProvider, setThroughputProvider] = useState<string | null>(null);
  const providerTabs = throughputProviderTabs(throughput.source);
  // A provider that goes idle past retention drops out of the snapshot — fall
  // back to 全部 instead of showing a stale, all-zero filter.
  const effectiveProvider = throughputProvider !== null
    && providerTabs.some((provider) => provider.providerId === throughputProvider)
    ? throughputProvider
    : null;
  const throughputView = buildThroughputView(throughput.source, throughputWindowMs, effectiveProvider);
  const headerReady = view.overallState === 'operational';
  const headerClass = view.overallState === 'loading'
    ? STATE_CLASS.loading
    : headerReady ? STATE_CLASS.ready : STATE_CLASS.attention;

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-6xl space-y-5 px-4 py-4 md:px-7 md:py-6">
        {/* Page controls only — the request-path visualization was removed;
            the status chip + manual refresh remain the page-level affordances. */}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {view.gateway.address.state === 'ready' && view.gateway.address.value ? <code className="hidden max-w-56 truncate font-mono text-[11px] text-muted-foreground xl:block">{view.gateway.address.value}</code> : null}
          <div className={cn('inline-flex items-center gap-2 rounded-full border px-3 py-1.5 font-mono text-xs', headerClass)} aria-live="polite">
            <CircleDot className={cn('h-3.5 w-3.5', headerReady && 'motion-safe:animate-pulse')} aria-hidden="true" />
            {view.overallState === 'loading' ? t('overview.source.loading') : headerReady ? t('overview.operational') : t('overview.actionRequired')}
          </div>
          <Button
            variant="outline"
            size="icon"
            disabled={data.refreshing}
            onClick={() => {
              data.refresh();
              throughput.refresh();
              void integrations.refresh();
            }}
            aria-label={t('overview.refresh')}
            title={t('overview.refresh')}
          >
            <RefreshCw className={data.refreshing ? 'animate-spin' : undefined} aria-hidden="true" />
          </Button>
        </div>

        {/* Setup checklist — visible until an upstream AND a CLI integration
            are configured; gone entirely for a fully set-up deployment. */}
        <QuickStartCard view={view} integrations={integrations} onNavigate={onNavigate} />

        <LiveThroughputEvidence
          view={throughputView}
          windowMs={throughputWindowMs}
          onWindowChange={setThroughputWindowMs}
          providers={providerTabs}
          providerFilter={effectiveProvider}
          onProviderChange={setThroughputProvider}
          onNavigate={onNavigate}
        />

        {/* Per-client persistent-integration status with one-click enable/repair. */}
        <IntegrationActionsCard integrations={integrations} onNavigate={onNavigate} />

        <div className="grid items-start gap-5 lg:grid-cols-[1.05fr_0.95fr]">
          <GatewayEvidence view={view} onNavigate={onNavigate} />
          <TodayEvidence view={view} onNavigate={onNavigate} />
        </div>

        {/* Full-width account pool: each account's 5h + weekly bars share a row. */}
        <AccountsEvidence view={view} onNavigate={onNavigate} />
      </div>
    </ScrollArea>
  );
}
