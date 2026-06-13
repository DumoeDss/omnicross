import {
  Check,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Plus,
  RotateCcw,
  Settings2,
  TestTube,
  Trash2,
  X
} from 'lucide-react';
import React, { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { RevealableInput } from '@/components/ui/revealable-input';
import { SettingRow } from '@/components/ui/setting-row';
import { Switch } from '@/components/ui/switch';
import { useTranslation } from '@/shared/state/LocaleContext';

import type { LLMProvider, ModelConfig, ModelGroup } from '@shared/llm-config';

import { ApiKeyPoolSection } from './ApiKeyPoolSection';
import { ModelTestDialog } from './ModelTestDialog';
import { ProviderApiModeSwitcher } from './ProviderApiModeSwitcher';
import { getProviderDisplayName } from './utils';

interface ProviderDetailsProps {
  selectedProvider: LLMProvider | null;
  visibleModelGroups: ModelGroup[];
  inlineName: string;
  setInlineName: (val: string) => void;
  inlineApiKey: string;
  setInlineApiKey: (val: string) => void;
  inlineApiUrl: string;
  setInlineApiUrl: (val: string) => void;
  inlineModelsEndpoint: string;
  setInlineModelsEndpoint: (val: string) => void;
  showApiKey: boolean;
  setShowApiKey: (val: boolean) => void;
  modelStatus: { type: 'success' | 'error'; message: string } | null;
  modelSearch: string;
  setModelSearch: (val: string) => void;
  collapsedGroups: Record<string, boolean>;
  toggleGroupCollapse: (id: string) => void;
  editingModel: { id: string; name: string } | null;
  setEditingModel: React.Dispatch<React.SetStateAction<{ id: string; name: string } | null>>;

  inlineMaxConcurrency: string;
  setInlineMaxConcurrency: (val: string) => void;

  onInlineUpdate: (field: string, value: string) => Promise<void>;
  /** Fetch + show the stored API key (the daemon holds it reversibly). */
  onRevealApiKey?: () => Promise<void>;
  onSelectApiMode?: (modeId: string, opts?: { keepCustomizations?: boolean }) => Promise<boolean>;
  onToggleProvider: (enabled: boolean) => Promise<void>;
  onToggleOfficial: (isOfficial: boolean) => Promise<void>;
  onDeleteProvider: () => Promise<void>;
  /** Reset this provider to catalog defaults (provider-storage-overlay). */
  onResetProvider?: (id?: string) => Promise<void>;
  onShowManageModels: () => void;
  onShowAddModelDialog: () => void;
  onApplyModelEdit: () => Promise<void>;
  onToggleModelEnabled: (id: string, enabled: boolean) => Promise<void>;
  onRemoveModel: (id: string) => Promise<void>;
  onShowEditModelDialog: (model: ModelConfig) => void;
}

export function ProviderDetails({
  selectedProvider,
  visibleModelGroups,
  inlineName,
  setInlineName,
  inlineApiKey,
  setInlineApiKey,
  inlineApiUrl,
  setInlineApiUrl,
  inlineModelsEndpoint,
  setInlineModelsEndpoint,
  showApiKey,
  setShowApiKey,
  modelStatus,
  modelSearch,
  setModelSearch,
  collapsedGroups,
  toggleGroupCollapse,
  editingModel,
  setEditingModel,
  inlineMaxConcurrency,
  setInlineMaxConcurrency,
  onInlineUpdate,
  onRevealApiKey,
  onSelectApiMode,
  onToggleProvider,
  onToggleOfficial,
  onDeleteProvider,
  onResetProvider,
  onShowManageModels,
  onShowAddModelDialog,
  onApplyModelEdit,
  onToggleModelEnabled,
  onRemoveModel,
  onShowEditModelDialog
}: ProviderDetailsProps) {
  const t = useTranslation();
  const [testingModel, setTestingModel] = useState<{ id: string; name: string } | null>(null);
  const [pendingModeSwitch, setPendingModeSwitch] = useState<string | null>(null);
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);
  // When a key is stored but not yet revealed, the field shows masked dots (as if
  // it holds a value) — NOT a placeholder. Cleared on focus so the user can type a
  // replacement, restored on blur if they leave it untouched.
  const [apiKeyFocused, setApiKeyFocused] = useState(false);

  if (!selectedProvider) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        {t('providerSettings.details.noSelection')}
      </div>
    );
  }

  const emptyState = visibleModelGroups.length === 0;

  // provider-storage-overlay: show "restore defaults" only when the user has
  // customized a preset-tracked field. `overriddenFields` is the read-only
  // projection of the backend `userOverrides.fields`, and is ONLY ever populated
  // for preset-derived rows by `resolveEffectiveProvider` — so a non-empty list
  // already implies preset-derived (custom rows get `[]`).
  const hasOverrides = Boolean(
    onResetProvider && (selectedProvider.overriddenFields?.length ?? 0) > 0,
  );

  const getGroupDisplayName = (group: ModelGroup) => {
    if (group.id === 'default') {
      return t('providerSettings.modelsManager.defaultGroup');
    }
    return group.name || group.id;
  };

  const getApiFormatLabel = (provider: LLMProvider): string => {
    // Use apiFormat (v3 field) first, fall back to apiType for legacy
    const format = provider.apiFormat || provider.apiType;
    switch (format) {
      case 'anthropic':
        return t('providerSettings.tags.anthropic');
      case 'google':
        return t('providerSettings.tags.gemini');
      case 'claudecode':
        return t('providerSettings.tags.claudeCode');
      case 'openai':
      default:
        return t('providerSettings.tags.openai');
    }
  };

  return (
    <div className="p-4 md:p-6 space-y-6">
      {/* Header with toggle */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div>
            {selectedProvider.isSystem ? (
              // Built-in providers display a locale-aware translated name and
              // can't be renamed. This avoids the "user-rename vs i18n" tug
              // of war and keeps the UI consistent across locales.
              <h2 className="h-9 text-lg font-semibold flex items-center px-0">
                {getProviderDisplayName(t, selectedProvider)}
              </h2>
            ) : (
              // Inline rename (app-parity-2 child 1) — the daemon now stores a
              // mutable display `name`; commit on blur/Enter. The id stays the
              // immutable identity (only the label changes). Empty input is a
              // no-op (the adapter only sends a non-empty name), so the name
              // cannot be blanked away.
              <Input
                value={inlineName}
                onChange={(e) => setInlineName(e.target.value)}
                onBlur={() => {
                  if (inlineName.trim() && inlineName !== getProviderDisplayName(t, selectedProvider)) {
                    onInlineUpdate('name', inlineName.trim());
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
                className="h-9 text-lg font-semibold border-transparent bg-transparent px-0"
              />
            )}
            <Badge variant="outline">
              {getApiFormatLabel(selectedProvider)}
            </Badge>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Restore-defaults — only when this preset-derived row has user
              overrides (provider-storage-overlay). Clears userOverrides so the
              live catalog flows again; key + sessions preserved. */}
          {hasOverrides ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmResetOpen(true)}
              title={t('providerSettings.reset.button')}
            >
              <RotateCcw className="h-4 w-4 mr-1" />
              {t('providerSettings.reset.button')}
            </Button>
          ) : null}
          <Switch
            checked={selectedProvider.enabled}
            onCheckedChange={onToggleProvider}
          />
          {/* Delete button - only for non-system providers */}
          {!selectedProvider.isSystem && (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => void onDeleteProvider()}
              title={t('common.delete')}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* API Key - Inline Editable. provider-storage-secrets: the stored key is
          never echoed back, so the field shows a masked "key is set" placeholder
          when `hasKey` and an empty blur leaves the stored key unchanged. */}
      <FormField
        label={t('providerSettings.credentials.apiKey')}
        description={selectedProvider.hasKey
          ? t('providerSettings.form.apiKeyReplaceHelper')
          : t('providerSettings.form.apiKeyHelper')}
      >
        <RevealableInput
          revealed={showApiKey}
          onRevealedChange={(revealed) => {
            setShowApiKey(revealed);
            // Revealing a stored-but-unshown key: fetch the real (decrypted) value
            // and drop it into the field. Only when the user hasn't typed a new one.
            if (revealed && selectedProvider.hasKey && inlineApiKey.trim().length === 0) {
              void onRevealApiKey?.();
            }
          }}
          // No placeholder for a stored key — the masked dots (below) ARE the
          // "key is set" indicator. The placeholder is only for an unset key.
          placeholder={selectedProvider.hasKey ? '' : t('providerSettings.form.apiKeyPlaceholder')}
          // Show masked dots when a key is stored but not revealed/edited/focused
          // (a real-looking masked value, not greyed placeholder text). The eye
          // reveal fetches the actual key into `inlineApiKey`, which then displays.
          value={
            selectedProvider.hasKey && !showApiKey && !apiKeyFocused && inlineApiKey.length === 0
              ? '••••••••••••'
              : inlineApiKey
          }
          onChange={(e) => setInlineApiKey(e.target.value)}
          onFocus={() => setApiKeyFocused(true)}
          onBlur={() => {
            setApiKeyFocused(false);
            // Only persist a non-empty replacement; empty = leave unchanged.
            if (inlineApiKey.trim().length > 0 && inlineApiKey !== (selectedProvider.api_key || '')) {
              onInlineUpdate('api_key', inlineApiKey);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur();
            }
          }}
        />
      </FormField>

      {/* API Key Pool */}
      <ApiKeyPoolSection providerId={selectedProvider.id} />

      {/* API mode switcher — only renders when provider declares >= 2 modes */}
      {(() => {
        const apiModes = selectedProvider.apiModes;
        if (!apiModes || apiModes.length < 2 || !onSelectApiMode) return null;
        return (
        <FormField label={t('apiMode.label')}>
          {/* API mode switcher (app-parity-2 child 4) — daemon-backed. The daemon
              stores apiModes + selectedApiModeId; core's resolveProviderEndpoint
              (layer 1) routes via the selected mode. Switching syncs the mode's
              baseUrl here (non-secret) and the mode's key server-side; a detected
              customization opens the confirm dialog (keep vs overwrite). */}
          <div className="flex flex-col gap-1.5">
            <ProviderApiModeSwitcher
              modes={apiModes}
              selectedId={selectedProvider.selectedApiModeId}
              onChange={(modeId) => {
                void onSelectApiMode(modeId).then((applied) => {
                  if (!applied) setPendingModeSwitch(modeId);
                });
              }}
            />
            {(() => {
              const active = apiModes.find(m => m.id === selectedProvider.selectedApiModeId);
              if (!active?.note) return null;
              return <p className="text-[11px] text-muted-foreground">{t(active.note) || active.note}</p>;
            })()}
            {(() => {
              const active = apiModes.find(m => m.id === selectedProvider.selectedApiModeId);
              if (!active?.apiKeyPrefix) return null;
              return (
                <p className="text-[11px] text-muted-foreground">
                  {t('apiMode.apiKeyPrefixHint', { prefix: active.apiKeyPrefix })}
                </p>
              );
            })()}
          </div>
        </FormField>
        );
      })()}

      <Dialog
        open={pendingModeSwitch !== null}
        onOpenChange={(open) => { if (!open) setPendingModeSwitch(null); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('apiMode.confirmOverwriteTitle')}</DialogTitle>
            <DialogDescription>{t('apiMode.confirmOverwriteBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingModeSwitch(null)}>
              {t('common.cancel') || 'Cancel'}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                if (pendingModeSwitch && onSelectApiMode) {
                  void onSelectApiMode(pendingModeSwitch, { keepCustomizations: true });
                }
                setPendingModeSwitch(null);
              }}
            >
              {t('apiMode.keepCustomizations')}
            </Button>
            <Button
              onClick={() => {
                if (pendingModeSwitch && onSelectApiMode) {
                  void onSelectApiMode(pendingModeSwitch);
                }
                setPendingModeSwitch(null);
              }}
            >
              {t('apiMode.overwriteAndSwitch')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* API URL - Inline Editable */}
      <FormField
        label={t('providerSettings.credentials.apiBaseUrl')}
        labelAction={selectedProvider.website ? (
          <a
            href={selectedProvider.website}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground hover:text-foreground transition-colors"
            title={t('mediaSettings.common.learnMore')}
          >
            <ExternalLink className="h-4 w-4" />
          </a>
        ) : undefined}
      >
        <Input
          placeholder={selectedProvider.api_base_url || t('providerSettings.form.apiUrlPlaceholder')}
          value={inlineApiUrl}
          onChange={(e) => setInlineApiUrl(e.target.value)}
          onBlur={() => {
            if (inlineApiUrl !== (selectedProvider.api_base_url || '')) {
              onInlineUpdate('api_base_url', inlineApiUrl);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur();
            }
          }}
        />
      </FormField>

      {/* Official Anthropic API toggle — daemon-backed (app-parity child 1):
          persisted as the provider row's `isOfficial`. */}
      {(selectedProvider.apiFormat || selectedProvider.apiType) === 'anthropic' ? (
        <SettingRow
          label={t('providerSettings.form.official')}
          description={t('providerSettings.form.officialHelper')}
          className="border-0 bg-transparent px-0"
        >
          <Switch
            checked={selectedProvider.isOfficial ?? false}
            onCheckedChange={(checked) => onToggleOfficial(checked)}
          />
        </SettingRow>
      ) : null}

      {/* Max Concurrent Requests — daemon-backed (app-parity child 1): persisted
          as the provider row's `maxConcurrency` (empty/0 → null = clear). */}
      <FormField label={t('providerSettings.form.maxConcurrency')} description={t('providerSettings.form.maxConcurrencyHelper')}>
        <Input
          type="number"
          min={-1}
          max={100}
          placeholder="-1"
          value={inlineMaxConcurrency}
          onChange={(e) => setInlineMaxConcurrency(e.target.value)}
          onBlur={() => {
            if (inlineMaxConcurrency !== (selectedProvider.maxConcurrency != null ? String(selectedProvider.maxConcurrency) : '')) {
              onInlineUpdate('maxConcurrency', inlineMaxConcurrency);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur();
            }
          }}
        />
      </FormField>

      {modelStatus ? <div
          className={`text-xs px-3 py-2 rounded border ${
            modelStatus.type === 'success'
              ? 'border-success/30 bg-success/10 text-success'
              : 'border-destructive/30 bg-destructive/10 text-destructive'
          }`}
        >
          {modelStatus.message}
        </div> : null}

      {/* Model management section */}
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {/* Search input */}
          <div className="relative flex-1 min-w-[180px]">
            <Input
              placeholder={t('providerSettings.modelsManager.searchPlaceholder')}
              value={modelSearch}
              onChange={(e) => setModelSearch(e.target.value)}
              className="pr-8"
            />
            {modelSearch ? <button
                type="button"
                className="absolute inset-y-0 right-0 flex items-center pr-3 text-muted-foreground"
                onClick={() => setModelSearch('')}
              >
                <X className="h-4 w-4" />
              </button> : null}
          </div>
          {/* Manage button */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onShowManageModels}
          >
            <Settings2 className="h-4 w-4 mr-1" />
            {t('providerSettings.modelsManager.manage')}
          </Button>
          {/* Add model button */}
          <Button
            type="button"
            size="sm"
            onClick={onShowAddModelDialog}
          >
            <Plus className="h-4 w-4 mr-1" />
            {t('providerSettings.modelsManager.add')}
          </Button>
        </div>
        {/* Models endpoint — daemon-backed (app-parity child 1): persisted as the
            provider row's `modelsEndpoint`. */}
        <div className="space-y-1">
          <label className="text-xs font-medium">{t('providerSettings.details.modelsEndpoint')}</label>
          <Input
            value={inlineModelsEndpoint}
            placeholder={`${selectedProvider.api_base_url?.replace(/\/chat\/completions$/, '/models') || ''}`}
            onChange={(e) => setInlineModelsEndpoint(e.target.value)}
            onBlur={() => {
              if (inlineModelsEndpoint !== (selectedProvider.modelsEndpoint || '')) {
                onInlineUpdate('modelsEndpoint', inlineModelsEndpoint);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur();
              }
            }}
          />
          <p className="text-[11px] text-muted-foreground">
            {t('providerSettings.details.modelsEndpointHelper')}
          </p>
        </div>
      </div>

      {/* Model list - always shown */}
      <div className="space-y-2">
        {emptyState ? (
          <div className="text-sm text-muted-foreground italic">
            {t('providerSettings.modelsManager.empty')}
          </div>
        ) : (
          visibleModelGroups.map(group => (
            <div key={group.id} className="border rounded-md overflow-hidden">
              <button
                type="button"
                className="w-full flex items-center justify-between px-3 py-2 bg-muted/40 hover:bg-muted/60 transition-colors"
                onClick={() => toggleGroupCollapse(group.id)}
              >
                <div>
                  <div className="text-sm font-medium">{getGroupDisplayName(group)}</div>
                  <div className="text-xs text-muted-foreground">
                    {t('providerSettings.listStatus', { count: group.models.length })}
                  </div>
                </div>
                {collapsedGroups[group.id] ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronUp className="h-4 w-4" />
                )}
              </button>
              {!collapsedGroups[group.id] && (
                <div className="divide-y">
                  {group.models.map(model => {
                    const isEditing = editingModel?.id === model.id;
                    const enabled = model.enabled !== false;
                    return (
                      <div key={model.id} className="flex items-center gap-3 px-3 py-2">
                        <div className="flex-1 min-w-0">
                          {isEditing ? (
                            // Inline model RENAME is now daemon-backed via
                            // `modelConfigs[].name` (app-parity child 2) — live.
                            // The model id itself is immutable here (id edit lives
                            // in the EditModelDialog where it edits `models[]`).
                            <div className="flex gap-2">
                              <Input
                                className="flex-1"
                                value={editingModel?.name || ''}
                                onChange={(e) =>
                                  setEditingModel(prev => (prev ? { ...prev, name: e.target.value } : prev))
                                }
                              />
                              <Button size="sm" onClick={() => void onApplyModelEdit()}>
                                <Check className="h-4 w-4" />
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => setEditingModel(null)}>
                                <X className="h-4 w-4" />
                              </Button>
                            </div>
                          ) : (
                            <>
                              <div className="font-medium text-sm truncate">{model.name || model.id}</div>
                              <div className="flex items-center gap-1.5">
                                <span className="text-xs text-muted-foreground truncate">{model.id}</span>
                                {model.vision ? <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 shrink-0">{t('providerSettings.modelsManager.filters.vision')}</Badge> : null}
                                {model.reasoning ? <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 shrink-0">{t('providerSettings.modelsManager.filters.reasoning')}</Badge> : null}
                              </div>
                            </>
                          )}
                        </div>
                        {!isEditing && (
                          <>
                            <Badge variant={enabled ? 'outline' : 'secondary'}>
                              {enabled
                                ? t('providerSettings.modelsManager.enabled')
                                : t('providerSettings.modelsManager.disabled')}
                            </Badge>
                            {/* Per-model enable toggle is daemon-backed via
                                `modelConfigs[].enabled` (app-parity child 2) — live.
                                ENFORCED (parity-2 child 2): disabling drops the
                                model from the daemon's advertised/routed catalog
                                (a discovery gate). Honest scope: not a hard
                                request block — a directly-requested disabled model
                                id still reaches the upstream (which rejects it). */}
                            <Switch
                              checked={enabled}
                              onCheckedChange={(checked) => void onToggleModelEnabled(model.id, checked)}
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              title={t('providerSettings.modelsManager.testDialog.testButton')}
                              onClick={() => setTestingModel({ id: model.id, name: model.name || model.id })}
                            >
                              <TestTube className="h-4 w-4" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => onShowEditModelDialog(model)}
                            >
                              <Settings2 className="h-4 w-4" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="text-destructive hover:text-destructive/80"
                              onClick={() => void onRemoveModel(model.id)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Model Test Dialog */}
      {selectedProvider && testingModel ? <ModelTestDialog
          open={!!testingModel}
          onOpenChange={(open) => { if (!open) setTestingModel(null); }}
          providerId={selectedProvider.id}
          providerName={getProviderDisplayName(t, selectedProvider)}
          modelId={testingModel.id}
          modelName={testingModel.name}
        /> : null}

      {/* Reset-to-default confirmation (provider-storage-overlay) */}
      <ConfirmDialog
        open={confirmResetOpen}
        onOpenChange={setConfirmResetOpen}
        title={t('providerSettings.reset.confirmTitle')}
        description={t('providerSettings.reset.confirmBody')}
        confirmLabel={t('providerSettings.reset.confirmButton')}
        variant="default"
        onConfirm={() => {
          void onResetProvider?.(selectedProvider.id);
          setConfirmResetOpen(false);
        }}
      />
    </div>
  );
}
