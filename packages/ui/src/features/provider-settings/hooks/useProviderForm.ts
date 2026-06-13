import { useCallback, useState } from 'react';

import { agent } from '@/shared/agent';
import { useTranslation } from '@/shared/state/LocaleContext';

import type {
  LLMProvider,
  ProviderTemplate,
} from '@shared/llm-config';

import { emptyFormData } from '../constants';
import type { ProviderFormData } from '../types';
import { getProviderDisplayName } from '../utils';

/**
 * Manages provider form state, inline editing, and provider CRUD operations.
 */
export function useProviderForm(
  providers: LLMProvider[],
  selectedProviderId: string | null,
  setSelectedProviderId: (id: string | null) => void,
  selectedProvider: LLMProvider | null,
  refreshProviders: () => Promise<void>,
  updateProviderInCache: (p: LLMProvider) => void,
) {
  const t = useTranslation();

  // ── Form state ──────────────────────────────────────────────────
  const [isEditing, setIsEditing] = useState(false);
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [formData, setFormData] = useState<ProviderFormData>(emptyFormData);
  const [showApiKey, setShowApiKey] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);

  // ── Inline edit state ───────────────────────────────────────────
  const [inlineName, setInlineName] = useState('');
  const [inlineModelsEndpoint, setInlineModelsEndpoint] = useState('');
  const [inlineApiKey, setInlineApiKey] = useState('');
  const [inlineApiUrl, setInlineApiUrl] = useState('');
  const [inlineMaxConcurrency, setInlineMaxConcurrency] = useState('');

  const updateProviderState = useCallback((updated: LLMProvider) => {
    updateProviderInCache(updated);
  }, [updateProviderInCache]);

  // ── Sync inline fields when selected provider changes ──
  const [prevSelectedId, setPrevSelectedId] = useState(selectedProvider?.id);
  if (prevSelectedId !== selectedProvider?.id) {
    setPrevSelectedId(selectedProvider?.id);
    if (selectedProvider) {
      // provider-storage-secrets: the key is NEVER echoed to the renderer, so
      // seed the inline key field EMPTY (a masked "key is set" state shows when
      // `hasKey`). A `$VAR` env ref is not a secret — preserve it for display.
      setInlineApiKey(selectedProvider.api_key?.startsWith('$') ? selectedProvider.api_key : '');
      setInlineApiUrl(selectedProvider.api_base_url || '');
      setInlineName(getProviderDisplayName(t, selectedProvider));
      setInlineModelsEndpoint(selectedProvider.modelsEndpoint || '');
      setInlineMaxConcurrency(selectedProvider.maxConcurrency != null ? String(selectedProvider.maxConcurrency) : '');
    }
  }

  // ── Handlers ────────────────────────────────────────────────────
  const handleSelectProvider = (providerId: string) => {
    setSelectedProviderId(providerId);
    setIsEditing(false);
    setIsAddingNew(false);
    setFormError(null);
  };

  const handleAddProvider = () => {
    setFormData(emptyFormData);
    setIsAddingNew(true);
    setIsEditing(false);
    setSelectedProviderId(null);
    setShowApiKey(false);
    setFormError(null);
    setShowTemplates(false);
  };

  /**
   * Materialize a synthesized "preset" list row into a REAL daemon provider.
   * Called the first time the user configures/enables a preset row (the row is
   * merged into the list by `useProviderSettings` and marked `__preset`). Uses
   * the preset's OWN id (`addFromPreset` → POST with that id) so the synthesized
   * row dedups against the new provider and flips in place. After this returns,
   * the row is a normal provider and update/toggle handlers apply.
   */
  const materializePreset = async (
    provider: LLMProvider,
    opts: { apiKey?: string; enabled?: boolean },
  ): Promise<boolean> => {
    try {
      const result = await agent.llmConfig.addFromPreset?.({
        presetId: provider.presetId ?? provider.id,
        apiKey: opts.apiKey,
        enabled: opts.enabled,
      });
      if (result && !result.success) {
        setFormError(result.message ?? t('providerSettings.errors.saveFailed'));
        return false;
      }
      setSelectedProviderId(result?.provider?.id ?? provider.id);
      setFormError(null);
      await refreshProviders();
      return true;
    } catch (error) {
      console.error('Error materializing preset:', error);
      setFormError(t('providerSettings.errors.saveFailed'));
      return false;
    }
  };

  const handleUseTemplate = (template: ProviderTemplate) => {
    setFormData({
      name: template.name,
      apiFormat: template.apiFormat || 'openai',
      chatApiFormat: template.chatApiFormat || template.apiFormat || 'openai',
      apiType: template.apiType,
      api_base_url: template.api_base_url,
      api_key: '',
      models: [...template.models],
      modelConfigs: template.modelConfigs ? [...template.modelConfigs] : [],
      modelGroups: template.modelGroups ? [...template.modelGroups] : [],
      modelsEndpoint: template.modelsEndpoint,
      enabled: true,
      icon: template.icon,
      transformer: template.transformer,
      apiVersion: template.apiVersion,
      maxConcurrency: template.maxConcurrency,
    });
    setShowTemplates(false);
  };

  const handleEditProvider = () => {
    if (!selectedProvider) return;
    setFormData({
      name: selectedProvider.name,
      apiFormat: selectedProvider.apiFormat || 'openai',
      chatApiFormat: selectedProvider.chatApiFormat || selectedProvider.apiFormat || 'openai',
      apiType: selectedProvider.apiType || 'openai',
      api_base_url: selectedProvider.api_base_url || '',
      // provider-storage-secrets: never prefill the key (it isn't echoed back).
      // Empty on save = "leave the stored key unchanged"; `$VAR` refs are shown.
      api_key: selectedProvider.api_key?.startsWith('$') ? selectedProvider.api_key : '',
      models: selectedProvider.models || [],
      modelConfigs: selectedProvider.modelConfigs || [],
      modelGroups: selectedProvider.modelGroups || [],
      modelsEndpoint: selectedProvider.modelsEndpoint || '',
      enabled: selectedProvider.enabled,
      icon: selectedProvider.icon,
      transformer: selectedProvider.transformer,
      apiVersion: selectedProvider.apiVersion,
      isOfficial: selectedProvider.isOfficial,
      maxConcurrency: selectedProvider.maxConcurrency,
    });
    setIsEditing(true);
    setIsAddingNew(false);
    setShowApiKey(false);
    setFormError(null);
  };

  const handleSaveProvider = async () => {
    if (!formData.name.trim()) {
      setFormError(t('providerSettings.errors.nameRequired'));
      return;
    }
    if (!formData.api_base_url.trim()) {
      setFormError(t('providerSettings.errors.urlRequired'));
      return;
    }
    // Validate URL format
    try {
      new URL(formData.api_base_url.trim());
    } catch {
      setFormError(t('providerSettings.errors.urlInvalid'));
      return;
    }

    // Saving the form for a synthesized preset row → materialize (create) it
    // rather than PUT a provider the daemon doesn't have yet.
    if (selectedProvider?.__preset) {
      const materialized = await materializePreset(selectedProvider, {
        apiKey: formData.api_key.trim() || undefined,
        enabled: formData.enabled,
      });
      if (materialized) {
        setIsEditing(false);
        setIsAddingNew(false);
      }
      return;
    }

    try {
      if (isEditing && selectedProviderId) {
        // provider-storage-secrets leave-unchanged-on-empty: only send `api_key`
        // when the user actually typed a replacement; an empty field preserves
        // the stored (encrypted) key rather than wiping it.
        const keyEdited = formData.api_key.trim().length > 0;
        await agent.llmConfig.updateProvider({
          id: selectedProviderId,
          name: formData.name,
          apiFormat: formData.apiFormat,
          chatApiFormat: formData.chatApiFormat,
          apiType: formData.apiType,
          api_base_url: formData.api_base_url,
          ...(keyEdited ? { api_key: formData.api_key } : {}),
          models: formData.models,
          modelConfigs: formData.modelConfigs,
          modelGroups: formData.modelGroups,
          modelsEndpoint: formData.modelsEndpoint,
          enabled: formData.enabled,
          icon: formData.icon,
          transformer: formData.transformer,
          apiVersion: formData.apiVersion,
          isOfficial: formData.isOfficial,
          maxConcurrency: formData.maxConcurrency,
          codingPlan: formData.codingPlan,
          presetId: formData.presetId,
        });
      } else {
        const result = await agent.llmConfig.addProvider({
          name: formData.name,
          apiFormat: formData.apiFormat,
          chatApiFormat: formData.chatApiFormat,
          apiType: formData.apiType,
          api_base_url: formData.api_base_url,
          api_key: formData.api_key,
          models: formData.models,
          modelConfigs: formData.modelConfigs,
          modelGroups: formData.modelGroups,
          modelsEndpoint: formData.modelsEndpoint,
          enabled: formData.enabled,
          icon: formData.icon,
          transformer: formData.transformer,
          apiVersion: formData.apiVersion,
          isOfficial: formData.isOfficial,
          maxConcurrency: formData.maxConcurrency,
          codingPlan: formData.codingPlan,
          presetId: formData.presetId,
        });
        if (result.provider) {
          setSelectedProviderId(result.provider.id);
        } else if (result.message) {
          setFormError(result.message);
          return;
        }
      }
      setIsEditing(false);
      setIsAddingNew(false);
      await refreshProviders();
    } catch (error) {
      console.error('Error saving provider:', error);
      setFormError(t('providerSettings.errors.saveFailed'));
    }
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setIsAddingNew(false);
    setFormError(null);
    if (providers.length > 0 && !selectedProviderId) {
      setSelectedProviderId(providers[0].id);
    }
  };

  const handleInlineUpdate = async (field: string, value: string) => {
    if (!selectedProviderId || !selectedProvider) return;
    // A synthesized preset row is not a real provider yet — materialize it on
    // the first key entry (id/url/format are the preset's; only the key is the
    // user's). Other inline fields are disabled for preset rows.
    if (selectedProvider.__preset) {
      if (field === 'api_key' && value.trim().length > 0) {
        await materializePreset(selectedProvider, { apiKey: value });
      }
      return;
    }
    // provider-storage-secrets leave-unchanged-on-empty: an empty inline key
    // edit must NOT wipe the stored (encrypted) key — treat it as a no-op.
    if (field === 'api_key' && value.trim().length === 0) return;
    try {
      // Three-way write contract for the clearable scalar fields (app-parity
      // child 1): a value sets, an EMPTY input clears (→ `null`, NOT `''`, so the
      // daemon removes the stored field instead of keeping it on a falsy `''`).
      // `maxConcurrency` parses to an int (or `null` when empty/invalid); the
      // clearable string fields map empty → `null`. Non-clearable string fields
      // (api_base_url/name) pass through verbatim.
      const isClearableString = field === 'modelsEndpoint' || field === 'apiVersion';
      const parsedValue: unknown = field === 'maxConcurrency'
        ? (value ? parseInt(value, 10) || null : null)
        : isClearableString
          ? (value ? value : null)
          : value;
      const result = await agent.llmConfig.updateProvider({
        id: selectedProviderId,
        [field]: parsedValue,
      });
      if (!result.success) {
        console.error('Failed to update provider:', result.message);
        return;
      }
      updateProviderState({ ...selectedProvider, [field]: parsedValue } as LLMProvider);
      await refreshProviders();
    } catch (error) {
      console.error('Error updating provider:', error);
    }
  };

  /**
   * Switch the selected API mode for the currently-selected provider.
   *
   * Persists `selectedApiModeId` + the daemon-required `apiFormat`/`baseUrl`. On a
   * normal switch the baseUrl adopts the mode's URL and the daemon syncs the mode's
   * SECRET key server-side (the key is masked, so the app can't); `keepCustomizations`
   * keeps the current URL/key. The keep/overwrite confirm dialog (owned by
   * ProviderDetails) is reached only if this returns `false` — customization
   * DETECTION is not yet implemented, so a switch currently always applies (overwrite
   * with the mode's endpoint) and returns `true`. Returns `false` only on failure.
   */
  const handleSelectApiMode = async (modeId: string, opts?: { keepCustomizations?: boolean }) => {
    if (!selectedProviderId || !selectedProvider) return false;
    const modes = selectedProvider.apiModes;
    if (!modes || modes.length === 0) return false;
    const next = modes.find(m => m.id === modeId);
    if (!next) return false;

    // The daemon requires apiFormat + baseUrl on every PUT, so always include them
    // (mirrors toggleProvider). On a normal switch the baseUrl adopts the mode's URL
    // — the daemon then syncs the mode's SECRET key server-side by matching this
    // baseUrl to the mode (the key is masked, so the app cannot sync it). On
    // keepCustomizations the current URL is kept and the key is left untouched.
    const updates: Record<string, unknown> = {
      selectedApiModeId: modeId,
      apiFormat: selectedProvider.apiFormat,
      api_base_url: opts?.keepCustomizations ? selectedProvider.api_base_url : next.baseUrl,
    };
    try {
      const result = await agent.llmConfig.updateProvider({ id: selectedProviderId, ...updates });
      if (!result.success) {
        console.error('Failed to switch api mode:', result.message);
        return false;
      }
      // Sync inline edit state to the values we just wrote. Without this:
      //   1. The Input field keeps showing the previous mode's URL/key
      //      because inline-state resync only fires on `provider.id` change.
      //   2. When the user later blurs the URL input, the stale inlineApiUrl
      //      gets written back to DB via onInlineUpdate (because it differs
      //      from the new selectedProvider.api_base_url) — silently undoing
      //      the mode switch and corrupting the mode↔URL pairing, which then
      //      triggers a false-positive "you customized URL" dialog on the
      //      next switch click.
      if (!opts?.keepCustomizations) {
        setInlineApiUrl(next.baseUrl);
        if (next.apiKey) setInlineApiKey(next.apiKey);
      }
      // Update the in-memory provider cache so the Switch and dependent UI
      // reflect the new mode immediately, without waiting for refreshProviders.
      updateProviderState({
        ...selectedProvider,
        selectedApiModeId: modeId,
        ...(opts?.keepCustomizations
          ? {}
          : {
              api_base_url: next.baseUrl,
              ...(next.apiKey ? { api_key: next.apiKey } : {}),
            }),
      } as LLMProvider);
      await refreshProviders();
      return true;
    } catch (error) {
      console.error('Error switching api mode:', error);
      return false;
    }
  };

  /**
   * Reveal (fetch + show) the provider's stored API key. The BYO key is held
   * reversibly by the daemon, so this asks for the decrypted value and drops it
   * into the inline field. The cache's `api_key` is updated to the revealed value
   * so the blur-commit guard treats it as unchanged (no redundant re-write) until
   * the user actually edits it.
   */
  const revealApiKey = async (): Promise<void> => {
    if (!selectedProviderId || !selectedProvider) return;
    try {
      const result = await agent.llmConfig.revealProviderKey?.(selectedProviderId);
      if (result?.success && typeof result.apiKey === 'string' && result.apiKey.length > 0) {
        setInlineApiKey(result.apiKey);
        updateProviderState({ ...selectedProvider, api_key: result.apiKey } as LLMProvider);
      }
    } catch (error) {
      console.error('Error revealing provider key:', error);
    }
  };

  const handleReorderProviders = async (orderedIds: string[]) => {
    try {
      const result = await agent.llmConfig.reorderProviders?.(orderedIds);
      if (result && !result.success) {
        console.error('Failed to reorder providers:', result.message);
      }
      await refreshProviders();
    } catch (error) {
      console.error('Error reordering providers:', error);
    }
  };

  const handleToggleProvider = async (enabled: boolean) => {
    if (!selectedProviderId || !selectedProvider) return;
    // Toggling a synthesized preset row materializes it (carrying any key the
    // user already typed inline); afterwards the normal toggle path applies.
    if (selectedProvider.__preset) {
      await materializePreset(selectedProvider, {
        enabled,
        apiKey: inlineApiKey.trim() || undefined,
      });
      return;
    }
    // Fold a just-typed (not-yet-committed) key into the enable so enabling can
    // never land a KEYLESS provider (which would trip the "re-enter key" banner).
    // The key field commits on blur, but clicking the Switch can preventDefault
    // the input's blur — so the onBlur key-commit may not have fired yet. An
    // empty field leaves the stored key untouched; a `$VAR` ref is sent verbatim.
    const pendingKey = inlineApiKey.trim();
    const keyPending = pendingKey.length > 0 && pendingKey !== (selectedProvider.api_key || '');
    try {
      if (keyPending) {
        const result = await agent.llmConfig.updateProvider({
          id: selectedProviderId,
          enabled,
          api_key: pendingKey,
        });
        if (!result.success) {
          console.error('Failed to enable provider with key:', result.message);
          return;
        }
        // The key is now stored (and never echoed back); drop the raw value from
        // the field so it flips to the masked "key is set" state.
        setInlineApiKey('');
      } else {
        await agent.llmConfig.toggleProvider(selectedProviderId, enabled);
      }
      await refreshProviders();
    } catch (error) {
      console.error('Error toggling provider:', error);
    }
  };

  const handleToggleOfficial = async (isOfficial: boolean) => {
    if (!selectedProviderId || !selectedProvider) return;
    try {
      const result = await agent.llmConfig.updateProvider({
        id: selectedProviderId,
        isOfficial,
      });
      if (!result.success) {
        console.error('Failed to update isOfficial:', result.message);
        return;
      }
      updateProviderState({ ...selectedProvider, isOfficial } as LLMProvider);
      await refreshProviders();
    } catch (error) {
      console.error('Error toggling isOfficial:', error);
    }
  };

  /**
   * Reset a provider to catalog defaults (provider-storage-overlay): clears the
   * row's `userOverrides` so previously-overridden fields track the live catalog
   * again. Preserves the stored key + sessions. Re-reads through the effective
   * path via `refreshProviders()`.
   */
  const handleResetProvider = async (id?: string) => {
    const targetId = id ?? selectedProviderId;
    if (!targetId) return;
    try {
      const result = await agent.llmConfig.resetProvider?.(targetId);
      if (result && !result.success) {
        console.error('Failed to reset provider:', result.message);
        return;
      }
      await refreshProviders();
    } catch (error) {
      console.error('Error resetting provider:', error);
    }
  };

  const handleDeleteProvider = async () => {
    if (!selectedProviderId || !selectedProvider) return;
    if (selectedProvider.isSystem) {
      console.warn('Cannot delete system provider');
      return;
    }
    try {
      const result = await agent.llmConfig.deleteProvider(selectedProviderId);
      if (result.success) {
        setSelectedProviderId(null);
        await refreshProviders();
      } else {
        console.error('Failed to delete provider:', result.message);
      }
    } catch (error) {
      console.error('Error deleting provider:', error);
    }
  };

  return {
    isEditing,
    isAddingNew,
    formData,
    setFormData,
    formError,
    showTemplates,
    setShowTemplates,
    showApiKey,
    setShowApiKey,
    inlineName,
    setInlineName,
    inlineModelsEndpoint,
    setInlineModelsEndpoint,
    inlineApiKey,
    setInlineApiKey,
    inlineApiUrl,
    setInlineApiUrl,
    inlineMaxConcurrency,
    setInlineMaxConcurrency,
    handleSelectProvider,
    handleAddProvider,
    handleUseTemplate,
    handleEditProvider,
    handleSaveProvider,
    handleCancelEdit,
    handleInlineUpdate,
    handleReorderProviders,
    handleSelectApiMode,
    handleToggleProvider,
    handleToggleOfficial,
    handleDeleteProvider,
    handleResetProvider,
    revealApiKey,
  };
}
