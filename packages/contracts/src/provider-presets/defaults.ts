/**
 * Derived/companion maps + the seed-id const for the provider preset registry.
 * These are CODE, not catalog data (several reference preset ids the orphan-id
 * tests police), so they stay TypeScript. Moved verbatim from the prior flat
 * `provider-presets.ts`.
 */
import type { ProviderModelMapping, ProviderSearchConfig } from './types';

/**
 * Coding Plan URL presets keyed by preset `id` (NOT `presetId`).
 * When enabling Coding Plan, the baseUrl is auto-filled from this map.
 *
 * Note: For variants that share `presetId` (e.g. xiaomi-mimo OpenAI vs Anthropic
 * formats both share `presetId: 'xiaomi-mimo'`), each variant has its own row
 * here keyed by its unique `id`.
 */
export const CODING_PLAN_URL_PRESETS: Record<string, { baseUrl: string; separateApiKey?: boolean }> = {
  zhipu: { baseUrl: 'https://api.z.ai/api/coding/paas/v4' },
  'zhipu-bigmodel': { baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4' },
  volcengine: { baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3' },
  kimi: { baseUrl: 'https://api.kimi.com/coding/v1' },
  dashscope: { baseUrl: 'https://coding.dashscope.aliyuncs.com/compatible-mode/v1', separateApiKey: true },
  tencent: { baseUrl: 'https://api.lkeap.cloud.tencent.com/coding/v3' },
  baidu: { baseUrl: 'https://qianfan.baidubce.com/v2/coding' },
  kuaishou: { baseUrl: 'https://wanqing.streamlakeapi.com/api/gateway/coding/v1' },
  // Xiaomi MiMo Token Plan — both formats first-class.
  // OpenAI variant id `xiaomi-mimo` -> OpenAI Token Plan endpoint.
  // Anthropic variant id `xiaomi-mimo-anthropic` -> Anthropic Token Plan endpoint.
  // Overseas users may swap `token-plan-cn` -> `token-plan-sgp` / `token-plan-ams` manually.
  'xiaomi-mimo': { baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1' },
  'xiaomi-mimo-anthropic': { baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic' },
  // MiniMax and Moore Threads don't need URL switching
};

/**
 * Known provider model mappings for the follow-provider feature.
 * Key is the provider's presetId (matching LLM_PROVIDER_PRESETS[].presetId).
 * Variants that share a presetId (e.g. xiaomi-mimo OpenAI/Anthropic) share one mapping.
 */
export const PROVIDER_MODEL_MAPPINGS: Record<string, ProviderModelMapping> = {
  zhipu: {
    primary: 'glm-5.1',
    background: 'glm-4.5-air',
    vision: 'glm-4.6v',
  },
  volcengine: {
    primary: 'ark-code-latest',
    background: 'doubao-seed-2.0-lite',
    vision: 'doubao-seed-2.0-code',
  },
  kimi: {
    primary: 'kimi-k2.5',
    background: 'kimi-k2-0905-preview',
    vision: 'kimi-k2.5',
  },
  dashscope: {
    primary: 'qwen3-max',
    background: 'qwen-turbo',
    vision: 'qwen3.5-plus',
  },
  tencent: {
    primary: 'tc-code-latest',
    background: 'hunyuan-turbos',
    vision: null,
  },
  minimax: {
    primary: 'MiniMax-M2.5',
    background: 'MiniMax-M2.1-highspeed',
    vision: null,
  },
  baidu: {
    primary: 'qianfan-code-latest',
    background: 'ernie-3.5',
    vision: 'ernie-4.5-vl-28b-a3b',
  },
  kuaishou: {
    primary: 'kat-coder-pro-v1',
    background: 'kat-coder-air-v1',
    vision: null,
  },
  mthreads: {
    primary: 'glm-4.7',
    background: 'glm-4.7',
    vision: null,
  },
  'xiaomi-mimo': {
    // xiaomi-mimo API expects lowercase ids — see the Xiaomi preset model list.
    primary: 'mimo-v2.5-pro',
    background: 'mimo-v2-flash',
    vision: 'mimo-v2-omni',
  },
  // International providers
  openai: {
    primary: 'gpt-4o',
    background: 'gpt-4o-mini',
    vision: 'gpt-4o',
  },
  anthropic: {
    primary: 'claude-sonnet-4-6',
    background: 'claude-haiku-4-5',
    vision: 'claude-sonnet-4-6',
  },
  gemini: {
    primary: 'gemini-3.1-pro',
    background: 'gemini-3-flash',
    vision: 'gemini-3.1-pro',
  },
};

/**
 * Search configurations for known providers.
 * Key is the provider's presetId (matching LLM_PROVIDER_PRESETS[].id or PROVIDER_TEMPLATES[].id).
 */
export const PROVIDER_SEARCH_CONFIGS: Record<string, ProviderSearchConfig> = {
  // Chinese providers
  dashscope: {
    type: 'model-param',
    paramName: 'enable_search',
    paramValue: true,
    applicableModels: ['qwen3-max', 'qwen3.5-plus', 'qwen-turbo'],
  },
  kimi: {
    type: 'builtin-tool',
    toolDefinition: {
      type: 'builtin_function',
      function: { name: 'web_search' },
    },
    conflictsWithFC: false,
    applicableModels: null,
  },
  volcengine: {
    type: 'model-param',
    paramName: 'web_search',
    paramValue: { enable: true },
    applicableModels: null,
  },
  baidu: {
    type: 'model-param',
    paramName: 'web_search',
    paramValue: { enable: true, enable_citation: true },
    applicableModels: ['ernie-4.5', 'ernie-3.5'],
  },
  minimax: {
    type: 'mcp',
    mcpServerId: 'minimax-search',
    applicableModels: null,
  },
  zhipu: {
    type: 'builtin-tool',
    toolDefinition: {
      type: 'web_search',
      web_search: { enable: true },
    },
    conflictsWithFC: false,
    applicableModels: null,
  },
  // International providers
  anthropic: {
    type: 'sdk-native',
    applicableModels: null,
  },
  openai: {
    type: 'builtin-tool',
    toolDefinition: {
      type: 'web_search_preview',
    },
    conflictsWithFC: false,
    applicableModels: null,
  },
  google: {
    type: 'builtin-tool',
    toolDefinition: {
      google_search: {},
    },
    conflictsWithFC: false,
    applicableModels: null,
  },
  // Alias: PROVIDER_MODEL_MAPPINGS uses "gemini", presetId may be either
  gemini: {
    type: 'builtin-tool',
    toolDefinition: {
      google_search: {},
    },
    conflictsWithFC: false,
    applicableModels: null,
  },
};

/**
 * Default `maxConcurrency` baseline (-1 = no limit).
 */
export const DEFAULT_MAX_CONCURRENCY = -1;

/**
 * Per-preset overrides for the default `maxConcurrency`. Anything not listed
 * falls back to {@link DEFAULT_MAX_CONCURRENCY} (-1 = no limit). The Chinese
 * cloud providers cluster here because they ship stricter per-key rate limits
 * (TPM / QPS) that bite at low concurrency — well-funded international
 * providers handle parallelism themselves, so a client-side semaphore would
 * just throttle us for no reason.
 *
 * A preset's own explicit `maxConcurrency` field still wins over this map.
 */
export const MAX_CONCURRENCY_DEFAULTS: Record<string, number> = {
  zhipu: 5,
  'zhipu-bigmodel': 5,
  kimi: 5,
  minimax: 5,
  dashscope: 5,
  volcengine: 5,
  tencent: 5,
  'tencent-anthropic': 5,
  baidu: 5,
  kuaishou: 5,
  mthreads: 5,
  'xiaomi-mimo': 5,
  'xiaomi-mimo-anthropic': 5,
};

/**
 * Default seed preset IDs for cold-boot — all available presets.
 * Each ID MUST resolve via `getAllProviderPresets()` — the host's provider
 * manager asserts this in development to catch orphan IDs early.
 *
 * **Ordering**: popular at top, cold/niche at bottom. The array index becomes
 * the initial `sortOrder` (× 100 to leave gaps for manual inserts), so users
 * see flagship providers first in the client's provider list. They can
 * drag-reorder afterwards via `reorderProviders()`.
 *
 * Tiers:
 *   1. International flagship (openai/anthropic/gemini/deepseek/grok)
 *   2. Aggregator + Chinese flagship with coding plan
 *   3. International extras + fast inference + local
 *   4. Specialized (azure / openai-response)
 *   5. Cold / niche / variants (bottom)
 */
export const DEFAULT_SEED_PRESET_IDS: readonly string[] = [
  // Tier 1 — international flagship
  'openai',
  'anthropic',
  'gemini',
  'gemini-vertex',
  'deepseek',
  'grok',
  // Tier 2 — aggregator + Chinese flagship (with coding plan).
  // MiniMax + Xiaomi MiMo bumped up next to Kimi per UX preference —
  // popular Anthropic-format Chinese providers cluster together.
  'openrouter',
  'zhipu',
  'zhipu-bigmodel',
  'kimi',
  'minimax',
  'xiaomi-mimo',
  'dashscope',
  'volcengine',
  'tencent',
  // Tier 3 — international extras + fast inference + local
  'siliconflow',
  'mistral',
  'together',
  'perplexity',
  'groq',
  'cerebras',
  'ollama',
  // Tier 4 — specialized
  'azure-openai',
  'openai-response',
  // Tier 5 — cold / niche / variants
  'xiaomi-mimo-anthropic',
  'tencent-anthropic',
  'baidu',
  'kuaishou',
  'mthreads',
];
