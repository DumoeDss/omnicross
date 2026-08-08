/**
 * KeyManagementSection.tsx — named outbound-key CRUD: list (keyPrefix only) +
 * create + revoke + enable/disable.
 *
 * SECRET DISCIPLINE: the list rows show ONLY `keyPrefix` (never a full key). The
 * create response's `plaintextOnce` is the FULL client key returned exactly once
 * — it is shown in a dismissible copy-to-clipboard reveal that makes clear it
 * will NOT be shown again, and is never stored or re-fetched (cleared from state
 * on dismiss).
 */

import { ArrowRight, Check, Copy, Eye, KeyRound, Link2, Plus, Route, SlidersHorizontal, Trash2 } from 'lucide-react';
import React, { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useTranslation } from '@/shared/state/LocaleContext';

import type {
  OutboundApiKeyCreated,
  OutboundApiKeyInfo,
  OutboundKeyPolicyPatch,
  GatewayBinding,
} from '@/daemon/types';

import {
  bindingAllowsClientKey,
  bindingsForClientKey,
  bindingTargetLabel,
  setBindingForClientKey,
} from './gatewayBindingUiModel';
import { KeyPolicyEditor } from './KeyPolicyEditor';

interface KeyManagementSectionProps {
  keys: OutboundApiKeyInfo[];
  busy: boolean;
  createdKey: OutboundApiKeyCreated | null;
  onCreate: (name: string) => Promise<boolean>;
  onReveal: (id: string) => Promise<{ success: boolean; key?: string; message?: string }>;
  onRevoke: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
  onSetMaxConcurrency: (id: string, maxConcurrency: number | null) => Promise<void>;
  onSetPolicy: (id: string, policy: OutboundKeyPolicyPatch) => Promise<void>;
  onDismissCreated: () => void;
  bindings?: GatewayBinding[];
  onOpenBinding?: (binding: GatewayBinding) => void;
  onChangeBindings?: (bindings: GatewayBinding[]) => Promise<void> | void;
}

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
  onDelete,
  onToggle,
  onSetMaxConcurrency,
  onSetPolicy,
  onDismissCreated,
  bindings = [],
  onOpenBinding,
  onChangeBindings,
}: KeyManagementSectionProps) {
  const t = useTranslation();
  const [name, setName] = useState('');
  const [revokeTarget, setRevokeTarget] = useState<OutboundApiKeyInfo | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<OutboundApiKeyInfo | null>(null);
  // Which key's policy editor is expanded (only one open at a time).
  const [policyOpenId, setPolicyOpenId] = useState<string | null>(null);
  const [bindingOpenId, setBindingOpenId] = useState<string | null>(null);
  // Inline "view key" reveal — the decrypted value is fetched on demand and held
  // only in memory until dismissed (never stored client-side), mirroring the
  // provider-key reveal. One key revealed at a time.
  const [reveal, setReveal] = useState<
    | { id: string; status: 'loading' | 'ok' | 'error'; value?: string; message?: string }
    | null
  >(null);

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

      {keys.length === 0 ? (
        <p className="rounded-md border border-dashed border-border/60 px-3 py-4 text-center text-xs text-muted-foreground">
          {t('apiService.keys.empty')}
        </p>
      ) : (
        <ul className="space-y-2">
          {keys.map((k) => {
            const relatedBindings = bindingsForClientKey(bindings, k.id);
            return (
            <li
              key={k.id}
              className="rounded-md border border-border/60 bg-surface-0/60 px-3 py-2"
            >
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">{k.name}</span>
                    {k.revoked ? (
                      <Badge variant="destructive">{t('apiService.keys.revoked')}</Badge>
                    ) : k.enabled ? (
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
                </div>
                {!k.revoked ? (
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
                ) : null}
                {!k.revoked ? (
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
                ) : null}
                {!k.revoked ? (
                  <Switch
                    checked={k.enabled}
                    disabled={busy}
                    onCheckedChange={(checked) => void onToggle(k.id, checked)}
                    aria-label={t('apiService.keys.toggle')}
                  />
                ) : null}
                {!k.revoked ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    disabled={busy}
                    onClick={() => setRevokeTarget(k)}
                    aria-label={t('apiService.keys.revoke')}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </Button>
                ) : (
                  // A revoked key keeps its row for history; this permanently
                  // removes it (hard delete). Offered ONLY on revoked keys so an
                  // active key must be revoked first (a deliberate two-step).
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    disabled={busy}
                    onClick={() => setDeleteTarget(k)}
                    aria-label={t('apiService.keys.delete')}
                    title={t('apiService.keys.delete')}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </Button>
                )}
              </div>
              {!k.revoked ? (
                <div className="mt-2 border-t border-border/60 pt-2">
                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Route className="h-3 w-3" />
                    {relatedBindings.length
                      ? t('apiService.keys.bindings.count', { count: relatedBindings.length })
                      : t('apiService.keys.bindings.empty')}
                  </div>
                  {relatedBindings.length ? (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {relatedBindings.map((binding) => (
                        <button
                          key={binding.id}
                          type="button"
                          className="inline-flex max-w-full items-center gap-1 rounded-md border border-primary/20 bg-primary/5 px-2 py-1 text-[11px] text-foreground hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() => onOpenBinding?.(binding)}
                          disabled={!onOpenBinding}
                        >
                          <span className="truncate">{binding.name}</span>
                          <ArrowRight className="h-3 w-3 shrink-0 text-primary" />
                          <span className="truncate">{bindingTargetLabel(binding)}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {bindings.length && onChangeBindings ? (
                    <div className="mt-2">
                      <Button
                        size="xs"
                        variant={bindingOpenId === k.id ? 'secondary' : 'ghost'}
                        onClick={() => setBindingOpenId((current) => current === k.id ? null : k.id)}
                      >
                        <Link2 className="h-3 w-3" />
                        {t('apiService.keys.bindings.manage')}
                      </Button>
                      {bindingOpenId === k.id ? (
                        <div className="mt-2 space-y-1 rounded-md border border-border/70 bg-surface-1/45 p-2">
                          {bindings.map((binding) => (
                            <label key={binding.id} className="flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-surface-2/60">
                              <input
                                type="checkbox"
                                checked={bindingAllowsClientKey(binding, k.id)}
                                disabled={busy}
                                onChange={(event) => void onChangeBindings(setBindingForClientKey(
                                  bindings,
                                  keys.map((key) => key.id),
                                  k.id,
                                  binding.id,
                                  event.target.checked,
                                ))}
                              />
                              <span className="min-w-0 flex-1 truncate text-foreground">{binding.name}</span>
                              <Badge variant={binding.enabled ? 'outline' : 'secondary'}>
                                {t(`apiService.endpoint.name.${binding.endpoint}`)}
                              </Badge>
                            </label>
                          ))}
                          <p className="px-2 pt-1 text-[10px] text-muted-foreground">
                            {t('apiService.keys.bindings.manageHint')}
                          </p>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {!k.revoked && policyOpenId === k.id ? (
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
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        title={t('apiService.keys.revokeConfirmTitle')}
        description={
          revokeTarget ? t('apiService.keys.revokeConfirmDesc', { name: revokeTarget.name }) : undefined
        }
        confirmLabel={t('apiService.keys.revoke')}
        cancelLabel={t('common.cancel')}
        variant="destructive"
        onConfirm={() => {
          if (revokeTarget) void onRevoke(revokeTarget.id);
          setRevokeTarget(null);
        }}
      />

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
          if (deleteTarget) void onDelete(deleteTarget.id);
          setDeleteTarget(null);
        }}
      />
    </section>
  );
}
