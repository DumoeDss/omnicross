/**
 * AccountList.tsx — one provider's sanitized multi-account list.
 *
 * Each row shows label + status badge + an active marker, and expands to a
 * read-only detail grid (auth method / subscription level / expiry / last
 * refreshed) plus an inline label-rename field. Daemon-backed actions: set-active,
 * remove (per-row, behind a confirm), rename (label-only), and — on the active
 * account when its token is expired — refresh.
 *
 * Maps 1:1 to the sanitized `providerAccounts[providerId]` array — NEVER a raw
 * token (the daemon's sanitized view omits all token material).
 */

import { AlertTriangle, Check, ChevronDown, ChevronRight, RefreshCw, Save, Trash2 } from 'lucide-react';
import React, { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { ProxyEditor, seedFromSanitized } from '@/components/ProxyEditor';
import { useTranslation } from '@/shared/state/LocaleContext';
import { cn } from '@/shared/utils/utils';

import { StatusBadge } from './StatusBadge';

import type { ProxyConfig, RefreshResult, SubscriptionAccountSanitized } from '@/daemon/types';

interface AccountListProps {
  accounts: SubscriptionAccountSanitized[];
  busy: boolean;
  onSetActive: (id: string) => void;
  onRemove: (id: string) => void;
  /** Rename one account's label. */
  onRename?: (id: string, label: string) => Promise<{ success: boolean; message?: string }>;
  /** Set one account's scheduling priority (subscription-account-scheduling). */
  onSetPriority?: (id: string, priority: number) => Promise<{ success: boolean; message?: string }>;
  /** Set (or clear) one account's per-account proxy override (upstream-proxy). */
  onSetProxy?: (
    id: string,
    proxy: ProxyConfig | undefined,
  ) => Promise<{ success: boolean; message?: string }>;
  /** Refresh the ACTIVE account's OAuth token (shown on the active+expired row). */
  onRefreshActive?: () => Promise<RefreshResult>;
}

/** Default precedence shown for an account with no explicit priority. */
const DEFAULT_PRIORITY = 50;

/** A single read-only detail line in the expanded row. */
function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate text-foreground">{value}</span>
    </div>
  );
}

/** Expired = explicitly flagged, or past its expiry timestamp. */
function isExpired(acc: SubscriptionAccountSanitized): boolean {
  if (acc.status === 'expired') return true;
  return acc.expiresAt ? new Date(acc.expiresAt).getTime() < Date.now() : false;
}

export function AccountList({
  accounts,
  busy,
  onSetActive,
  onRemove,
  onRename,
  onSetPriority,
  onSetProxy,
  onRefreshActive,
}: AccountListProps) {
  const t = useTranslation();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<SubscriptionAccountSanitized | null>(null);
  const [draftLabels, setDraftLabels] = useState<Record<string, string>>({});
  const [draftPriorities, setDraftPriorities] = useState<Record<string, string>>({});
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);

  if (accounts.length === 0) return null;

  const handleRename = async (acc: SubscriptionAccountSanitized) => {
    if (!onRename) return;
    const next = (draftLabels[acc.id] ?? acc.label ?? '').trim();
    if (next === (acc.label ?? '').trim()) return;
    setRowBusyId(acc.id);
    setNotice(null);
    try {
      const result = await onRename(acc.id, next);
      if (!result.success) {
        setNotice({ kind: 'error', text: result.message ?? t('accounts.rename.failed') });
      }
    } finally {
      setRowBusyId(null);
    }
  };

  const handleSetPriority = async (acc: SubscriptionAccountSanitized) => {
    if (!onSetPriority) return;
    const current = acc.priority ?? DEFAULT_PRIORITY;
    const raw = draftPriorities[acc.id];
    const next = raw === undefined || raw === '' ? current : Number(raw);
    if (!Number.isFinite(next) || next === current) return;
    setRowBusyId(acc.id);
    setNotice(null);
    try {
      const result = await onSetPriority(acc.id, next);
      if (!result.success) {
        setNotice({ kind: 'error', text: result.message ?? t('accounts.priority.failed') });
      }
    } finally {
      setRowBusyId(null);
    }
  };

  const handleRefresh = async (acc: SubscriptionAccountSanitized) => {
    if (!onRefreshActive) return;
    setRowBusyId(acc.id);
    setNotice(null);
    try {
      const result = await onRefreshActive();
      if (!result.ok) {
        setNotice({ kind: 'error', text: result.message ?? t('accounts.refresh.failed') });
      }
    } finally {
      setRowBusyId(null);
    }
  };

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium text-foreground">{t('accounts.list.title')}</div>
      <ul className="space-y-2">
        {accounts.map((acc) => {
          const isExpanded = expandedId === acc.id;
          const displayLabel = (acc.label ?? '').trim() || acc.id;
          const draftLabel = draftLabels[acc.id] ?? acc.label ?? '';
          const expiresAt = acc.expiresAt ? new Date(acc.expiresAt) : null;
          const lastRefreshedAt = acc.lastRefreshedAt ? new Date(acc.lastRefreshedAt) : null;
          const lastUsedAt = acc.lastUsedAt ? new Date(acc.lastUsedAt) : null;
          const draftPriority = draftPriorities[acc.id] ?? String(acc.priority ?? DEFAULT_PRIORITY);
          const rowBusy = rowBusyId === acc.id;
          const showRefresh = Boolean(onRefreshActive && acc.isActive && isExpired(acc));
          return (
            <li
              key={acc.id}
              className={cn(
                'rounded-md border px-3 py-2',
                acc.isActive
                  ? 'border-primary/40 bg-surface-2/60'
                  : 'border-border/50 bg-surface-1/50',
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() => setExpandedId(isExpanded ? null : acc.id)}
                  aria-expanded={isExpanded}
                >
                  {isExpanded ? (
                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {displayLabel}
                  </span>
                  <StatusBadge status={acc.status} />
                  {acc.isActive ? (
                    <span className="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-xs text-primary">
                      {t('accounts.list.active')}
                    </span>
                  ) : null}
                  {acc.health && acc.health !== 'healthy' ? (
                    <span
                      className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-600 dark:text-amber-500"
                      title={
                        acc.cooldownUntil
                          ? t('accounts.health.until', { time: new Date(acc.cooldownUntil).toLocaleString() })
                          : undefined
                      }
                    >
                      {t(`accounts.health.${acc.health}`)}
                    </span>
                  ) : null}
                </button>
                <div className="flex shrink-0 items-center gap-2">
                  {showRefresh ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || rowBusy}
                      onClick={() => void handleRefresh(acc)}
                      title={t('accounts.actions.refresh')}
                    >
                      <RefreshCw className={cn('mr-1 h-3.5 w-3.5', rowBusy && 'animate-spin')} />
                      {t('accounts.actions.refresh')}
                    </Button>
                  ) : null}
                  {!acc.isActive ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || rowBusy}
                      onClick={() => onSetActive(acc.id)}
                    >
                      <Check className="mr-1 h-3.5 w-3.5" />
                      {t('accounts.list.setActive')}
                    </Button>
                  ) : null}
                  <Button
                    size="icon"
                    variant="outline"
                    className="h-7 w-7 text-destructive hover:text-destructive"
                    disabled={busy || rowBusy}
                    onClick={() => setRemoveTarget(acc)}
                    aria-label={t('accounts.list.remove')}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              {acc.syncWarning ? (
                <p className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-500">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{t(`accounts.syncWarning.${acc.syncWarning}`)}</span>
                </p>
              ) : null}

              {isExpanded ? (
                <div className="mt-2 space-y-2 border-t border-border/40 pt-2">
                  {onRename ? (
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">
                        {t('accounts.detail.label')}
                      </label>
                      <div className="flex items-center gap-2">
                        <Input
                          density="compact"
                          value={draftLabel}
                          placeholder={t('accounts.detail.labelPlaceholder')}
                          onChange={(e) =>
                            setDraftLabels((prev) => ({ ...prev, [acc.id]: e.target.value }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              void handleRename(acc);
                            }
                          }}
                          disabled={rowBusy}
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={rowBusy || draftLabel.trim() === (acc.label ?? '').trim()}
                          onClick={() => void handleRename(acc)}
                          aria-label={t('accounts.detail.saveLabel')}
                        >
                          <Save className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  ) : null}
                  {onSetPriority ? (
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">
                        {t('accounts.detail.priority')}
                      </label>
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          density="compact"
                          className="w-24"
                          value={draftPriority}
                          onChange={(e) =>
                            setDraftPriorities((prev) => ({ ...prev, [acc.id]: e.target.value }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              void handleSetPriority(acc);
                            }
                          }}
                          disabled={rowBusy}
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={rowBusy || draftPriority === String(acc.priority ?? DEFAULT_PRIORITY)}
                          onClick={() => void handleSetPriority(acc)}
                          aria-label={t('accounts.detail.savePriority')}
                        >
                          <Save className="h-3.5 w-3.5" />
                        </Button>
                        <span className="text-xs text-muted-foreground">
                          {t('accounts.detail.priorityHint')}
                        </span>
                      </div>
                    </div>
                  ) : null}
                  {onSetProxy ? (
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">
                        {t('accounts.detail.proxy')}
                      </label>
                      <ProxyEditor
                        label={t('accounts.detail.proxyLabel')}
                        description={t('accounts.detail.proxyHint')}
                        seed={seedFromSanitized(acc.proxy)}
                        busy={rowBusy}
                        onSave={(proxy) => void onSetProxy(acc.id, proxy)}
                        onClear={() => void onSetProxy(acc.id, undefined)}
                      />
                    </div>
                  ) : null}
                  <div className="grid gap-1 text-xs sm:grid-cols-2">
                    {acc.authMethod ? (
                      <DetailRow
                        label={t('accounts.detail.authMethod')}
                        value={t(`accounts.authMethod.${acc.authMethod}`)}
                      />
                    ) : null}
                    {acc.subscriptionLevel ? (
                      <DetailRow
                        label={t('accounts.detail.subscriptionLevel')}
                        value={acc.subscriptionLevel}
                      />
                    ) : null}
                    {expiresAt ? (
                      <DetailRow
                        label={t('accounts.detail.expiresAt')}
                        value={expiresAt.toLocaleString()}
                      />
                    ) : null}
                    {lastRefreshedAt ? (
                      <DetailRow
                        label={t('accounts.detail.lastRefreshed')}
                        value={lastRefreshedAt.toLocaleString()}
                      />
                    ) : null}
                    <DetailRow
                      label={t('accounts.detail.lastUsed')}
                      value={lastUsedAt ? lastUsedAt.toLocaleString() : t('accounts.detail.neverUsed')}
                    />
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {notice ? (
        <p className={cn('text-xs', notice.kind === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
          {notice.text}
        </p>
      ) : null}

      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
        title={t('accounts.list.removeConfirmTitle')}
        description={
          removeTarget
            ? t('accounts.list.removeConfirmDesc', { name: removeTarget.label || removeTarget.id })
            : undefined
        }
        confirmLabel={t('accounts.list.remove')}
        cancelLabel={t('common.cancel')}
        variant="destructive"
        onConfirm={() => {
          if (removeTarget) onRemove(removeTarget.id);
          setRemoveTarget(null);
        }}
      />
    </div>
  );
}
