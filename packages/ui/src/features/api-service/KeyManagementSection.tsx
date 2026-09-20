/**
 * KeyManagementSection.tsx — named outbound-key CRUD: list (keyPrefix only) +
 * create + soft delete (row + spend history kept) + enable/disable.
 *
 * There is exactly ONE delete: the soft one (revoke). Deleted rows keep their
 * place and history forever — no hard delete exists anywhere in the product.
 *
 * SECRET DISCIPLINE: the list rows show ONLY `keyPrefix` (never a full key). The
 * create response's `plaintextOnce` is the FULL client key returned exactly once
 * — it is shown in a dismissible copy-to-clipboard reveal that makes clear it
 * will NOT be shown again, and is never stored or re-fetched (cleared from state
 * on dismiss).
 */

import { ArrowDown, ArrowUp, Settings2, Check, Copy, Eye, KeyRound, Link2, Network, Plus, SlidersHorizontal, Trash2 } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { agent } from '@/shared/agent';
import { useTranslation } from '@/shared/state/LocaleContext';

import type {
  CliIntegrationClient,
  CliIntegrationStatus,
  KeyUpstreamBinding,
  MutationResult,
  OutboundApiKeyCreated,
  OutboundApiKeyInfo,
  OutboundKeyPolicyPatch,
  UpstreamCatalogEntry,
} from '@/daemon/types';

import { KeyPolicyEditor } from './KeyPolicyEditor';
import { UpstreamMappingEditor } from '../upstreams/UpstreamMappingEditor';

interface KeyManagementSectionProps {
  keys: OutboundApiKeyInfo[];
  busy: boolean;
  createdKey: OutboundApiKeyCreated | null;
  onCreate: (name: string) => Promise<boolean>;
  onReveal: (id: string) => Promise<{ success: boolean; key?: string; message?: string }>;
  onRevoke: (id: string) => Promise<void>;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
  onSetMaxConcurrency: (id: string, maxConcurrency: number | null) => Promise<void>;
  onSetPolicy: (id: string, policy: OutboundKeyPolicyPatch) => Promise<void>;
  onDismissCreated: () => void;
  /** UPSTREAM ROUTING MODEL: set (or clear) a key's ordered upstream set. */
  onSetUpstreamBinding?: (id: string, binding: KeyUpstreamBinding | null) => Promise<void>;
  integrations?: CliIntegrationStatus[];
  onBindIntegration?: (client: CliIntegrationClient, keyId: string) => Promise<MutationResult>;
}

const INTEGRATION_CLIENTS: readonly CliIntegrationClient[] = ['codex', 'claude'];

/**
 * Per-key concurrency ceiling input. Empty string OR a non-positive value →
 * `null` (unlimited) — matching the §2 contract where absent/0 = unlimited —
 * following `ProviderForm.tsx`'s `Number.isFinite(parsed) ? parsed : …` idiom
 * (here the clear value is `null` because the key endpoint's clear contract is
 * `null`). A valid positive value is clamped to the endpoint's 1..1000 range
 * locally so an out-of-range entry never round-trips to a daemon 400. Commits on
 * blur / Enter only when the resolved value differs from the stored one.
 */
function KeyConcurrencyInput({
  value,
  busy,
  onCommit,
}: {
  value: number | undefined;
  busy: boolean;
  onCommit: (maxConcurrency: number | null) => void;
}) {
  const t = useTranslation();
  const [draft, setDraft] = useState(value != null ? String(value) : '');

  // Re-seed the draft when the persisted value changes (e.g. after a refresh).
  React.useEffect(() => {
    setDraft(value != null ? String(value) : '');
  }, [value]);

  const commit = () => {
    const trimmed = draft.trim();
    const parsed = parseInt(trimmed, 10);
    // Empty or non-positive → null (unlimited, §2); otherwise clamp to 1..1000.
    const next =
      trimmed !== '' && Number.isFinite(parsed) && parsed > 0
        ? Math.min(1000, Math.max(1, parsed))
        : null;
    // Re-seed the draft to the resolved value so a clamped/cleared entry never
    // lingers in the box on the no-op path (mirrors NumberField).
    setDraft(next != null ? String(next) : '');
    if (next === (value ?? null)) return;
    onCommit(next);
  };

  return (
    <Input
      type="number"
      min={1}
      max={1000}
      density="compact"
      className="w-16 text-center"
      value={draft}
      disabled={busy}
      placeholder={t('apiService.queue.key.placeholder')}
      aria-label={t('apiService.queue.key.label')}
      title={t('apiService.queue.key.label')}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
    />
  );
}

/** The one-time plaintext reveal — shown once, never re-fetchable. */
function CreatedKeyReveal({
  created,
  onDismiss,
}: {
  created: OutboundApiKeyCreated;
  onDismiss: () => void;
}) {
  const t = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(created.plaintextOnce).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="rounded-md border border-primary/50 bg-primary-soft/20 p-3 space-y-2" role="status">
      <div className="text-sm font-medium text-foreground">{t('apiService.keys.created.title')}</div>
      <p className="text-xs text-muted-foreground">{t('apiService.keys.created.warning')}</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-surface-2/70 px-2 py-1.5 text-xs text-foreground">
          {created.plaintextOnce}
        </code>
        <Button variant="outline" size="sm" onClick={copy}>
          {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? t('apiService.keys.created.copied') : t('apiService.keys.created.copy')}
        </Button>
      </div>
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          {t('apiService.keys.created.dismiss')}
        </Button>
      </div>
    </div>
  );
}

/**
 * Inline "view key" reveal — the on-demand decrypted value of an EXISTING key
 * (vs. CreatedKeyReveal, which shows the one-time plaintext of a freshly created
 * key). The value is held only in memory until dismissed; copy reuses the
 * created-key i18n strings for consistency.
 */
function KeyReveal({ value, onDismiss }: { value: string; onDismiss: () => void }) {
  const t = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="mt-2 space-y-1.5 rounded-md border border-primary/50 bg-primary-soft/20 p-2.5" role="status">
      <p className="text-xs text-muted-foreground">{t('apiService.keys.revealHint')}</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-surface-2/70 px-2 py-1 text-xs text-foreground">{value}</code>
        <Button variant="outline" size="sm" onClick={copy}>
          {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? t('apiService.keys.created.copied') : t('apiService.keys.created.copy')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          {t('apiService.keys.created.dismiss')}
        </Button>
      </div>
    </div>
  );
}

export function KeyManagementSection({
  keys,
  busy,
  createdKey,
  onCreate,
  onReveal,
  onRevoke,
  onToggle,
  onSetMaxConcurrency,
  onSetPolicy,
  onDismissCreated,
  onSetUpstreamBinding,
  integrations = [],
  onBindIntegration,
}: KeyManagementSectionProps) {
  const t = useTranslation();
  const [name, setName] = useState('');
  // Soft delete (stops the key; row + history stay) — the only delete there is.
  const [deleteTarget, setDeleteTarget] = useState<OutboundApiKeyInfo | null>(null);
  // UPSTREAM ROUTING MODEL: the editor dialog state + the upstream catalog.
  const [bindingTarget, setBindingTarget] = useState<OutboundApiKeyInfo | null>(null);
  const [catalog, setCatalog] = useState<UpstreamCatalogEntry[]>([]);

  useEffect(() => {
    if (!bindingTarget) return;
    let cancelled = false;
    void (async () => {
      const result = await agent.apiService.listUpstreams();
      if (!cancelled) setCatalog(result.upstreams ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [bindingTarget]);
  // Which key's policy editor is expanded (only one open at a time).
  const [policyOpenId, setPolicyOpenId] = useState<string | null>(null);
  const [integrationTarget, setIntegrationTarget] = useState<{
    client: CliIntegrationClient;
    key: OutboundApiKeyInfo;
  } | null>(null);
  // Inline "view key" reveal — the decrypted value is fetched on demand and held
  // only in memory until dismissed (never stored client-side), mirroring the
  // provider-key reveal. One key revealed at a time.
  const [reveal, setReveal] = useState<
    | { id: string; status: 'loading' | 'ok' | 'error'; value?: string; message?: string }
    | null
  >(null);

  // The list renders LIVE keys only: a soft-deleted (revoked) key stays in the
  // daemon's data for spend history but must not appear in the UI.
  const visibleKeys = useMemo(() => keys.filter((k) => !k.revoked), [keys]);

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const ok = await onCreate(trimmed);
    if (ok) setName('');
  };

  const handleReveal = async (k: OutboundApiKeyInfo) => {
    setReveal({ id: k.id, status: 'loading' });
    const result = await onReveal(k.id);
    if (result.success && result.key) {
      setReveal({ id: k.id, status: 'ok', value: result.key });
    } else {
      setReveal({ id: k.id, status: 'error', message: result.message ?? t('apiService.keys.revealError') });
    }
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-primary" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-foreground">{t('apiService.keys.title')}</h3>
      </div>
      <p className="text-xs text-muted-foreground">{t('apiService.keys.description')}</p>

      {createdKey ? <CreatedKeyReveal created={createdKey} onDismiss={onDismissCreated} /> : null}

      <div className="flex items-center gap-2">
        <Input
          density="compact"
          value={name}
          placeholder={t('apiService.keys.namePlaceholder')}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleCreate();
          }}
        />
        <Button variant="default" size="sm" disabled={busy || !name.trim()} onClick={() => void handleCreate()}>
          <Plus className="h-3.5 w-3.5" />
          {t('apiService.keys.create')}
        </Button>
      </div>

      {/* Soft-deleted keys STAY in the daemon's data (history) but never
          render here — the list shows only live keys. */}
      {visibleKeys.length === 0 ? (
        <p className="rounded-md border border-dashed border-border/60 px-3 py-4 text-center text-xs text-muted-foreground">
          {t('apiService.keys.empty')}
        </p>
      ) : (
        <ul className="space-y-2">
          {visibleKeys.map((k) => {
            const usedClients = integrations
              .filter((integration) => integration.key?.id === k.id)
              .map((integration) => integration.client);
            const integrationEligible = k.enabled && !k.revoked && k.revealable === true;
            return (
            <li
              key={k.id}
              className="rounded-md border border-border/60 bg-surface-0/60 px-3 py-2"
            >
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">{k.name}</span>
                    {k.enabled ? (
                      <Badge variant="success">{t('apiService.keys.enabled')}</Badge>
                    ) : (
                      <Badge variant="secondary">{t('apiService.keys.disabled')}</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <code className="text-xs text-muted-foreground">{k.keyPrefix}…</code>
                    {k.revealable ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        disabled={reveal?.id === k.id && reveal.status === 'loading'}
                        onClick={() => void handleReveal(k)}
                        aria-label={t('apiService.keys.reveal')}
                        title={t('apiService.keys.reveal')}
                      >
                        <Eye className="h-3 w-3" />
                      </Button>
                    ) : null}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {INTEGRATION_CLIENTS.map((client) => {
                      const inUse = usedClients.includes(client);
                      const name = client === 'codex' ? 'Codex' : 'Claude';
                      return (
                        <Button
                          key={client}
                          size="xs"
                          variant={inUse ? 'secondary' : 'outline'}
                          disabled={busy || inUse || !integrationEligible || !onBindIntegration}
                          title={!integrationEligible
                            ? t('apiService.keys.integrations.unavailable')
                            : undefined}
                          onClick={() => setIntegrationTarget({ client, key: k })}
                        >
                          <Link2 className="h-3 w-3" />
                          {inUse
                            ? t('apiService.keys.integrations.inUse')
                            : t('apiService.keys.integrations.useFor', { name })}
                        </Button>
                      );
                    })}
                  </div>
                  {onSetUpstreamBinding ? (
                    <button
                      type="button"
                      className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
                      onClick={() => setBindingTarget(k)}
                      title={t('apiService.keys.upstream.edit')}
                    >
                      <Network className="h-3 w-3 shrink-0" />
                      <span className="truncate">{upstreamBindingSummary(k, t)}</span>
                    </button>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    {t('apiService.queue.key.label')}
                  </span>
                  <KeyConcurrencyInput
                    value={k.maxConcurrency}
                    busy={busy}
                    onCommit={(next) => void onSetMaxConcurrency(k.id, next)}
                  />
                </div>
                <Button
                  variant={policyOpenId === k.id ? 'secondary' : 'ghost'}
                  size="icon"
                  className="h-7 w-7"
                  disabled={busy}
                  onClick={() => setPolicyOpenId((cur) => (cur === k.id ? null : k.id))}
                  aria-label={t('apiService.keys.policy.title')}
                  title={t('apiService.keys.policy.title')}
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                </Button>
                <Switch
                  checked={k.enabled}
                  disabled={busy || usedClients.length > 0}
                  onCheckedChange={(checked) => void onToggle(k.id, checked)}
                  aria-label={t('apiService.keys.toggle')}
                />
                {/* The ONE delete affordance is a SOFT delete: the key stops
                    authenticating immediately; its row and spend history stay
                    in the daemon's data (hidden from this list). */}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  disabled={busy || usedClients.length > 0}
                  onClick={() => setDeleteTarget(k)}
                  aria-label={t('apiService.keys.delete')}
                  title={t('apiService.keys.delete')}
                >
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              </div>
              {policyOpenId === k.id ? (
                <KeyPolicyEditor
                  keyInfo={k}
                  busy={busy}
                  onSave={async (policy) => {
                    await onSetPolicy(k.id, policy);
                  }}
                />
              ) : null}
              {reveal?.id === k.id ? (
                reveal.status === 'ok' && reveal.value ? (
                  <KeyReveal value={reveal.value} onDismiss={() => setReveal(null)} />
                ) : reveal.status === 'error' ? (
                  <p className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                    {reveal.message}
                  </p>
                ) : null
              ) : null}
            </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t('apiService.keys.deleteConfirmTitle')}
        description={
          deleteTarget ? t('apiService.keys.deleteConfirmDesc', { name: deleteTarget.name }) : undefined
        }
        confirmLabel={t('apiService.keys.delete')}
        cancelLabel={t('common.cancel')}
        variant="destructive"
        onConfirm={() => {
          // Soft delete: the revoke endpoint stops the key while the row and
          // its spend history stay on the list.
          if (deleteTarget) void onRevoke(deleteTarget.id);
          setDeleteTarget(null);
        }}
      />

      <ConfirmDialog
        open={integrationTarget !== null}
        onOpenChange={(open) => {
          if (!open) setIntegrationTarget(null);
        }}
        title={integrationTarget
          ? t('apiService.keys.integrations.confirmTitle', {
              name: integrationTarget.client === 'codex' ? 'Codex' : 'Claude',
            })
          : ''}
        description={integrationTarget
          ? t('apiService.keys.integrations.confirmDescription', {
              key: integrationTarget.key.name,
            })
          : undefined}
        confirmLabel={t('apiService.keys.integrations.confirm')}
        cancelLabel={t('common.cancel')}
        variant="default"
        onConfirm={() => {
          if (integrationTarget && onBindIntegration) {
            void onBindIntegration(integrationTarget.client, integrationTarget.key.id);
          }
          setIntegrationTarget(null);
        }}
      />

      <UpstreamBindingDialog
        target={bindingTarget}
        catalog={catalog}
        busy={busy}
        onCatalogRefresh={() => {
          // Keep the dialog's catalog snapshot fresh after a mapping write.
          void agent.apiService
            .listUpstreams()
            .then((result) => setCatalog(result.upstreams ?? []));
        }}
        onClose={() => setBindingTarget(null)}
        onSave={async (binding) => {
          if (bindingTarget && onSetUpstreamBinding) {
            await onSetUpstreamBinding(bindingTarget.id, binding);
          }
          setBindingTarget(null);
        }}
      />
    </section>
  );
}

/** One key's upstream-binding summary line (the row's clickable affordance). */
function upstreamBindingSummary(
  key: OutboundApiKeyInfo,
  t: (k: string, opts?: Record<string, unknown>) => string,
): string {
  const binding = key.upstreamBinding;
  if (!binding) return t('apiService.keys.upstream.summaryLegacy');
  if (binding.mode === 'all') return t('apiService.keys.upstream.summaryAll');
  if (binding.targets.length === 0) return t('apiService.keys.upstream.summaryNone');
  return t('apiService.keys.upstream.summaryExplicit', { count: binding.targets.length });
}

/**
 * The upstream-binding editor: ONE ordered selection list (list order =
 * routing priority; can-serve misses yield to the next entry). There is no
 * separate "all upstreams" mode — a key whose binding says `all` (or a
 * not-yet-migrated legacy key) simply opens with EVERY upstream selected, and
 * saving always writes the explicit selection (all-selected = the default the
 * gateway setting materializes at creation). An EMPTY selection is a valid,
 * deliberate state: the key authenticates but every request is rejected.
 * Each catalog row also opens the per-upstream mapping-table editor (the data
 * lives on the upstream — the entry point merely shares this dialog).
 */
function UpstreamBindingDialog({
  target,
  catalog,
  busy,
  onClose,
  onSave,
  onCatalogRefresh,
}: {
  target: OutboundApiKeyInfo | null;
  catalog: UpstreamCatalogEntry[];
  busy: boolean;
  onClose: () => void;
  onSave: (binding: KeyUpstreamBinding | null) => Promise<void>;
  onCatalogRefresh: () => void;
}) {
  const t = useTranslation();
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [mappingKey, setMappingKey] = useState<string | null>(null);
  // Which key row the current selection was seeded from (an 'all'/legacy row
  // re-seeds once the catalog arrives, since "all" is catalog-dependent).
  const [seededFor, setSeededFor] = useState<string | null>(null);

  useEffect(() => {
    if (!target) {
      setSeededFor(null);
      return;
    }
    const binding = target.upstreamBinding;
    if (seededFor !== target.id) {
      if (binding && binding.mode === 'explicit') {
        setSelected(
          binding.targets.map((entry) =>
            entry.kind === 'provider' ? entry.providerId : `sub:${entry.providerId}`,
          ),
        );
        setSeededFor(target.id);
        return;
      }
      // 'all' or legacy: default-select-everything, applied once the catalog is known.
      if (catalog.length > 0) {
        setSelected(catalog.map((entry) => entry.key));
        setSeededFor(target.id);
      }
      return;
    }
    // Already seeded and the catalog just arrived (or changed): drop any
    // selection whose upstream no longer exists — a provider/pool deleted
    // after the binding was saved, or one the catalog no longer offers
    // (disabled upstreams are unbindable). Saving a stale target would fail
    // the whole write with "unknown upstream".
    if (catalog.length > 0) {
      const catalogKeys = new Set(catalog.map((entry) => entry.key));
      setSelected((current) => current.filter((key) => catalogKeys.has(key)));
    }
  }, [catalog, seededFor, target]);

  const labelOf = (key: string): string =>
    catalog.find((entry) => entry.key === key)?.label ?? key;

  const toggle = (key: string): void => {
    setSelected((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
    );
  };

  const move = (index: number, delta: -1 | 1): void => {
    setSelected((current) => {
      const next = [...current];
      const to = index + delta;
      if (to < 0 || to >= next.length) return current;
      [next[index], next[to]] = [next[to]!, next[index]!];
      return next;
    });
  };

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    try {
      await onSave({
        mode: 'explicit',
        targets: selected.flatMap((key) => {
          const entry = catalog.find((candidate) => candidate.key === key);
          // An upstream that vanished (or became unbindable) mid-edit cannot
          // be part of the saved binding — sending it would 400 the write.
          if (!entry) return [];
          return [{
            kind: entry.target.kind === 'provider' ? ('provider' as const) : ('account-pool' as const),
            providerId: entry.target.providerId,
          }];
        }),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('apiService.keys.upstream.dialogTitle', { name: target?.name ?? '' })}</DialogTitle>
          <DialogDescription>{t('apiService.keys.upstream.dialogDesc')}</DialogDescription>
        </DialogHeader>
        <div className="max-h-64 space-y-1 overflow-y-auto">
          {catalog.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('apiService.keys.upstream.emptyCatalog')}</p>
          ) : null}
          {catalog.map((entry) => {
            const index = selected.indexOf(entry.key);
            const checked = index >= 0;
            return (
              <div
                key={entry.key}
                className="flex items-center gap-2 rounded-md border border-border/50 px-2 py-1.5"
              >
                <Button
                  variant={checked ? 'secondary' : 'ghost'}
                  size="xs"
                  onClick={() => toggle(entry.key)}
                  aria-pressed={checked}
                >
                  {checked ? <Check className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
                  {checked ? `#${index + 1}` : ''}
                </Button>
                <span className="min-w-0 flex-1 truncate text-xs text-foreground">{entry.label}</span>
                <Button
                  variant="ghost" size="icon" className="h-6 w-6 shrink-0"
                  onClick={() => setMappingKey(entry.key)}
                  aria-label={t('apiService.keys.upstream.mappingEdit')}
                  title={t('apiService.keys.upstream.mappingEdit')}
                >
                  <Settings2 className="h-3 w-3" />
                </Button>
                {checked ? (
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button
                      variant="ghost" size="icon" className="h-6 w-6"
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                      aria-label={t('apiService.keys.upstream.orderUp')}
                    >
                      <ArrowUp className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost" size="icon" className="h-6 w-6"
                      disabled={index === selected.length - 1}
                      onClick={() => move(index, 1)}
                      aria-label={t('apiService.keys.upstream.orderDown')}
                    >
                      <ArrowDown className="h-3 w-3" />
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          })}
          <p className="text-[11px] text-muted-foreground">
            {t('apiService.keys.upstream.orderHint')}
          </p>
        </div>
        <UpstreamMappingEditor
          upstreamKey={mappingKey}
          label={mappingKey ? labelOf(mappingKey) : ''}
          onClose={() => setMappingKey(null)}
          onSaved={onCatalogRefresh}
        />
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="secondary" onClick={onClose} disabled={saving || busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="default"
            onClick={() => void handleSave()}
            disabled={saving || busy}
          >
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
