import { ArrowLeft } from 'lucide-react';
import React, { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { OAuthProviderCard } from '@/features/accounts/OAuthProviderCard';
import { OpenCodeGoAccountCard } from '@/features/accounts/OpenCodeGoAccountCard';
import type { useAccounts } from '@/features/accounts/hooks/useAccounts';
import type { SubscriptionListEntry, SubscriptionProviderId } from '@/daemon/types';
import { useTranslation } from '@/shared/state/LocaleContext';

interface AddAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountsApi: ReturnType<typeof useAccounts>;
}

export function AddAccountDialog({ open, onOpenChange, accountsApi }: AddAccountDialogProps) {
  const t = useTranslation();
  const [providerId, setProviderId] = useState<SubscriptionProviderId | null>(null);
  const selectedEntry = providerId
    ? accountsApi.data.accounts.find((entry) => entry.providerId === providerId)
    : undefined;

  const close = () => {
    setProviderId(null);
    onOpenChange(false);
  };

  const renderProvider = (entry: SubscriptionListEntry) => {
    const common = {
      entry,
      accounts: accountsApi.data.providerAccounts[entry.providerId] ?? [],
      accountsApi,
      mode: 'add' as const,
      onAdded: close,
      onAddRequest: () => setProviderId(entry.providerId),
    };
    return entry.providerId === 'opencodego'
      ? <OpenCodeGoAccountCard {...common} />
      : <OAuthProviderCard {...common} />;
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
        else onOpenChange(true);
      }}
    >
      <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('accounts.addDialog.title')}</DialogTitle>
          <DialogDescription>{t('accounts.addDialog.description')}</DialogDescription>
        </DialogHeader>
        {selectedEntry ? (
          <div className="space-y-3">
            <Button size="sm" variant="ghost" className="px-1" onClick={() => setProviderId(null)}>
              <ArrowLeft className="mr-1.5 h-4 w-4" />
              {t('accounts.addDialog.back')}
            </Button>
            {renderProvider(selectedEntry)}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {accountsApi.data.accounts.map((entry) => {
              const count = accountsApi.data.providerAccounts[entry.providerId]?.length ?? 0;
              return (
                <button
                  key={entry.providerId}
                  type="button"
                  className="rounded-lg border border-border bg-surface-1/50 p-4 text-left transition-colors hover:border-primary/50 hover:bg-surface-2/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => setProviderId(entry.providerId)}
                >
                  <span className="block text-sm font-medium text-foreground">{t(`accounts.provider.${entry.providerId}.title`)}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">{t('accounts.addDialog.existingCount', { count })}</span>
                </button>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
