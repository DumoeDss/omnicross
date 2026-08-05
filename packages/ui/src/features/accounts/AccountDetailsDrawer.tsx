import { Activity, AlertTriangle, Gauge, Network, Route, Settings2, ShieldAlert, Trash2 } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ProxyEditor, seedFromSanitized } from '@/components/ProxyEditor';
import { Switch } from '@/components/ui/switch';
import { useTranslation } from '@/shared/state/LocaleContext';
import { cn } from '@/shared/utils/utils';
import type { AccountDetailTabId } from '@/shared/state/hashRoute';

import { AccountAllowance } from './AccountAllowance';
import { SupportedModelsEditor } from './SupportedModelsEditor';

import type {
  AccountManagementPatch,
  AccountProbeRecord,
  ProxyConfig,
} from '@/daemon/types';
import { accountSchedulingState, type ManagedAccountRow } from './accountManagementModel';

type DrawerTab = AccountDetailTabId;

interface AccountDetailsDrawerProps {
  account: ManagedAccountRow | null;
  busy: boolean;
  activeTab: DrawerTab;
  onOpenChange: (open: boolean) => void;
  onTabChange: (tab: DrawerTab) => void;
  onPatch: (patch: AccountManagementPatch) => Promise<{ success: boolean; message?: string }>;
  onSetProxy: (proxy: ProxyConfig | undefined) => Promise<{ success: boolean; message?: string }>;
  onSetSupportedModels: (
    supportedModels: string[] | Record<string, string> | undefined,
  ) => Promise<{ success: boolean; message?: string }>;
  onTest: () => Promise<{ success: boolean; ok?: boolean; message?: string }>;
  onLoadEvents: () => Promise<{ success: boolean; events: AccountProbeRecord[]; message?: string }>;
  onRefreshAllowance?: () => Promise<{ success: boolean; message?: string }>;
  routePanel?: React.ReactNode;
  onRemove: () => void;
}

const TAB_ICONS = {
  overview: Activity,
  routes: Route,
  allowance: Gauge,
  scheduling: Settings2,
  network: Network,
  diagnostics: AlertTriangle,
  danger: ShieldAlert,
} as const;

export function AccountDetailsDrawer({
  account,
  busy,
  activeTab,
  onOpenChange,
  onTabChange,
  onPatch,
  onSetProxy,
  onSetSupportedModels,
  onTest,
  onLoadEvents,
  onRefreshAllowance,
  routePanel,
  onRemove,
}: AccountDetailsDrawerProps) {
  const t = useTranslation();
  const tab = activeTab;
  const [label, setLabel] = useState('');
  const [group, setGroup] = useState('');
  const [tags, setTags] = useState('');
  const [priority, setPriority] = useState('50');
  const [events, setEvents] = useState<AccountProbeRecord[]>([]);
  const [diagnostic, setDiagnostic] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);

  useEffect(() => {
    if (!account) return;
    setLabel(account.label ?? '');
    setGroup(account.group ?? account.providerId);
    setTags(account.tags.join(', '));
    setPriority(String(account.priority ?? 50));
    setEvents([]);
    setDiagnostic(null);
  }, [account]);

  useEffect(() => {
    if (!account || tab !== 'diagnostics') return;
    void onLoadEvents().then((result) => {
      if (result.success) setEvents(result.events);
      else setDiagnostic({ kind: 'error', text: result.message ?? t('accounts.management.diagnostics.loadFailed') });
    });
  // `onLoadEvents` is scoped to the selected row by the parent. Account identity
  // + tab are the actual reload boundary; event state updates must not re-fetch.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.providerId, account?.id, tab]);

  if (!account) return null;

  const saveOverview = () => onPatch({
    label: label.trim(),
    group: group.trim() || null,
    tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
  });

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

  const tabs = (Object.keys(TAB_ICONS) as DrawerTab[]).map((id) => ({ id, Icon: TAB_ICONS[id] }));

  return (
    <>
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent
          className="h-screen max-h-screen w-[min(94vw,42rem)] max-w-none overflow-hidden rounded-none p-0 sm:rounded-none"
          style={{ left: 'auto', right: 0, top: 0, transform: 'none' }}
        >
          <DialogHeader className="border-b border-border px-6 py-5 pr-12">
            <DialogTitle>{account.label || account.id}</DialogTitle>
            <DialogDescription className="font-mono text-xs">
              {account.providerId} · {account.id}
            </DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
            <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-surface-1/60 p-2 sm:w-40 sm:flex-col sm:border-b-0 sm:border-r">
              {tabs.map(({ id, Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => onTabChange(id)}
                  aria-current={tab === id ? 'page' : undefined}
                  className={cn(
                    'flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                    tab === id ? 'bg-primary/12 text-primary' : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground',
                    id === 'danger' && 'sm:mt-auto',
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {t(`accounts.management.tabs.${id}`)}
                </button>
              ))}
            </nav>

            <div className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-6">
              {tab === 'overview' ? (
                <div className="space-y-5">
                  <div className="flex items-center justify-between rounded-lg border border-border bg-surface-1/50 p-4">
                    <div>
                      <p className="text-sm font-medium">{t('accounts.management.fields.enabled')}</p>
                      <p className="text-xs text-muted-foreground">{t('accounts.management.fields.enabledHint')}</p>
                    </div>
                    <Switch checked={account.enabled} disabled={busy} onCheckedChange={(enabled) => void onPatch({ enabled })} />
                  </div>
                  <Field label={t('accounts.management.fields.label')} value={label} onChange={setLabel} />
                  <Field label={t('accounts.management.fields.group')} value={group} onChange={setGroup} />
                  <Field label={t('accounts.management.fields.tags')} value={tags} onChange={setTags} placeholder={t('accounts.management.fields.tagsPlaceholder')} />
                  <Button disabled={busy} onClick={() => void saveOverview()}>{t('common.save')}</Button>
                  <dl className="grid gap-3 rounded-lg border border-border p-4 text-sm sm:grid-cols-2">
                    <Info label={t('accounts.management.fields.credential')} value={t(`accounts.status.${account.status}`)} />
                    <Info label={t('accounts.management.fields.health')} value={t(`accounts.health.${account.health ?? 'healthy'}`)} />
                    <Info label={t('accounts.management.fields.scheduling')} value={t(`accounts.management.schedulingState.${accountSchedulingState(account)}`)} />
                    {account.allowanceAction ? <Info label={t('accounts.management.fields.allowanceAction')} value={t(`accounts.management.allowanceAction.${account.allowanceAction}`)} /> : null}
                    {account.allowanceEffectivePriority !== undefined ? <Info label={t('accounts.management.fields.effectivePriority')} value={String(account.allowanceEffectivePriority)} /> : null}
                    {account.allowanceUsedPercent !== undefined ? <Info label={t('accounts.management.fields.allowanceUsed')} value={`${account.allowanceUsedPercent}%`} /> : null}
                    {account.allowanceResumeAt ? <Info label={t('accounts.management.fields.allowanceResume')} value={new Date(account.allowanceResumeAt).toLocaleString()} /> : null}
                    <Info label={t('accounts.management.fields.lastUsed')} value={account.lastUsedAt ? new Date(account.lastUsedAt).toLocaleString() : t('accounts.detail.neverUsed')} />
                  </dl>
                </div>
              ) : null}

              {tab === 'allowance' ? (
                <AccountAllowance
                  providerId={account.providerId}
                  snapshot={account.allowance}
                  loading={false}
                  onRefresh={account.providerId === 'claude' ? onRefreshAllowance : undefined}
                />
              ) : null}

              {tab === 'routes' ? (
                routePanel ?? (
                  <p className="rounded-lg border border-dashed border-border/70 px-4 py-8 text-center text-sm text-muted-foreground">
                    {t('upstreams.routes.openFromUpstreams')}
                  </p>
                )
              ) : null}

              {tab === 'scheduling' ? (
                <div className="space-y-5">
                  <Field label={t('accounts.management.fields.priority')} value={priority} onChange={setPriority} type="number" />
                  <Button
                    disabled={busy || !Number.isFinite(Number(priority))}
                    onClick={() => void onPatch({ priority: Number(priority) })}
                  >
                    {t('common.save')}
                  </Button>
                  <SupportedModelsEditor
                    value={account.supportedModels}
                    busy={busy}
                    onSave={(value) => void onSetSupportedModels(value)}
                    onClear={() => void onSetSupportedModels(undefined)}
                  />
                </div>
              ) : null}

              {tab === 'network' ? (
                <ProxyEditor
                  label={t('accounts.detail.proxyLabel')}
                  description={t('accounts.detail.proxyHint')}
                  seed={seedFromSanitized(account.proxy)}
                  busy={busy}
                  onSave={(proxy) => void onSetProxy(proxy)}
                  onClear={() => void onSetProxy(undefined)}
                />
              ) : null}

              {tab === 'diagnostics' ? (
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
              ) : null}

              {tab === 'danger' ? (
                <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-5">
                  <h3 className="font-medium text-destructive">{t('accounts.management.danger.title')}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{t('accounts.management.danger.description')}</p>
                  <Button className="mt-4" variant="destructive" onClick={() => setRemoveOpen(true)}>
                    <Trash2 className="mr-2 h-4 w-4" />
                    {t('accounts.list.remove')}
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={t('accounts.list.removeConfirmTitle')}
        description={t('accounts.list.removeConfirmDesc', { name: account.label || account.id })}
        confirmLabel={t('accounts.list.remove')}
        cancelLabel={t('common.cancel')}
        variant="destructive"
        onConfirm={onRemove}
      />
    </>
  );
}

function Field({ label, value, onChange, placeholder, type = 'text' }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; type?: string }) {
  return <label className="block space-y-1.5 text-sm"><span className="font-medium">{label}</span><Input type={type} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} /></label>;
}

function Info({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-0.5 truncate text-foreground">{value}</dd></div>;
}

function Notice({ text }: { text: string }) {
  return <p className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{text}</p>;
}
