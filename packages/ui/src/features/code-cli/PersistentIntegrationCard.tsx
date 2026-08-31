import { AlertTriangle, FileCog, KeyRound, Loader2, PlugZap, Search, Trash2, Wrench } from 'lucide-react';
import React, { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useTranslation } from '@/shared/state/LocaleContext';

import { integrationStatusPresentation } from './integrationStatusModel';

import type {
  CliIntegrationPlan,
  CliIntegrationPlanResult,
  CliIntegrationStatus,
  MutationResult,
} from '@/daemon/types';

interface PersistentIntegrationCardProps {
  integration: CliIntegrationStatus;
  busy: boolean;
  disabled: boolean;
  onPlan: (configPath?: string) => Promise<CliIntegrationPlanResult>;
  onInstall: (configPath?: string) => Promise<MutationResult>;
  onRepair: () => Promise<MutationResult>;
  onRemove: () => Promise<MutationResult>;
}

const DISPLAY_NAME = { codex: 'Codex', claude: 'Claude Code' } as const;

export function PersistentIntegrationCard({
  integration,
  busy,
  disabled,
  onPlan,
  onInstall,
  onRepair,
  onRemove,
}: PersistentIntegrationCardProps) {
  const t = useTranslation();
  const view = integrationStatusPresentation(integration.status);
  const [configPath, setConfigPath] = useState('');
  const [removeOpen, setRemoveOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [plan, setPlan] = useState<CliIntegrationPlan | null>(null);

  const handlePlan = async () => {
    setPlanning(true);
    try {
      const result = await onPlan(configPath.trim() || undefined);
      if (result.success) {
        setPlan(result.plan);
        setPlanOpen(true);
      }
    } finally {
      setPlanning(false);
    }
  };

  const handleApplyPlan = async () => {
    if (!plan) return;
    if (plan.action === 'none') {
      setPlanOpen(false);
      return;
    }
    const result = plan.action === 'repair'
      ? await onRepair()
      : await onInstall(configPath.trim() || undefined);
    if (result.success) setPlanOpen(false);
  };

  const handleRemove = async () => {
    const result = await onRemove();
    if (result.success) setRemoveOpen(false);
  };

  return (
    <section className="space-y-4 rounded-xl border border-border/70 bg-surface-1/60 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2">
            <PlugZap className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-foreground">{DISPLAY_NAME[integration.client]}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">{t(view.hintKey)}</p>
          </div>
        </div>
        <Badge variant={view.badgeVariant} className="shrink-0">{t(view.labelKey)}</Badge>
      </div>

      {view.needsAttention ? (
        <div className="flex gap-2 rounded-md border border-destructive/35 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {view.protectsUserChanges
              ? t('codeCli.persistent.driftProtection')
              : t('codeCli.persistent.attention')}
          </span>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <FileCog className="h-3.5 w-3.5" />
          {t('codeCli.persistent.configPath')}
        </div>
        <code className="block break-all rounded-md border border-border/50 bg-surface-0/60 px-2.5 py-2 text-xs text-foreground">
          {integration.configPath}
        </code>
      </div>

      {integration.gatewayBaseUrl ? (
        <p className="text-xs text-muted-foreground">
          {t('codeCli.persistent.routesTo', { url: integration.gatewayBaseUrl })}
        </p>
      ) : null}

      {integration.key ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-border/50 bg-surface-0/50 px-2.5 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="truncate text-xs font-medium text-foreground">{integration.key.name}</p>
              <code className="text-[11px] text-muted-foreground">{integration.key.keyPrefix}…</code>
            </div>
          </div>
          <Badge variant={integration.key.ownership === 'selected' ? 'default' : 'outline'}>
            {integration.key.ownership === 'selected'
              ? t('codeCli.persistent.keySelected')
              : t('codeCli.persistent.keyManaged')}
          </Badge>
        </div>
      ) : null}

      {view.canInstall ? (
        <div className="space-y-2 border-t border-border/40 pt-3">
          <label className="text-xs font-medium text-muted-foreground" htmlFor={`config-path-${integration.client}`}>
            {t('codeCli.persistent.customPath')}{' '}
            <span className="font-normal text-muted-foreground/80">({t('common.optional')})</span>
          </label>
          <Input
            id={`config-path-${integration.client}`}
            value={configPath}
            placeholder={integration.configPath}
            onChange={(event) => setConfigPath(event.target.value)}
            autoComplete="off"
          />
          <Button className="w-full" disabled={disabled || planning} onClick={() => void handlePlan()}>
            {planning ? <Loader2 className="animate-spin" /> : <Search />}
            {t('codeCli.persistent.reviewEnable')}
          </Button>
        </div>
      ) : view.canRepair ? (
        <div className="flex flex-wrap justify-end gap-2 border-t border-border/40 pt-3">
          {view.canRemove ? (
            <Button
              variant="outline"
              disabled={disabled}
              onClick={() => setRemoveOpen(true)}
            >
              <Trash2 />
              {t('codeCli.persistent.remove')}
            </Button>
          ) : null}
          <Button disabled={disabled || planning} onClick={() => void handlePlan()}>
            {planning ? <Loader2 className="animate-spin" /> : <Wrench />}
            {t('codeCli.persistent.repair')}
          </Button>
        </div>
      ) : (
        <div className="flex justify-end border-t border-border/40 pt-3">
          <Button
            variant="outline"
            disabled={disabled || !view.canRemove}
            title={!view.canRemove ? t('codeCli.persistent.removeLocked') : undefined}
            onClick={() => setRemoveOpen(true)}
          >
            {busy ? <Loader2 className="animate-spin" /> : <Trash2 />}
            {t('codeCli.persistent.remove')}
          </Button>
        </div>
      )}

      <Dialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('codeCli.persistent.removeTitle', { name: DISPLAY_NAME[integration.client] })}</DialogTitle>
            <DialogDescription>{t('codeCli.persistent.removeDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="secondary" disabled={busy} onClick={() => setRemoveOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void handleRemove()}>
              {busy ? <Loader2 className="animate-spin" /> : <Trash2 />}
              {t('codeCli.persistent.remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={planOpen} onOpenChange={setPlanOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('codeCli.persistent.planTitle')}</DialogTitle>
            <DialogDescription>{t('codeCli.persistent.planDescription')}</DialogDescription>
          </DialogHeader>
          {plan ? (
            <div className="space-y-3 text-xs">
              <div>
                <p className="font-medium text-muted-foreground">{t('codeCli.persistent.configPath')}</p>
                <code className="mt-1 block break-all rounded-md border border-border/50 bg-surface-0/60 px-2.5 py-2 text-foreground">
                  {plan.configPath}
                </code>
              </div>
              <div>
                <p className="font-medium text-muted-foreground">{t('codeCli.persistent.planChanges')}</p>
                {plan.changes.length > 0 ? (
                  <ul className="mt-1 space-y-1 rounded-md border border-border/50 bg-surface-0/60 px-3 py-2">
                    {plan.changes.map((change) => <li key={change}><code>{change}</code></li>)}
                  </ul>
                ) : (
                  <p className="mt-1 text-muted-foreground">{t('codeCli.persistent.noChanges')}</p>
                )}
              </div>
              {plan.warnings.length > 0 ? (
                <div className="rounded-md border border-destructive/35 bg-destructive/10 px-3 py-2 text-destructive">
                  <p className="font-medium">{t('codeCli.persistent.planWarnings')}</p>
                  <ul className="mt-1 list-disc space-y-1 pl-4">
                    {plan.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="secondary" disabled={busy} onClick={() => setPlanOpen(false)}>
              {plan?.action === 'none' ? t('common.close') : t('common.cancel')}
            </Button>
            {plan?.action !== 'none' ? (
              <Button disabled={busy || !plan?.canApply} onClick={() => void handleApplyPlan()}>
                {busy ? <Loader2 className="animate-spin" /> : plan?.action === 'repair' ? <Wrench /> : <PlugZap />}
                {plan?.action === 'repair'
                  ? t('codeCli.persistent.applyRepair')
                  : t('codeCli.persistent.applyEnable')}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
