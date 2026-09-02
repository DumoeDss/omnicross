/**
 * SearchPage — the standalone top-level home for search-provider settings
 * (search-settings-tab, design D1/D2). A true sibling of the Gateway nav
 * entry, NOT a section inside the API Service page (owner feedback
 * 2026-09-02): the search runtime is a first-class daemon capability with its
 * own product surface, exactly like Elftia's web-search tab.
 *
 * The page shell mirrors RouteActivityPage (header + scroll body); the body is
 * the settings section (modes, provider cards with ALWAYS-reachable entry
 * fields, policy, egress) — the page owns the data via `useSearchSettings`.
 */

import { Search } from 'lucide-react';
import React from 'react';

import { ScrollArea } from '@/components/ui/scroll-area';
import { useTranslation } from '@/shared/state/LocaleContext';

import { SearchSettingsSection } from './SearchSettingsSection';
import { useSearchSettings } from './hooks/useSearchSettings';

export function SearchPage() {
  const t = useTranslation();
  const {
    loading,
    config,
    diagnostics,
    busy,
    error,
    updateSearchConfig,
    runSearchQuery,
  } = useSearchSettings();

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b border-border/70 bg-surface-0/80 px-5 py-4 md:px-6">
        <div className="mx-auto flex max-w-5xl items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
            <Search className="h-5 w-5 text-primary" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-foreground">{t('search.title')}</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">{t('search.description')}</p>
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
            <p className="text-sm text-muted-foreground">{t('search.page.loading')}</p>
          ) : (
            <SearchSettingsSection
              config={config}
              diagnostics={diagnostics}
              busy={busy}
              onUpdate={updateSearchConfig}
              onQuery={runSearchQuery}
            />
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

export default SearchPage;
