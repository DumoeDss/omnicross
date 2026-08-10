import { Flame } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Line, ResponsiveContainer } from 'recharts';

import { Badge } from '@/components/ui/badge';
import type { ManagedAccountRow } from '@/features/accounts/accountManagementModel';
import type { OverloadCounterEntry, OverloadCounterResponse } from '@/daemon/types';
import { agent } from '@/shared/agent';
import { getChartTheme } from '@/features/usage-stats/components/chartTheme';
import { useTranslation } from '@/shared/state/LocaleContext';
import { cn } from '@/shared/utils/utils';

interface OverloadTrendViewProps {
  accounts: ManagedAccountRow[];
}

const EMPTY: OverloadCounterResponse = { available: true, entries: [], collectedAt: 0 };

/** Sparkline horizon + resolution: the last hour split into 24 buckets. */
const SPARK_WINDOW_MS = 60 * 60_000;
const SPARK_BUCKETS = 24;

function relativeTime(ts: number, now: number, t: (k: string, fallback: string) => string): string {
  const secs = Math.max(0, Math.round((now - ts) / 1000));
  if (secs < 60) return t('upstreams.activity.overloadJustNow', 'just now');
  const mins = Math.round(secs / 60);
  if (mins < 60) return t('upstreams.activity.overloadMinsAgo', '{{n}} min ago').replace('{{n}}', String(mins));
  const hrs = Math.round(mins / 60);
  return t('upstreams.activity.overloadHoursAgo', '{{n}} h ago').replace('{{n}}', String(hrs));
}

/** Bucket the recent event timestamps into a fixed-window histogram for the sparkline. */
function sparkData(recent: number[], now: number): Array<{ b: number; c: number }> {
  const start = now - SPARK_WINDOW_MS;
  const bucketMs = SPARK_WINDOW_MS / SPARK_BUCKETS;
  const counts = new Array<number>(SPARK_BUCKETS).fill(0);
  for (const ts of recent) {
    if (ts < start) continue;
    const idx = Math.min(SPARK_BUCKETS - 1, Math.floor((ts - start) / bucketMs));
    counts[idx] += 1;
  }
  return counts.map((c, b) => ({ b, c }));
}

export function OverloadTrendView({ accounts }: OverloadTrendViewProps) {
  const t = useTranslation();
  const [snapshot, setSnapshot] = useState<OverloadCounterResponse>(EMPTY);
  const [live, setLive] = useState(true);
  const loadingRef = useRef(false);

  const load = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      setSnapshot(await agent.apiService.queryOverloadCounters({}));
    } finally {
      loadingRef.current = false;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(timer);
  }, [live, load]);

  const accountLabels = useMemo(
    () => new Map(accounts.map((account) => [`${account.providerId}\0${account.id}`, account.label || account.id])),
    [accounts],
  );

  // Stable "now" per render for relative times + bucketing.
  const now = snapshot.collectedAt || Date.now();
  const theme = getChartTheme();
  const entries = snapshot.entries;

  return (
    <section className="mx-auto w-full max-w-7xl shrink-0 border-b border-border/70 bg-surface-0/30 px-5 py-3 md:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Flame className="h-4 w-4 text-rose-500" />
          <h3 className="text-sm font-semibold text-foreground">
            {t('upstreams.activity.overloadTrend', 'Server overload trend')}
          </h3>
          <Badge variant="outline" className="gap-1 border-rose-500/30 bg-rose-500/5 text-rose-700 dark:text-rose-300">
            {t('upstreams.activity.metadataOnly', 'Metadata only')}
          </Badge>
        </div>
        <button
          type="button"
          className="text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() => setLive((value) => !value)}
          aria-pressed={live}
        >
          {live ? t('upstreams.activity.live', 'Live') : t('upstreams.activity.paused', 'Paused')}
        </button>
      </div>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        {t('upstreams.activity.overloadTrendHint', 'Codex `server_is_overloaded` / `slow_down` events arrive inside 200 streams. They are account-independent capacity issues, so they are recorded — not retried.')}
      </p>

      {!snapshot.available ? (
        <div className="mt-3 text-xs text-muted-foreground">
          {t('upstreams.activity.overloadUnavailable', 'Overload tracking is unavailable on this daemon version.')}
        </div>
      ) : entries.length === 0 ? (
        <div className="mt-3 text-xs text-muted-foreground">
          {t('upstreams.activity.overloadNone', 'No server overloads recorded in the last hour.')}
        </div>
      ) : (
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {entries.map((entry) => (
            <OverloadEntryCard
              key={`${entry.providerId}\0${entry.accountId}\0${entry.endpoint}`}
              entry={entry}
              label={accountLabels.get(`${entry.providerId}\0${entry.accountId}`) ?? entry.accountId}
              now={now}
              stroke={theme.accent}
              t={t}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function OverloadEntryCard({
  entry,
  label,
  now,
  stroke,
  t,
}: {
  entry: OverloadCounterEntry;
  label: string;
  now: number;
  stroke: string;
  t: (k: string, fallback: string) => string;
}) {
  const data = useMemo(() => sparkData(entry.recent, now), [entry.recent, now]);
  const recentInWindow = data.reduce((sum, point) => sum + point.c, 0);
  return (
    <div className={cn('rounded-lg border border-border/70 bg-surface-0 px-3 py-2.5')}>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-foreground" title={label}>{label}</span>
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">{entry.providerId}</span>
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-lg font-semibold tabular-nums text-rose-600 dark:text-rose-400">{entry.count}</span>
        <span className="text-[11px] text-muted-foreground">
          {t('upstreams.activity.overloadTotal', 'total')} · {relativeTime(entry.lastTs, now, t)}
        </span>
      </div>
      <div className="mt-1 h-8 w-full" aria-label={`${recentInWindow} in the last hour`}>
        <ResponsiveContainer width="100%" height="100%">
          <Line data={data} dataKey="c" stroke={stroke} strokeWidth={1.5} dot={false} isAnimationActive={false}>
            {/* No axes/grid — this is a sparkline, not a full chart. */}
          </Line>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
