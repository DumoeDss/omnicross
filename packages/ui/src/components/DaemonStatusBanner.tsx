/**
 * DaemonStatusBanner.tsx — the honest daemon-lifecycle indicator for the shell.
 *
 * Truthfully reflects the Rust lifecycle state from `useDaemonStatus`:
 *   - probing / spawning → transient "starting…" strip (non-blocking);
 *   - running / adopted  → quiet/hidden (no clutter once connected);
 *   - failed             → a red banner with the reason + a remediation hint.
 *
 * Honesty invariant: "running" is derived ONLY from the real lifecycle reaching
 * `running` (or a successful browser-dev liveness probe). A `failed` state NEVER
 * renders as running. The per-page "daemon unreachable" errors remain the
 * runtime fallback.
 */

import { AlertTriangle, Loader2 } from 'lucide-react';
import React from 'react';

import { useTranslation } from '@/shared/state/LocaleContext';
import { useDaemonStatus } from '@/shared/state/useDaemonStatus';

export function DaemonStatusBanner() {
  const t = useTranslation();
  const status = useDaemonStatus();

  // Connected states are intentionally quiet — no banner once the daemon runs.
  if (status.state === 'running' || status.state === 'adopted') {
    return null;
  }

  if (status.state === 'failed') {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-xs text-foreground"
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="font-medium text-destructive">{t('daemonStatus.failed')}</p>
          {status.reason ? (
            <p className="break-words text-muted-foreground">{status.reason}</p>
          ) : null}
          <p className="text-muted-foreground">{t('daemonStatus.failedHint')}</p>
        </div>
      </div>
    );
  }

  // probing | spawning → transient, non-blocking.
  const label = status.state === 'spawning' ? t('daemonStatus.spawning') : t('daemonStatus.probing');
  return (
    <div className="flex items-center gap-2 border-b border-border/50 bg-surface-1/60 px-4 py-1.5 text-xs text-muted-foreground">
      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
