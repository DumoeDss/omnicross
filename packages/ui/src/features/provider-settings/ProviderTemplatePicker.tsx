/**
 * ProviderTemplatePicker — step 1 of the ADD-provider flow.
 *
 * The built-in catalog is the common case, so the picker leads with it: a grid of
 * preset cards (translated name, icon, blurb, capability tags) that prefills the
 * form on click. Presets already added are shown disabled + badged rather than
 * hidden, so the catalog reads as a stable, complete list.
 *
 * Above the grid sits the escape hatch the picker must never bury: pick a bare
 * API type (or "configure manually") and go straight to an EMPTY form. Nothing
 * here writes — every path lands on `ProviderForm`, which owns the create.
 */
import { Check, Plus, Search, SlidersHorizontal, X } from 'lucide-react';
import React, { useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTranslation } from '@/shared/state/LocaleContext';
import { cn } from '@/shared/utils/utils';

import type { DaemonPresetView } from '@/daemon/types';
import type { ApiFormat } from '@shared/llm-config';

import { getProviderDisplayName, getProviderIcon } from './utils';

/** The API types a hand-rolled provider can start from (no template needed). */
const CUSTOM_TYPE_OPTIONS: Array<{ apiFormat: ApiFormat; label: string }> = [
  { apiFormat: 'openai', label: 'OpenAI' },
  { apiFormat: 'anthropic', label: 'Anthropic' },
  { apiFormat: 'google', label: 'Google Gemini' },
  { apiFormat: 'openai-response', label: 'OpenAI Responses' },
  { apiFormat: 'azure-openai', label: 'Azure OpenAI' },
];

/** Preset `features[]` tag → i18n key (several tags collapse onto one label). */
const FEATURE_KEYS: Record<string, string> = {
  search: 'providerSettings.presets.features.search',
  'mcp-search': 'providerSettings.presets.features.search',
  vision: 'providerSettings.presets.features.vision',
  'mcp-vision': 'providerSettings.presets.features.vision',
  mcp: 'providerSettings.presets.features.mcp',
  'coding-plan': 'providerSettings.presets.features.codingPlan',
};

function featureLabels(features: string[] | undefined, t: (key: string) => string): string[] {
  const seen = new Set<string>();
  for (const feature of features ?? []) {
    const key = FEATURE_KEYS[feature];
    if (key) seen.add(t(key));
  }
  return [...seen];
}

export interface ProviderTemplatePickerProps {
  presets: DaemonPresetView[];
  loading?: boolean;
  /** Ids of presets that already exist as real providers (badged "added"). */
  addedPresetIds: Set<string>;
  onUseTemplate: (preset: DaemonPresetView) => void;
  onStartCustom: (apiFormat: ApiFormat) => void;
  onCancel: () => void;
}

export function ProviderTemplatePicker({
  presets,
  loading = false,
  addedPresetIds,
  onUseTemplate,
  onStartCustom,
  onCancel,
}: ProviderTemplatePickerProps) {
  const t = useTranslation();
  const [query, setQuery] = useState('');

  const visiblePresets = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return presets;
    return presets.filter((preset) => {
      const haystack = [
        preset.name,
        getProviderDisplayName(t, { name: preset.name, nameKey: preset.nameKey }),
        preset.id,
        preset.description ?? '',
        preset.baseUrl,
        (preset.models ?? []).join(' '),
      ].join(' ').toLowerCase();
      return haystack.includes(needle);
    });
  }, [presets, query, t]);

  return (
    <div className="space-y-5 p-4">
      {/* Start from an API type — the no-template path, kept above the fold. */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground">
            {t('providerSettings.presets.customTitle')}
          </h3>
        </div>
        <p className="text-xs text-muted-foreground">
          {t('providerSettings.presets.customDescription')}
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          {CUSTOM_TYPE_OPTIONS.map((option) => (
            <button
              key={option.apiFormat}
              type="button"
              className="rounded-lg border border-border/60 bg-surface-1 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-primary/50 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onStartCustom(option.apiFormat)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {/* Built-in catalog */}
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-foreground">
            {t('providerSettings.presets.title')}
          </h3>
          <div className="relative w-56 max-w-[60%]">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="h-9 pl-8"
              placeholder={t('providerSettings.presets.searchPlaceholder')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query ? (
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
                onClick={() => setQuery('')}
                aria-label={t('common.clear')}
              >
                <X className="h-4 w-4" />
              </button>
            ) : null}
          </div>
        </div>

        {loading && presets.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t('common.loading')}
          </p>
        ) : visiblePresets.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {presets.length === 0
              ? t('providerSettings.presets.loadFailed')
              : t('providerSettings.presets.empty')}
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {visiblePresets.map((preset) => {
              const added = addedPresetIds.has(preset.id);
              const tags = featureLabels(preset.features, t);
              return (
                <div
                  key={preset.id}
                  className={cn(
                    'flex flex-col gap-3 rounded-xl border border-border/40 bg-surface-1 p-4 transition-colors',
                    added ? 'opacity-60' : 'hover:border-primary/40 hover:bg-surface-2/60',
                  )}
                >
                  <div className="flex items-center gap-2.5">
                    {getProviderIcon(preset.icon)}
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                      {getProviderDisplayName(t, { name: preset.name, nameKey: preset.nameKey })}
                    </span>
                    {added ? (
                      <Badge variant="success" className="shrink-0 text-[10px]">
                        <Check className="h-3 w-3" />
                        {t('providerSettings.presets.added')}
                      </Badge>
                    ) : null}
                  </div>

                  {tags.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {tags.map((label) => (
                        <Badge key={label} variant="secondary" className="text-[10px]">
                          {label}
                        </Badge>
                      ))}
                    </div>
                  ) : null}

                  {preset.description ? (
                    <p className="line-clamp-2 text-xs text-muted-foreground">{preset.description}</p>
                  ) : null}

                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-auto w-full"
                    disabled={added}
                    onClick={() => onUseTemplate(preset)}
                  >
                    <Plus className="mr-1 h-3.5 w-3.5" />
                    {added ? t('providerSettings.presets.added') : t('providerSettings.presets.add')}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2 border-t border-border/60 pt-3">
        <Button variant="outline" onClick={onCancel}>
          {t('providerSettings.form.buttons.cancel')}
        </Button>
      </div>
    </div>
  );
}

export default ProviderTemplatePicker;
