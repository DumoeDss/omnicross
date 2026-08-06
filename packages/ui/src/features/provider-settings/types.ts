import type { ApiFormat,
  ChatApiFormat,
  CodingPlanConfig,
  ModelConfig,
  ModelGroup,
  ProviderApiType,
  ProviderModelDiscoveryEntry,
  TransformerConfig } from '@shared/llm-config';

export type ModelCatalogFilterKey =
  | 'all'
  | 'vision'
  | 'reasoning'
  | 'free'
  | 'tools';

export interface ModelCatalogFilterDefinition {
  key: ModelCatalogFilterKey;
  labelKey: string;
  predicate: (entry: ProviderModelDiscoveryEntry) => boolean;
}

export interface ProviderFormData {
  /**
   * Explicit provider id for a CREATE. Only set when the form was prefilled from
   * a catalog template — the row must land on the preset's OWN id so the
   * synthesized catalog row dedups against it and flips in place. Left undefined
   * for a hand-rolled provider, where the adapter mints a unique id from the name.
   */
  id?: string;
  name: string;
  // v3 fields - apiFormat determines transformer selection
  apiFormat?: ApiFormat;
  /** @deprecated Use apiFormat instead */
  chatApiFormat?: ChatApiFormat;
  /** @deprecated Use apiFormat instead */
  apiType?: ProviderApiType;
  api_base_url: string;
  api_key: string;
  models: string[];
  modelConfigs?: ModelConfig[];
  modelGroups?: ModelGroup[];
  modelsEndpoint?: string;
  enabled: boolean;
  icon?: string;
  // Transformer configuration for API conversion
  transformer?: TransformerConfig;
  // Azure OpenAI API version
  apiVersion?: string;
  // Whether this is an official Anthropic API provider
  isOfficial?: boolean;
  // Maximum concurrent requests (Agent proxy Semaphore limit)
  maxConcurrency?: number;
  // Coding Plan configuration
  codingPlan?: CodingPlanConfig;
  // Preset ID (if created from a preset)
  presetId?: string;
}

