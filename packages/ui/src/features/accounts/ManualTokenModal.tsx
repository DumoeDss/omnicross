/**
 * ManualTokenModal.tsx — paste an already-obtained token for an OAuth-capable
 * provider (claude / codex / gemini).
 *
 * The token flows IN only: the parent serializes it field-by-field through the
 * provider's daemon allowlist (`authMethod: 'manual'`), and the write response is
 * status-only — the submitted token is never echoed back. Per-provider extras:
 * claude takes a subscription level, gemini takes an optional refresh token.
 *
 * An optional account-label input names the new account (the daemon's manual
 * append path accepts a `label`).
 */

import React, { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { RevealableInput } from '@/components/ui/revealable-input';
import { Select } from '@/components/ui/select';
import { useTranslation } from '@/shared/state/LocaleContext';

type ManualProvider = 'claude' | 'codex' | 'gemini';
type SubscriptionLevel = 'Free' | 'Pro' | 'Max';

interface ManualExtra {
  subscriptionLevel?: SubscriptionLevel;
  refreshToken?: string;
}

interface ManualTokenModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: ManualProvider;
  busy: boolean;
  error: string | null;
  onSubmit: (
    accessToken: string,
    label: string | undefined,
    extra?: ManualExtra,
  ) => Promise<{ success: boolean }>;
}

const SUBSCRIPTION_LEVELS: SubscriptionLevel[] = ['Free', 'Pro', 'Max'];

export function ManualTokenModal({
  open,
  onOpenChange,
  provider,
  busy,
  error,
  onSubmit,
}: ManualTokenModalProps) {
  const t = useTranslation();
  const [accessToken, setAccessToken] = useState('');
  const [refreshToken, setRefreshToken] = useState('');
  const [accountLabel, setAccountLabel] = useState('');
  const [subscriptionLevel, setSubscriptionLevel] = useState<SubscriptionLevel>('Free');

  // Reset whenever the modal (re)opens.
  useEffect(() => {
    if (open) {
      setAccessToken('');
      setRefreshToken('');
      setAccountLabel('');
      setSubscriptionLevel('Free');
    }
  }, [open]);

  const handleSubmit = async () => {
    if (accessToken.trim().length === 0) return;
    const extra: ManualExtra = {};
    if (provider === 'claude') extra.subscriptionLevel = subscriptionLevel;
    if (provider === 'gemini' && refreshToken.trim()) extra.refreshToken = refreshToken.trim();
    const result = await onSubmit(accessToken.trim(), accountLabel.trim() || undefined, extra);
    if (result.success) onOpenChange(false);
  };

  const subscriptionOptions = SUBSCRIPTION_LEVELS.map((level) => ({ value: level, label: level }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('accounts.manual.title')}</DialogTitle>
          <DialogDescription>{t('accounts.manual.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
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
              {t('accounts.field.accessToken')}
            </label>
            <RevealableInput
              value={accessToken}
              placeholder={t('accounts.manual.accessTokenPlaceholder')}
              onChange={(e) => setAccessToken(e.target.value)}
              autoComplete="off"
              autoFocus
            />
          </div>

          {provider === 'claude' ? (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                {t('accounts.write.subscriptionLevel')}
              </label>
              <Select
                value={subscriptionLevel}
                options={subscriptionOptions}
                onChange={(value) => setSubscriptionLevel(value as SubscriptionLevel)}
                size="sm"
              />
            </div>
          ) : null}

          {provider === 'gemini' ? (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                {t('accounts.field.refreshToken')}{' '}
                <span className="font-normal text-muted-foreground/80">
                  ({t('common.optional')})
                </span>
              </label>
              <RevealableInput
                value={refreshToken}
                placeholder={t('accounts.manual.refreshTokenPlaceholder')}
                onChange={(e) => setRefreshToken(e.target.value)}
                autoComplete="off"
              />
            </div>
          ) : null}

          <p className="rounded-md bg-surface-2 px-3 py-2 text-xs text-muted-foreground">
            {t('accounts.manual.hint')}
          </p>

          {error ? (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="default"
            onClick={() => void handleSubmit()}
            disabled={busy || accessToken.trim().length === 0}
          >
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
