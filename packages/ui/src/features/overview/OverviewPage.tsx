import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Boxes,
  Cable,
  CircleAlert,
  CircleDot,
  Gauge,
  KeyRound,
  PlugZap,
  RefreshCw,
  Route,
  ServerCog,
  Users,
  WalletCards,
} from 'lucide-react';
import React, { type ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTranslation } from '@/shared/state/LocaleContext';
import type { AppRoute } from '@/shared/state/hashRoute';
import { cn } from '@/shared/utils/utils';

import { useOverviewData } from './useOverviewData';
import {
  buildOverviewModel,
  type DataSourceState,
  type OverviewIssue,
  type OverviewMetric,
  type PathState,
  type RequestPathStage,
} from './overviewModel';

const STAGE_ICONS = { client: Cable, gateway: ServerCog, routing: Route, upstream: Boxes } as const;
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

function PathStage({ stage }: { stage: RequestPathStage }) {
  const t = useTranslation();
  const Icon = STAGE_ICONS[stage.id];
  const detail = stage.detailState === 'ready' && stage.detail !== null
    ? t(`overview.path.detail.${stage.id}`, { value: stage.detail })
    : sourceText(stage.detailState, t);
  return (
    <div className="relative flex min-w-0 flex-1 items-center gap-3 rounded-lg border border-border/70 bg-surface-1 px-3 py-3 md:block md:px-4 md:py-4">
      <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full border', STATE_CLASS[stage.state])}>
        <Icon className="h-4 w-4" aria-hidden="true" />
      </div>
      <div className="min-w-0 md:mt-5">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{t(`overview.path.${stage.id}`)}</p>
        <p className="mt-1 truncate font-mono text-sm text-foreground" title={detail}>{detail}</p>
      </div>
      <span className="sr-only">{t(`overview.state.${stage.state}`)}</span>
    </div>
  );
}

function SectionHeading({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: typeof Activity;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-2 text-primary">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
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
  const allowanceIncomplete = view.allowance.unavailableCount > 0;
  const allowanceValue = view.allowance.sourceState === 'ready' && !allowanceIncomplete
    ? t('overview.accounts.allowanceValue', { near: view.allowance.nearLimit.length, stale: view.allowance.stale.length })
    : sourceText(view.allowance.sourceState, t);
  return (
    <section className="rounded-xl border border-border/70 bg-surface-1/60 p-4 md:p-5" aria-labelledby="account-evidence-title">
      <SectionHeading
        icon={Users}
        title={t('overview.accounts.title')}
        description={t('overview.accounts.description')}
        action={<Button variant="ghost" size="sm" onClick={() => onNavigate({ page: 'accounts' })}>{t('overview.accounts.open')}</Button>}
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
        <EvidenceRow
          label={t('overview.accounts.abnormal')}
          value={metricText(view.accounts.abnormal, t, formatCount)}
          detail={view.accounts.abnormal.state === 'ready' && view.accounts.abnormal.value === 0 ? t('overview.accounts.none') : undefined}
          valueClassName={view.accounts.abnormal.state === 'ready' && (view.accounts.abnormal.value ?? 0) > 0 ? 'font-mono tabular-nums text-warning' : 'font-mono tabular-nums'}
        />
        <EvidenceRow
          label={t('overview.accounts.allowance')}
          value={allowanceValue}
          detail={allowanceIncomplete
            ? t('overview.accounts.allowanceUnavailable', { count: view.allowance.unavailableCount })
            : view.allowance.sourceState === 'ready' ? t('overview.accounts.allowanceThreshold', { threshold: view.allowance.threshold }) : undefined}
          valueClassName="font-mono tabular-nums"
        />
        <EvidenceRow
          label={t('overview.accounts.expiringSoon')}
          value={metricText(view.accounts.expiringSoon, t, formatCount)}
          detail={view.accounts.expiringSoon.state === 'ready' ? t('overview.accounts.expiringSoonHint') : undefined}
          valueClassName="font-mono tabular-nums"
        />
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

function IntegrationsEvidence({
  view,
  onNavigate,
}: {
  view: ReturnType<typeof buildOverviewModel>;
  onNavigate: (route: AppRoute) => void;
}) {
  const t = useTranslation();
  return (
    <section className="rounded-xl border border-border/70 bg-surface-1/60 p-4 md:p-5" aria-labelledby="integrations-evidence-title">
      <SectionHeading
        icon={PlugZap}
        title={t('overview.integrations.title')}
        description={t('overview.integrations.description')}
        action={<Button variant="ghost" size="sm" onClick={() => onNavigate({ page: 'integrations' })}>{t('overview.integrations.open')}</Button>}
      />
      <div className="mt-4 divide-y divide-border/60 border-y border-border/60">
        {view.integrations.map((integration) => {
          const label = t(`overview.integrations.${integration.client}`);
          const statusLabel = integration.state !== 'ready' || !integration.status
            ? sourceText(integration.state, t)
            : t(`overview.integrations.status.${integration.status}`);
          const variant = integration.state !== 'ready'
            ? integration.state === 'loading' ? 'default' : 'destructive'
            : integration.needsAttention ? 'destructive' : integration.status === 'enabled' ? 'success' : 'secondary';
          return (
            <div key={integration.client} className="flex min-w-0 items-center gap-3 py-3">
              <div className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-md', integration.needsAttention ? 'bg-warning/15 text-warning' : 'bg-surface-2 text-muted-foreground')}>
                <PlugZap className="h-3.5 w-3.5" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{label}</p>
                <p className="truncate text-[11px] text-muted-foreground">{integration.gatewayBaseUrl ?? t('overview.integrations.persistentHint')}</p>
              </div>
              <Badge variant={variant}>{statusLabel}</Badge>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function RoutesEvidence({
  view,
  sourceState,
  onNavigate,
}: {
  view: ReturnType<typeof buildOverviewModel>;
  sourceState: DataSourceState;
  onNavigate: (route: AppRoute) => void;
}) {
  const t = useTranslation();
  return (
    <section className="rounded-xl border border-border/70 bg-surface-1/60 p-4 md:p-5" aria-labelledby="route-matrix-title">
      <SectionHeading
        icon={Route}
        title={t('overview.routes.title')}
        description={t('overview.routes.description')}
        action={<Button variant="ghost" size="sm" onClick={() => onNavigate({ page: 'api-service', tab: 'routes' })}>{t('overview.open')}</Button>}
      />
      <div className="mt-4 divide-y divide-border/60 border-y border-border/60">
        {sourceState === 'loading' ? <p className="py-4 text-xs text-muted-foreground">{t('overview.source.loading')}</p> : null}
        {sourceState === 'unavailable' ? <p className="py-4 text-xs text-destructive">{t('overview.routes.unavailable')}</p> : null}
        {sourceState === 'ready' && view.routeRows.map((row) => (
          <div key={row.endpoint} className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3 py-2.5 text-xs">
            <span className="font-mono uppercase text-muted-foreground">{row.endpoint}</span>
            <span className={cn('truncate font-mono', row.configured ? 'text-foreground' : 'text-warning')} title={row.targets.join(', ')}>
              {row.targets.length ? row.targets.join(' · ') : t('overview.routes.unconfigured')}
            </span>
          </div>
        ))}
        {sourceState === 'ready' && view.routeRows.length === 0 ? <p className="py-4 text-xs text-muted-foreground">{t('overview.routes.unavailable')}</p> : null}
      </div>
    </section>
  );
}

function issueIcon(issue: OverviewIssue) {
  if (issue.id.includes('AccessKey')) return KeyRound;
  if (issue.id.includes('Account') || issue.id.includes('Upstream') || issue.id.includes('Schedulable') || issue.id.includes('Allowance')) return WalletCards;
  if (issue.id.includes('Integration')) return PlugZap;
  if (issue.id.includes('Usage') || issue.id.includes('Rate')) return Activity;
  if (issue.id.includes('Routing')) return Route;
  if (issue.id.includes('Config') || issue.id.includes('Gateway')) return ServerCog;
  return AlertTriangle;
}

function AttentionEvidence({
  issues,
  loading,
  onNavigate,
}: {
  issues: OverviewIssue[];
  loading: boolean;
  onNavigate: (route: AppRoute) => void;
}) {
  const t = useTranslation();
  return (
    <section className="rounded-xl border border-border/70 bg-surface-1/60 p-4 md:p-5" aria-labelledby="attention-title">
      <SectionHeading
        icon={CircleAlert}
        title={t('overview.attention.title')}
        description={t('overview.attention.description')}
      />
      <div className="mt-4 space-y-2" aria-live="polite">
        {loading ? <p className="rounded-lg border border-border/70 bg-surface-0/60 px-3 py-3 text-xs text-muted-foreground">{t('overview.source.loading')}</p> : null}
        {!loading && issues.length === 0 ? <div className="rounded-lg border border-success/30 bg-success/10 px-3 py-3 text-xs text-success">{t('overview.attention.empty')}</div> : null}
        {!loading && issues.map((issue) => {
          const Icon = issueIcon(issue);
          const label = issue.count === undefined
            ? t(`overview.attention.${issue.id}`)
            : t(`overview.attention.${issue.id}`, { count: issue.count });
          return (
            <button
              key={issue.id}
              type="button"
              onClick={() => onNavigate(issue.route)}
              className={cn(
                'flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                issue.severity === 'blocking' ? 'border-destructive/40 bg-destructive/5 hover:border-destructive/70' : 'border-warning/40 bg-warning/5 hover:border-warning/70',
              )}
            >
              <Icon className={cn('h-4 w-4 shrink-0', issue.severity === 'blocking' ? 'text-destructive' : 'text-warning')} aria-hidden="true" />
              <span className="min-w-0 flex-1 text-xs text-foreground">{label}</span>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            </button>
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
  const headerReady = view.overallState === 'operational';
  const headerClass = view.overallState === 'loading'
    ? STATE_CLASS.loading
    : headerReady ? STATE_CLASS.ready : STATE_CLASS.attention;

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-6xl space-y-6 px-4 py-5 md:px-7 md:py-7">
        <header className="flex flex-col gap-3 border-b border-border/70 pb-5 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-primary">{t('overview.eyebrow')}</p>
            <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight text-foreground md:text-3xl">{t('overview.title')}</h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{t('overview.description')}</p>
          </div>
          <div className="flex items-center gap-2">
            <div className={cn('inline-flex items-center gap-2 rounded-full border px-3 py-1.5 font-mono text-xs', headerClass)} aria-live="polite">
              <CircleDot className={cn('h-3.5 w-3.5', headerReady && 'motion-safe:animate-pulse')} aria-hidden="true" />
              {view.overallState === 'loading' ? t('overview.source.loading') : headerReady ? t('overview.operational') : t('overview.actionRequired')}
            </div>
            <Button variant="outline" size="icon" disabled={data.refreshing} onClick={data.refresh} aria-label={t('overview.refresh')} title={t('overview.refresh')}>
              <RefreshCw className={data.refreshing ? 'animate-spin' : undefined} aria-hidden="true" />
            </Button>
          </div>
        </header>

        <section aria-labelledby="request-path-title">
          <div className="mb-3 flex items-end justify-between gap-3">
            <div>
              <h2 id="request-path-title" className="text-sm font-semibold text-foreground">{t('overview.requestPath')}</h2>
              <p className="mt-1 text-xs text-muted-foreground">{t('overview.requestPathHint')}</p>
            </div>
            {view.gateway.address.state === 'ready' && view.gateway.address.value ? <code className="hidden max-w-[45%] truncate font-mono text-[11px] text-muted-foreground md:block">{view.gateway.address.value}</code> : null}
          </div>
          <div className="relative grid gap-2 rounded-xl border border-border/70 bg-surface-2/30 p-2 md:grid-cols-4">
            <div className={cn('pointer-events-none absolute left-[12.5%] right-[12.5%] top-[2.1rem] hidden h-px bg-border md:block', view.pathOperational && 'request-path-live')} aria-hidden="true" />
            {view.stages.map((stage, index) => (
              <React.Fragment key={stage.id}>
                <PathStage stage={stage} />
                {index < view.stages.length - 1 ? <ArrowRight className="mx-auto h-3.5 w-3.5 rotate-90 text-muted-foreground md:hidden" aria-hidden="true" /> : null}
              </React.Fragment>
            ))}
          </div>
        </section>

        <div className="grid gap-5 lg:grid-cols-[1.05fr_0.95fr]">
          <GatewayEvidence view={view} onNavigate={onNavigate} />
          <AccountsEvidence view={view} onNavigate={onNavigate} />
        </div>

        <div className="grid gap-5 lg:grid-cols-[1.05fr_0.95fr]">
          <TodayEvidence view={view} onNavigate={onNavigate} />
          <IntegrationsEvidence view={view} onNavigate={onNavigate} />
        </div>

        <div className="grid gap-5 lg:grid-cols-[1.05fr_0.95fr]">
          <RoutesEvidence view={view} sourceState={data.sources.gateway.config.state} onNavigate={onNavigate} />
          <AttentionEvidence issues={view.issues} loading={data.loading} onNavigate={onNavigate} />
        </div>
      </div>
    </ScrollArea>
  );
}
