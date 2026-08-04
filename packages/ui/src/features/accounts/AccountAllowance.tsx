import { RefreshCw } from 'lucide-react';
import React, { useState } from 'react';

import { Button } from '@/components/ui/button';
import { useTranslation } from '@/shared/state/LocaleContext';
import { cn } from '@/shared/utils/utils';

import { allowanceState } from './allowanceLogic';

import type {
  AccountAllowanceSnapshot,
  AllowanceWindow,
  AllowanceWindowState,
  SubscriptionProviderId,
} from '@/daemon/types';

interface AccountAllowanceProps {
  providerId: SubscriptionProviderId;
  snapshot?: AccountAllowanceSnapshot;
  loading: boolean;
  error?: string;
  onRefresh?: () => Promise<{ success: boolean; message?: string }>;
}

function stateClass(state: AllowanceWindowState): string {
  switch (state) {
    case 'fresh':
      return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400';
    case 'stale':
      return 'bg-amber-500/15 text-amber-700 dark:text-amber-400';
    case 'unavailable':
      return 'bg-destructive/10 text-destructive';
    case 'unsupported':
      return 'bg-muted text-muted-foreground';
  }
}

function windowLabel(window: AllowanceWindow, fiveHour: string, weekly: string): string {
  if (window.id === 'five-hour' || window.windowMinutes === 300) return fiveHour;
  if (window.id === 'seven-day' || window.windowMinutes === 10_080) return weekly;
  return window.label;
}

export function AccountAllowance({
  providerId,
  snapshot,
  loading,
  error,
  onRefresh,
}: AccountAllowanceProps) {
  const t = useTranslation();
  const [refreshing, setRefreshing] = useState(false);
  const supportsAllowance = providerId === 'claude' || providerId === 'codex';
  const summaryState: AllowanceWindowState = snapshot
    ? allowanceState(snapshot)
    : supportsAllowance
      ? 'unavailable'
      : 'unsupported';

  const refresh = async () => {
    if (!onRefresh) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="mt-2 rounded-md border border-border/40 bg-surface-0/45 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-xs font-medium text-foreground">{t('accounts.allowance.title')}</span>
          <span className={cn('rounded px-1.5 py-0.5 text-[11px]', stateClass(summaryState))}>
            {loading && !snapshot
              ? t('accounts.allowance.loading')
              : t(`accounts.allowance.state.${summaryState}`)}
          </span>
        </div>
        {onRefresh ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            <RefreshCw className={cn('mr-1 h-3 w-3', refreshing && 'animate-spin')} />
            {t('accounts.allowance.refresh')}
          </Button>
        ) : null}
      </div>

      {!supportsAllowance ? (
        <p className="mt-1.5 text-xs text-muted-foreground">
          {t('accounts.allowance.unsupportedProvider')}
        </p>
      ) : snapshot?.windows.length ? (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {snapshot.windows.map((window) => {
            const percent = window.usedPercent === null
              ? null
              : Math.max(0, Math.min(100, window.usedPercent));
            return (
              <div key={`${window.id}:${window.modelFamily ?? 'all'}`} className="min-w-0">
                <div className="mb-1 flex items-center justify-between gap-2 text-[11px]">
                  <span className="truncate text-muted-foreground">
                    {windowLabel(
                      window,
                      t('accounts.allowance.fiveHour'),
                      t('accounts.allowance.weekly'),
                    )}
                    {window.modelFamily ? ` · ${window.modelFamily}` : ''}
                  </span>
                  <span className="shrink-0 font-medium text-foreground">
                    {percent === null
                      ? t(`accounts.allowance.state.${window.state}`)
                      : t('accounts.allowance.used', { percent: Math.round(percent) })}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                  <div
                    className={cn(
                      'h-full rounded-full transition-[width]',
                      window.state === 'fresh' ? 'bg-primary' : 'bg-muted-foreground/50',
                    )}
                    style={{ width: `${percent ?? 0}%` }}
                  />
                </div>
                {window.resetsAt ? (
                  <p className="mt-1 truncate text-[10px] text-muted-foreground">
                    {t('accounts.allowance.resetsAt', {
                      time: new Date(window.resetsAt).toLocaleString(),
                    })}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : loading ? null : (
        <p className="mt-1.5 text-xs text-muted-foreground">
          {providerId === 'codex'
            ? t('accounts.allowance.codexNotObserved')
            : t('accounts.allowance.unavailableHint')}
        </p>
      )}

      {snapshot ? (
        <p className="mt-1.5 text-[10px] text-muted-foreground">
          {t('accounts.allowance.observedAt', {
            time: new Date(snapshot.observedAt).toLocaleString(),
          })}
        </p>
      ) : null}
      {error ? <p className="mt-1.5 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
