import { Activity, AlertTriangle, ChevronDown, Trash2, UserRound } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import { ProxyEditor, seedFromSanitized } from '@/components/ProxyEditor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { AccountAllowance } from '@/features/accounts/AccountAllowance';
import { SupportedModelsEditor } from '@/features/accounts/SupportedModelsEditor';
import { accountSchedulingState, type ManagedAccountRow } from '@/features/accounts/accountManagementModel';
import type { AccountManagementPatch, AccountProbeRecord, ProxyConfig } from '@/daemon/types';
import { useTranslation } from '@/shared/state/LocaleContext';
import { cn } from '@/shared/utils/utils';

export interface AccountResourceDetailsProps {
  account: ManagedAccountRow;
  busy: boolean;
  onPatch: (patch: AccountManagementPatch) => Promise<{ success: boolean; message?: string }>;
  onSetProxy: (proxy: ProxyConfig | undefined) => Promise<{ success: boolean; message?: string }>;
  onSetSupportedModels: (
    supportedModels: string[] | Record<string, string> | undefined,
  ) => Promise<{ success: boolean; message?: string }>;
  onTest: () => Promise<{ success: boolean; ok?: boolean; message?: string }>;
  onLoadEvents: () => Promise<{ success: boolean; events: AccountProbeRecord[]; message?: string }>;
  onRefreshAllowance?: () => Promise<{ success: boolean; message?: string }>;
  onRemove: () => void;
}

export function AccountResourceDetails({
  account,
  busy,
  onPatch,
  onSetProxy,
  onSetSupportedModels,
  onTest,
  onLoadEvents,
  onRefreshAllowance,
  onRemove,
}: AccountResourceDetailsProps) {
  const t = useTranslation();
  const [label, setLabel] = useState('');
  const [group, setGroup] = useState('');
  const [tags, setTags] = useState('');
  const [priority, setPriority] = useState('50');
  const [events, setEvents] = useState<AccountProbeRecord[]>([]);
  const [diagnostic, setDiagnostic] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  // Low-frequency sections — each independently collapsed, hidden until needed.
  const [proxyOpen, setProxyOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [dangerOpen, setDangerOpen] = useState(false);

  useEffect(() => {
    setLabel(account.label ?? '');
    setGroup(account.group ?? account.providerId);
    setTags(account.tags.join(', '));
    setPriority(String(account.priority ?? 50));
    setEvents([]);
    setDiagnostic(null);
  }, [account]);

  const saveOverview = () => {
    const patch: AccountManagementPatch = {
      label: label.trim(),
      group: group.trim() || null,
      tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
    };
    if (Number.isFinite(Number(priority))) patch.priority = Number(priority);
    void onPatch(patch);
  };

  const runTest = async () => {
    setTesting(true);
    setDiagnostic(null);
    const result = await onTest();
    setDiagnostic(result.success && result.ok
      ? { kind: 'ok', text: t('accounts.management.diagnostics.testPassed') }
      : { kind: 'error', text: result.message ?? t('accounts.management.diagnostics.testFailed') });
    const refreshed = await onLoadEvents();
    if (refreshed.success) setEvents(refreshed.events);
    setTesting(false);
  };

  return (
    <>
      {/* Header + enable switch (the one high-frequency toggle that must be inline) */}
      <section className="rounded-xl border border-border/70 bg-surface-1/50 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <UserRound className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold">{account.label || account.id}</h2>
              <Badge variant={account.schedulable ? 'success' : 'secondary'}>{t(`accounts.management.schedulingState.${accountSchedulingState(account)}`)}</Badge>
            </div>
            <p className="mt-1 font-mono text-xs text-muted-foreground">{account.providerId} · {account.id}</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <p className="text-sm font-medium">{t('accounts.management.fields.enabled')}</p>
              <p className="text-xs text-muted-foreground">{t('accounts.management.fields.enabledHint')}</p>
            </div>
            <Switch checked={account.enabled} disabled={busy} onCheckedChange={(enabled) => void onPatch({ enabled })} />
          </div>
        </div>

        {/* Basic editable fields — one save commits the whole block */}
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <FormField label={t('accounts.management.fields.label')}>
            <Input value={label} onChange={(event) => setLabel(event.target.value)} />
          </FormField>
          <FormField label={t('accounts.management.fields.group')}>
            <Input value={group} onChange={(event) => setGroup(event.target.value)} />
          </FormField>
          <FormField label={t('accounts.management.fields.tags')} description={t('accounts.management.fields.tagsPlaceholder')}>
            <Input value={tags} onChange={(event) => setTags(event.target.value)} placeholder={t('accounts.management.fields.tagsPlaceholder')} />
          </FormField>
          <FormField label={t('accounts.management.fields.priority')} description={t('accounts.management.fields.priorityHint')}>
            <Input type="number" value={priority} onChange={(event) => setPriority(event.target.value)} />
          </FormField>
        </div>
        <Button className="mt-3" disabled={busy} onClick={saveOverview}>{t('common.save')}</Button>

        {/* Read-only status grid */}
        <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-4">
          <Info label={t('accounts.management.fields.credential')} value={t(`accounts.status.${account.status}`)} />
          <Info label={t('accounts.management.fields.health')} value={t(`accounts.health.${account.health ?? 'healthy'}`)} />
          <Info label={t('accounts.management.fields.scheduling')} value={t(`accounts.management.schedulingState.${accountSchedulingState(account)}`)} />
          {account.allowanceAction ? <Info label={t('accounts.management.fields.allowanceAction')} value={t(`accounts.management.allowanceAction.${account.allowanceAction}`)} /> : null}
          {account.allowanceEffectivePriority !== undefined ? <Info label={t('accounts.management.fields.effectivePriority')} value={String(account.allowanceEffectivePriority)} /> : null}
          {account.allowanceUsedPercent !== undefined ? <Info label={t('accounts.management.fields.allowanceUsed')} value={`${account.allowanceUsedPercent}%`} /> : null}
          {account.allowanceResumeAt ? <Info label={t('accounts.management.fields.allowanceResume')} value={new Date(account.allowanceResumeAt).toLocaleString()} /> : null}
          <Info label={t('accounts.management.fields.lastUsed')} value={account.lastUsedAt ? new Date(account.lastUsedAt).toLocaleString() : t('accounts.detail.neverUsed')} />
        </dl>
      </section>

      {/* Allowance */}
      <section className="rounded-xl border border-border/70 bg-surface-1/50 p-4 md:p-5">
        <AccountAllowance providerId={account.providerId} snapshot={account.allowance} loading={false} onRefresh={onRefreshAllowance} />
      </section>

      {/* Low-frequency advanced controls — collapsed by default */}
      <CollapsibleSection open={proxyOpen} onToggle={() => setProxyOpen((v) => !v)} title={t('accounts.management.tabs.network')}>
        <ProxyEditor
          label={t('accounts.detail.proxyLabel')}
          description={t('accounts.detail.proxyHint')}
          seed={seedFromSanitized(account.proxy)}
          busy={busy}
          onSave={(proxy) => void onSetProxy(proxy)}
          onClear={() => void onSetProxy(undefined)}
        />
      </CollapsibleSection>

      <CollapsibleSection open={modelsOpen} onToggle={() => setModelsOpen((v) => !v)} title={t('accounts.detail.supportedModels')}>
        <SupportedModelsEditor
          value={account.supportedModels}
          busy={busy}
          onSave={(value) => void onSetSupportedModels(value)}
          onClear={() => void onSetSupportedModels(undefined)}
        />
      </CollapsibleSection>

      <CollapsibleSection open={diagnosticsOpen} onToggle={() => setDiagnosticsOpen((v) => !v)} title={t('accounts.management.tabs.diagnostics')}>
        <div className="space-y-4">
          {account.syncWarning ? <Notice text={t(`accounts.syncWarning.${account.syncWarning}`)} /> : null}
          {account.errorMessage ? <Notice text={account.errorMessage} /> : null}
          <Button variant="outline" disabled={testing} onClick={() => void runTest()}>
            <Activity className={cn('mr-2 h-4 w-4', testing && 'animate-pulse')} />
            {t('accounts.management.diagnostics.testConnection')}
          </Button>
          {diagnostic ? (
            <p className={cn('rounded-md px-3 py-2 text-sm', diagnostic.kind === 'ok' ? 'bg-emerald-500/10 text-emerald-600' : 'bg-destructive/10 text-destructive')}>{diagnostic.text}</p>
          ) : null}
          <div className="space-y-2">
            <h3 className="text-sm font-medium">{t('accounts.management.diagnostics.history')}</h3>
            {events.length ? events.slice().reverse().map((event) => (
              <div key={`${event.ts}:${event.tier}`} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-xs">
                <span>{new Date(event.ts).toLocaleString()}</span>
                <span className={event.ok ? 'text-emerald-600' : 'text-destructive'}>{event.ok ? 'OK' : event.status ?? 'network'}</span>
                <span className="text-muted-foreground">{event.tier}{event.latencyMs !== undefined ? ` · ${event.latencyMs}ms` : ''}</span>
              </div>
            )) : <p className="text-sm text-muted-foreground">{t('accounts.management.diagnostics.empty')}</p>}
          </div>
        </div>
      </CollapsibleSection>

      <CollapsibleSection tone="danger" open={dangerOpen} onToggle={() => setDangerOpen((v) => !v)} title={t('accounts.management.danger.title')} description={t('accounts.management.danger.description')}>
        <Button variant="destructive" onClick={() => setRemoveOpen(true)}>
          <Trash2 className="mr-2 h-4 w-4" />
          {t('accounts.list.remove')}
        </Button>
      </CollapsibleSection>

      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={t('accounts.list.removeConfirmTitle')}
        description={t('accounts.list.removeConfirmDesc', { name: account.label || account.id })}
        confirmLabel={t('accounts.list.remove')}
        cancelLabel={t('common.cancel')}
        variant="destructive"
        onConfirm={() => { setRemoveOpen(false); onRemove(); }}
      />
    </>
  );
}

function CollapsibleSection({
  open,
  onToggle,
  title,
  description,
  tone,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  title: string;
  description?: string;
  tone?: 'danger';
  children: React.ReactNode;
}) {
  return (
    <section className={cn('rounded-xl border bg-surface-1/50 p-4 md:p-5', tone === 'danger' ? 'border-destructive/40' : 'border-border/70')}>
      <button
        type="button"
        className="flex w-full items-center justify-between text-left"
        onClick={onToggle}
        aria-expanded={open}
      >
        <div>
          <h3 className={cn('text-sm font-semibold', tone === 'danger' && 'text-destructive')}>{title}</h3>
          {description ? <p className="mt-1 text-xs text-muted-foreground">{description}</p> : null}
        </div>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      {open ? <div className="mt-3 space-y-3 border-t border-border/40 pt-3">{children}</div> : null}
    </section>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-0.5 truncate text-foreground">{value}</dd></div>;
}

function Notice({ text }: { text: string }) {
  return (
    <p className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      {text}
    </p>
  );
}
