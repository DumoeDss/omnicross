import { Activity, ArrowRight } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useTranslation } from '@/shared/state/LocaleContext';

import type { OutboundQueueStatus } from '@/daemon/types';

interface QueueStatusSummaryProps {
  queueStatus: OutboundQueueStatus | undefined;
  running: boolean;
  onOpenLiveTraffic: () => void;
}

export function QueueStatusSummary({ queueStatus, running, onOpenLiveTraffic }: QueueStatusSummaryProps) {
  const t = useTranslation();
  const active = (queueStatus?.serial.filter((entry) => entry.holding).length ?? 0) +
    (queueStatus?.concurrency.reduce((total, entry) => total + entry.active, 0) ?? 0);
  const waiting = (queueStatus?.serial.reduce((total, entry) => total + entry.waiting, 0) ?? 0) +
    (queueStatus?.concurrency.reduce((total, entry) => total + entry.waiting, 0) ?? 0);
  const hasActivity = active > 0 || waiting > 0;

  return (
    <section className="rounded-md border border-border/60 bg-surface-0/60 p-3" role="status">
      <div className="flex flex-wrap items-center gap-3">
        <Activity className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium text-foreground">{t('apiService.status.queue.title')}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {!running || !queueStatus
              ? t('apiService.liveTraffic.queueUnavailable')
              : hasActivity
                ? t('apiService.status.queue.summary', { active, waiting })
                : t('apiService.liveTraffic.queueIdle')}
          </p>
        </div>
        <Button variant="ghost" size="sm" className="shrink-0" onClick={onOpenLiveTraffic}>
          {t('apiService.status.queue.open')}
          <ArrowRight aria-hidden="true" />
        </Button>
      </div>
    </section>
  );
}
