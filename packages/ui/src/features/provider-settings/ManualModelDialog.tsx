import React, { useEffect } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Unbacked, useUnbackedTitle } from '@/components/ui/unbacked';
import { useTranslation } from '@/shared/state/LocaleContext';

import type { LLMProvider, ModelGroup, OpenRouterProviderRouting } from '@shared/llm-config';

import { OpenRouterProviderConfig } from './OpenRouterProviderConfig';
import { isOpenRouterProvider } from './utils';

interface ManualModelDialogProps {
  selectedProvider: LLMProvider | null;
  showAddModelDialog: boolean;
  setShowAddModelDialog: (val: boolean) => void;
  newModelEntry: { id: string; name: string; groupId: string; openRouterProvider?: OpenRouterProviderRouting; vision?: boolean; reasoning?: boolean };
  setNewModelEntry: React.Dispatch<React.SetStateAction<{ id: string; name: string; groupId: string; openRouterProvider?: OpenRouterProviderRouting; vision?: boolean; reasoning?: boolean }>>;
  normalizedModelGroups: ModelGroup[];
  defaultGroupId: string;
  onAddModelEntry: (id: string, name: string, groupId: string, openRouterProvider?: OpenRouterProviderRouting, vision?: boolean, reasoning?: boolean) => Promise<void>;
}

export function ManualModelDialog({
  selectedProvider,
  showAddModelDialog,
  setShowAddModelDialog,
  newModelEntry,
  setNewModelEntry,
  normalizedModelGroups,
  defaultGroupId,
  onAddModelEntry
}: ManualModelDialogProps) {
  const t = useTranslation();
  const unbackedTitle = useUnbackedTitle();

  const handleClose = () => {
    setShowAddModelDialog(false);
    setNewModelEntry({ id: '', name: '', groupId: defaultGroupId, openRouterProvider: undefined, vision: undefined, reasoning: undefined });
  };

  // ESC key handler
  useEffect(() => {
    if (!showAddModelDialog) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showAddModelDialog]);

  if (!selectedProvider || !showAddModelDialog) return null;

  const showOpenRouterConfig = isOpenRouterProvider(selectedProvider);

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className={`bg-background border rounded-lg shadow-xl w-full ${showOpenRouterConfig ? 'max-w-lg max-h-[90vh] flex flex-col' : 'max-w-md'}`}>
        <div className="p-4 border-b flex-shrink-0">
          <h3 className="text-lg font-semibold">{t('providerSettings.modelsManager.manualDialog.title')}</h3>
          <p className="text-xs text-muted-foreground mt-1">
            {t('providerSettings.modelsManager.manualDialog.subtitle')}
          </p>
        </div>
        <div className={`p-4 space-y-4 ${showOpenRouterConfig ? 'overflow-y-auto flex-1' : ''}`}>
          <div className="space-y-1.5">
            <label className="text-sm font-medium flex items-center gap-1">
              {t('providerSettings.modelsManager.manualDialog.modelId')}
              <span className="text-red-500">*</span>
            </label>
            <Input
              value={newModelEntry.id}
              onChange={(e) => setNewModelEntry(prev => ({ ...prev, id: e.target.value }))}
              placeholder={t('providerSettings.modelsManager.manualDialog.modelIdPlaceholder')}
            />
            <p className="text-xs text-muted-foreground">
              {t('providerSettings.modelsManager.manualDialog.modelIdHelper')}
            </p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              {t('providerSettings.modelsManager.manualDialog.modelName')}
            </label>
            {/* Model NAME is UNBACKED (daemon stores models as a flat string[]).
                Disabled-with-tooltip; the model ID above IS backed (D6). */}
            <Unbacked>
              <Input
                value={newModelEntry.name}
                disabled
                title={unbackedTitle}
                placeholder={t('providerSettings.modelsManager.manualDialog.modelNamePlaceholder')}
              />
            </Unbacked>
            <p className="text-xs text-muted-foreground">
              {t('providerSettings.modelsManager.manualDialog.modelNameHelper')}
            </p>
          </div>
          {/* Model GROUP is UNBACKED (no daemon model-group storage) — disabled. */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('providerSettings.modelsManager.manualDialog.group')}</label>
            <Unbacked>
              <Input
                className="w-full"
                value={newModelEntry.groupId}
                disabled
                title={unbackedTitle}
                placeholder={t('providerSettings.modelsManager.manualDialog.groupPlaceholder')}
              />
            </Unbacked>
          </div>

          {/* Vision / Reasoning flags are UNBACKED (no per-model caps storage). */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm font-medium">{t('providerSettings.modelsManager.editDialog.vision')}</label>
              <p className="text-xs text-muted-foreground">{t('providerSettings.modelsManager.editDialog.visionHint')}</p>
            </div>
            <Unbacked>
              <Switch checked={newModelEntry.vision ?? false} disabled />
            </Unbacked>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm font-medium">{t('providerSettings.modelsManager.editDialog.reasoning')}</label>
              <p className="text-xs text-muted-foreground">{t('providerSettings.modelsManager.editDialog.reasoningHint')}</p>
            </div>
            <Unbacked>
              <Switch checked={newModelEntry.reasoning ?? false} disabled />
            </Unbacked>
          </div>

          {/* OpenRouter Provider Routing — UNBACKED (no daemon per-model routing
              storage; the adapter drops it on write). Inert (D6). */}
          {showOpenRouterConfig ? (
            <Unbacked>
              <OpenRouterProviderConfig
                config={newModelEntry.openRouterProvider || {}}
                onChange={() => {
                  // unbacked — no daemon op
                }}
              />
            </Unbacked>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-2 border-t px-4 py-3 bg-muted/30 flex-shrink-0">
          <Button
            type="button"
            variant="ghost"
            onClick={handleClose}
          >
            {t('providerSettings.modelsManager.manualDialog.cancel')}
          </Button>
          <Button
            type="button"
            onClick={() => void onAddModelEntry(newModelEntry.id, newModelEntry.name, newModelEntry.groupId, newModelEntry.openRouterProvider, newModelEntry.vision, newModelEntry.reasoning)}
            disabled={!newModelEntry.id.trim()}
          >
            {t('providerSettings.modelsManager.manualDialog.submit')}
          </Button>
        </div>
      </div>
    </div>
  );
}

