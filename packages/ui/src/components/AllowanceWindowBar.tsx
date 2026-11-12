/**
 * AllowanceWindowBar — the ONE window-card renderer for quota/allowance
 * windows (label + model-family suffix, used percent, 3-state bar, threshold
 * coloring, and a live reset countdown).
 *
 * Promoted from the Overview page's local bar (the most evolved of the three
 * former hand-rolled copies — accounts allowance card, key-pool section,
 * overview) so every surface shows identical cards. The countdown is computed
 * from `resetsAt` against a self-updating clock (30s tick — a card shows
 * hour/minute granularity, so a faster tick buys nothing); the absolute stamp
 * stays available as the line's tooltip for scheduling against wall-clock time.
 */

import { useEffect, useState } from 'react';

import { useTranslation } from '@/shared/state/LocaleContext';
import { cn } from '@/shared/utils/utils';

import type { AllowanceWindowState } from '@/daemon/types';

/** Locale-free compact countdown ("2d 4h", "1h 23m", "45m", "<1m"). */
export function formatResetCountdown(msLeft: number): string {
  const totalMinutes = Math.floor(msLeft / 60_000);
  if (totalMinutes < 1) return '<1m';
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

export interface AllowanceWindowBarProps {
  label: string;
  /** Model-family suffix ("fable") rendered as "label · family" when present. */
  modelFamily?: string;
  usedPercent?: number | null;
  state: AllowanceWindowState;
  /** Absolute reset instant; drives the countdown (and its tooltip). */
  resetsAt?: string;
  /** Percent at/above which the number and fill turn warning-colored. */
  threshold?: number;
}

export function AllowanceWindowBar({
  label,
  modelFamily,
  usedPercent,
  state,
  resetsAt,
  threshold = 80,
}: AllowanceWindowBarProps) {
  const t = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const hasData = typeof usedPercent === 'number';
  const percent = hasData ? Math.max(0, Math.min(100, usedPercent as number)) : 0;
  const nearLimit = hasData && (usedPercent as number) >= threshold;

  const resetsAtMs = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  // A deadline already in the past means the window rolled over and the next
  // observation has not landed yet — show the absolute stamp instead of "0m".
  const countdownActive = Number.isFinite(resetsAtMs) && resetsAtMs - now > 0;

  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="truncate text-muted-foreground">
          {label}
          {modelFamily ? ` · ${modelFamily}` : ''}
        </span>
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
        <p
          className="mt-0.5 truncate text-[10px] text-muted-foreground"
          title={new Date(resetsAt).toLocaleString()}
        >
          {countdownActive
            ? t('accounts.allowance.resetsIn', { duration: formatResetCountdown(resetsAtMs - now) })
            : t('accounts.allowance.resetsAt', { time: new Date(resetsAt).toLocaleString() })}
        </p>
      ) : null}
    </div>
  );
}
