import React, { useEffect } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Unbacked } from '@/components/ui/unbacked';
import { useTranslation } from '@/shared/state/LocaleContext';

import type { LLMProvider, ModelGroup, OpenRouterProviderRouting } from '@shared/llm-config';

import { OpenRouterProviderConfig } from './OpenRouterProviderConfig';
import { isOpenRouterProvider } from './utils';

export interface EditModelEntry {
  id: string;
  name: string;
  groupId: string;
  openRouterProvider?: OpenRouterProviderRouting;
  vision?: boolean;
  reasoning?: boolean;
}

interface EditModelDialogProps {
  selectedProvider: LLMProvider | null;
  showEditModelDialog: boolean;
  setShowEditModelDialog: (val: boolean) => void;
  editModelEntry: EditModelEntry;
  setEditModelEntry: React.Dispatch<React.SetStateAction<EditModelEntry>>;
  normalizedModelGroups: ModelGroup[];
  onApplyEditModelDialog: () => Promise<void>;
  setEditingModel: React.Dispatch<React.SetStateAction<{ id: string; name: string } | null>>;
}

export function EditModelDialog({
  selectedProvider,
  showEditModelDialog,
  setShowEditModelDialog,
  editModelEntry,
  setEditModelEntry,
  normalizedModelGroups,
  onApplyEditModelDialog,
  setEditingModel
}: EditModelDialogProps) {
  const t = useTranslation();

  const handleClose = () => {
    setShowEditModelDialog(false);
    setEditingModel(null);
    setEditModelEntry({ id: '', name: '', groupId: 'default', openRouterProvider: undefined, vision: undefined, reasoning: undefined });
  };

  // ESC key handler
  useEffect(() => {
    if (!showEditModelDialog) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showEditModelDialog]);

  if (!selectedProvider || !showEditModelDialog) return null;

  const showOpenRouterConfig = isOpenRouterProvider(selectedProvider);

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className={`bg-background border rounded-lg shadow-xl w-full ${showOpenRouterConfig ? 'max-w-lg max-h-[90vh] flex flex-col' : 'max-w-md'}`}>
        <div className="p-4 border-b flex-shrink-0">
          <h3 className="text-lg font-semibold">{t('providerSettings.modelsManager.editDialog.title')}</h3>
          <p className="text-xs text-muted-foreground mt-1">
            {t('providerSettings.modelsManager.editDialog.subtitle')}
          </p>
        </div>
        <div className={`p-4 space-y-4 ${showOpenRouterConfig ? 'overflow-y-auto flex-1' : ''}`}>
          <div className="space-y-1.5">
            <label className="text-sm font-medium flex items-center gap-1">
              {t('providerSettings.modelsManager.editDialog.modelId')}
              <span className="text-red-500">*</span>
            </label>
            <Input
              value={editModelEntry.id}
              onChange={(e) => setEditModelEntry(prev => ({ ...prev, id: e.target.value }))}
              placeholder={t('providerSettings.modelsManager.editDialog.modelIdPlaceholder')}
            />
            <p className="text-xs text-muted-foreground">
              {t('providerSettings.modelsManager.editDialog.modelIdHelper')}
            </p>
          </div>
          {/* Model NAME is now daemon-backed via `modelConfigs[].name` (app-parity
              child 2) — live. The model ID above is also backed (edits `models[]`). */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              {t('providerSettings.modelsManager.editDialog.modelName')}
            </label>
            <Input
              value={editModelEntry.name}
              onChange={(e) => setEditModelEntry(prev => ({ ...prev, name: e.target.value }))}
              placeholder={t('providerSettings.modelsManager.editDialog.modelNamePlaceholder')}
            />
            <p className="text-xs text-muted-foreground">
              {t('providerSettings.modelsManager.editDialog.modelNameHelper')}
            </p>
          </div>
          {/* Model GROUP is now daemon-backed via `modelConfigs[].group` (the app
              derives groups from it — no separate daemon array) — live. */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('providerSettings.modelsManager.editDialog.group')}</label>
            <Input
              className="w-full"
              value={editModelEntry.groupId}
              onChange={(e) => setEditModelEntry(prev => ({ ...prev, groupId: e.target.value }))}
              placeholder={t('providerSettings.modelsManager.editDialog.groupPlaceholder')}
            />
          </div>

          {/* Vision / Reasoning flags are now daemon-backed via
              `modelConfigs[].vision`/`.reasoning` (app-parity child 2) — live.
              NOTE: persisted-not-enforced — display/management metadata, not a
              routing gate. */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm font-medium">{t('providerSettings.modelsManager.editDialog.vision')}</label>
              <p className="text-xs text-muted-foreground">{t('providerSettings.modelsManager.editDialog.visionHint')}</p>
            </div>
            <Switch
              checked={editModelEntry.vision ?? false}
              onCheckedChange={(checked) => setEditModelEntry(prev => ({ ...prev, vision: checked }))}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm font-medium">{t('providerSettings.modelsManager.editDialog.reasoning')}</label>
              <p className="text-xs text-muted-foreground">{t('providerSettings.modelsManager.editDialog.reasoningHint')}</p>
            </div>
            <Switch
              checked={editModelEntry.reasoning ?? false}
              onCheckedChange={(checked) => setEditModelEntry(prev => ({ ...prev, reasoning: checked }))}
            />
          </div>

          {/* OpenRouter Provider Routing — UNBACKED (the daemon stores no
              per-model routing config; the adapter drops it on write). Renders
              for parity but is inert (D6). */}
          {isOpenRouterProvider(selectedProvider) && (
            <Unbacked>
              <OpenRouterProviderConfig
                config={editModelEntry.openRouterProvider || {}}
                onChange={() => {
                  // unbacked — no daemon op
                }}
              />
            </Unbacked>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t px-4 py-3 bg-muted/30 flex-shrink-0">
          <Button
            type="button"
            variant="ghost"
            onClick={handleClose}
          >
            {t('providerSettings.modelsManager.editDialog.cancel')}
          </Button>
          <Button
            type="button"
            onClick={() => void onApplyEditModelDialog()}
            disabled={!editModelEntry.id.trim()}
          >
            {t('providerSettings.modelsManager.editDialog.submit')}
          </Button>
        </div>
      </div>
    </div>
  );
}

