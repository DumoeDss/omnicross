import { ArrowDownAZ, ArrowUpAZ, ChevronRight, Search, Trash2, UsersRound } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Select, type SelectOption } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useTranslation } from '@/shared/state/LocaleContext';
import { cn } from '@/shared/utils/utils';
import {
  selectedAccountFromRoute,
  type AccountDetailTabId,
  type AppRoute,
  type RouteNavigate,
} from '@/shared/state/hashRoute';

import { AccountDetailsDrawer } from './AccountDetailsDrawer';
import {
  accountSchedulingState,
  DEFAULT_ACCOUNT_FILTERS,
  filterAndSortAccounts,
  flattenAccounts,
  summarizeAccounts,
  type AccountFilters,
  type ManagedAccountRow,
} from './accountManagementModel';

import type { useAccounts } from './hooks/useAccounts';
import type { AccountBatchInput, SubscriptionProviderId } from '@/daemon/types';

interface AccountManagementWorkspaceProps {
  accountsApi: ReturnType<typeof useAccounts>;
  route: AppRoute;
  onNavigate: RouteNavigate;
}

const rowKey = (row: Pick<ManagedAccountRow, 'providerId' | 'id'>) => `${row.providerId}\0${row.id}`;

export function AccountManagementWorkspace({ accountsApi, route, onNavigate }: AccountManagementWorkspaceProps) {
  const t = useTranslation();
  const filters = useMemo<AccountFilters>(
    () => ({ ...DEFAULT_ACCOUNT_FILTERS, ...route.accountFilters }),
    [route.accountFilters],
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchGroup, setBatchGroup] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);

  const rows = useMemo(
    () => flattenAccounts(accountsApi.data, accountsApi.allowances),
    [accountsApi.allowances, accountsApi.data],
  );
  const visible = useMemo(() => filterAndSortAccounts(rows, filters), [filters, rows]);
  const summary = useMemo(() => summarizeAccounts(rows), [rows]);
  const selectedRouteAccount = selectedAccountFromRoute(route);
  const details = selectedRouteAccount
    ? rows.find((row) => row.providerId === selectedRouteAccount.providerId && row.id === selectedRouteAccount.accountId) ?? null
    : null;
  const groups = useMemo(() => [...new Set(rows.map((row) => row.group))].sort(), [rows]);

  const navigateAccounts = (
    selection?: { providerId: ManagedAccountRow['providerId']; accountId: string },
    accountTab?: AccountDetailTabId,
    options?: Parameters<RouteNavigate>[1],
  ) => {
    const next: AppRoute = { page: 'upstreams', upstreamFilter: 'account', accountFilters: filters };
    if (selection) {
      next.accountProvider = selection.providerId;
      next.accountId = selection.accountId;
      next.accountTab = accountTab;
    }
    onNavigate(next, options);
  };

  const patchFilters = (patch: Partial<AccountFilters>) => {
    const nextFilters = { ...filters, ...patch };
    onNavigate({
      page: 'upstreams',
      upstreamFilter: 'account',
      accountProvider: route.accountProvider,
      accountId: route.accountId,
      accountTab: route.accountTab,
      accountFilters: nextFilters,
    }, { replace: true });
  };

  const closeDetails = () => navigateAccounts();
  const openDetails = (row: ManagedAccountRow) => navigateAccounts({ providerId: row.providerId, accountId: row.id }, 'overview');
  const changeDetailsTab = (tab: AccountDetailTabId) => {
    if (selectedRouteAccount) navigateAccounts(selectedRouteAccount, tab);
  };

  useEffect(() => {
    const requestedGroup = route.accountFilters?.group;
    if (accountsApi.loading || !requestedGroup || requestedGroup === 'all' || groups.includes(requestedGroup)) return;
    patchFilters({ group: 'all' });
  // Dynamic group values are validated against the loaded account set.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountsApi.loading, groups, route.accountFilters?.group]);

  const selectedRows = rows.filter((row) => selected.has(rowKey(row)));
  const allVisibleSelected = visible.length > 0 && visible.every((row) => selected.has(rowKey(row)));

  const toggleRow = (key: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const runBatch = async (input: AccountBatchInput) => {
    const result = await accountsApi.batchManage(input);
    if (result.success) setSelected(new Set());
  };

  const refs = selectedRows.map((row) => ({ providerId: row.providerId, accountId: row.id }));

  return (
    <div className="space-y-4">
      <section className="grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-4">
        <SummaryCell label={t('accounts.management.summary.total')} value={summary.total} />
        <SummaryCell label={t('accounts.management.summary.schedulable')} value={summary.schedulable} tone="good" />
        <SummaryCell label={t('accounts.management.summary.excluded')} value={summary.excluded} tone="muted" />
        <SummaryCell label={t('accounts.management.summary.warnings')} value={summary.warnings} tone={summary.warnings ? 'warn' : 'muted'} />
      </section>

      <section className="rounded-xl border border-border bg-surface-1/50 p-3">
        <div className="flex flex-col gap-2 xl:flex-row xl:items-center">
          <div className="relative min-w-56 flex-1">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input className="pl-9" value={filters.query} onChange={(event) => patchFilters({ query: event.target.value })} placeholder={t('accounts.management.searchPlaceholder')} />
          </div>
          <div className="flex flex-wrap gap-2">
            <FilterSelect value={filters.provider} onChange={(provider) => patchFilters({ provider: provider as AccountFilters['provider'] })} options={providerOptions(t)} />
            <FilterSelect value={filters.group} onChange={(group) => patchFilters({ group })} options={[{ value: 'all', label: t('accounts.management.filters.allGroups') }, ...groups.map((group) => ({ value: group, label: group }))]} />
            <FilterSelect value={filters.health} onChange={(health) => patchFilters({ health: health as AccountFilters['health'] })} options={healthOptions(t)} />
            <FilterSelect value={filters.credential} onChange={(credential) => patchFilters({ credential: credential as AccountFilters['credential'] })} options={credentialOptions(t)} />
            <FilterSelect value={filters.scheduling} onChange={(scheduling) => patchFilters({ scheduling: scheduling as AccountFilters['scheduling'] })} options={schedulingOptions(t)} />
            <FilterSelect value={filters.sort} onChange={(sort) => patchFilters({ sort: sort as AccountFilters['sort'] })} options={sortOptions(t)} />
            <Button size="icon" variant="outline" onClick={() => patchFilters({ direction: filters.direction === 'asc' ? 'desc' : 'asc' })} aria-label={t('accounts.management.sortDirection')}>
              {filters.direction === 'asc' ? <ArrowDownAZ className="h-4 w-4" /> : <ArrowUpAZ className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </section>

      {selectedRows.length ? (
        <section className="flex flex-wrap items-center gap-2 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2">
          <span className="mr-auto text-sm font-medium">{t('accounts.management.selected', { count: selectedRows.length })}</span>
          <Button size="sm" variant="outline" disabled={accountsApi.busy} onClick={() => void runBatch({ action: 'enable', accounts: refs })}>{t('accounts.management.batch.enable')}</Button>
          <Button size="sm" variant="outline" disabled={accountsApi.busy} onClick={() => void runBatch({ action: 'disable', accounts: refs })}>{t('accounts.management.batch.disable')}</Button>
          <Input className="h-8 w-36" value={batchGroup} onChange={(event) => setBatchGroup(event.target.value)} placeholder={t('accounts.management.batch.groupPlaceholder')} />
          <Button size="sm" variant="outline" disabled={accountsApi.busy} onClick={() => void runBatch({ action: 'set-group', accounts: refs, group: batchGroup.trim() || null })}>{t('accounts.management.batch.setGroup')}</Button>
          <Button size="sm" variant="destructive" disabled={accountsApi.busy} onClick={() => setDeleteOpen(true)}><Trash2 className="mr-1.5 h-3.5 w-3.5" />{t('accounts.management.batch.delete')}</Button>
        </section>
      ) : null}

      <section className="overflow-hidden rounded-xl border border-border bg-surface-1/40">
        {visible.length ? (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full min-w-[880px] text-left text-sm">
                <thead className="border-b border-border bg-surface-2/60 text-xs text-muted-foreground">
                  <tr>
                    <th className="w-12 px-4 py-3"><input type="checkbox" checked={allVisibleSelected} onChange={() => setSelected(allVisibleSelected ? new Set() : new Set(visible.map(rowKey)))} aria-label={t('accounts.management.selectAll')} /></th>
                    <th className="px-3 py-3">{t('accounts.management.columns.account')}</th>
                    <th className="px-3 py-3">{t('accounts.management.columns.providerGroup')}</th>
                    <th className="px-3 py-3">{t('accounts.management.columns.status')}</th>
                    <th className="px-3 py-3">{t('accounts.management.columns.priority')}</th>
                    <th className="px-3 py-3">{t('accounts.management.columns.lastUsed')}</th>
                    <th className="w-36 px-3 py-3">{t('accounts.management.columns.actions')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/70">
                  {visible.map((row) => <AccountTableRow key={rowKey(row)} row={row} selected={selected.has(rowKey(row))} busy={accountsApi.busy} onSelect={() => toggleRow(rowKey(row))} onToggle={(enabled) => void accountsApi.patchAccount(row.providerId, row.id, { enabled })} onDetails={() => openDetails(row)} />)}
                </tbody>
              </table>
            </div>
            <div className="divide-y divide-border md:hidden">
              {visible.map((row) => <AccountMobileCard key={rowKey(row)} row={row} selected={selected.has(rowKey(row))} busy={accountsApi.busy} onSelect={() => toggleRow(rowKey(row))} onToggle={(enabled) => void accountsApi.patchAccount(row.providerId, row.id, { enabled })} onDetails={() => openDetails(row)} />)}
            </div>
          </>
        ) : (
          <div className="px-6 py-14 text-center"><UsersRound className="mx-auto h-8 w-8 text-muted-foreground" /><p className="mt-3 text-sm text-muted-foreground">{t('accounts.management.emptyFiltered')}</p></div>
        )}
      </section>

      <AccountDetailsDrawer
        account={details}
        busy={accountsApi.busy}
        activeTab={route.accountTab ?? 'overview'}
        onOpenChange={(open) => { if (!open) closeDetails(); }}
        onTabChange={changeDetailsTab}
        onPatch={(patch) => details ? accountsApi.patchAccount(details.providerId, details.id, patch) : Promise.resolve({ success: false, message: 'account is no longer available' })}
        onSetProxy={(proxy) => details ? accountsApi.setAccountProxy(details.providerId, details.id, proxy) : Promise.resolve({ success: false, message: 'account is no longer available' })}
        onSetSupportedModels={(models) => details ? accountsApi.setAccountSupportedModels(details.providerId, details.id, models) : Promise.resolve({ success: false, message: 'account is no longer available' })}
        onTest={() => details ? accountsApi.testAccount(details.providerId, details.id) : Promise.resolve({ success: false, message: 'account is no longer available' })}
        onLoadEvents={() => details ? accountsApi.listAccountEvents(details.providerId, details.id) : Promise.resolve({ success: false, events: [], message: 'account is no longer available' })}
        onRefreshAllowance={details?.providerId === 'claude' ? () => accountsApi.refreshAccountAllowance(details.id) : undefined}
        onRemove={() => {
          if (!details) return;
          closeDetails();
          void accountsApi.removeAccount(details.providerId, details.id);
        }}
      />

      <ConfirmDialog open={deleteOpen} onOpenChange={setDeleteOpen} title={t('accounts.management.batch.deleteTitle')} description={t('accounts.management.batch.deleteDescription', { count: selectedRows.length })} confirmLabel={t('accounts.management.batch.delete')} cancelLabel={t('common.cancel')} variant="destructive" onConfirm={() => void runBatch({ action: 'delete', accounts: refs })} />
    </div>
  );
}

function AccountTableRow({ row, selected, busy, onSelect, onToggle, onDetails }: RowProps) {
  const t = useTranslation();
  return <tr className={cn('transition-colors hover:bg-surface-2/40', selected && 'bg-primary/5')}>
    <td className="px-4 py-3"><input type="checkbox" checked={selected} onChange={onSelect} aria-label={t('accounts.management.selectAccount', { name: row.label || row.id })} /></td>
    <td className="max-w-64 px-3 py-3"><div className="truncate font-medium">{row.label || row.id}</div><div className="truncate font-mono text-[11px] text-muted-foreground">{row.id}</div>{row.tags.length ? <div className="mt-1 flex flex-wrap gap-1">{row.tags.slice(0, 3).map((tag) => <Badge key={tag} variant="outline">{tag}</Badge>)}</div> : null}</td>
    <td className="px-3 py-3"><div>{t(`accounts.provider.${row.providerId}.title`)}</div><div className="text-xs text-muted-foreground">{row.group}</div></td>
    <td className="px-3 py-3"><SchedulingStatus row={row} /></td>
    <td className="px-3 py-3 tabular-nums"><PriorityValue row={row} /></td>
    <td className="px-3 py-3 text-xs text-muted-foreground">{row.lastUsedAt ? new Date(row.lastUsedAt).toLocaleString() : t('accounts.detail.neverUsed')}</td>
    <td className="px-3 py-3"><div className="flex items-center justify-end gap-2"><Switch checked={row.enabled} disabled={busy} onCheckedChange={onToggle} /><Button size="icon" variant="ghost" onClick={onDetails} aria-label={t('accounts.management.openDetails')}><ChevronRight className="h-4 w-4" /></Button></div></td>
  </tr>;
}

function AccountMobileCard({ row, selected, busy, onSelect, onToggle, onDetails }: RowProps) {
  const t = useTranslation();
  return <article className={cn('space-y-3 p-4', selected && 'bg-primary/5')}><div className="flex items-start gap-3"><input className="mt-1" type="checkbox" checked={selected} onChange={onSelect} /><button type="button" className="min-w-0 flex-1 text-left" onClick={onDetails}><p className="truncate font-medium">{row.label || row.id}</p><p className="mt-0.5 text-xs text-muted-foreground">{t(`accounts.provider.${row.providerId}.title`)} · {row.group}</p></button><Switch checked={row.enabled} disabled={busy} onCheckedChange={onToggle} /></div><div className="flex items-center justify-between"><SchedulingStatus row={row} /><div className="text-xs text-muted-foreground"><PriorityValue row={row} /></div></div></article>;
}

interface RowProps { row: ManagedAccountRow; selected: boolean; busy: boolean; onSelect: () => void; onToggle: (enabled: boolean) => void; onDetails: () => void }

function SchedulingStatus({ row }: { row: ManagedAccountRow }) {
  const t = useTranslation();
  const state = accountSchedulingState(row);
  const variant = state === 'schedulable' ? 'success' : state === 'demoted' ? 'default' : state === 'disabled' ? 'secondary' : 'destructive';
  return <div className="space-y-1"><Badge variant={variant}>{t(`accounts.management.schedulingState.${state}`)}</Badge><div className="text-xs text-muted-foreground">{t(`accounts.status.${row.status}`)} · {t(`accounts.health.${row.health ?? 'healthy'}`)}</div>{row.allowanceAction ? <div className="text-xs text-muted-foreground">{row.allowanceUsedPercent === undefined ? t('accounts.management.allowanceDecisionNoUsage', { action: t(`accounts.management.allowanceAction.${row.allowanceAction}`) }) : t('accounts.management.allowanceDecision', { action: t(`accounts.management.allowanceAction.${row.allowanceAction}`), used: row.allowanceUsedPercent })}</div> : null}</div>;
}

function PriorityValue({ row }: { row: ManagedAccountRow }) {
  const t = useTranslation();
  const base = row.priority ?? 50;
  const effective = row.allowanceEffectivePriority ?? base;
  if (effective === base) return <>{effective}</>;
  return <div><div>{effective}</div><div className="text-[11px] text-muted-foreground">{t('accounts.management.effectivePriority', { base, effective })}</div></div>;
}

function SummaryCell({ label, value, tone = 'muted' }: { label: string; value: number; tone?: 'good' | 'warn' | 'muted' }) {
  return <div className="bg-surface-1 px-4 py-3"><p className="text-xs text-muted-foreground">{label}</p><p className={cn('mt-1 text-2xl font-semibold tabular-nums', tone === 'good' && 'text-emerald-600', tone === 'warn' && 'text-amber-600')}>{value}</p></div>;
}

function FilterSelect({ value, onChange, options }: { value: string; onChange: (value: string) => void; options: SelectOption[] }) {
  return <Select size="sm" value={value} onChange={onChange} options={options} />;
}

type Translate = ReturnType<typeof useTranslation>;
const providerOptions = (t: Translate): SelectOption[] => [{ value: 'all', label: t('accounts.management.filters.allProviders') }, ...(['claude', 'codex', 'gemini', 'opencodego'] as SubscriptionProviderId[]).map((id) => ({ value: id, label: t(`accounts.provider.${id}.title`) }))];
const healthOptions = (t: Translate): SelectOption[] => [{ value: 'all', label: t('accounts.management.filters.allHealth') }, ...['healthy', 'rate_limited', 'overloaded', 'transient', 'blocked'].map((id) => ({ value: id, label: t(`accounts.health.${id}`) }))];
const credentialOptions = (t: Translate): SelectOption[] => [{ value: 'all', label: t('accounts.management.filters.allCredentials') }, ...['authorized', 'configured', 'expired', 'error', 'unconfigured'].map((id) => ({ value: id, label: t(`accounts.status.${id}`) }))];
const schedulingOptions = (t: Translate): SelectOption[] => ['all', 'enabled', 'disabled', 'schedulable', 'excluded'].map((id) => ({ value: id, label: t(`accounts.management.filters.scheduling.${id}`) }));
const sortOptions = (t: Translate): SelectOption[] => ['label', 'priority', 'last-used', 'allowance', 'reset-time'].map((id) => ({ value: id, label: t(`accounts.management.sort.${id}`) }));
