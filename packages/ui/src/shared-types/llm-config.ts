/**
 * llm-config.ts — the hand-mirrored SUBSET of the upstream `@shared/llm-config`
 * the ported Provider page consumes (design D6 type closure).
 *
 * This is a STANDALONE copy: it carries the types + the two display consts
 * (`PROVIDER_TEMPLATES`, `BUILTIN_TRANSFORMERS`) the full form/dialogs reference,
 * plus a minimal `resolveModelCapabilities` passthrough. The app does NOT bundle
 * the canonical model-capability registry, so `resolveModelCapabilities` returns
 * no derived caps (honest: the daemon does not store per-model caps either).
 *
 * Keep this in sync with the upstream source only as needed — the app owns its copy.
 */

// ── Thinking levels (ported from completion-types) ──────────────────────────────
export type ThinkLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

// ── Provider-preset subset (ported from provider-presets/types) ─────────────────
export type ApiModeId = string;

/** One API endpoint variant on a provider (standard / coding-plan / token-plan). */
export interface ApiMode {
  id: ApiModeId;
  label: string;
  baseUrl: string;
  apiKey?: string;
  apiKeyPrefix?: string;
  note?: string;
}

/** Coding Plan configuration on a provider (deprecated; superseded by apiModes). */
export interface CodingPlanConfig {
  enabled: boolean;
  baseUrl?: string;
  apiKey?: string;
  note?: string;
  /**
   * Read-only view hint (app-parity-2 child 3): whether the daemon has a
   * coding-plan key stored. The literal key is NEVER returned (secret-IN-never-OUT);
   * `apiKey` stays '' on read for blank-on-edit. NOT sent on write.
   */
  hasApiKey?: boolean;
}

/** Minimal preset template shape the preset grid references. */
export interface PresetProviderTemplate {
  id: string;
  presetId: string;
  name: string;
  nameKey?: string;
  apiFormat?: ApiFormat;
  api_base_url: string;
  models: string[];
}

// ── Transformer types ───────────────────────────────────────────────────────────
export type TransformerEntry = string | [string, Record<string, unknown>];

export interface TransformerConfig {
  use?: TransformerEntry[];
  [modelName: string]: { use?: TransformerEntry[] } | TransformerEntry[] | undefined;
}

export interface TransformerInfo {
  name: string;
  endpoint?: string | null;
  description?: string;
  hasOptions?: boolean;
  optionSchema?: Record<
    string,
    { type: 'string' | 'number' | 'boolean' | 'object'; description?: string; default?: unknown }
  >;
}

// ── Completion settings ─────────────────────────────────────────────────────────
export interface CompletionSettings {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTokens?: number;
  contextLength?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  stop?: string[];
  stream?: boolean;
  jsonMode?: boolean;
  seed?: number;
}

// ── Model group ─────────────────────────────────────────────────────────────────
export interface ModelGroup {
  name: string;
  id: string;
  models: ModelConfig[];
}

// ── OpenRouter routing ──────────────────────────────────────────────────────────
export type OpenRouterProviderSort = 'price' | 'throughput' | 'latency';
export type OpenRouterDataCollection = 'allow' | 'deny';
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

export interface OpenRouterMaxPrice {
  prompt?: number;
  completion?: number;
  request?: number;
  image?: number;
}

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

// ── Model discovery ─────────────────────────────────────────────────────────────
export interface ProviderModelDiscoveryEntry {
  id: string;
  name: string;
  description?: string;
  contextLength?: number;
  maxTokens?: number;
  category?: string;
  group?: string;
  capabilities?: string[];
}

export interface ProviderModelDiscoveryResult {
  success: boolean;
  source: 'cache' | 'network';
  endpoint: string;
  fetchedAt?: string;
  models: ProviderModelDiscoveryEntry[];
  raw?: unknown;
  error?: string;
  /** App-local: set when the daemon reports the format is unsupported for discovery. */
  unsupportedFormat?: boolean;
}

// ── Provider types ──────────────────────────────────────────────────────────────
export type ProviderApiType = 'openai' | 'claudecode' | 'anthropic' | 'google' | 'custom';
export type ApiFormat = 'openai' | 'anthropic' | 'google' | 'azure-openai' | 'openai-response';
export type ChatApiFormat = ApiFormat;
export type ProviderUsageType = 'chat' | 'code';

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

export interface LLMProvider {
  id: string;
  name: string;
  apiFormat?: ApiFormat;
  chatApiFormat?: ChatApiFormat;
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
  codingPlan?: CodingPlanConfig;
  presetId?: string;
  sortOrder?: number;
  apiModes?: ApiMode[];
  selectedApiModeId?: string;
  nameKey?: string;
  presetRef?: string;
  overriddenFields?: string[];
  /**
   * App-only marker: a synthesized "available preset" row merged into the list
   * that does NOT yet exist as a real daemon provider. The form handlers detect
   * this and MATERIALIZE it (create the real provider) on first key/enable, then
   * normal update/toggle applies. Never sent to the daemon.
   */
  __preset?: boolean;
}

export interface LLMProviderInput {
  name: string;
  apiFormat?: ApiFormat;
  chatApiFormat?: ChatApiFormat;
  apiType?: ProviderApiType;
  api_base_url: string;
  api_key: string;
  models: string[];
  modelConfigs?: ModelConfig[];
  modelGroups?: ModelGroup[];
  modelsEndpoint?: string;
  enabled?: boolean;
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
  codingPlan?: CodingPlanConfig;
  presetId?: string;
  presetRef?: string;
  sortOrder?: number;
  apiModes?: ApiMode[];
  selectedApiModeId?: string;
}

export interface LLMProviderUpdateInput {
  name?: string;
  apiFormat?: ApiFormat;
  chatApiFormat?: ChatApiFormat;
  apiType?: ProviderApiType;
  api_base_url?: string;
  api_key?: string;
  models?: string[];
  modelConfigs?: ModelConfig[];
  modelGroups?: ModelGroup[];
  // Editable-clearable scalar fields (app-parity child 1): the three-way write
  // contract — omit→keep, `null`→clear, value→set. The `| null` models the
  // explicit-clear signal the inline editors emit (no cast needed downstream).
  modelsEndpoint?: string | null;
  enabled?: boolean;
  transformer?: TransformerConfig;
  rerouterEnabled?: boolean;
  icon?: string;
  website?: string;
  docsUrl?: string;
  defaultSettings?: CompletionSettings;
  isSystem?: boolean;
  isOfficial?: boolean;
  rateLimit?: number;
  maxConcurrency?: number | null;
  notes?: string;
  apiVersion?: string | null;
  codingPlan?: CodingPlanConfig;
  presetId?: string;
  presetRef?: string;
  sortOrder?: number;
  apiModes?: ApiMode[];
  selectedApiModeId?: string;
}

export interface LLMProviderResult {
  success: boolean;
  provider?: LLMProvider;
  message?: string;
}

// ── API key pool ────────────────────────────────────────────────────────────────
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

export interface KeyHealth {
  until: number;
  errors: number;
  lastStatus: number | null;
}

export type KeyHealthMap = Record<string, KeyHealth>;

export interface ApiKeyEntryInput {
  providerId: string;
  label?: string;
  apiKey: string;
  enabled?: boolean;
  weight?: number;
}

// ── Provider template (legacy compat consts) ────────────────────────────────────
export interface ProviderTemplate {
  id: string;
  name: string;
  apiFormat?: ApiFormat;
  chatApiFormat?: ChatApiFormat;
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

export const DEFAULT_COMPLETION_SETTINGS: CompletionSettings = {
  temperature: 0.7,
  topP: 1,
  maxTokens: 4096,
  stream: true,
};

/** Common provider templates (ported from the upstream; display/seed data only). */
export const PROVIDER_TEMPLATES: ProviderTemplate[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    apiFormat: 'openai',
    apiType: 'openai',
    api_base_url: 'https://api.openai.com/v1/chat/completions',
    models: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.2', 'gpt-5', 'gpt-4o', 'gpt-4o-mini'],
    modelConfigs: [
      { id: 'gpt-5.5', name: 'GPT-5.5', enabled: true },
      { id: 'gpt-5.4', name: 'GPT-5.4', enabled: true },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', enabled: true },
      { id: 'gpt-5.2', name: 'GPT-5.2', enabled: true },
      { id: 'gpt-5', name: 'GPT-5', enabled: false },
      { id: 'gpt-4o', name: 'GPT-4o', enabled: true },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', enabled: true },
    ],
    description: 'OpenAI official API',
    icon: 'openai',
    website: 'https://openai.com',
    docsUrl: 'https://platform.openai.com/docs',
    defaultSettings: { temperature: 0.7, maxTokens: 4096 },
    isSystem: true,
    maxConcurrency: 8,
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    apiFormat: 'google',
    apiType: 'google',
    api_base_url: 'https://generativelanguage.googleapis.com/v1beta/models/',
    modelsEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
    models: ['gemini-3-flash', 'gemini-3.1-pro'],
    modelConfigs: [
      { id: 'gemini-3-flash', name: 'Gemini 3 Flash', enabled: true },
      { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', enabled: true },
    ],
    transformer: { use: ['gemini'] },
    description: "Google's multimodal AI models",
    icon: 'gemini',
    website: 'https://ai.google.dev',
    docsUrl: 'https://ai.google.dev/docs',
    defaultSettings: { temperature: 0.7, topP: 0.95, maxTokens: 65536 },
    isSystem: true,
    maxConcurrency: 5,
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    apiFormat: 'anthropic',
    apiType: 'anthropic',
    api_base_url: 'https://api.anthropic.com/v1/messages',
    modelsEndpoint: 'https://api.anthropic.com/v1/models',
    models: [
      'claude-opus-4-7',
      'claude-opus-4-7[1m]',
      'claude-sonnet-4-6',
      'claude-sonnet-4-6[1m]',
      'claude-opus-4-6',
      'claude-opus-4-6[1m]',
      'claude-haiku-4-5',
    ],
    modelConfigs: [
      { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', enabled: true },
      { id: 'claude-opus-4-7[1m]', name: 'Claude Opus 4.7 (1M)', enabled: false },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', enabled: true },
      { id: 'claude-sonnet-4-6[1m]', name: 'Claude Sonnet 4.6 (1M)', enabled: false },
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', enabled: true },
      { id: 'claude-opus-4-6[1m]', name: 'Claude Opus 4.6 (1M)', enabled: false },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', enabled: true },
    ],
    transformer: { use: ['anthropic'] },
    description: 'Claude models official API (Anthropic Messages format)',
    icon: 'anthropic',
    website: 'https://anthropic.com',
    docsUrl: 'https://docs.anthropic.com',
    defaultSettings: { temperature: 0.7, maxTokens: 65536 },
    isSystem: true,
    isOfficial: true,
    maxConcurrency: 10,
  },
  {
    id: 'azure-openai',
    name: 'Azure OpenAI',
    apiFormat: 'azure-openai',
    api_base_url: '',
    apiVersion: '2024-08-01-preview',
    models: [],
    description: 'Azure OpenAI Service (requires deployment name as model)',
    icon: 'azure-openai',
    website: 'https://azure.microsoft.com/products/ai-services/openai-service',
    docsUrl: 'https://learn.microsoft.com/azure/ai-services/openai/',
    defaultSettings: { temperature: 0.7, maxTokens: 4096 },
    isSystem: false,
  },
  {
    id: 'openai-response',
    name: 'OpenAI (Responses API)',
    apiFormat: 'openai-response',
    api_base_url: 'https://api.openai.com',
    models: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.2', 'o3', 'o4-mini', 'gpt-4.1'],
    modelConfigs: [
      { id: 'gpt-5.5', name: 'GPT-5.5', enabled: true },
      { id: 'gpt-5.4', name: 'GPT-5.4', enabled: true },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', enabled: true },
      { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', enabled: true },
      { id: 'gpt-5.2', name: 'GPT-5.2', enabled: true },
      { id: 'o3', name: 'o3', enabled: true },
      { id: 'o4-mini', name: 'o4 Mini', enabled: true },
      { id: 'gpt-4.1', name: 'GPT-4.1', enabled: true },
    ],
    transformer: { use: ['openai-response'] },
    description: 'OpenAI Responses API (/v1/responses endpoint)',
    icon: 'openai',
    website: 'https://openai.com',
    docsUrl: 'https://platform.openai.com/docs/api-reference/responses',
    defaultSettings: { temperature: 0.7, maxTokens: 4096 },
    isSystem: false,
  },
  {
    id: 'grok',
    name: 'Grok',
    apiFormat: 'openai',
    apiType: 'openai',
    api_base_url: 'https://api.x.ai/v1/chat/completions',
    models: ['grok-4.3', 'grok-4.20', 'grok-4.20-reasoning', 'grok-4.20-multi-agent'],
    modelConfigs: [
      { id: 'grok-4.3', name: 'Grok 4.3', enabled: true },
      { id: 'grok-4.20', name: 'Grok 4.20', enabled: true },
      { id: 'grok-4.20-reasoning', name: 'Grok 4.20 Reasoning', enabled: true },
      { id: 'grok-4.20-multi-agent', name: 'Grok 4.20 Multi-Agent', enabled: true },
    ],
    description: 'xAI Grok models with reasoning, vision, and web search capabilities',
    icon: 'grok',
    website: 'https://x.ai',
    docsUrl: 'https://docs.x.ai',
    defaultSettings: { temperature: 0.7, maxTokens: 4096 },
    isSystem: true,
    maxConcurrency: 8,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    apiFormat: 'openai',
    apiType: 'openai',
    api_base_url: 'https://api.deepseek.com/v1/chat/completions',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'],
    modelConfigs: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', enabled: true },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', enabled: true },
      { id: 'deepseek-chat', name: 'DeepSeek Chat (Legacy)', enabled: false },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner (Legacy)', enabled: false },
    ],
    transformer: { use: ['deepseek'] },
    description: 'DeepSeek official API',
    icon: 'deepseek',
    website: 'https://deepseek.com',
    docsUrl: 'https://api-docs.deepseek.com',
    defaultSettings: { temperature: 0.7, maxTokens: 8192 },
    isSystem: true,
    maxConcurrency: 8,
  },
];

/** Built-in transformer names + descriptions (ported from the upstream). */
export const BUILTIN_TRANSFORMERS: TransformerInfo[] = [
  { name: 'anthropic', description: 'Preserve original Anthropic request/response format' },
  { name: 'deepseek', description: 'Adapt for DeepSeek API format' },
  { name: 'gemini', description: 'Adapt for Google Gemini API format' },
  { name: 'openai-response', description: 'Adapt for OpenAI Responses API (/v1/responses) format' },
  { name: 'openrouter', description: 'Adapt for OpenRouter API with provider routing support', hasOptions: true },
  { name: 'groq', description: 'Adapt for Groq API format' },
  { name: 'openai', description: 'Standard OpenAI chat completions format' },
  {
    name: 'maxtoken',
    description: 'Set specific max_tokens value',
    hasOptions: true,
    optionSchema: {
      max_tokens: { type: 'number', description: 'Maximum tokens for completion', default: 4096 },
    },
  },
  { name: 'tooluse', description: 'Optimize tool usage via tool_choice parameter' },
  { name: 'reasoning', description: 'Process reasoning_content field for chain-of-thought' },
  { name: 'sampling', description: 'Process sampling parameters (temperature, top_p, etc.)' },
  { name: 'enhancetool', description: 'Add error tolerance to tool call parameters' },
  { name: 'cleancache', description: 'Clear cache_control field from requests' },
  { name: 'vertex-gemini', description: 'Handle Gemini API using Vertex authentication' },
  { name: 'vertex-claude', description: 'Handle Claude API using Vertex authentication' },
  { name: 'cerebras', description: 'Adapt for Cerebras API format' },
  { name: 'vercel', description: 'Adapt for Vercel AI SDK format' },
  { name: 'forcereasoning', description: 'Force reasoning mode for models that support it' },
  { name: 'maxcompletiontokens', description: 'Set max_completion_tokens instead of max_tokens' },
  { name: 'streamoptions', description: 'Configure streaming options' },
  { name: 'customparams', description: 'Add custom parameters to requests' },
];

/**
 * Resolve a model's canonical capabilities.
 *
 * The app does NOT bundle the upstream canonical model-capability registry (the
 * daemon does not store per-model caps either), so this returns the
 * explicitly-set `rowOverride` caps only — no inferred defaults. Honest
 * passthrough: a model shows the caps the user/daemon set, nothing synthesized.
 */
export function resolveModelCapabilities(
  _modelId: string,
  presetOverride?: Partial<ModelConfig>,
  rowOverride?: Partial<ModelConfig>,
): Partial<ModelConfig> {
  const out: Partial<ModelConfig> = {};
  const fields: Array<keyof ModelConfig> = [
    'vision',
    'functionCall',
    'reasoning',
    'webSearch',
    'contextLength',
    'maxTokens',
    'thinkingLevels',
    'thinkingTokenLimit',
  ];
  for (const f of fields) {
    const rv = rowOverride?.[f];
    if (rv !== undefined) {
      (out as Record<string, unknown>)[f] = rv;
      continue;
    }
    const pv = presetOverride?.[f];
    if (pv !== undefined) {
      (out as Record<string, unknown>)[f] = pv;
    }
  }
  return out;
}
