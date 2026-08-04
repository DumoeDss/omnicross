import { AlertTriangle, ArrowDown, Clock3, PauseCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingRow } from '@/components/ui/setting-row';
import { Switch } from '@/components/ui/switch';
import type { AccountAllowanceSchedulingStatus, AllowanceSchedulingConfig } from '@/daemon/types-server';
import { useTranslation } from '@/shared/state/LocaleContext';

import { DEFAULT_ALLOWANCE_SCHEDULING, recentAppliedDecisions, validateAllowanceScheduling } from './allowanceSchedulingLogic';

interface AllowanceSchedulingSectionProps {
  config?: AllowanceSchedulingConfig;
  busy: boolean;
  onUpdate: (config: AllowanceSchedulingConfig) => Promise<void>;
  onLoadStatus: () => Promise<AccountAllowanceSchedulingStatus | null>;
}

export function AllowanceSchedulingSection({ config, busy, onUpdate, onLoadStatus }: AllowanceSchedulingSectionProps) {
  const t = useTranslation();
  const [draft, setDraft] = useState<AllowanceSchedulingConfig>(config ?? DEFAULT_ALLOWANCE_SCHEDULING);
  const [status, setStatus] = useState<AccountAllowanceSchedulingStatus | null | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  const validation = validateAllowanceScheduling(draft);
  const decisions = useMemo(() => recentAppliedDecisions(status?.history ?? []), [status]);

  useEffect(() => setDraft(config ?? DEFAULT_ALLOWANCE_SCHEDULING), [config]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try { setStatus(await onLoadStatus()); }
    finally { setRefreshing(false); }
  }, [onLoadStatus]);

  useEffect(() => { void refresh(); }, [refresh]);

  const save = useCallback(async () => {
    await onUpdate(draft);
    await refresh();
  }, [draft, onUpdate, refresh]);

  const numberField = (field: 'demoteAtPercent' | 'pauseAtPercent' | 'priorityPenalty', min: number, max: number) => (
    <Input
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      step={1}
      value={draft[field]}
      disabled={busy}
      className="w-24 font-mono tabular-nums"
      onChange={(event) => setDraft((current) => ({ ...current, [field]: Number(event.target.value) }))}
    />
  );

  return (
    <div className="space-y-5">
      <section className="space-y-3 rounded-xl border border-border/70 bg-surface-1/60 p-4 md:p-5">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft/30">
            <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground">{t('settings.allowanceScheduling.title')}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{t('settings.allowanceScheduling.description')}</p>
          </div>
        </div>

        <div className="flex items-start gap-2 rounded-lg border border-success/30 bg-success/10 px-3 py-2.5 text-xs text-foreground">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
          <span>{t('settings.allowanceScheduling.safety')}</span>
        </div>

        <SettingRow label={t('settings.allowanceScheduling.enable.label')} description={t('settings.allowanceScheduling.enable.description')}>
          <Switch checked={draft.enabled} disabled={busy} aria-label={t('settings.allowanceScheduling.enable.label')} onCheckedChange={(enabled) => setDraft((current) => ({ ...current, enabled }))} />
        </SettingRow>
        <SettingRow label={t('settings.allowanceScheduling.demote.label')} description={t('settings.allowanceScheduling.demote.description')}>
          {numberField('demoteAtPercent', 0, 100)}
        </SettingRow>
        <SettingRow label={t('settings.allowanceScheduling.pause.label')} description={t('settings.allowanceScheduling.pause.description')}>
          {numberField('pauseAtPercent', 0, 100)}
        </SettingRow>
        <SettingRow label={t('settings.allowanceScheduling.penalty.label')} description={t('settings.allowanceScheduling.penalty.description')}>
          {numberField('priorityPenalty', 1, 1_000)}
        </SettingRow>

        {validation ? (
          <p className="flex items-center gap-2 text-xs text-destructive" role="alert">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
            {t(`settings.allowanceScheduling.validation.${validation}`)}
          </p>
        ) : null}
        <div className="flex justify-end">
          <Button disabled={busy || validation !== null} onClick={() => void save()}>{t('settings.allowanceScheduling.save')}</Button>
        </div>
      </section>

      <section className="rounded-xl border border-border/70 bg-surface-1/60 p-4 md:p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">{t('settings.allowanceScheduling.history.title')}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{t('settings.allowanceScheduling.history.description')}</p>
          </div>
          <Button variant="ghost" size="sm" disabled={refreshing} onClick={() => void refresh()}>
            <RefreshCw className={refreshing ? 'animate-spin' : ''} aria-hidden="true" />
            {t('settings.allowanceScheduling.history.refresh')}
          </Button>
        </div>

        <div className="mt-4">
          {status === undefined ? <p className="text-xs text-muted-foreground">{t('common.loading')}</p> : null}
          {status === null ? (
            <div className="rounded-lg border border-border/70 bg-surface-0/60 px-3 py-3 text-xs text-muted-foreground">{t('settings.allowanceScheduling.history.unavailable')}</div>
          ) : null}
          {status && decisions.length === 0 ? (
            <div className="rounded-lg border border-border/70 bg-surface-0/60 px-3 py-3 text-xs text-muted-foreground">{t('settings.allowanceScheduling.history.empty')}</div>
          ) : null}
          {status && decisions.length > 0 ? (
            <div className="divide-y divide-border/60 border-y border-border/60">
              {decisions.map((decision, index) => (
                <div key={`${decision.providerId}:${decision.accountId}:${decision.decidedAt}:${index}`} className="grid gap-2 py-3 text-xs md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={decision.action === 'pause' ? 'destructive' : 'outline'} className={decision.action === 'demote' ? 'border-warning/60 bg-warning/10 text-warning' : undefined}>
                        {decision.action === 'pause' ? <PauseCircle className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
                        {t(`settings.allowanceScheduling.history.action.${decision.action}`)}
                      </Badge>
                      <span className="font-mono text-foreground">{decision.providerId}</span>
                      <span className="truncate font-mono text-muted-foreground" title={decision.accountId}>{decision.accountId}</span>
                    </div>
                    <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                      {t('settings.allowanceScheduling.history.priority', { base: decision.basePriority, effective: decision.effectivePriority, used: decision.usedPercent ?? '—' })}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground md:justify-end">
                    <Clock3 className="h-3 w-3" aria-hidden="true" />
                    <time dateTime={decision.decidedAt}>{new Date(decision.decidedAt).toLocaleString()}</time>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
