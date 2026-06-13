/**
 * OAuthInlineFlow.tsx — the inline code-paste OAuth step for the OAuth-capable
 * code-paste providers (claude / gemini).
 *
 * Two-phase, honest: the parent already called `startOAuth` (the daemon minted
 * the public authorize URL + an opaque sessionId). This panel opens that URL in
 * the user's browser via a plain `target="_blank"` anchor (no native-shell call),
 * the user authorizes and pastes the authorization code back, and the parent
 * calls `completeOAuth`. The code crosses to the daemon ONLY; the daemon responds
 * with the sanitized status, so this flow never expects (or shows) the minted
 * token back.
 *
 * An optional account-label input names the new account (the daemon's
 * OAuth-complete path accepts a `label`).
 */

import { Check, CheckCircle, Copy, ExternalLink, RefreshCw } from 'lucide-react';
import React, { useCallback, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTranslation } from '@/shared/state/LocaleContext';

interface OAuthInlineFlowProps {
  authUrl: string;
  authCode: string;
  accountLabel: string;
  isExchanging: boolean;
  error: string | null;
  onAccountLabelChange: (label: string) => void;
  onAuthCodeChange: (code: string) => void;
  onExchange: () => void;
  onCancel: () => void;
}

const STEP_KEYS = ['step1', 'step2', 'step3', 'step4'] as const;

export function OAuthInlineFlow({
  authUrl,
  authCode,
  accountLabel,
  isExchanging,
  error,
  onAccountLabelChange,
  onAuthCodeChange,
  onExchange,
  onCancel,
}: OAuthInlineFlowProps) {
  const t = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopyUrl = useCallback(() => {
    void navigator.clipboard?.writeText(authUrl).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    });
  }, [authUrl]);

  return (
    <div className="space-y-3">
      <div className="space-y-1.5 rounded-md bg-surface-2 p-4">
        <label className="text-sm font-medium text-foreground">
          {t('accounts.detail.label')}{' '}
          <span className="font-normal text-muted-foreground/80">({t('common.optional')})</span>
        </label>
        <Input
          value={accountLabel}
          placeholder={t('accounts.detail.labelPlaceholder')}
          onChange={(e) => onAccountLabelChange(e.target.value)}
          autoComplete="off"
        />
      </div>
      {STEP_KEYS.map((step, index) => (
        <div key={step} className="space-y-2 rounded-md bg-surface-2 p-4">
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
              {index + 1}
            </span>
            <span className="font-medium text-foreground">
              {t(`accounts.oauthFlow.${step}.title`)}
            </span>
          </div>
          <p className="pl-8 text-sm text-muted-foreground">
            {t(`accounts.oauthFlow.${step}.desc`)}
          </p>
          {index === 0 ? (
            <div className="pl-8">
              <a
                href={authUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                <ExternalLink className="h-4 w-4" />
                {t('accounts.oauth.openPage')}
              </a>
            </div>
          ) : null}
          {index === STEP_KEYS.length - 1 ? (
            <div className="pl-8">
              <input
                type="text"
                value={authCode}
                onChange={(e) => onAuthCodeChange(e.target.value)}
                placeholder={t('accounts.oauth.codePlaceholder')}
                autoComplete="off"
                className="w-full rounded-md border border-border bg-surface-1 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>
          ) : null}
        </div>
      ))}

      {error ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <details className="rounded-md bg-surface-1/50 p-3">
        <summary className="cursor-pointer text-sm text-muted-foreground">
          {t('accounts.oauthFlow.showUrl')}
        </summary>
        <div className="mt-2 flex items-center gap-2">
          <code className="flex-1 truncate rounded bg-surface-1 px-2 py-1 text-xs">{authUrl}</code>
          <Button variant="ghost" size="sm" className="shrink-0" onClick={handleCopyUrl}>
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          </Button>
        </div>
      </details>

      <div className="flex items-center gap-2 pt-1">
        <Button
          className="flex-1"
          onClick={onExchange}
          disabled={authCode.trim().length === 0 || isExchanging}
        >
          {isExchanging ? (
            <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <CheckCircle className="mr-2 h-4 w-4" />
          )}
          {t('accounts.oauthFlow.authorize')}
        </Button>
        <Button variant="outline" onClick={onCancel} disabled={isExchanging}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}
