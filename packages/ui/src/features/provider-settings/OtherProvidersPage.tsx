/**
 * OtherProvidersPage — the standalone home for category-'other' providers
 * (Jev-style decision engines / key storage for external tools).
 *
 * Owner feedback 2026-09-23: these rows were only discoverable inside the
 * add-provider picker's collapsed "其他" section — there was no surface that
 * SHOWS their configuration. The page reuses the provider-settings workbench
 * with a category filter so list, selection, and the add flow all agree.
 *
 * The shell mirrors SearchPage (header + fill body); the body is the
 * non-embedded ProviderSettings (its own two-pane list/details layout).
 */
import { CircleEllipsis } from 'lucide-react';
import React from 'react';

import { useTranslation } from '@/shared/state/LocaleContext';

import { ProviderSettings } from './ProviderSettings';

export function OtherProvidersPage() {
  const t = useTranslation();

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b border-border/70 bg-surface-0/80 px-5 py-4 md:px-6">
        <div className="mx-auto flex max-w-5xl items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
            <CircleEllipsis className="h-5 w-5 text-primary" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-foreground">{t('otherProviders.title')}</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">{t('otherProviders.description')}</p>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1">
        <ProviderSettings categoryFilter="other" />
      </div>
    </div>
  );
}
