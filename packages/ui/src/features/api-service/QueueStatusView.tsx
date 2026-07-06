/**
 * QueueStatusView.tsx — a quiet-when-idle readout of live queue activity
 * (`status.queueStatus`, omnicross-user-queue-concurrency §COMMITTED §4).
 *
 * Renders NOTHING when `queueStatus` is absent or both arrays are empty (the
 * office-hours "silent when nothing is queued" intent — no empty-state box).
 * When there is activity it lists serial holders/waiters per provider and
 * concurrency active/waiting per key, read-only.
 */

import { Activity } from 'lucide-react';

import { useTranslation } from '@/shared/state/LocaleContext';

import type { OutboundQueueStatus } from '@/daemon/types';

interface QueueStatusViewProps {
  queueStatus: OutboundQueueStatus | undefined;
}

export function QueueStatusView({ queueStatus }: QueueStatusViewProps) {
  const t = useTranslation();

  const serial = queueStatus?.serial ?? [];
  const concurrency = queueStatus?.concurrency ?? [];
  if (serial.length === 0 && concurrency.length === 0) return null;

  return (
    <div className="rounded-md border border-border/60 bg-surface-0/60 p-3 space-y-2" role="status">
      <div className="flex items-center gap-2">
        <Activity className="h-4 w-4 text-primary" aria-hidden="true" />
        <span className="text-sm font-medium text-foreground">{t('apiService.queue.status.title')}</span>
      </div>

      {serial.length > 0 ? (
        <div className="space-y-1">
          <div className="text-xs font-semibold text-muted-foreground">
            {t('apiService.queue.status.serial')}
          </div>
          <ul className="space-y-0.5">
            {serial.map((s) => (
              <li key={s.providerId} className="flex items-center gap-2 text-xs">
                <code className="min-w-0 flex-1 truncate text-foreground" title={s.providerId}>
                  {s.providerId}
                </code>
                {s.holding ? (
                  <span className="text-amber-500">{t('apiService.queue.status.holding')}</span>
                ) : null}
                <span className="tabular-nums text-muted-foreground">
                  {t('apiService.queue.status.waiting', { count: s.waiting })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {concurrency.length > 0 ? (
        <div className="space-y-1">
          <div className="text-xs font-semibold text-muted-foreground">
            {t('apiService.queue.status.concurrency')}
          </div>
          <ul className="space-y-0.5">
            {concurrency.map((c) => (
              <li key={c.apiKeyId} className="flex items-center gap-2 text-xs">
                <code className="min-w-0 flex-1 truncate text-foreground" title={c.apiKeyId}>
                  {c.apiKeyId}
                </code>
                <span className="tabular-nums text-muted-foreground">
                  {t('apiService.queue.status.active', { count: c.active })}
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {t('apiService.queue.status.waiting', { count: c.waiting })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export default QueueStatusView;
