/**
 * Canonical Model Registry
 *
 * Single source of truth for **model capabilities** (contextLength, vision,
 * reasoning, thinking levels, etc.). Capabilities are properties of the
 * *model*, not of the provider that hosts it — so this registry is keyed by a
 * normalized model id and used by every provider that exposes that model.
 *
 * Use cases:
 *  - Aggregator providers (OpenRouter / SiliconFlow / Together) that host
 *    upstream models inherit caps automatically; their preset modelConfigs
 *    don't have to redeclare vision/reasoning/etc. for every model.
 *  - User adds a model id (e.g. `glm-5.1`) via Manage Models on any provider:
 *    runtime fills capability fields from this registry on every load.
 *  - Per-preset and per-row overrides remain authoritative when defined —
 *    `resolveModelCapabilities` does per-field merge with preset / row
 *    winning over canonical.
 *
 * Maintenance: vendor-grouped const blocks below. To add a new model from
 * vendor X, edit the `X_MODELS` block. The flat `KNOWN_MODELS` export at the
 * bottom is auto-merged at module init; a duplicate-id assertion fails fast
 * if two vendors accidentally claim the same id.
 */

import type { ThinkLevel } from './completion-types';
import type { ModelConfig } from './llm-config';

// ============================================================================
// Types
// ============================================================================

/**
 * Capability subset of {@link ModelConfig} — fields that describe what the
 * model can do, independent of who's hosting it. Excludes `id`, `name`,
 * `enabled`, `group`, `completionSettings`, `openRouterProvider` (per-row /
 * per-provider concerns).
 */
export interface KnownModelCapabilities {
  category?: ModelConfig['category'];
  contextLength?: number;
  maxTokens?: number;
  vision?: boolean;
  functionCall?: boolean;
  reasoning?: boolean;
  webSearch?: boolean;
  thinkingLevels?: ThinkLevel[];
  thinkingTokenLimit?: { min: number; max: number };
}

/**
 * Result of three-layer resolution. Same shape as KnownModelCapabilities;
 * any subset of fields may be defined.
 */
export type ResolvedModelCapabilities = KnownModelCapabilities;

// ============================================================================
// Vendor-grouped canonical entries
// ----------------------------------------------------------------------------
// Each block is a `Record<canonicalNormalizedId, KnownModelCapabilities>`.
// Keys MUST be lowercase, no `publisher/` prefix, no `:tag` suffix —
// matching the output of `normalizeModelId`.
// ============================================================================

const OPENAI_MODELS: Record<string, KnownModelCapabilities> = {
  'gpt-5.5': { category: 'reasoning', contextLength: 1050000, maxTokens: 128000, reasoning: true, vision: true, functionCall: true, thinkingLevels: ['none', 'low', 'medium', 'high', 'xhigh'], thinkingTokenLimit: { min: 0, max: 128000 } },
  'gpt-5.4': { category: 'reasoning', contextLength: 1050000, maxTokens: 128000, reasoning: true, vision: true, functionCall: true, thinkingLevels: ['none', 'low', 'medium', 'high', 'xhigh'], thinkingTokenLimit: { min: 0, max: 128000 } },
  'gpt-5.4-mini': { category: 'reasoning', contextLength: 400000, maxTokens: 128000, reasoning: true, vision: true, functionCall: true, thinkingLevels: ['none', 'low', 'medium', 'high', 'xhigh'], thinkingTokenLimit: { min: 0, max: 128000 } },
  'gpt-5.3-codex': { category: 'code', contextLength: 400000, maxTokens: 128000, reasoning: true, vision: true, functionCall: true, thinkingLevels: ['low', 'medium', 'high', 'xhigh'], thinkingTokenLimit: { min: 0, max: 128000 } },
  'gpt-5.2': { category: 'reasoning', contextLength: 1050000, maxTokens: 65536, reasoning: true, vision: true, functionCall: true, thinkingLevels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'], thinkingTokenLimit: { min: 0, max: 65536 } },
  'gpt-5': { category: 'reasoning', contextLength: 1050000, maxTokens: 65536, reasoning: true, vision: true, functionCall: true },
  'gpt-4.1': { category: 'chat', contextLength: 1050000, maxTokens: 32768, vision: true, functionCall: true },
  'gpt-4o': { category: 'chat', contextLength: 128000, maxTokens: 16384, vision: true, functionCall: true },
  'gpt-4o-mini': { category: 'chat', contextLength: 128000, maxTokens: 16384, functionCall: true },
  'o3': { category: 'reasoning', contextLength: 200000, maxTokens: 100000, reasoning: true, thinkingLevels: ['low', 'medium', 'high'], thinkingTokenLimit: { min: 0, max: 65536 } },
  'o4-mini': { category: 'reasoning', contextLength: 200000, maxTokens: 100000, reasoning: true, thinkingLevels: ['low', 'medium', 'high'], thinkingTokenLimit: { min: 0, max: 32768 } },
};

// Claude default context is 200K. The 1M-context tier is a separate model id
// with a `[1m]` suffix (matches Anthropic's `anthropic_beta:
// context-1m-2025-08-07` header semantics — the request is effectively a
// different model from the API's perspective when the long-context tier is
// engaged). Pricing on the 1M tier differs from the standard tier.
const ANTHROPIC_MODELS: Record<string, KnownModelCapabilities> = {
  'claude-opus-4-7': { category: 'reasoning', contextLength: 200000, maxTokens: 128000, vision: true, functionCall: true, reasoning: true },
  'claude-opus-4-7[1m]': { category: 'reasoning', contextLength: 1000000, maxTokens: 128000, vision: true, functionCall: true, reasoning: true },
  'claude-opus-4-6': { category: 'reasoning', contextLength: 200000, maxTokens: 128000, vision: true, functionCall: true, reasoning: true, thinkingLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], thinkingTokenLimit: { min: 1024, max: 128000 } },
  'claude-opus-4-6[1m]': { category: 'reasoning', contextLength: 1000000, maxTokens: 128000, vision: true, functionCall: true, reasoning: true, thinkingLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], thinkingTokenLimit: { min: 1024, max: 128000 } },
  'claude-sonnet-4-6': { category: 'chat', contextLength: 200000, maxTokens: 64000, vision: true, functionCall: true, reasoning: true, thinkingLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], thinkingTokenLimit: { min: 1024, max: 64000 } },
  'claude-sonnet-4-6[1m]': { category: 'chat', contextLength: 1000000, maxTokens: 64000, vision: true, functionCall: true, reasoning: true, thinkingLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], thinkingTokenLimit: { min: 1024, max: 64000 } },
  'claude-haiku-4-5': { category: 'chat', contextLength: 200000, maxTokens: 64000, vision: true, functionCall: true, reasoning: true, thinkingLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], thinkingTokenLimit: { min: 1024, max: 64000 } },
};

const GEMINI_MODELS: Record<string, KnownModelCapabilities> = {
  'gemini-3-flash': { category: 'chat', contextLength: 1000000, maxTokens: 65536, vision: true, functionCall: true, reasoning: true, thinkingLevels: ['none', 'low', 'medium', 'high'], thinkingTokenLimit: { min: 0, max: 24576 } },
  'gemini-3.1-pro': { category: 'chat', contextLength: 1000000, maxTokens: 65536, vision: true, functionCall: true, reasoning: true, thinkingLevels: ['low', 'medium', 'high'], thinkingTokenLimit: { min: 128, max: 32768 } },
};

const GROK_MODELS: Record<string, KnownModelCapabilities> = {
  'grok-4.3': { category: 'chat', contextLength: 1000000, maxTokens: 32768, vision: true, functionCall: true, reasoning: true, thinkingLevels: ['none', 'low', 'medium', 'high'], thinkingTokenLimit: { min: 0, max: 32768 } },
  'grok-4.20': { category: 'chat', contextLength: 131072, maxTokens: 32768, vision: true, functionCall: true },
  'grok-4.20-reasoning': { category: 'reasoning', contextLength: 131072, maxTokens: 32768, reasoning: true, vision: true, functionCall: true, thinkingLevels: ['none', 'low', 'medium', 'high'], thinkingTokenLimit: { min: 0, max: 32768 } },
  'grok-4.20-multi-agent': { category: 'reasoning', contextLength: 131072, maxTokens: 32768, reasoning: true, thinkingLevels: ['none', 'low', 'medium', 'high'], thinkingTokenLimit: { min: 0, max: 32768 } },
};

const DEEPSEEK_MODELS: Record<string, KnownModelCapabilities> = {
  'deepseek-v4-flash': { category: 'chat', contextLength: 1000000, maxTokens: 384000, functionCall: true, reasoning: true, thinkingLevels: ['none', 'high', 'max'], thinkingTokenLimit: { min: 0, max: 32768 } },
  'deepseek-v4-pro': { category: 'reasoning', contextLength: 1000000, maxTokens: 384000, functionCall: true, reasoning: true, thinkingLevels: ['none', 'high', 'max'], thinkingTokenLimit: { min: 0, max: 32768 } },
  'deepseek-v3': { category: 'chat', contextLength: 65536, maxTokens: 8192, functionCall: true },
  'deepseek-v3.2': { category: 'code', contextLength: 256000, maxTokens: 32768, functionCall: true, reasoning: true },
  'deepseek-r1': { category: 'reasoning', contextLength: 64000, maxTokens: 8192, reasoning: true, thinkingTokenLimit: { min: 0, max: 32768 } },
};

const ZHIPU_MODELS: Record<string, KnownModelCapabilities> = {
  'glm-5': { category: 'chat', contextLength: 200000, maxTokens: 128000, functionCall: true },
  'glm-5.1': { category: 'chat', contextLength: 200000, maxTokens: 128000, functionCall: true },
  'glm-4.5-air': { category: 'chat', contextLength: 128000, maxTokens: 32768, functionCall: true },
  'glm-4.6v': { category: 'chat', contextLength: 128000, maxTokens: 32768, vision: true, functionCall: true },
  'glm-4.7': { category: 'code', contextLength: 200000, maxTokens: 128000, functionCall: true },
};

const KIMI_MODELS: Record<string, KnownModelCapabilities> = {
  'kimi-k2.6': { category: 'code', contextLength: 256000, maxTokens: 32768, vision: true, functionCall: true, reasoning: true, thinkingLevels: ['none', 'low', 'medium', 'high'], thinkingTokenLimit: { min: 0, max: 32768 } },
  'kimi-k2.5': { category: 'chat', contextLength: 256000, maxTokens: 65535, vision: true, functionCall: true, reasoning: true, thinkingLevels: ['none', 'low', 'medium', 'high'], thinkingTokenLimit: { min: 0, max: 32768 } },
  'kimi-k2-thinking': { category: 'reasoning', contextLength: 256000, reasoning: true, functionCall: true, thinkingLevels: ['none', 'low', 'medium', 'high'], thinkingTokenLimit: { min: 0, max: 32768 } },
};

const DASHSCOPE_QWEN_MODELS: Record<string, KnownModelCapabilities> = {
  'qwen3-max': { category: 'chat', contextLength: 262144, maxTokens: 65536, functionCall: true, webSearch: true },
  'qwen3.5-plus': { category: 'chat', contextLength: 1000000, vision: true, functionCall: true, webSearch: true },
  'qwen-turbo': { category: 'chat', contextLength: 1000000, vision: true, webSearch: true },
  'qwen3-coder-plus': { category: 'code', contextLength: 1000000, functionCall: true },
  'qwen-3-coder-480b': { category: 'code', contextLength: 131072, maxTokens: 8192, functionCall: true },
  'qwen-3-32b': { category: 'chat', contextLength: 131072, maxTokens: 8192, functionCall: true },
  'qwen2.5-coder-32b-instruct': { category: 'code', contextLength: 32768, maxTokens: 8192, functionCall: true },
  'qwen2.5-coder-7b-instruct': { category: 'code', contextLength: 32768, maxTokens: 8192, functionCall: true },
};

const VOLCENGINE_DOUBAO_MODELS: Record<string, KnownModelCapabilities> = {
  'ark-code-latest': { category: 'code', contextLength: 256000, maxTokens: 32768, functionCall: true },
  'doubao-seed-2.0-code': { category: 'code', contextLength: 256000, maxTokens: 128000, vision: true, functionCall: true },
  'doubao-seed-2.0-lite': { category: 'chat', contextLength: 256000, maxTokens: 32768, functionCall: true },
};

const TENCENT_HUNYUAN_MODELS: Record<string, KnownModelCapabilities> = {
  'tc-code-latest': { category: 'code', functionCall: true },
  'hunyuan-2.0-instruct': { category: 'chat', functionCall: true },
  'hunyuan-turbos': { category: 'chat', functionCall: true },
};

const MINIMAX_MODELS: Record<string, KnownModelCapabilities> = {
  'minimax-m2.5': { category: 'code', contextLength: 204800, functionCall: true },
  'minimax-m2.5-highspeed': { category: 'code', contextLength: 204800, functionCall: true },
  'minimax-m2.1': { category: 'code', contextLength: 204800, functionCall: true },
  'minimax-m2.1-highspeed': { category: 'code', contextLength: 204800, functionCall: true },
};

const XIAOMI_MIMO_CANONICAL: Record<string, KnownModelCapabilities> = {
  'mimo-v2.5': { category: 'code', contextLength: 1000000, maxTokens: 32768, vision: true, functionCall: true, reasoning: true, thinkingLevels: ['none', 'low', 'medium', 'high'], thinkingTokenLimit: { min: 0, max: 32768 } },
  // mimo-v2.5-pro does not support vision (text + reasoning only).
  'mimo-v2.5-pro': { category: 'code', contextLength: 1000000, maxTokens: 32768, vision: false, functionCall: true, reasoning: true, thinkingLevels: ['none', 'low', 'medium', 'high'], thinkingTokenLimit: { min: 0, max: 32768 } },
  'mimo-v2-pro': { category: 'code', contextLength: 1000000, maxTokens: 32768, vision: true, functionCall: true, reasoning: true, thinkingLevels: ['none', 'low', 'medium', 'high'], thinkingTokenLimit: { min: 0, max: 32768 } },
  'mimo-v2-flash': { category: 'code', contextLength: 256000, maxTokens: 32768, vision: true, functionCall: true },
  'mimo-v2-omni': { category: 'chat', contextLength: 256000, maxTokens: 32768, vision: true, functionCall: true },
};

const META_LLAMA_MODELS: Record<string, KnownModelCapabilities> = {
  'llama-3.3-70b': { category: 'chat', contextLength: 131072, maxTokens: 8192, functionCall: true },
  'llama-3.3-70b-versatile': { category: 'chat', contextLength: 131072, maxTokens: 32768, functionCall: true },
  'llama-3.3-70b-instruct': { category: 'chat', contextLength: 131072, maxTokens: 8192, functionCall: true },
  'llama-3.3-70b-instruct-turbo': { category: 'chat', contextLength: 131072, maxTokens: 8192, functionCall: true },
  'llama-3.1-8b-instant': { category: 'chat', contextLength: 131072, maxTokens: 8192, functionCall: true },
};

const MISTRAL_MODELS: Record<string, KnownModelCapabilities> = {
  'mistral-large-latest': { category: 'chat', contextLength: 131072, maxTokens: 8192, functionCall: true },
  'codestral-latest': { category: 'code', contextLength: 256000, maxTokens: 8192, functionCall: true },
  'mistral-medium-latest': { category: 'chat', contextLength: 131072, maxTokens: 8192, functionCall: true },
  'mixtral-8x7b-32768': { category: 'chat', contextLength: 32768, maxTokens: 32768, functionCall: true },
};

const PERPLEXITY_MODELS: Record<string, KnownModelCapabilities> = {
  'sonar': { category: 'chat', contextLength: 127072, maxTokens: 8192, webSearch: true },
  'sonar-pro': { category: 'chat', contextLength: 200000, maxTokens: 8192, webSearch: true },
  'sonar-reasoning-pro': { category: 'reasoning', contextLength: 127072, maxTokens: 8192, reasoning: true, webSearch: true },
};

const BAIDU_ERNIE_MODELS: Record<string, KnownModelCapabilities> = {
  'qianfan-code-latest': { category: 'code', contextLength: 98304, maxTokens: 65536, functionCall: true },
  'ernie-4.5': { category: 'chat', functionCall: true },
  'ernie-3.5': { category: 'chat' },
};

const KUAISHOU_KAT_MODELS: Record<string, KnownModelCapabilities> = {
  'kat-coder-pro-v1': { category: 'code', contextLength: 256000, maxTokens: 128000, functionCall: true },
  'kat-coder-air-v1': { category: 'code', contextLength: 128000, maxTokens: 32768, functionCall: true },
};

// ============================================================================
// Public flat registry
// ----------------------------------------------------------------------------
// Merged from vendor groups at module load. Lookup is O(1) by normalized id.
// A duplicate-id assertion below fails fast on collisions.
// ============================================================================

const VENDOR_GROUPS: Array<{ name: string; entries: Record<string, KnownModelCapabilities> }> = [
  { name: 'OPENAI_MODELS', entries: OPENAI_MODELS },
  { name: 'ANTHROPIC_MODELS', entries: ANTHROPIC_MODELS },
  { name: 'GEMINI_MODELS', entries: GEMINI_MODELS },
  { name: 'GROK_MODELS', entries: GROK_MODELS },
  { name: 'DEEPSEEK_MODELS', entries: DEEPSEEK_MODELS },
  { name: 'ZHIPU_MODELS', entries: ZHIPU_MODELS },
  { name: 'KIMI_MODELS', entries: KIMI_MODELS },
  { name: 'DASHSCOPE_QWEN_MODELS', entries: DASHSCOPE_QWEN_MODELS },
  { name: 'VOLCENGINE_DOUBAO_MODELS', entries: VOLCENGINE_DOUBAO_MODELS },
  { name: 'TENCENT_HUNYUAN_MODELS', entries: TENCENT_HUNYUAN_MODELS },
  { name: 'MINIMAX_MODELS', entries: MINIMAX_MODELS },
  { name: 'XIAOMI_MIMO_CANONICAL', entries: XIAOMI_MIMO_CANONICAL },
  { name: 'META_LLAMA_MODELS', entries: META_LLAMA_MODELS },
  { name: 'MISTRAL_MODELS', entries: MISTRAL_MODELS },
  { name: 'PERPLEXITY_MODELS', entries: PERPLEXITY_MODELS },
  { name: 'BAIDU_ERNIE_MODELS', entries: BAIDU_ERNIE_MODELS },
  { name: 'KUAISHOU_KAT_MODELS', entries: KUAISHOU_KAT_MODELS },
];

/**
 * Module-init sanity check. Throws if two vendor groups register the same
 * canonical id — that's almost always a copy-paste bug, and silently
 * letting one group override the other would mask capability regressions.
 */
function assertNoDuplicateCanonicalIds(): void {
  const seen = new Map<string, string>();
  for (const { name, entries } of VENDOR_GROUPS) {
    for (const id of Object.keys(entries)) {
      const prior = seen.get(id);
      if (prior) {
        throw new Error(
          `[canonical-models] duplicate id '${id}' registered in both '${prior}' and '${name}'. ` +
          `Each model must live in exactly one vendor group.`,
        );
      }
      seen.set(id, name);
    }
  }
}

assertNoDuplicateCanonicalIds();

export const KNOWN_MODELS: Record<string, KnownModelCapabilities> = Object.freeze(
  Object.assign(
    Object.create(null),
    ...VENDOR_GROUPS.map((g) => g.entries),
  ),
) as Record<string, KnownModelCapabilities>;

// ============================================================================
// Normalization + alias
// ============================================================================

/**
 * Reduce a raw model id (as it appears in any provider's model list) to its
 * canonical key for {@link KNOWN_MODELS} lookup.
 *
 * Rules:
 *  1. Strip publisher prefix: take everything after the LAST `/`. Handles
 *     `zai-org/GLM-4.7` → `GLM-4.7`, `anthropic/claude-haiku` → `claude-haiku`.
 *  2. Strip aggregator quality / deployment suffixes — anything after `:`
 *     (e.g. `:beta`, `:nitro`, `:free`) — they don't change capabilities.
 *  3. Lowercase. Aggregators disagree on case (`DeepSeek-V3` vs `deepseek-v3`).
 *
 * Pure, deterministic, idempotent.
 */
export function normalizeModelId(rawId: string): string {
  if (!rawId) return '';
  const slashIdx = rawId.lastIndexOf('/');
  const base = slashIdx >= 0 ? rawId.slice(slashIdx + 1) : rawId;
  const colonIdx = base.indexOf(':');
  const noSuffix = colonIdx >= 0 ? base.slice(0, colonIdx) : base;
  return noSuffix.toLowerCase();
}

/**
 * Marketing / legacy aliases that resolve to canonical ids. Applied AFTER
 * `normalizeModelId`. Values MUST be keys of {@link KNOWN_MODELS}; an
 * assertion at module load enforces this so the alias map can't drift to
 * point at non-existent entries.
 *
 * Currently covers DeepSeek's marketing names (`deepseek-chat` is the
 * marketing alias for the latest non-reasoning model — historically v3,
 * may rotate as new releases land).
 */
export const MODEL_ALIASES: Record<string, string> = {
  'deepseek-chat': 'deepseek-v3',
  'deepseek-reasoner': 'deepseek-r1',
};

/**
 * Resolve a normalized id through the alias map. Pass-through if no alias
 * is registered.
 */
export function applyAlias(normalizedId: string): string {
  return MODEL_ALIASES[normalizedId] ?? normalizedId;
}

function assertAliasesPointToKnownModels(): void {
  for (const [from, to] of Object.entries(MODEL_ALIASES)) {
    if (!(to in KNOWN_MODELS)) {
      throw new Error(
        `[canonical-models] alias '${from}' → '${to}' points at unknown id. ` +
        `Either add '${to}' to a vendor group or fix the alias.`,
      );
    }
  }
}

assertAliasesPointToKnownModels();

// ============================================================================
// Three-layer resolution
// ============================================================================

const CAPABILITY_FIELDS = [
  'category',
  'contextLength',
  'maxTokens',
  'vision',
  'functionCall',
  'reasoning',
  'webSearch',
  'thinkingLevels',
  'thinkingTokenLimit',
] as const;

type CapabilityField = typeof CAPABILITY_FIELDS[number];

/**
 * Look up canonical capabilities for a model id. Pure read — no merge.
 * Returns `undefined` if the id (after normalize + alias) isn't in the table.
 *
 * Hosts store the bare model id and a separate `useExtendedContext`
 * flag. When that flag is true, this lookup first
 * tries the `<id>[1m]` capability key (which has the 1M `contextLength` and
 * higher `maxTokens` values) and falls back to the bare id. The `[1m]`
 * suffix in `KNOWN_MODELS` is a lookup convention, not a string-protocol
 * violation — it lives entirely inside this capability table.
 */
export function lookupCanonicalCapabilities(
  rawId: string,
  extendedContext = false,
): KnownModelCapabilities | undefined {
  const normalized = normalizeModelId(rawId);
  if (!normalized) return undefined;
  const canonicalId = applyAlias(normalized);
  if (extendedContext) {
    const extendedKey = `${canonicalId}[1m]`;
    const extended = KNOWN_MODELS[extendedKey];
    if (extended) return extended;
  }
  return KNOWN_MODELS[canonicalId];
}

/**
 * Three-layer merge for a single model. Priority (lowest → highest):
 *   1. Canonical `KNOWN_MODELS` entry (after normalize + alias)
 *   2. `presetOverride` — `modelConfig` declared on a `PresetProviderTemplate`
 *   3. `rowOverride` — user-edited fields persisted on the `llm_models` row
 *
 * Each capability field is merged independently — a higher-priority
 * `undefined` does NOT shadow a lower-priority defined value.
 */
export function resolveModelCapabilities(
  modelId: string,
  presetOverride?: Partial<ModelConfig>,
  rowOverride?: Partial<ModelConfig>,
): ResolvedModelCapabilities {
  const canonical = lookupCanonicalCapabilities(modelId) ?? {};
  const result: KnownModelCapabilities = {};
  for (const field of CAPABILITY_FIELDS) {
    const rowValue = rowOverride?.[field];
    if (rowValue !== undefined) {
      assignField(result, field, rowValue);
      continue;
    }
    const presetValue = presetOverride?.[field];
    if (presetValue !== undefined) {
      assignField(result, field, presetValue);
      continue;
    }
    const canonicalValue = canonical[field];
    if (canonicalValue !== undefined) {
      assignField(result, field, canonicalValue);
    }
  }
  return result;
}

// Type-safe per-field copy. Casts isolated here so callers stay clean.
function assignField<K extends CapabilityField>(
  target: KnownModelCapabilities,
  field: K,
  value: unknown,
): void {
  (target as Record<string, unknown>)[field] = value;
}
