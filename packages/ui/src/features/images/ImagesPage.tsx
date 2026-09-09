/**
 * ImagesPage — the standalone top-level home for image-generation settings
 * (images-settings-tab, design D1). A true sibling of the Search page, NOT a
 * section inside the API Service page: image generation is a first-class
 * daemon capability with its own product surface (the search-settings-tab
 * precedent).
 *
 * The page shell mirrors SearchPage (header + scroll body). The body carries
 * the per-provider status cards and the live-verification panel above the
 * migrated ImagesSection; the page owns its data via `useImagesSettings`.
 */

import { Image as ImageIcon } from 'lucide-react';
import React from 'react';

import { ScrollArea } from '@/components/ui/scroll-area';
import { useTranslation } from '@/shared/state/LocaleContext';

import { ImagesSection } from './ImagesSection';
import { ProviderStatusCards } from './ProviderStatusCards';
import { VerifyLivePanel } from './VerifyLivePanel';
import { useImagesSettings } from './hooks/useImagesSettings';

export function ImagesPage() {
  const t = useTranslation();
  const {
    loading,
    config,
    capability,
    status,
    accounts,
    busy,
    error,
    updateImagesConfig,
    verifyImagesLive,
    refresh,
  } = useImagesSettings();

  const antigravityRouted = Object.values(config?.models ?? {})
    .some((provider) => provider === 'antigravity-subscription');

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b border-border/70 bg-surface-0/80 px-5 py-4 md:px-6">
        <div className="mx-auto flex max-w-5xl items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
            <ImageIcon className="h-5 w-5 text-primary" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-foreground">{t('images.page.title')}</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">{t('images.page.description')}</p>
          </div>
        </div>
      </header>

      <ScrollArea className="flex-1">
        <div className="mx-auto max-w-5xl space-y-5 px-6 py-5">
          {error ? (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          ) : null}

          {loading ? (
            <p className="text-sm text-muted-foreground">{t('images.page.loading')}</p>
          ) : !config ? (
            <section className="rounded-xl border border-dashed border-border/70 p-4">
              <p className="text-sm font-semibold text-foreground">{t('images.page.title')}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t('images.unsupportedDaemon')}</p>
            </section>
          ) : (
            <>
              <ProviderStatusCards capability={capability} />
              <VerifyLivePanel
                antigravityRouted={antigravityRouted}
                busy={busy}
                onVerify={verifyImagesLive}
                onVerified={refresh}
              />
              <ImagesSection
                config={config}
                capability={capability}
                status={status}
                accounts={accounts.providerAccounts.codex}
                busy={busy}
                onUpdate={updateImagesConfig}
              />
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
