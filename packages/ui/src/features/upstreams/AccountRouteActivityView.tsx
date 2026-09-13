import {
  Activity,
  ArrowRight,
  CircleAlert,
  Clock3,
  Flame,
  KeyRound,
  RefreshCw,
  Radio,
  ShieldCheck,
  Shuffle,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { LLMProvider } from '@omnicross/contracts/llm-config';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { ManagedAccountRow } from '@/features/accounts/accountManagementModel';
import type {
  AccountRouteActivityRecord,
  AccountRouteActivityResponse,
  RouteCredentialKind,
} from '@/daemon/types';
import { agent } from '@/shared/agent';
import { useTranslation } from '@/shared/state/LocaleContext';
import { cn } from '@/shared/utils/utils';

interface AccountRouteActivityViewProps {
  accounts: ManagedAccountRow[];
  /** BYO provider rows — display names for provider-key activity rows. */
  providers: LLMProvider[];
}

type OutcomeFilter = 'all' | 'success' | 'issues' | 'switched';
type KindFilter = 'all' | 'subscription-account' | 'provider-key';

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

/** Older daemons only ever recorded account rows, so a missing kind is one. */
function credentialKind(record: AccountRouteActivityRecord): RouteCredentialKind {
  return record.credentialKind ?? 'subscription-account';
}

function shortSession(key: string | undefined): string {
  return key ? key.slice(0, 8) : '—';
}

function shortId(key: string | undefined): string {
  return key ? key.slice(0, 8) : '—';
}

/** Best-effort per-provider key labels (`Map<providerId, Map<keyId, label>>`) for
 *  the provider-key rows in view — one secret-free admin read per provider. */
function useKeyLabels(providerIds: readonly string[]): Map<string, Map<string, string>> {
  const idsKey = providerIds.join('\0');
  const [labels, setLabels] = useState<Map<string, Map<string, string>>>(() => new Map());
  useEffect(() => {
    const ids = idsKey ? idsKey.split('\0') : [];
    if (ids.length === 0) {
      setLabels(new Map());
      return;
    }
    let cancelled = false;
    void (async () => {
      const next = new Map<string, Map<string, string>>();
      await Promise.all(ids.map(async (providerId) => {
        try {
          const keys = await agent.llmConfig.getApiKeys(providerId);
          if (keys?.length) {
            next.set(providerId, new Map(keys.map((key) => [key.id, key.label || key.id])));
          }
        } catch {
          /* key labels are best-effort display */
        }
      }));
      if (!cancelled) setLabels(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [idsKey]);
  return labels;
}

export function AccountRouteActivityView({ accounts, providers }: AccountRouteActivityViewProps) {
  const t = useTranslation();
  const [snapshot, setSnapshot] = useState<AccountRouteActivityResponse>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [live, setLive] = useState(true);
  const [provider, setProvider] = useState('all');
  const [outcome, setOutcome] = useState<OutcomeFilter>('all');
  const [kind, setKind] = useState<KindFilter>('all');
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
  const providerLabels = useMemo(
    () => new Map(providers.map((row) => [row.id, row.name || row.id])),
    [providers],
  );
  const providersInRecords = useMemo(
    () => [...new Set(snapshot.records
      .filter((record) => credentialKind(record) === 'provider-key')
      .map((record) => record.providerId))].sort(),
    [snapshot.records],
  );
  const keyLabels = useKeyLabels(providersInRecords);
  const providerOptions = useMemo(
    () => [...new Set(snapshot.records.map((record) => record.providerId))].sort(),
    [snapshot.records],
  );
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return snapshot.records.filter((record) => {
      if (provider !== 'all' && record.providerId !== provider) return false;
      if (kind !== 'all' && credentialKind(record) !== kind) return false;
      if (outcome === 'success' && isIssue(record)) return false;
      if (outcome === 'issues' && !isIssue(record)) return false;
      if (outcome === 'switched' && record.affinity !== 'switched') return false;
      if (!needle) return true;
      const recordKind = credentialKind(record);
      const label = recordKind === 'provider-key'
        ? keyLabels.get(record.providerId)?.get(record.keyId ?? '') ?? ''
        : accountLabels.get(`${record.providerId}\0${record.accountId}`) ?? '';
      const providerName = providerLabels.get(record.providerId) ?? '';
      return `${record.providerId} ${providerName} ${record.accountId ?? ''} ${record.keyId ?? ''} ${label} ${record.model} ${record.sessionKey ?? ''}`
        .toLocaleLowerCase()
        .includes(needle);
    });
  }, [accountLabels, keyLabels, kind, outcome, provider, providerLabels, query, snapshot.records]);

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
                {t('upstreams.activity.title', 'Recent routing')}
              </h2>
              <Badge variant="outline" className="gap-1 border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300">
                <ShieldCheck className="h-3 w-3" />
                {t('upstreams.activity.metadataOnly', 'Metadata only')}
              </Badge>
            </div>
            <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
              {t('upstreams.activity.description', 'See which credential actually served each request — subscription pool accounts and BYO provider API keys on one timeline. Session identifiers are hashed; prompts, headers, tokens and key strings are never collected.')}
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
          <Metric icon={Shuffle} label={t('upstreams.activity.switches', 'Credential switches')} value={stats.switched} tone={stats.switched ? 'warning' : undefined} />
          <Metric icon={CircleAlert} label={t('upstreams.activity.issues', 'Upstream issues')} value={stats.issues} tone={stats.issues ? 'error' : undefined} />
          <Metric icon={Flame} label={t('upstreams.activity.overloadCount', 'Server overloads')} value={stats.overloads} tone={stats.overloads ? 'warning' : undefined} />
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Input
            className="min-w-52 flex-1 sm:max-w-sm"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('upstreams.activity.search', 'Search account, key, model or session hash…')}
          />
          <select
            className="h-9 rounded-md border border-input bg-surface-0 px-3 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={kind}
            onChange={(event) => setKind(event.target.value as KindFilter)}
            aria-label={t('upstreams.activity.kindFilter', 'Filter by credential kind')}
          >
            <option value="all">{t('upstreams.activity.kind.all', 'All credentials')}</option>
            <option value="subscription-account">{t('upstreams.activity.kind.account', 'Accounts')}</option>
            <option value="provider-key">{t('upstreams.activity.kind.key', 'API keys')}</option>
          </select>
          <select
            className="h-9 rounded-md border border-input bg-surface-0 px-3 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
            aria-label={t('upstreams.activity.providerFilter', 'Filter by provider')}
          >
            <option value="all">{t('upstreams.activity.allProviders', 'All providers')}</option>
            {providerOptions.map((value) => (
              <option key={value} value={value}>{providerLabels.get(value) ?? value}</option>
            ))}
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
                accountLabel={accountLabels.get(`${record.providerId}\0${record.accountId ?? ''}`)}
                keyLabel={keyLabels.get(record.providerId)?.get(record.keyId ?? '')}
                providerLabel={providerLabels.get(record.providerId)}
              />
            ))}
            {!loading && !snapshot.available ? (
              <div className="flex min-h-56 flex-col items-center justify-center rounded-xl border border-dashed border-amber-500/40 bg-amber-500/[0.03] px-6 text-center">
                <CircleAlert className="h-7 w-7 text-amber-600/70" />
                <p className="mt-3 text-sm font-medium text-foreground">
                  {t('upstreams.activity.unavailable', 'Routing activity is unavailable')}
                </p>
                <p className="mt-1 max-w-md text-xs leading-5 text-muted-foreground">
                  {t('upstreams.activity.unavailableHint', 'Update or reconnect the daemon, then refresh this view. Existing routing continues normally.')}
                </p>
              </div>
            ) : !loading && visible.length === 0 ? (
              <div className="flex min-h-56 flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 text-center">
                <Activity className="h-7 w-7 text-muted-foreground/50" />
                <p className="mt-3 text-sm font-medium text-foreground">
                  {t('upstreams.activity.empty', 'No routing activity yet')}
                </p>
                <p className="mt-1 max-w-md text-xs leading-5 text-muted-foreground">
                  {t('upstreams.activity.emptyHint', 'Start a request through a subscription route or a BYO provider. New activity appears here without enabling request-body capture.')}
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

function RouteActivityRow({
  record,
  accountLabel,
  keyLabel,
  providerLabel,
}: {
  record: AccountRouteActivityRecord;
  accountLabel?: string;
  keyLabel?: string;
  providerLabel?: string;
}) {
  const t = useTranslation();
  const isKey = credentialKind(record) === 'provider-key';
  const switched = record.affinity === 'switched';
  const overloaded = Boolean(record.streamError);
  // A 200 whose stream carried a server-overload failure is NOT a success —
  // surface it as a warning so it is not disguised as healthy green.
  const kind = overloaded ? 'warning' : statusKind(record.status);
  const statusLabel = record.status === 0 ? t('upstreams.activity.networkError', 'Network error') : `HTTP ${record.status}`;
  const affinityLabel = record.affinity === 'sticky' || record.affinity === 'switched'
    ? t(`upstreams.activity.affinity.${isKey ? 'key' : 'account'}.${record.affinity}`, record.affinity)
    : t(`upstreams.activity.affinity.${record.affinity}`, record.affinity);
  // Credential cell — account rows show the managed-account label; provider-key
  // rows show the pool key label (or a generic "provider key" when the pool had
  // no binding — a static row key never had a key id).
  const credentialTitle = isKey
    ? keyLabel ?? (record.keyId ? `${t('upstreams.activity.keyPrefix', 'key')}:${shortId(record.keyId)}` : t('upstreams.activity.providerKey', 'provider key'))
    : accountLabel ?? record.accountId ?? '—';
  const credentialSub = isKey ? record.keyId ?? providerLabel ?? record.providerId : record.accountId ?? '';
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

      <div className={cn('min-w-0 border-l-2 pl-3', isKey ? 'border-violet-500/50' : 'border-primary/50')}>
        <div className="flex items-center gap-2">
          {isKey ? <KeyRound className="h-3.5 w-3.5 shrink-0 text-violet-600 dark:text-violet-400" /> : null}
          <span className="truncate text-sm font-medium text-foreground" title={isKey ? record.keyId : record.accountId}>
            {credentialTitle}
          </span>
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
            {providerLabel ?? record.providerId}
          </span>
        </div>
        <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground" title={credentialSub}>{credentialSub}</div>
      </div>

      <div className="flex items-center justify-between gap-3 md:block md:text-right">
        <span className={cn(
          'text-xs font-semibold',
          kind === 'success' && 'text-emerald-600 dark:text-emerald-400',
          kind === 'warning' && 'text-amber-600 dark:text-amber-400',
          kind === 'error' && 'text-destructive',
        )}>{statusLabel}</span>
        <div className="mt-1 text-[10px] text-muted-foreground">
          {affinityLabel}
        </div>
      </div>
    </article>
  );
}
