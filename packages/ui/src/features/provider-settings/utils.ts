import type {
  LLMProvider,
  ModelConfig,
  ModelGroup,
  ProviderModelDiscoveryEntry
} from '@shared/llm-config';
import { resolveModelCapabilities } from '@shared/llm-config';

import {
  AGGREGATED_PROVIDER_IDS,
  DEFAULT_MODEL_GROUP_ID,
  DEFAULT_MODEL_GROUP_NAME,
  PROVIDER_ICONS
} from './constants';
import type { ModelCatalogFilterDefinition } from './types';

export const getProviderIcon = (icon?: string) => {
  return PROVIDER_ICONS[icon || 'default'] || PROVIDER_ICONS.default;
};

/**
 * Resolve a single ModelConfig with canonical capabilities filled in.
 *
 * The main process already runs canonical resolution via
 * `ProviderManager.mergeModelConfigsFromTemplate` before sending data through
 * IPC, so any `LLMProvider.modelConfigs` reaching the renderer already have
 * canonical caps merged. This helper is the renderer-side resolver for
 * places that build a `ModelConfig` from outside that path — e.g. the
 * model-discovery dialog where `ProviderModelDiscoveryEntry` is converted to
 * a row before persistence, or future surfaces that need to preview "what
 * caps would this model have?" without round-tripping through the main.
 */
export const getResolvedModelConfig = (model: ModelConfig): ModelConfig => {
  const caps = resolveModelCapabilities(model.id, undefined, model);
  return { ...model, ...caps };
};

/**
 * Resolve the display name for a provider, applying i18n when the preset
 * declares a `nameKey`. Built-in providers can't be renamed (the inline-edit
 * Input is hidden on `isSystem` rows in ProviderDetails), so we don't need
 * customization detection here.
 *
 * Falls back to the raw `name` field when:
 *   - the preset has no nameKey (English-named built-ins like OpenAI)
 *   - no translation exists for the current locale
 *   - the provider is user-created (no nameKey is attached by merge)
 */
export const getProviderDisplayName = (
  t: (key: string) => string,
  provider: { name: string; nameKey?: string },
): string => {
  if (!provider.nameKey) return provider.name;
  const translated = t(provider.nameKey);
  // LocaleContext returns the key string when no translation is found.
  return translated === provider.nameKey ? provider.name : translated;
};

/**
 * Check if provider is OpenRouter based on base URL
 */
export const isOpenRouterProvider = (provider: LLMProvider | null): boolean => {
  if (!provider) return false;
  const baseUrl = (provider.api_base_url || '').toLowerCase();
  return baseUrl.includes('openrouter.ai');
};

export const prettifyGroupLabel = (value: string) => {
  if (!value) return DEFAULT_MODEL_GROUP_NAME;
  return value
    .split(/[-_/]/)
    .map((segment) => (segment ? segment[0].toUpperCase() + segment.slice(1) : segment))
    .join(' ');
};

export const deriveAutoGroupIdFromModelId = (providerId: string | undefined, modelId: string): string | null => {
  if (!providerId || !AGGREGATED_PROVIDER_IDS.has(providerId)) {
    return null;
  }
  const normalized = modelId.trim();
  if (!normalized) {
    return null;
  }
  const slashIndex = normalized.indexOf('/');
  if (slashIndex > 0) {
    return normalized.slice(0, slashIndex);
  }
  const colonIndex = normalized.indexOf(':');
  if (colonIndex > 0) {
    return normalized.slice(0, colonIndex);
  }
  return null;
};

export const buildAutoGroupsFromConfigs = (
  provider: LLMProvider | null,
  configs: ModelConfig[]
): ModelGroup[] | null => {
  if (!provider || !AGGREGATED_PROVIDER_IDS.has(provider.id)) {
    return null;
  }
  const buckets = new Map<string, ModelConfig[]>();
  configs.forEach((model) => {
    const derived = deriveAutoGroupIdFromModelId(provider.id, model.id);
    const groupId = derived || DEFAULT_MODEL_GROUP_ID;
    const entry = buckets.get(groupId) ?? [];
    entry.push(model);
    buckets.set(groupId, entry);
  });
  if (!buckets.size) {
    return null;
  }
  return Array.from(buckets.entries())
    .map(([groupId, models]) => ({
      id: groupId,
      name: groupId === DEFAULT_MODEL_GROUP_ID ? DEFAULT_MODEL_GROUP_NAME : prettifyGroupLabel(groupId),
      models
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
};

export const buildAutoGroupsFromCatalog = (
  provider: LLMProvider | null,
  entries: ProviderModelDiscoveryEntry[]
): Array<{ id: string; name: string; models: ProviderModelDiscoveryEntry[] }> => {
  if (!provider || !entries.length) {
    return [];
  }
  const buckets = new Map<string, ProviderModelDiscoveryEntry[]>();
  entries.forEach((entry) => {
    // First try to derive group from model ID (for aggregated providers like OpenRouter)
    const derived = deriveAutoGroupIdFromModelId(provider.id, entry.id);
    // Then use entry.group (e.g., "Gemini 2.5", "Claude Sonnet") for UI grouping
    // Finally fall back to entry.category or default
    const groupId =
      derived ||
      (entry.group ? entry.group : null) ||
      (entry.category ? entry.category.toLowerCase() : DEFAULT_MODEL_GROUP_ID);
    const bucket = buckets.get(groupId) ?? [];
    bucket.push(entry);
    buckets.set(groupId, bucket);
  });
  return Array.from(buckets.entries())
    .map(([groupId, models]) => ({
      id: groupId,
      name:
        groupId === DEFAULT_MODEL_GROUP_ID
          ? DEFAULT_MODEL_GROUP_NAME
          : prettifyGroupLabel(groupId),
      models
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
};

/**
 * Build model groups payload from provider and configs.
 * Ensures every config is assigned to exactly one group.
 */
export const buildGroupsPayload = (
  provider: LLMProvider,
  configs: ModelConfig[],
): ModelGroup[] => {
  const map = new Map(configs.map(cfg => [cfg.id, cfg]));
  const sourceGroups = provider.modelGroups?.length
    ? provider.modelGroups
    : buildAutoGroupsFromConfigs(provider, configs);
  if (!sourceGroups?.length) {
    return [{ id: DEFAULT_MODEL_GROUP_ID, name: DEFAULT_MODEL_GROUP_NAME, models: configs }];
  }
  const groups = sourceGroups
    .map(group => ({
      ...group,
      models: (group.models || [])
        .map(model => map.get(model.id) || null)
        .filter((model): model is ModelConfig => Boolean(model)),
    }))
    .filter(group => group.models.length > 0);
  if (!groups.length) {
    return [{ id: DEFAULT_MODEL_GROUP_ID, name: DEFAULT_MODEL_GROUP_NAME, models: configs }];
  }
  return groups;
};

/**
 * Attach a model config to a specific group, creating the group if it doesn't exist.
 */
export const attachModelToGroup = (
  groups: ModelGroup[],
  groupId: string,
  model: ModelConfig,
): ModelGroup[] => {
  if (!groups.length) {
    return [{
      id: groupId || DEFAULT_MODEL_GROUP_ID,
      name: groupId === DEFAULT_MODEL_GROUP_ID ? DEFAULT_MODEL_GROUP_NAME : prettifyGroupLabel(groupId),
      models: [model],
    }];
  }
  let found = false;
  const nextGroups = groups.map(group => {
    if (group.id !== groupId) return group;
    found = true;
    if (group.models.some(existing => existing.id === model.id)) return group;
    return { ...group, models: [...group.models, model] };
  });
  if (!found) {
    return [
      ...nextGroups,
      {
        id: groupId || DEFAULT_MODEL_GROUP_ID,
        name: groupId === DEFAULT_MODEL_GROUP_ID ? DEFAULT_MODEL_GROUP_NAME : prettifyGroupLabel(groupId),
        models: [model],
      },
    ];
  }
  return nextGroups;
};

export const capabilityMatches = (entry: ProviderModelDiscoveryEntry, targets: string[]): boolean => {
  if (!entry.capabilities?.length) {
    return false;
  }
  return entry.capabilities.some((capability) => {
    const lower = capability.toLowerCase();
    return targets.some((target) => lower.includes(target));
  });
};

export const categoryMatches = (entry: ProviderModelDiscoveryEntry, targets: string[]): boolean => {
  if (!entry.category) {
    return false;
  }
  const normalized = entry.category.toLowerCase();
  return targets.some((target) => normalized.includes(target));
};

export const MODEL_FILTER_DEFS: ModelCatalogFilterDefinition[] = [
  {
    key: 'all',
    labelKey: 'providerSettings.modelsManager.filters.all',
    predicate: () => true
  },
  {
    key: 'vision',
    labelKey: 'providerSettings.modelsManager.filters.vision',
    predicate: (entry) =>
      capabilityMatches(entry, ['vision', 'multimodal', 'image', 'video']) ||
      categoryMatches(entry, ['vision', 'multimodal'])
  },
  {
    key: 'reasoning',
    labelKey: 'providerSettings.modelsManager.filters.reasoning',
    predicate: (entry) =>
      capabilityMatches(entry, ['reasoning', 'thinking', 'cot', 'chain-of-thought']) ||
      categoryMatches(entry, ['reasoning', 'thinking'])
  },
  {
    key: 'free',
    labelKey: 'providerSettings.modelsManager.filters.free',
    predicate: (entry) =>
      capabilityMatches(entry, ['free', 'trial']) || categoryMatches(entry, ['free'])
  },
  {
    key: 'tools',
    labelKey: 'providerSettings.modelsManager.filters.tools',
    predicate: (entry) =>
      capabilityMatches(entry, ['tool', 'function', 'planner']) ||
      categoryMatches(entry, ['tool'])
  }
];

