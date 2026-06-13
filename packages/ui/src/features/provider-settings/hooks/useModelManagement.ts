import { useCallback,useEffect, useMemo, useState } from 'react';

import { agent } from '@/shared/agent';
import { useTranslation } from '@/shared/state/LocaleContext';

import type {
  LLMProvider,
  ModelConfig,
  ModelGroup,
  OpenRouterProviderRouting,
  ProviderModelDiscoveryEntry,
  ProviderModelDiscoveryResult,
} from '@shared/llm-config';

import {
  DEFAULT_MODEL_GROUP_ID,
  DEFAULT_MODEL_GROUP_NAME,
} from '../constants';
import {
  attachModelToGroup,
  buildAutoGroupsFromConfigs,
  buildGroupsPayload,
  deriveAutoGroupIdFromModelId,
} from '../utils';

/**
 * Manages model CRUD operations, discovery, grouping, and editing.
 */
export function useModelManagement(
  selectedProvider: LLMProvider | null,
  updateProviderInCache: (p: LLMProvider) => void,
) {
  const t = useTranslation();

  // ── State ───────────────────────────────────────────────────────
  const [modelSearch, setModelSearch] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [showManageModels, setShowManageModels] = useState(false);
  const [showAddModelDialog, setShowAddModelDialog] = useState(false);
  const [modelDiscovery, setModelDiscovery] = useState<Record<string, ProviderModelDiscoveryResult | null>>({});
  const [modelDiscoveryLoading, setModelDiscoveryLoading] = useState(false);
  const [modelDiscoveryError, setModelDiscoveryError] = useState<string | null>(null);
  const [newModelEntry, setNewModelEntry] = useState<{ id: string; name: string; groupId: string; openRouterProvider?: OpenRouterProviderRouting; vision?: boolean; reasoning?: boolean }>({ id: '', name: '', groupId: 'default', openRouterProvider: undefined, vision: undefined, reasoning: undefined });
  const [modelStatus, setModelStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [editingModel, setEditingModel] = useState<{ id: string; name: string } | null>(null);
  const [showEditModelDialog, setShowEditModelDialog] = useState(false);
  const [editModelEntry, setEditModelEntry] = useState<{
    id: string;
    name: string;
    groupId: string;
    openRouterProvider?: OpenRouterProviderRouting;
    vision?: boolean;
    reasoning?: boolean;
  }>({ id: '', name: '', groupId: 'default', openRouterProvider: undefined, vision: undefined, reasoning: undefined });

  const updateProviderState = useCallback((updated: LLMProvider) => {
    updateProviderInCache(updated);
  }, [updateProviderInCache]);

  // ── Computed ────────────────────────────────────────────────────
  const normalizedModelConfigs = useMemo<ModelConfig[]>(() => {
    if (!selectedProvider) return [];
    if (selectedProvider.modelConfigs?.length) {
      return selectedProvider.modelConfigs;
    }
    return (selectedProvider.models || []).map(id => ({ id, name: id, enabled: true }));
  }, [selectedProvider]);

  const normalizedModelGroups = useMemo<ModelGroup[]>(() => {
    if (!selectedProvider) return [];
    if (!selectedProvider.modelGroups?.length) {
      const autoGroups = buildAutoGroupsFromConfigs(selectedProvider, normalizedModelConfigs);
      if (autoGroups) return autoGroups;
    }
    const map = new Map(normalizedModelConfigs.map(cfg => [cfg.id, cfg]));
    const baseGroups = (selectedProvider.modelGroups || []).map(group => {
      const normalizedModels = (group.models || [])
        .map(model => map.get(model.id) || { ...model, enabled: model.enabled ?? true })
        .filter((model): model is ModelConfig => Boolean(model));
      return { ...group, models: normalizedModels };
    });

    const assigned = new Set<string>();
    baseGroups.forEach(group => { group.models.forEach(model => assigned.add(model.id)); });
    const remaining = normalizedModelConfigs.filter(cfg => !assigned.has(cfg.id));
    const groups = [...baseGroups];
    if (remaining.length > 0) {
      const defaultGroupIndex = groups.findIndex(group => group.id === DEFAULT_MODEL_GROUP_ID);
      if (defaultGroupIndex >= 0) {
        groups[defaultGroupIndex] = { ...groups[defaultGroupIndex], models: [...groups[defaultGroupIndex].models, ...remaining] };
      } else {
        groups.push({ id: DEFAULT_MODEL_GROUP_ID, name: DEFAULT_MODEL_GROUP_NAME, models: remaining });
      }
    }
    if (!groups.length) {
      return [{ id: DEFAULT_MODEL_GROUP_ID, name: DEFAULT_MODEL_GROUP_NAME, models: normalizedModelConfigs }];
    }
    return groups;
  }, [selectedProvider, normalizedModelConfigs]);

  const defaultGroupId = normalizedModelGroups[0]?.id || DEFAULT_MODEL_GROUP_ID;

  const existingModelIds = useMemo(() => {
    return new Set(normalizedModelConfigs.map(cfg => cfg.id));
  }, [normalizedModelConfigs]);

  const visibleModelGroups = useMemo(() => {
    if (!modelSearch.trim()) return normalizedModelGroups;
    const term = modelSearch.trim().toLowerCase();
    return normalizedModelGroups
      .map(group => ({
        ...group,
        models: group.models.filter(model => {
          const name = model.name?.toLowerCase() || '';
          return name.includes(term) || model.id.toLowerCase().includes(term);
        }),
      }))
      .filter(group => group.models.length > 0);
  }, [normalizedModelGroups, modelSearch]);

  const discoveryResult = selectedProvider ? modelDiscovery[selectedProvider.id] : null;
  const discoveryModels = discoveryResult?.models ?? [];

  // ── Helpers ─────────────────────────────────────────────────────
  const getCurrentModelConfigs = (): ModelConfig[] => {
    if (!selectedProvider) return [];
    if (selectedProvider.modelConfigs?.length) return selectedProvider.modelConfigs;
    return (selectedProvider.models || []).map(id => ({ id, name: id, enabled: true }));
  };

  const persistModelChanges = async (provider: LLMProvider, configs: ModelConfig[], overrideGroups?: ModelGroup[]) => {
    try {
      const payload = {
        id: provider.id,
        models: configs.map(cfg => cfg.id),
        modelConfigs: configs,
        modelGroups: overrideGroups ?? buildGroupsPayload(provider, configs),
      };
      const result = await agent.llmConfig.updateProvider(payload);
      if (result.provider) {
        updateProviderState(result.provider);
        return result.provider;
      }
      if (result.message) {
        setModelStatus({ type: 'error', message: result.message });
      }
    } catch (error) {
      setModelStatus({
        type: 'error',
        message: error instanceof Error ? error.message : t('providerSettings.errors.saveFailed'),
      });
    }
    return null;
  };

  const showModelMessage = (key: string, type: 'success' | 'error' = 'success') => {
    setModelStatus({ type, message: t(key) });
  };

  // ── Effects ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!selectedProvider) return;
    setNewModelEntry(prev => ({ ...prev, groupId: defaultGroupId }));
  }, [selectedProvider?.id, defaultGroupId]);

  useEffect(() => {
    setModelStatus(null);
    setEditingModel(null);
    setModelSearch('');
  }, [selectedProvider?.id]);

  useEffect(() => {
    if (!modelStatus) return;
    const timer = setTimeout(() => setModelStatus(null), 3000);
    return () => clearTimeout(timer);
  }, [modelStatus]);

  useEffect(() => {
    if (showManageModels && selectedProvider) {
      void loadModelDiscovery();
    }
  }, [showManageModels, selectedProvider?.id]);

  // ── Handlers ────────────────────────────────────────────────────
  const handleRemoveModel = async (modelId: string) => {
    if (!selectedProvider) return;
    const configs = getCurrentModelConfigs();
    const nextConfigs = configs.filter(cfg => cfg.id !== modelId);
    const updated = await persistModelChanges(selectedProvider, nextConfigs);
    if (updated) showModelMessage('providerSettings.modelsManager.messages.removed');
  };

  const handleAddModelEntry = async (id: string, name: string, groupId: string, openRouterProvider?: OpenRouterProviderRouting, vision?: boolean, reasoning?: boolean) => {
    if (!selectedProvider) return;
    const trimmedId = id.trim();
    if (!trimmedId) return;
    const configs = getCurrentModelConfigs();
    if (configs.some(cfg => cfg.id === trimmedId)) {
      showModelMessage('providerSettings.modelsManager.messages.duplicate', 'error');
      return;
    }
    const newConfig: ModelConfig = {
      id: trimmedId,
      name: name.trim() || trimmedId,
      enabled: true,
      openRouterProvider: openRouterProvider && Object.keys(openRouterProvider).length > 0 ? openRouterProvider : undefined,
      vision,
      reasoning,
    };
    const nextConfigs = [...configs, newConfig];
    const baseGroups = buildGroupsPayload(selectedProvider, nextConfigs);
    const normalizedGroupId =
      groupId.trim() ||
      deriveAutoGroupIdFromModelId(selectedProvider.id, trimmedId) ||
      baseGroups[0]?.id ||
      DEFAULT_MODEL_GROUP_ID;
    const targetGroupId = normalizedGroupId || DEFAULT_MODEL_GROUP_ID;
    const nextGroups = attachModelToGroup(baseGroups, targetGroupId, newConfig);
    const updated = await persistModelChanges(selectedProvider, nextConfigs, nextGroups);
    if (updated) {
      showModelMessage('providerSettings.modelsManager.messages.added');
      setShowAddModelDialog(false);
      setNewModelEntry({ id: '', name: '', groupId: targetGroupId, openRouterProvider: undefined, vision: undefined, reasoning: undefined });
    }
  };

  const handleAddDiscoveredModel = async (entry: ProviderModelDiscoveryEntry) => {
    if (!selectedProvider) return;
    const configs = getCurrentModelConfigs();
    if (configs.some(cfg => cfg.id === entry.id)) {
      showModelMessage('providerSettings.modelsManager.messages.duplicate', 'error');
      return;
    }
    const validCategories = ['chat', 'reasoning', 'image', 'video', 'embedding', 'code'] as const;
    const category = entry.category && validCategories.includes(entry.category as any)
      ? (entry.category as ModelConfig['category'])
      : 'chat';
    // Translate `capabilities: string[]` (the discovery entry's wire format,
    // populated by both the upstream API and `hydrateFromCanonical` in
    // utils.ts) back into the boolean fields ModelConfig persists. Without
    // this, vision/reasoning/etc shown in the picker silently disappear
    // when the user clicks "添加".
    const caps = new Set(entry.capabilities ?? []);
    const newConfig: ModelConfig = {
      id: entry.id,
      name: entry.name || entry.id,
      enabled: true,
      contextLength: entry.contextLength,
      maxTokens: entry.maxTokens,
      category,
      ...(caps.has('vision') ? { vision: true } : {}),
      ...(caps.has('function_call') ? { functionCall: true } : {}),
      ...(caps.has('reasoning') ? { reasoning: true } : {}),
      ...(caps.has('web_search') ? { webSearch: true } : {}),
    };
    const nextConfigs = [...configs, newConfig];
    const baseGroups = buildGroupsPayload(selectedProvider, nextConfigs);
    const nextGroups = attachModelToGroup(baseGroups, defaultGroupId, newConfig);
    const updated = await persistModelChanges(selectedProvider, nextConfigs, nextGroups);
    if (updated) showModelMessage('providerSettings.modelsManager.messages.added');
  };

  const handleApplyModelEdit = async () => {
    if (!selectedProvider || !editingModel) return;
    const trimmed = editingModel.name.trim();
    if (!trimmed) return;
    const configs = getCurrentModelConfigs().map(cfg =>
      cfg.id === editingModel.id ? { ...cfg, name: trimmed } : cfg,
    );
    const updated = await persistModelChanges(selectedProvider, configs);
    if (updated) {
      showModelMessage('providerSettings.modelsManager.messages.updated');
      setEditingModel(null);
    }
  };

  const handleApplyEditModelDialog = async () => {
    if (!selectedProvider || !showEditModelDialog) return;
    const trimmedId = editModelEntry.id.trim();
    const trimmedName = editModelEntry.name.trim();
    if (!trimmedId) return;
    const currentConfigs = getCurrentModelConfigs();
    const originalModel = editingModel ? currentConfigs.find(m => m.id === editingModel.id) : null;
    if (!originalModel) return;
    const configs = currentConfigs.map(cfg => {
      if (cfg.id === originalModel.id) {
        return {
          ...cfg,
          id: trimmedId,
          name: trimmedName || trimmedId,
          group: editModelEntry.groupId || 'default',
          openRouterProvider: editModelEntry.openRouterProvider,
          vision: editModelEntry.vision,
          reasoning: editModelEntry.reasoning,
        };
      }
      return cfg;
    });
    const updated = await persistModelChanges(selectedProvider, configs);
    if (updated) {
      showModelMessage('providerSettings.modelsManager.messages.updated');
      setShowEditModelDialog(false);
      setEditingModel(null);
      setEditModelEntry({ id: '', name: '', groupId: 'default', openRouterProvider: undefined, vision: undefined, reasoning: undefined });
    }
  };

  const handleToggleModelEnabled = async (modelId: string, enabled: boolean) => {
    if (!selectedProvider) return;
    const configs = getCurrentModelConfigs().map(cfg =>
      cfg.id === modelId ? { ...cfg, enabled } : cfg,
    );
    await persistModelChanges(selectedProvider, configs);
  };

  const toggleGroupCollapse = (groupId: string) => {
    setCollapsedGroups(prev => ({ ...prev, [groupId]: !prev[groupId] }));
  };

  const loadModelDiscovery = async (force = false) => {
    if (!selectedProvider) return;
    setModelDiscoveryLoading(true);
    setModelDiscoveryError(null);
    try {
      const result = await agent.llmConfig.discoverModels(
        selectedProvider.id,
        force ? { forceRefresh: true } : undefined,
      );
      setModelDiscovery(prev => ({ ...prev, [selectedProvider.id as string]: result }));
      if (!result.success && result.error) {
        setModelDiscoveryError(result.error);
      }
    } catch (error) {
      setModelDiscoveryError(error instanceof Error ? error.message : t('providerSettings.errors.saveFailed'));
    } finally {
      setModelDiscoveryLoading(false);
    }
  };

  const onShowEditModelDialog = (model: ModelConfig) => {
    setEditingModel({ id: model.id, name: model.name || model.id });
    setEditModelEntry({
      id: model.id,
      name: model.name || model.id,
      groupId: model.group || 'default',
      openRouterProvider: model.openRouterProvider,
      vision: model.vision,
      reasoning: model.reasoning,
    });
    setShowEditModelDialog(true);
  };

  return {
    modelSearch,
    setModelSearch,
    collapsedGroups,
    toggleGroupCollapse,
    showManageModels,
    setShowManageModels,
    showAddModelDialog,
    setShowAddModelDialog,
    modelDiscoveryLoading,
    modelDiscoveryError,
    newModelEntry,
    setNewModelEntry,
    modelStatus,
    editingModel,
    setEditingModel,
    showEditModelDialog,
    setShowEditModelDialog,
    editModelEntry,
    setEditModelEntry,
    visibleModelGroups,
    normalizedModelGroups,
    defaultGroupId,
    discoveryResult,
    discoveryModels,
    existingModelIds,
    handleRemoveModel,
    handleAddModelEntry,
    handleAddDiscoveredModel,
    handleApplyModelEdit,
    handleApplyEditModelDialog,
    handleToggleModelEnabled,
    loadModelDiscovery,
    onShowEditModelDialog,
  };
}
