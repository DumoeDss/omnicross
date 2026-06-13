import {
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Search,
  X} from 'lucide-react';
import React, { useEffect } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTranslation } from '@/shared/state/LocaleContext';
import { cn } from '@/shared/utils/utils';

import type {
  LLMProvider,
  ProviderModelDiscoveryEntry,
  ProviderModelDiscoveryResult} from '@shared/llm-config';

import { DEFAULT_MODEL_GROUP_ID } from './constants';
import type { ModelCatalogFilterKey } from './types';
import { MODEL_FILTER_DEFS } from './utils';

interface ManageModelsDialogProps {
  selectedProvider: LLMProvider | null;
  showManageModels: boolean;
  setShowManageModels: (val: boolean) => void;
  discoveryResult: ProviderModelDiscoveryResult | null;
  filteredDiscoveryModels: ProviderModelDiscoveryEntry[];
  catalogGroups: Array<{ id: string; name: string; models: ProviderModelDiscoveryEntry[] }>;
  catalogSearchTerm: string;
  setCatalogSearchTerm: (val: string) => void;
  catalogFilter: ModelCatalogFilterKey;
  setCatalogFilter: (val: ModelCatalogFilterKey) => void;
  catalogCollapsedGroups: Record<string, boolean>;
  toggleCatalogGroup: (id: string) => void;
  modelDiscoveryLoading: boolean;
  modelDiscoveryError: string | null;
  existingModelIds: Set<string>;
  onLoadModelDiscovery: (force?: boolean) => Promise<void>;
  onAddDiscoveredModel: (model: ProviderModelDiscoveryEntry) => Promise<void>;
}

export function ManageModelsDialog({
  selectedProvider,
  showManageModels,
  setShowManageModels,
  discoveryResult,
  filteredDiscoveryModels,
  catalogGroups,
  catalogSearchTerm,
  setCatalogSearchTerm,
  catalogFilter,
  setCatalogFilter,
  catalogCollapsedGroups,
  toggleCatalogGroup,
  modelDiscoveryLoading,
  modelDiscoveryError,
  existingModelIds,
  onLoadModelDiscovery,
  onAddDiscoveredModel
}: ManageModelsDialogProps) {
  const t = useTranslation();

  // ESC key handler
  useEffect(() => {
    if (!showManageModels) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowManageModels(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showManageModels, setShowManageModels]);

  if (!selectedProvider || !showManageModels) return null;

  const sourceKey =
    discoveryResult?.source === 'network'
      ? t('providerSettings.modelsManager.manageDialog.sourceNetwork')
      : t('providerSettings.modelsManager.manageDialog.sourceCache');
  
  const noCatalogMatches = !filteredDiscoveryModels.length && !modelDiscoveryLoading;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-background border rounded-lg shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div className="p-4 border-b flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold">
              {t('providerSettings.modelsManager.manageDialog.title')} · {selectedProvider.name}
            </h3>
            <p className="text-xs text-muted-foreground mt-1">
              {discoveryResult?.fetchedAt
                ? t('providerSettings.modelsManager.manageDialog.cachedAt', {
                    date: new Date(discoveryResult.fetchedAt).toLocaleString(),
                    source: sourceKey
                  })
                : t('providerSettings.modelsManager.manageDialog.empty')}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void onLoadModelDiscovery(true)}
              disabled={modelDiscoveryLoading}
            >
              <RefreshCw
                className={`h-4 w-4 mr-1 ${modelDiscoveryLoading ? 'animate-spin' : ''}`}
              />
              {t('providerSettings.modelsManager.manageDialog.refresh')}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setShowManageModels(false)}>
              {t('providerSettings.modelsManager.manageDialog.close')}
            </Button>
          </div>
        </div>
        <div className="px-4 py-3 border-b space-y-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={catalogSearchTerm}
              onChange={(event) => setCatalogSearchTerm(event.target.value)}
              placeholder={t('providerSettings.modelsManager.searchPlaceholder')}
              className="pl-8 pr-8"
            />
            {catalogSearchTerm ? <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
                onClick={() => setCatalogSearchTerm('')}
              >
                <X className="h-4 w-4" />
              </button> : null}
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            {MODEL_FILTER_DEFS.map((filter) => (
              <button
                type="button"
                key={filter.key}
                className={cn(
                  'px-3 py-1 rounded-full border transition-colors',
                  catalogFilter === filter.key
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'border-border text-muted-foreground hover:text-foreground'
                )}
                onClick={() => setCatalogFilter(filter.key)}
              >
                {t(filter.labelKey)}
              </button>
            ))}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {modelDiscoveryError ? <div className="text-sm text-destructive border border-destructive/30 bg-destructive/10 px-3 py-2 rounded">
              {t('providerSettings.modelsManager.manageDialog.error', {
                message: modelDiscoveryError
              })}
            </div> : null}
          {modelDiscoveryLoading ? (
            <div className="text-center text-sm text-muted-foreground py-10">
              {t('providerSettings.loading')}
            </div>
          ) : noCatalogMatches ? (
            <div className="text-sm text-muted-foreground">
              {t('providerSettings.modelsManager.manageDialog.empty')}
            </div>
          ) : (
            <div className="space-y-3">
              {catalogGroups.map((group) => (
                <div key={group.id} className="border rounded-md overflow-hidden">
                  <button
                    type="button"
                    className="w-full flex items-center justify-between px-3 py-2 bg-muted/40 hover:bg-muted/60 transition-colors"
                    onClick={() => toggleCatalogGroup(group.id)}
                  >
                    <div>
                      <div className="text-sm font-medium">
                        {group.id === DEFAULT_MODEL_GROUP_ID
                          ? t('providerSettings.modelsManager.defaultGroup')
                          : group.name}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {t('providerSettings.listStatus', { count: group.models.length })}
                      </div>
                    </div>
                    {catalogCollapsedGroups[group.id] ? (
                      <ChevronDown className="h-4 w-4" />
                    ) : (
                      <ChevronUp className="h-4 w-4" />
                    )}
                  </button>
                  {!catalogCollapsedGroups[group.id] && (
                    <div className="divide-y">
                      {group.models.map((model) => {
                        const exists = existingModelIds.has(model.id);
                        return (
                          <div
                            key={model.id}
                            className="flex flex-col gap-3 px-3 py-3 md:flex-row md:items-center"
                          >
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <div className="font-medium text-sm truncate">
                                  {model.name || model.id}
                                </div>
                                <div className="text-xs text-muted-foreground truncate">
                                  {model.id}
                                </div>
                              </div>
                              {model.description ? <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                                  {model.description}
                                </p> : null}
                              {(model.contextLength || model.maxTokens) ? <div className="text-[11px] text-muted-foreground mt-1">
                                  {model.contextLength
                                    ? t('providerSettings.modelsManager.manageDialog.contextLength', {
                                        value: model.contextLength
                                      })
                                    : null}
                                  {model.contextLength && model.maxTokens ? ' · ' : null}
                                  {model.maxTokens
                                    ? t('providerSettings.modelsManager.manageDialog.maxTokens', {
                                        value: model.maxTokens
                                      })
                                    : null}
                                </div> : null}
                              {model.capabilities?.length ? (
                                <div className="flex flex-wrap gap-1 mt-2">
                                  {model.capabilities.slice(0, 6).map((capability) => (
                                    <Badge
                                      key={`${model.id}-${capability}`}
                                      variant="secondary"
                                      className="text-[10px] uppercase tracking-wide"
                                    >
                                      {capability}
                                    </Badge>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                            <Button
                              type="button"
                              size="sm"
                              variant={exists ? 'outline' : 'default'}
                              disabled={exists}
                              onClick={() => void onAddDiscoveredModel(model)}
                            >
                              {exists
                                ? t('providerSettings.modelsManager.messages.duplicate')
                                : t('providerSettings.modelsManager.manageDialog.addFromCatalog')}
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {discoveryResult?.raw ? <details className="border rounded-md">
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
                {t('providerSettings.modelsManager.manageDialog.raw')}
              </summary>
              <pre className="text-xs bg-muted/40 p-3 max-h-64 overflow-y-auto">
                {JSON.stringify(discoveryResult.raw, null, 2)}
              </pre>
            </details> : null}
        </div>
      </div>
    </div>
  );
}

