/**
 * LLM provider configuration TYPES.
 *
 * A dependency-light, TYPE-ONLY set of the LLM-provider config interfaces the
 * `@omnicross/*` packages — and the `provider-presets` directory in this package —
 * consume (`LLMProvider`, `ModelConfig`, `ApiFormat`, `ProviderTemplate`, etc.).
 * Type interfaces only; no runtime values.
 */

import type { ThinkLevel } from './completion-types';
import type { ApiMode, CodingPlanConfig } from './provider-presets';

// ============================================================================
// Transformer Types
// ============================================================================

/**
 * A transformer entry can be either:
 * - A string (transformer name only)
 * - A tuple of [name, options] for parameterized transformers
 */
export type TransformerEntry = string | [string, Record<string, unknown>];

/**
 * Transformer configuration for a provider or model
 */
export interface TransformerConfig {
  /** List of transformers to apply at provider level */
  use?: TransformerEntry[];
  /** Model-specific transformer configurations */
  [modelName: string]: { use?: TransformerEntry[] } | TransformerEntry[] | undefined;
}

// ============================================================================
// Completion Settings Types
// ============================================================================

/**
 * Default completion settings for a provider or model
 */
export interface CompletionSettings {
  /** Temperature (0-2, default 0.7) */
  temperature?: number;
  /** Top P / Nucleus sampling (0-1, default 1) */
  topP?: number;
  /** Top K sampling (optional) */
  topK?: number;
  /** Maximum tokens for completion output */
  maxTokens?: number;
  /** Context window size (for display/reference) */
  contextLength?: number;
  /** Presence penalty (-2 to 2) */
  presencePenalty?: number;
  /** Frequency penalty (-2 to 2) */
  frequencyPenalty?: number;
  /** Stop sequences */
  stop?: string[];
  /** Enable streaming by default */
  stream?: boolean;
  /** Enable JSON mode */
  jsonMode?: boolean;
  /** Seed for reproducibility */
  seed?: number;
}

/**
 * Model group for organizing models in the UI
 */
export interface ModelGroup {
  /** Group name */
  name: string;
  /** Group ID */
  id: string;
  /** Models in this group */
  models: ModelConfig[];
}

// ============================================================================
// OpenRouter Provider Routing Types
// ============================================================================

/** OpenRouter provider sorting strategy */
export type OpenRouterProviderSort = 'price' | 'throughput' | 'latency';

/** OpenRouter data collection policy */
export type OpenRouterDataCollection = 'allow' | 'deny';

/** OpenRouter quantization levels */
export type OpenRouterQuantization =
  | 'int4'
  | 'int8'
  | 'fp4'
  | 'fp6'
  | 'fp8'
  | 'fp16'
  | 'bf16'
  | 'fp32'
  | 'unknown';

/** OpenRouter maximum pricing configuration */
export interface OpenRouterMaxPrice {
  prompt?: number;
  completion?: number;
  request?: number;
  image?: number;
}

/**
 * OpenRouter provider routing configuration
 * @see https://openrouter.ai/docs/guides/routing/provider-selection
 */
export interface OpenRouterProviderRouting {
  sort?: OpenRouterProviderSort;
  order?: string[];
  allow_fallbacks?: boolean;
  require_parameters?: boolean;
  data_collection?: OpenRouterDataCollection;
  zdr?: boolean;
  enforce_distillable_text?: boolean;
  only?: string[];
  ignore?: string[];
  quantizations?: OpenRouterQuantization[];
  max_price?: OpenRouterMaxPrice;
}

// ============================================================================
// Provider Types
// ============================================================================

/** @deprecated Use apiFormat instead */
export type ProviderApiType = 'openai' | 'claudecode' | 'anthropic' | 'google' | 'custom';

/**
 * API format - the API format used by the provider.
 * 'openai' | 'anthropic' | 'google' | 'azure-openai' | 'openai-response'
 */
export type ApiFormat = 'openai' | 'anthropic' | 'google' | 'azure-openai' | 'openai-response';

/** @deprecated Use ApiFormat instead */
export type ChatApiFormat = ApiFormat;

/**
 * Model configuration with extended metadata
 */
export interface ModelConfig {
  id: string;
  name: string;
  enabled: boolean;
  category?: 'chat' | 'reasoning' | 'image' | 'video' | 'embedding' | 'code';
  group?: string;
  contextLength?: number;
  maxTokens?: number;
  completionSettings?: CompletionSettings;
  vision?: boolean;
  functionCall?: boolean;
  reasoning?: boolean;
  thinkingLevels?: ThinkLevel[];
  thinkingTokenLimit?: { min: number; max: number };
  webSearch?: boolean;
  openRouterProvider?: OpenRouterProviderRouting;
}

/**
 * LLM Provider configuration.
 */
export interface LLMProvider {
  id: string;
  name: string;
  apiFormat?: ApiFormat;
  /** @deprecated Use apiFormat instead */
  chatApiFormat?: ChatApiFormat;
  /** @deprecated Use apiFormat instead */
  apiType?: ProviderApiType;
  api_base_url: string;
  api_key: string;
  hasKey?: boolean;
  models: string[];
  modelConfigs?: ModelConfig[];
  modelGroups?: ModelGroup[];
  modelsEndpoint?: string;
  enabled: boolean;
  transformer?: TransformerConfig;
  rerouterEnabled?: boolean;
  icon?: string;
  website?: string;
  docsUrl?: string;
  defaultSettings?: CompletionSettings;
  isSystem?: boolean;
  isOfficial?: boolean;
  rateLimit?: number;
  maxConcurrency?: number;
  notes?: string;
  apiVersion?: string;
  createdAt?: string;
  updatedAt?: string;
  /** @deprecated Prefer `apiModes` + `selectedApiModeId`. */
  codingPlan?: CodingPlanConfig;
  presetId?: string;
  sortOrder?: number;
  apiModes?: ApiMode[];
  selectedApiModeId?: string;
  nameKey?: string;
  presetRef?: string;
  overriddenFields?: string[];
}

// ============================================================================
// API Key Pool Types
// ============================================================================

/**
 * API key entry in the key pool. Each provider can have multiple keys for
 * load balancing.
 */
export interface ApiKeyEntry {
  id: string;
  providerId: string;
  label: string;
  apiKey: string;
  hasKey?: boolean;
  keyHint?: string;
  enabled: boolean;
  weight: number;
  sortOrder: number;
  createdAt?: string;
  updatedAt?: string;
  disabledReason?: string | null;
  lastErrorStatus?: number | null;
  lastErrorAt?: number | null;
}

// ============================================================================
// Router / Agent default model types
// ============================================================================

/** Model reference in format "provider,model" or just "model" */
export type ModelRef = string;

/**
 * Agent default models configuration. Used when running Agent mode to specify
 * models for different task types.
 */
export interface AgentDefaultModels {
  /** Background task model - format: "providerId,modelId" */
  background?: ModelRef;
  /** Image processing model - format: "providerId,modelId" */
  image?: ModelRef;
}

// ============================================================================
// Global Model Parameters
// ============================================================================

/** Individual parameter with enable toggle */
export interface ModelParameter<T> {
  enabled: boolean;
  value: T;
}

/**
 * Global model parameters configuration. Can be overridden by session-specific
 * settings.
 */
export interface GlobalModelParameters {
  temperature?: ModelParameter<number>;
  topP?: ModelParameter<number>;
  maxTokens?: ModelParameter<number>;
  defaultThinkingBudget?: ThinkLevel;
  toolMaxTurns?: number;
}

// ============================================================================
// Provider Templates
// ============================================================================

/**
 * Pre-defined provider template for quick setup. `provider-presets` extends
 * this into `PresetProviderTemplate`.
 */
export interface ProviderTemplate {
  id: string;
  name: string;
  apiFormat?: ApiFormat;
  /** @deprecated Use apiFormat instead */
  chatApiFormat?: ChatApiFormat;
  /** @deprecated Use apiFormat instead */
  apiType?: ProviderApiType;
  api_base_url: string;
  models: string[];
  modelConfigs?: ModelConfig[];
  modelGroups?: ModelGroup[];
  modelsEndpoint?: string;
  transformer?: TransformerConfig;
  description?: string;
  icon?: string;
  website?: string;
  docsUrl?: string;
  defaultSettings?: CompletionSettings;
  isSystem?: boolean;
  isOfficial?: boolean;
  apiVersion?: string;
  maxConcurrency?: number;
}
