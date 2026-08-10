import {
  Activity,
  ArrowRight,
  CircleAlert,
  Clock3,
  Flame,
  RefreshCw,
  Radio,
  ShieldCheck,
  Shuffle,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { ManagedAccountRow } from '@/features/accounts/accountManagementModel';
import type { AccountRouteActivityRecord, AccountRouteActivityResponse } from '@/daemon/types';
import { agent } from '@/shared/agent';
import { useTranslation } from '@/shared/state/LocaleContext';
import { cn } from '@/shared/utils/utils';

interface AccountRouteActivityViewProps {
  accounts: ManagedAccountRow[];
}

type OutcomeFilter = 'all' | 'success' | 'issues' | 'switched';

const EMPTY_SNAPSHOT: AccountRouteActivityResponse = {
  available: true,
  records: [],
  capacity: 300,
  collectedAt: 0,
};

function statusKind(status: number): 'success' | 'warning' | 'error' {
  if (status >= 200 && status < 400) return 'success';
  if (status === 0 || status >= 500) return 'error';
  return 'warning';
}

/** A row counts as an issue when its status is non-success OR it carries a
 *  post-hoc stream error (e.g. a 200 that failed mid-stream with overload). */
function isIssue(record: AccountRouteActivityRecord): boolean {
  return statusKind(record.status) !== 'success' || Boolean(record.streamError);
}

function shortSession(key: string | undefined): string {
  return key ? key.slice(0, 8) : '—';
}

export function AccountRouteActivityView({ accounts }: AccountRouteActivityViewProps) {
  const t = useTranslation();
  const [snapshot, setSnapshot] = useState<AccountRouteActivityResponse>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [live, setLive] = useState(true);
  const [provider, setProvider] = useState('all');
  const [outcome, setOutcome] = useState<OutcomeFilter>('all');
  const [query, setQuery] = useState('');
  const loadingRef = useRef(false);

  const load = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setRefreshing(true);
    try {
      setSnapshot(await agent.apiService.queryAccountRouteActivity({ limit: 300 }));
    } finally {
      loadingRef.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => void load(), 3_000);
    return () => window.clearInterval(timer);
  }, [live, load]);

  const accountLabels = useMemo(
    () => new Map(accounts.map((account) => [
      `${account.providerId}\0${account.id}`,
      account.label || account.id,
    ])),
    [accounts],
  );
  const providers = useMemo(
    () => [...new Set(snapshot.records.map((record) => record.providerId))].sort(),
    [snapshot.records],
  );
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return snapshot.records.filter((record) => {
      if (provider !== 'all' && record.providerId !== provider) return false;
      if (outcome === 'success' && isIssue(record)) return false;
      if (outcome === 'issues' && !isIssue(record)) return false;
      if (outcome === 'switched' && record.affinity !== 'switched') return false;
      if (!needle) return true;
      const label = accountLabels.get(`${record.providerId}\0${record.accountId}`) ?? '';
      return `${record.providerId} ${record.accountId} ${label} ${record.model} ${record.sessionKey ?? ''}`
        .toLocaleLowerCase()
        .includes(needle);
    });
  }, [accountLabels, outcome, provider, query, snapshot.records]);

  const stats = useMemo(() => ({
    sessions: new Set(snapshot.records.map((record) => `${record.providerId}\0${record.sessionKey ?? record.id}`)).size,
    switched: snapshot.records.filter((record) => record.affinity === 'switched').length,
    issues: snapshot.records.filter((record) => isIssue(record)).length,
    overloads: snapshot.records.filter((record) => Boolean(record.streamError)).length,
  }), [snapshot.records]);

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col bg-surface-0/30">
      <section className="shrink-0 border-b border-border/70 px-5 py-4 md:px-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold text-foreground">
                {t('upstreams.activity.title', 'Recent account routing')}
              </h2>
              <Badge variant="outline" className="gap-1 border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300">
                <ShieldCheck className="h-3 w-3" />
                {t('upstreams.activity.metadataOnly', 'Metadata only')}
              </Badge>
            </div>
            <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
              {t('upstreams.activity.description', 'See which managed account actually served each subscription request. Session identifiers are hashed; prompts, headers and tokens are never collected.')}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant={live ? 'secondary' : 'outline'}
              className={cn('gap-1.5', live && 'text-primary')}
              onClick={() => setLive((value) => !value)}
              aria-pressed={live}
            >
              <Radio className={cn('h-3.5 w-3.5', live && 'animate-pulse')} />
              {live ? t('upstreams.activity.live', 'Live') : t('upstreams.activity.paused', 'Paused')}
            </Button>
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void load()} disabled={refreshing}>
              <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
              {t('common.refresh', 'Refresh')}
            </Button>
          </div>
        </div>

        <div className="mt-4 grid gap-px overflow-hidden rounded-lg border border-border/70 bg-border/70 sm:grid-cols-2 lg:grid-cols-4">
          <Metric icon={Clock3} label={t('upstreams.activity.sessions', 'Sessions in view')} value={stats.sessions} />
          <Metric icon={Shuffle} label={t('upstreams.activity.switches', 'Account switches')} value={stats.switched} tone={stats.switched ? 'warning' : undefined} />
          <Metric icon={CircleAlert} label={t('upstreams.activity.issues', 'Upstream issues')} value={stats.issues} tone={stats.issues ? 'error' : undefined} />
          <Metric icon={Flame} label={t('upstreams.activity.overloadCount', 'Server overloads')} value={stats.overloads} tone={stats.overloads ? 'warning' : undefined} />
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Input
            className="min-w-52 flex-1 sm:max-w-sm"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('upstreams.activity.search', 'Search account, model or session hash…')}
          />
          <select
            className="h-9 rounded-md border border-input bg-surface-0 px-3 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
            aria-label={t('upstreams.activity.providerFilter', 'Filter by provider')}
          >
            <option value="all">{t('upstreams.activity.allProviders', 'All providers')}</option>
            {providers.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <select
            className="h-9 rounded-md border border-input bg-surface-0 px-3 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={outcome}
            onChange={(event) => setOutcome(event.target.value as OutcomeFilter)}
            aria-label={t('upstreams.activity.outcomeFilter', 'Filter by outcome')}
          >
            {(['all', 'success', 'issues', 'switched'] as const).map((value) => (
              <option key={value} value={value}>{t(`upstreams.activity.filter.${value}`, value)}</option>
            ))}
          </select>
        </div>
      </section>

      <div className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <div className="space-y-2 p-4 md:p-6">
            {visible.map((record) => (
              <RouteActivityRow
                key={record.id}
                record={record}
                accountLabel={accountLabels.get(`${record.providerId}\0${record.accountId}`) ?? record.accountId}
              />
            ))}
            {!loading && !snapshot.available ? (
              <div className="flex min-h-56 flex-col items-center justify-center rounded-xl border border-dashed border-amber-500/40 bg-amber-500/[0.03] px-6 text-center">
                <CircleAlert className="h-7 w-7 text-amber-600/70" />
                <p className="mt-3 text-sm font-medium text-foreground">
                  {t('upstreams.activity.unavailable', 'Routing activity is unavailable')}
                </p>
                <p className="mt-1 max-w-md text-xs leading-5 text-muted-foreground">
                  {t('upstreams.activity.unavailableHint', 'Update or reconnect the daemon, then refresh this view. Existing account routing continues normally.')}
                </p>
              </div>
            ) : !loading && visible.length === 0 ? (
              <div className="flex min-h-56 flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 text-center">
                <Activity className="h-7 w-7 text-muted-foreground/50" />
                <p className="mt-3 text-sm font-medium text-foreground">
                  {t('upstreams.activity.empty', 'No account routing activity yet')}
                </p>
                <p className="mt-1 max-w-md text-xs leading-5 text-muted-foreground">
                  {t('upstreams.activity.emptyHint', 'Start a Codex or Claude Code request through a subscription route. New activity appears here without enabling request-body capture.')}
                </p>
              </div>
            ) : null}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof Activity;
  label: string;
  value: number;
  tone?: 'warning' | 'error';
}) {
  return (
    <div className="flex items-center gap-3 bg-surface-0 px-4 py-3">
      <Icon className={cn('h-4 w-4 text-muted-foreground', tone === 'warning' && 'text-amber-600', tone === 'error' && 'text-destructive')} />
      <div>
        <div className="text-lg font-semibold leading-none tabular-nums text-foreground">{value}</div>
        <div className="mt-1 text-[11px] text-muted-foreground">{label}</div>
      </div>
    </div>
  );
}

function RouteActivityRow({ record, accountLabel }: { record: AccountRouteActivityRecord; accountLabel: string }) {
  const t = useTranslation();
  const switched = record.affinity === 'switched';
  const overloaded = Boolean(record.streamError);
  // A 200 whose stream carried a server-overload failure is NOT a success —
  // surface it as a warning so it is not disguised as healthy green.
  const kind = overloaded ? 'warning' : statusKind(record.status);
  const statusLabel = record.status === 0 ? t('upstreams.activity.networkError', 'Network error') : `HTTP ${record.status}`;
  return (
    <article className={cn(
      'grid gap-3 rounded-xl border bg-surface-0 px-4 py-3 shadow-sm shadow-black/[0.02] md:grid-cols-[7.5rem_minmax(10rem,1fr)_2.5rem_minmax(12rem,1fr)_7rem] md:items-center',
      switched || overloaded ? 'border-amber-500/40' : 'border-border/70',
    )}>
      <div className="text-[11px] text-muted-foreground">
        <div className="font-medium text-foreground">{new Date(record.ts).toLocaleTimeString()}</div>
        <div className="mt-1 tabular-nums">{record.durationMs} ms</div>
      </div>

      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary" className="font-mono text-[10px] uppercase tracking-wide">{record.endpoint}</Badge>
          <span className="truncate font-mono text-xs text-foreground" title={record.sessionKey}>
            {t('upstreams.activity.session', 'session')}:{shortSession(record.sessionKey)}
          </span>
          {switched ? (
            <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-300">
              {t('upstreams.activity.switched', 'switched')}
            </Badge>
          ) : null}
          {overloaded ? (
            <Badge variant="outline" className="gap-1 border-rose-500/40 bg-rose-500/10 text-[10px] text-rose-700 dark:text-rose-300" title={record.streamError}>
              <Flame className="h-3 w-3" />
              {t('upstreams.activity.overloaded', 'overloaded')}
            </Badge>
          ) : null}
        </div>
        <div className="mt-1.5 truncate text-[11px] text-muted-foreground" title={record.model}>{record.model}</div>
      </div>

      <div className="hidden items-center md:flex" aria-hidden="true">
        <div className={cn('h-px flex-1', switched ? 'bg-amber-500/60' : 'bg-primary/35')} />
        <ArrowRight className={cn('h-3.5 w-3.5', switched ? 'text-amber-600' : 'text-primary')} />
      </div>

      <div className="min-w-0 border-l-2 border-primary/50 pl-3">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground" title={record.accountId}>{accountLabel}</span>
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">{record.providerId}</span>
        </div>
        <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground" title={record.accountId}>{record.accountId}</div>
      </div>

      <div className="flex items-center justify-between gap-3 md:block md:text-right">
        <span className={cn(
          'text-xs font-semibold',
          kind === 'success' && 'text-emerald-600 dark:text-emerald-400',
          kind === 'warning' && 'text-amber-600 dark:text-amber-400',
          kind === 'error' && 'text-destructive',
        )}>{statusLabel}</span>
        <div className="mt-1 text-[10px] text-muted-foreground">
          {t(`upstreams.activity.affinity.${record.affinity}`, record.affinity)}
        </div>
      </div>
    </article>
  );
}
