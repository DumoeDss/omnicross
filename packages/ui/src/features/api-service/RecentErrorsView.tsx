import { AlertTriangle, RefreshCw } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import type { AuditRecord } from '@/daemon/types';
import { useTranslation } from '@/shared/state/LocaleContext';

interface RecentErrorsViewProps {
  active: boolean;
  auditEnabled: boolean;
  onQuery: (query: { limit?: number }) => Promise<AuditRecord[]>;
}

function isError(record: AuditRecord): boolean {
  return record.status >= 400 || Boolean(record.error);
}

export function RecentErrorsView({ active, auditEnabled, onQuery }: RecentErrorsViewProps) {
  const t = useTranslation();
  const [records, setRecords] = useState<AuditRecord[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const recent = await onQuery({ limit: 25 });
      setRecords(recent.filter(isError).slice(0, 5));
    } catch {
      setRecords(null);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [onQuery]);

  useEffect(() => {
    if (!active || !auditEnabled) {
      setRecords(null);
      setError(false);
      return;
    }
    void refresh();
  }, [active, auditEnabled, refresh]);

  return (
    <section className="space-y-3 rounded-md border border-border/60 bg-surface-0/60 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{t('apiService.liveTraffic.errors.title')}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{t('apiService.liveTraffic.errors.description')}</p>
        </div>
        {auditEnabled ? (
          <Button variant="ghost" size="sm" disabled={loading} onClick={() => void refresh()}>
            <RefreshCw className={loading ? 'animate-spin' : ''} aria-hidden="true" />
            {t('apiService.liveTraffic.errors.refresh')}
          </Button>
        ) : null}
      </div>

      {!auditEnabled ? (
        <p className="rounded-md border border-dashed border-border/60 px-3 py-3 text-xs text-muted-foreground">
          {t('apiService.liveTraffic.errors.auditOff')}
        </p>
      ) : loading && records === null ? (
        <p className="text-xs text-muted-foreground" role="status">
          {t('apiService.liveTraffic.errors.loading')}
        </p>
      ) : error ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-3 text-xs text-destructive" role="alert">
          <span>{t('apiService.liveTraffic.errors.loadError')}</span>
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            {t('apiService.liveTraffic.errors.retry')}
          </Button>
        </div>
      ) : records && records.length === 0 ? (
        <p className="flex items-center gap-2 rounded-md border border-success/30 bg-success/10 px-3 py-3 text-xs text-foreground">
          <AlertTriangle className="h-3.5 w-3.5 text-success" aria-hidden="true" />
          {t('apiService.liveTraffic.errors.empty')}
        </p>
      ) : records ? (
        <ul className="divide-y divide-border/60 border-y border-border/60">
          {records.map((record) => (
            <li key={record.id} className="grid gap-1 py-3 text-xs sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-start sm:gap-3">
              <span className="font-mono tabular-nums text-destructive">{record.status}</span>
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="font-mono text-foreground">{record.method}</span>
                  <code className="min-w-0 truncate text-muted-foreground" title={record.path}>{record.path}</code>
                </div>
                {record.error ? <p className="mt-1 truncate text-muted-foreground" title={record.error}>{record.error}</p> : null}
              </div>
              <time className="font-mono text-[11px] text-muted-foreground sm:text-right" dateTime={new Date(record.ts).toISOString()}>
                {new Date(record.ts).toLocaleTimeString()}
              </time>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
