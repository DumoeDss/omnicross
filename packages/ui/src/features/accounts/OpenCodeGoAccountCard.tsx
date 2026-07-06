/**
 * OpenCodeGoAccountCard.tsx — the OpenCodeGo (static-bearer) provider card.
 *
 * OpenCodeGo uses a static API key (no OAuth), so the add path is a FORM (required
 * apiKey + optional baseUrl / zenBaseUrl) rather than a sign-in button. The
 * sanitized multi-account `AccountList` handles set-active / remove. The API key
 * flows IN only — the write response is status-only.
 *
 * No account-label input — the daemon's write path does not accept a
 * client-supplied label.
 */

import { KeyRound, Plus } from 'lucide-react';
import React, { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RevealableInput } from '@/components/ui/revealable-input';
import { useTranslation } from '@/shared/state/LocaleContext';

import { AccountList } from './AccountList';
import { StatusBadge } from './StatusBadge';

import type { useAccounts } from './hooks/useAccounts';
import type {
  SubscriptionAccountSanitized,
  SubscriptionListEntry,
  TokenStatus,
} from '@/daemon/types';

interface OpenCodeGoAccountCardProps {
  entry: SubscriptionListEntry;
  accounts: SubscriptionAccountSanitized[];
  accountsApi: ReturnType<typeof useAccounts>;
}

function headerStatus(
  entry: SubscriptionListEntry,
  accounts: SubscriptionAccountSanitized[],
): TokenStatus {
  const active = accounts.find((a) => a.isActive) ?? accounts[0];
  if (active) return active.status;
  return entry.credentialStatus.ok ? 'configured' : 'unconfigured';
}

export function OpenCodeGoAccountCard({ entry, accounts, accountsApi }: OpenCodeGoAccountCardProps) {
  const t = useTranslation();
  const { busy, appendTokens, setActive, removeAccount, renameAccount, setAccountPriority, setAccountProxy } =
    accountsApi;

  const [formOpen, setFormOpen] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [accountLabel, setAccountLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [zenBaseUrl, setZenBaseUrl] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const status = headerStatus(entry, accounts);

  const resetForm = () => {
    setApiKey('');
    setAccountLabel('');
    setBaseUrl('');
    setZenBaseUrl('');
    setFormError(null);
  };

  const handleAdd = async () => {
    if (apiKey.trim().length === 0) {
      setFormError(t('accounts.openCodeGo.apiKeyRequired'));
      return;
    }
    setFormError(null);
    const result = await appendTokens(
      {
        providerId: 'opencodego',
        input: {
          authMethod: 'manual',
          status: 'configured',
          apiKey: apiKey.trim(),
          baseUrl: baseUrl.trim() || undefined,
          zenBaseUrl: zenBaseUrl.trim() || undefined,
        },
      },
      accountLabel.trim() || undefined,
    );
    if (result.success) {
      resetForm();
      setFormOpen(false);
    } else {
      setFormError(result.message ?? t('accounts.errors.requestFailed'));
    }
  };

  return (
    <div className="space-y-4 rounded-lg border border-border bg-surface-1/50 p-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-2">
            <KeyRound className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <h3 className="font-medium text-foreground">{t('accounts.provider.opencodego.title')}</h3>
            <p className="text-sm text-muted-foreground">
              {t('accounts.provider.opencodego.description')}
            </p>
          </div>
        </div>
        <StatusBadge status={status} />
      </div>

      {/* Multi-account list (no refresh — OpenCodeGo is a static key) */}
      <AccountList
        accounts={accounts}
        busy={busy}
        onSetActive={(id) => void setActive('opencodego', id)}
        onRemove={(id) => void removeAccount('opencodego', id)}
        onRename={(id, label) => renameAccount('opencodego', id, label)}
        onSetPriority={(id, priority) => setAccountPriority('opencodego', id, priority)}
        onSetProxy={(id, proxy) => setAccountProxy('opencodego', id, proxy)}
      />

      {/* Add path: API-key form */}
      {formOpen ? (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {t('accounts.field.apiKey')}
            </label>
            <RevealableInput
              value={apiKey}
              placeholder={t('accounts.openCodeGo.apiKeyPlaceholder')}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {t('accounts.detail.label')}{' '}
              <span className="font-normal text-muted-foreground/80">({t('common.optional')})</span>
            </label>
            <Input
              density="compact"
              value={accountLabel}
              placeholder={t('accounts.detail.labelPlaceholder')}
              onChange={(e) => setAccountLabel(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {t('accounts.field.baseUrl')}
            </label>
            <Input
              density="compact"
              value={baseUrl}
              placeholder={t('accounts.openCodeGo.baseUrlPlaceholder')}
              onChange={(e) => setBaseUrl(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {t('accounts.field.zenBaseUrl')}
            </label>
            <Input
              density="compact"
              value={zenBaseUrl}
              placeholder={t('accounts.openCodeGo.zenBaseUrlPlaceholder')}
              onChange={(e) => setZenBaseUrl(e.target.value)}
              autoComplete="off"
            />
          </div>

          {formError ? (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {formError}
            </p>
          ) : null}

          <div className="flex items-center gap-2">
            <Button
              className="flex-1"
              disabled={busy || apiKey.trim().length === 0}
              onClick={() => void handleAdd()}
            >
              <Plus className="mr-2 h-4 w-4" />
              {t('accounts.accounts.addAccount')}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                resetForm();
                setFormOpen(false);
              }}
            >
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          className="w-full"
          disabled={busy}
          onClick={() => {
            setFormError(null);
            setFormOpen(true);
          }}
        >
          <Plus className="mr-2 h-4 w-4" />
          {t('accounts.accounts.addAccount')}
        </Button>
      )}
    </div>
  );
}
