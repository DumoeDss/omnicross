import { CircleDot, GripVertical, Loader2, Plus, Search, X } from 'lucide-react';
import React, { useCallback, useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTranslation } from '@/shared/state/LocaleContext';
import { cn } from '@/shared/utils/utils';

import type { LLMProvider } from '@shared/llm-config';

import { getProviderDisplayName } from './utils';

interface ProviderListProps {
  providers: LLMProvider[];
  loading?: boolean;
  selectedProviderId: string | null;
  searchTerm: string;
  setSearchTerm: (term: string) => void;
  onSelectProvider: (id: string) => void;
  onAddProvider: () => void;
  onReorderProviders?: (orderedIds: string[]) => void | Promise<void>;
  isAddingNew: boolean;
}

export function ProviderList({
  providers,
  loading = false,
  selectedProviderId,
  searchTerm,
  setSearchTerm,
  onSelectProvider,
  onAddProvider,
  onReorderProviders,
  isAddingNew
}: ProviderListProps) {
  const t = useTranslation();
  const [enabledOnly, setEnabledOnly] = useState(false);

  const [dragIdx, setDragIdx] = useState<number>(-1);
  const [dragOverIdx, setDragOverIdx] = useState<number>(-1);

  const filteredProviders = useMemo(() => {
    let list = providers;
    if (enabledOnly) {
      list = list.filter(p => p.enabled);
    }
    if (searchTerm.trim()) {
      const term = searchTerm.trim().toLowerCase();
      list = list.filter(provider => {
        const haystack = `${provider.name} ${getProviderDisplayName(t, provider)} ${provider.apiFormat || provider.apiType || ''} ${provider.models?.join(' ') || ''}`.toLowerCase();
        const idMatch = provider.id.toLowerCase().includes(term);
        return haystack.includes(term) || idMatch;
      });
    }
    return list;
  }, [providers, searchTerm, enabledOnly, t]);

  // Drag is only meaningful on the unfiltered, unsearched list — reordering a
  // filtered subset would silently scramble hidden rows. Disable drag whenever
  // a filter is active.
  const dragEnabled = !!onReorderProviders && !enabledOnly && !searchTerm.trim();

  const handleDragStart = useCallback(
    (idx: number) => (e: React.DragEvent) => {
      if (!dragEnabled) return;
      setDragIdx(idx);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(idx));
    },
    [dragEnabled],
  );

  const handleDragOver = useCallback(
    (idx: number) => (e: React.DragEvent) => {
      if (!dragEnabled) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDragOverIdx(idx);
    },
    [dragEnabled],
  );

  const handleDragEnd = useCallback(() => {
    setDragIdx(-1);
    setDragOverIdx(-1);
  }, []);

  const handleDrop = useCallback(
    (overIdx: number) => () => {
      setDragIdx(-1);
      setDragOverIdx(-1);
      if (!dragEnabled || !onReorderProviders) return;
      if (dragIdx === -1 || overIdx === -1 || dragIdx === overIdx) return;

      const next = [...providers];
      const [item] = next.splice(dragIdx, 1);
      next.splice(overIdx, 0, item);
      void onReorderProviders(next.map(p => p.id));
    },
    [providers, onReorderProviders, dragEnabled, dragIdx],
  );

  return (
    <div className="w-72 border-r border-border bg-surface-1/60 flex flex-col h-full overflow-hidden">
      {/* Search + filter toggle */}
      <div className="p-3 border-b border-border/70 flex-shrink-0 flex items-center gap-2">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t('providerSettings.searchPlaceholder')}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-8 h-9"
          />
          {searchTerm ? (
            <button
              type="button"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
              onClick={() => setSearchTerm('')}
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>
        <button
          type="button"
          className={cn(
            'h-9 w-9 flex items-center justify-center rounded-md border transition-colors flex-shrink-0',
            enabledOnly
              ? 'border-primary text-primary bg-primary/10'
              : 'border-border/40 text-muted-foreground hover:border-border hover:text-foreground',
          )}
          onClick={() => setEnabledOnly(prev => !prev)}
          aria-pressed={enabledOnly}
          aria-label={enabledOnly ? t('providerSettings.showAll') : t('providerSettings.showEnabledOnly')}
          title={enabledOnly ? t('providerSettings.showAll') : t('providerSettings.showEnabledOnly')}
        >
          <CircleDot className="h-4 w-4" />
        </button>
      </div>

      {/* Provider List */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-2 space-y-1.5">
          {loading && providers.length === 0 ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : filteredProviders.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-6">
              {searchTerm || enabledOnly
                ? t('providerSettings.emptySearch')
                : t('providerSettings.emptyList')}
            </p>
          ) : (
            filteredProviders.map((provider, idx) => {
              const isSelected = selectedProviderId === provider.id && !isAddingNew;
              const isDropTarget = dragEnabled && dragOverIdx === idx && dragIdx !== idx;
              return (
                <div
                  key={provider.id}
                  draggable={dragEnabled}
                  onDragStart={handleDragStart(idx)}
                  onDragOver={handleDragOver(idx)}
                  onDrop={handleDrop(idx)}
                  onDragEnd={handleDragEnd}
                  className={cn(
                    'group relative rounded-lg border transition-colors',
                    isSelected
                      ? 'border-primary bg-primary/10'
                      : 'border-transparent hover:border-primary/40 hover:bg-surface-2',
                    isDropTarget && 'border-primary/60 bg-primary/5',
                  )}
                >
                  <button
                    className={cn(
                      'w-full px-3 py-2 pl-7 text-left',
                      isSelected && 'text-primary',
                    )}
                    onClick={() => onSelectProvider(provider.id)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={cn(
                            'h-2 w-2 rounded-full flex-shrink-0',
                            provider.enabled ? 'bg-primary' : 'bg-border',
                          )}
                        />
                        <span className="font-medium text-sm truncate">{getProviderDisplayName(t, provider)}</span>
                      </div>
                      <Badge
                        variant="secondary"
                        className="text-[10px] uppercase tracking-wide flex-shrink-0"
                      >
                        {provider.enabled
                          ? t('providerSettings.enabled')
                          : t('providerSettings.disabled')}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {provider.models?.length
                        ? t('providerSettings.listStatus', { count: provider.models.length })
                        : t('providerSettings.noModels')}
                    </p>
                  </button>
                  {dragEnabled ? (
                    <span
                      className="absolute left-1 top-1/2 -translate-y-1/2 flex items-center text-muted-foreground/40 group-hover:text-muted-foreground cursor-grab active:cursor-grabbing"
                      aria-label={t('providerSettings.dragHandle')}
                      title={t('providerSettings.dragHandle')}
                    >
                      <GripVertical className="h-3.5 w-3.5" />
                    </span>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </ScrollArea>

      {/* Add Button */}
      <div className="border-t border-border/70 p-3 flex-shrink-0">
        <Button className="w-full" variant="outline" onClick={onAddProvider}>
          <Plus className="h-4 w-4 mr-1" />
          {t('providerSettings.form.buttons.submitAdd')}
        </Button>
      </div>
    </div>
  );
}
