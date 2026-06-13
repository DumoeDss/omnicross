/**
 * AccountsPage.tsx — the Accounts / Subscriptions page shell.
 *
 * Renders a header card, one dedicated card per subscription provider returned by
 * `GET /accounts` (claude/codex/gemini → `OAuthProviderCard`; opencodego →
 * `OpenCodeGoAccountCard`), and a closing info card. Each provider card wires the
 * sanitized status + multi-account management to the daemon-backed `useAccounts`
 * mutations (token IN, status-only OUT).
 */

import { UserCircle } from 'lucide-react';
import React from 'react';

import { ScrollArea } from '@/components/ui/scroll-area';
import { useTranslation } from '@/shared/state/LocaleContext';

import { OAuthProviderCard } from './OAuthProviderCard';
import { OpenCodeGoAccountCard } from './OpenCodeGoAccountCard';
import { useAccounts } from './hooks/useAccounts';

import type { SubscriptionListEntry } from '@/daemon/types';

export function AccountsPage() {
  const t = useTranslation();
  const accountsApi = useAccounts();
  const { loading, data } = accountsApi;

  const renderCard = (entry: SubscriptionListEntry) => {
    const accounts = data.providerAccounts[entry.providerId] ?? [];
    if (entry.providerId === 'opencodego') {
      return (
        <OpenCodeGoAccountCard
          key={entry.providerId}
          entry={entry}
          accounts={accounts}
          accountsApi={accountsApi}
        />
      );
    }
    return (
      <OAuthProviderCard
        key={entry.providerId}
        entry={entry}
        accounts={accounts}
        accountsApi={accountsApi}
      />
    );
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ScrollArea className="flex-1">
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-6">
          {/* Header card */}
          <section className="rounded-xl border border-border/70 bg-surface-1/60 p-4 md:p-5">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-2">
                <UserCircle className="h-5 w-5 text-muted-foreground" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-foreground">{t('accounts.title')}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{t('accounts.description')}</p>
              </div>
            </div>
          </section>

          {/* Provider cards */}
          {loading ? (
            <p className="text-sm text-muted-foreground">{t('accounts.loading')}</p>
          ) : data.accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('accounts.empty')}</p>
          ) : (
            <div className="space-y-4">{data.accounts.map(renderCard)}</div>
          )}

          {/* Info card */}
          <section className="rounded-xl border border-border/70 bg-surface-1/60 p-4 md:p-5">
            <h3 className="mb-2 text-base font-semibold text-foreground">{t('accounts.info.title')}</h3>
            <p className="text-sm text-muted-foreground">{t('accounts.info.description')}</p>
          </section>
        </div>
      </ScrollArea>
    </div>
  );
}

export default AccountsPage;
