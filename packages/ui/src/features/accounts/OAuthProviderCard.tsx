/**
 * OAuthProviderCard.tsx — the per-provider card for the OAuth-capable providers
 * (claude / codex / gemini). All three are uniformly multi-account here (the
 * daemon stores a sanitized account array per provider), so the card always
 * renders the multi-account `AccountList` and an add-account control.
 *
 * Add paths (each APPENDS a new account daemon-side, then activates it):
 *  - OAuth: claude/gemini use the code-paste flow (`OAuthInlineFlow`); codex uses
 *    the loopback flow (`CodexInlineSignIn`, app-parity-2 child 5).
 *  - Manual: paste an already-obtained token (`ManualTokenModal`).
 *
 * SECRET DISCIPLINE: a token only ever flows IN (the OAuth code / the pasted
 * manual token). Every daemon response is status-only — the minted/submitted
 * token is never echoed back.
 */

import { Edit2, ExternalLink, HardDriveDownload, Key } from 'lucide-react';
import React, { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Select, type SelectOption } from '@/components/ui/select';
import { useTranslation } from '@/shared/state/LocaleContext';

import { AccountList } from './AccountList';
import { CodexInlineSignIn } from './CodexInlineSignIn';
import { ManualTokenModal } from './ManualTokenModal';
import { OAuthInlineFlow } from './OAuthInlineFlow';
import { StatusBadge } from './StatusBadge';

import type { useAccounts } from './hooks/useAccounts';
import type {
  AccountTokenInput,
  StartOAuthResult,
  SubscriptionAccountSanitized,
  SubscriptionListEntry,
  TokenStatus,
} from '@/daemon/types';

type OAuthProviderId = 'claude' | 'codex' | 'gemini';
type AuthMethod = 'oauth' | 'manual';

interface OAuthProviderCardProps {
  entry: SubscriptionListEntry;
  accounts: SubscriptionAccountSanitized[];
  accountsApi: ReturnType<typeof useAccounts>;
}

/** Derive the header status from the active account, else the credential status. */
function headerStatus(
  entry: SubscriptionListEntry,
  accounts: SubscriptionAccountSanitized[],
): TokenStatus {
  const active = accounts.find((a) => a.isActive) ?? accounts[0];
  if (active) return active.status;
  return entry.credentialStatus.ok ? 'configured' : 'unconfigured';
}

/** Build the manual-write payload for a provider from the modal's collected fields. */
function buildManualPayload(
  providerId: OAuthProviderId,
  accessToken: string,
  extra?: { subscriptionLevel?: 'Free' | 'Pro' | 'Max'; refreshToken?: string },
): AccountTokenInput {
  switch (providerId) {
    case 'claude':
      return {
        providerId: 'claude',
        input: {
          authMethod: 'manual',
          status: 'configured',
          accessToken,
          subscriptionLevel: extra?.subscriptionLevel,
        },
      };
    case 'gemini':
      return {
        providerId: 'gemini',
        input: { authMethod: 'manual', status: 'configured', accessToken, refreshToken: extra?.refreshToken },
      };
    case 'codex':
      return {
        providerId: 'codex',
        input: { authMethod: 'manual', status: 'configured', accessToken },
      };
  }
}

export function OAuthProviderCard({ entry, accounts, accountsApi }: OAuthProviderCardProps) {
  const t = useTranslation();
  const providerId = entry.providerId as OAuthProviderId;
  const isCodex = providerId === 'codex';
  const {
    busy,
    data,
    appendTokens,
    setActive,
    removeAccount,
    renameAccount,
    setAccountPriority,
    refreshProvider,
    startOAuth,
    completeOAuth,
    pollCodexOAuth,
    importExternalCli,
    refresh,
  } = accountsApi;

  const [authMethod, setAuthMethod] = useState<AuthMethod>('oauth');
  const [oauth, setOauth] = useState<StartOAuthResult | null>(null);
  const [authCode, setAuthCode] = useState('');
  const [accountLabel, setAccountLabel] = useState('');
  const [exchanging, setExchanging] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  // Per-card error — scoped to THIS provider so one card's failure never spills
  // onto the others (they all share a single useAccounts instance).
  const [cardError, setCardError] = useState<string | null>(null);

  const status = headerStatus(entry, accounts);

  // External CLI import (external-cli-sync): offered only while the provider
  // has NO accounts yet and the daemon detected a usable native CLI login.
  const canImportExternal =
    accounts.length === 0 &&
    (providerId === 'claude' || providerId === 'codex') &&
    Boolean(data.externalCli?.[providerId]);

  const handleImportExternal = async () => {
    if (providerId === 'gemini') return;
    setCardError(null);
    const result = await importExternalCli(providerId);
    if (!result.success) setCardError(result.message ?? t('accounts.errors.requestFailed'));
  };

  const handleStartOAuth = async () => {
    setCardError(null);
    const started = await startOAuth(providerId);
    if (started) {
      setOauth(started);
      setAuthCode('');
      setAccountLabel('');
    } else {
      setCardError(t('accounts.errors.requestFailed'));
    }
  };

  const handleExchange = async () => {
    if (!oauth || authCode.trim().length === 0) return;
    setExchanging(true);
    try {
      const result = await completeOAuth(providerId, {
        sessionId: oauth.sessionId,
        code: authCode.trim(),
        label: accountLabel.trim() || undefined,
      });
      if (result.success) {
        setOauth(null);
        setAuthCode('');
        setAccountLabel('');
        setCardError(null);
      } else {
        setCardError(result.message ?? t('accounts.errors.requestFailed'));
      }
    } finally {
      setExchanging(false);
    }
  };

  const cancelOAuth = () => {
    setOauth(null);
    setAuthCode('');
    setAccountLabel('');
    setCardError(null);
  };

  const handleManualSubmit = async (
    accessToken: string,
    label: string | undefined,
    extra?: { subscriptionLevel?: 'Free' | 'Pro' | 'Max'; refreshToken?: string },
  ) => {
    const result = await appendTokens(buildManualPayload(providerId, accessToken, extra), label);
    if (!result.success) setCardError(result.message ?? t('accounts.errors.requestFailed'));
    return result;
  };

  const authMethodOptions: SelectOption[] = [
    { value: 'oauth', label: t('accounts.authMethod.oauth') },
    { value: 'manual', label: t('accounts.authMethod.manual') },
  ];

  const addLabel =
    accounts.length > 0
      ? t('accounts.accounts.addAccount')
      : authMethod === 'manual'
        ? t('accounts.actions.enterToken')
        : t('accounts.actions.authorize');

  return (
    <div className="space-y-4 rounded-lg border border-border bg-surface-1/50 p-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-2">
            <Key className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <h3 className="font-medium text-foreground">{t(`accounts.provider.${providerId}.title`)}</h3>
            <p className="text-sm text-muted-foreground">
              {t(`accounts.provider.${providerId}.description`)}
            </p>
          </div>
        </div>
        <StatusBadge status={status} />
      </div>

      {/* Card-level error (suppressed while the inline OAuth flow renders its own). */}
      {cardError && !oauth ? (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{cardError}</div>
      ) : null}

      {/* Multi-account list */}
      <AccountList
        accounts={accounts}
        busy={busy}
        onSetActive={(id) => void setActive(providerId, id)}
        onRemove={(id) => void removeAccount(providerId, id)}
        onRename={(id, label) => renameAccount(providerId, id, label)}
        onSetPriority={(id, priority) => setAccountPriority(providerId, id, priority)}
        onRefreshActive={() => refreshProvider(providerId)}
      />

      {/* Add path: inline OAuth (code-paste / loopback) OR the method picker + button */}
      {oauth && isCodex ? (
        <CodexInlineSignIn
          authUrl={oauth.authUrl}
          sessionId={oauth.sessionId}
          onPoll={pollCodexOAuth}
          onDone={() => {
            setOauth(null);
            void refresh();
          }}
          onCancel={cancelOAuth}
        />
      ) : oauth ? (
        <OAuthInlineFlow
          authUrl={oauth.authUrl}
          authCode={authCode}
          accountLabel={accountLabel}
          isExchanging={exchanging}
          error={cardError}
          onAccountLabelChange={setAccountLabel}
          onAuthCodeChange={setAuthCode}
          onExchange={() => void handleExchange()}
          onCancel={cancelOAuth}
        />
      ) : (
        <>
          {canImportExternal ? (
            <div className="space-y-2 rounded-md border border-border/60 bg-surface-2/40 p-3">
              <p className="text-sm text-foreground">
                {t('accounts.importExternal.detected', {
                  name: t(`accounts.provider.${providerId}.title`),
                })}
              </p>
              <p className="text-xs text-muted-foreground">{t('accounts.importExternal.hint')}</p>
              <Button
                className="w-full"
                variant="outline"
                disabled={busy}
                onClick={() => void handleImportExternal()}
              >
                <HardDriveDownload className="mr-2 h-4 w-4" />
                {t('accounts.importExternal.button')}
              </Button>
            </div>
          ) : null}
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">{t('accounts.authMethodLabel')}</label>
            <Select
              value={authMethod}
              options={authMethodOptions}
              onChange={(value) => setAuthMethod(value as AuthMethod)}
            />
            <p className="text-xs text-muted-foreground">{t(`accounts.authMethodDesc.${authMethod}`)}</p>
          </div>

          <Button
            className="w-full"
            disabled={busy}
            onClick={() => {
              setCardError(null);
              if (authMethod === 'manual') setManualOpen(true);
              else void handleStartOAuth();
            }}
          >
            {authMethod === 'manual' ? (
              <Edit2 className="mr-2 h-4 w-4" />
            ) : (
              <ExternalLink className="mr-2 h-4 w-4" />
            )}
            {addLabel}
          </Button>
        </>
      )}

      <ManualTokenModal
        open={manualOpen}
        onOpenChange={setManualOpen}
        provider={providerId}
        busy={busy}
        error={cardError}
        onSubmit={handleManualSubmit}
      />
    </div>
  );
}
