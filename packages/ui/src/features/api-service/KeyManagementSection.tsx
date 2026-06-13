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

import { Check, Copy, KeyRound, Plus, Trash2 } from 'lucide-react';
import React, { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useTranslation } from '@/shared/state/LocaleContext';

import type { OutboundApiKeyCreated, OutboundApiKeyInfo } from '@/daemon/types';

interface KeyManagementSectionProps {
  keys: OutboundApiKeyInfo[];
  busy: boolean;
  createdKey: OutboundApiKeyCreated | null;
  onCreate: (name: string) => Promise<boolean>;
  onRevoke: (id: string) => Promise<void>;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
  onDismissCreated: () => void;
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

export function KeyManagementSection({
  keys,
  busy,
  createdKey,
  onCreate,
  onRevoke,
  onToggle,
  onDismissCreated,
}: KeyManagementSectionProps) {
  const t = useTranslation();
  const [name, setName] = useState('');
  const [revokeTarget, setRevokeTarget] = useState<OutboundApiKeyInfo | null>(null);

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const ok = await onCreate(trimmed);
    if (ok) setName('');
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
          {keys.map((k) => (
            <li
              key={k.id}
              className="flex items-center gap-3 rounded-md border border-border/60 bg-surface-0/60 px-3 py-2"
            >
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
                <code className="text-xs text-muted-foreground">{k.keyPrefix}…</code>
              </div>
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
              ) : null}
            </li>
          ))}
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
    </section>
  );
}
