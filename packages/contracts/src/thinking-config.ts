/**
 * thinking-config — dependency-light thinking-budget / reasoning-effort helpers.
 *
 * The PURE budget/effort functions the `@omnicross/*` packages consume
 * (`getOpenAIReasoningEffort`, `buildAnthropicThinking`, `calculateThinkingBudget`,
 * `getClaudeMaxTokens`, `isReasoningModel`, `DEFAULT_MAX_TOKENS`) plus the in-file
 * regex/numeric data they rely on.
 *
 * This module is intentionally import-closed (0 runtime deps): it OMITS any
 * global model-thinking-level cache + its initializing side-effect (which would
 * pull the full canonical-models / provider-presets closure into the import
 * graph) and the cache-fed lookups (`getAvailableThinkLevels` / `validateThinkLevel`),
 * none of which the `@omnicross/*` packages call.
 */

import type { ThinkLevel } from './completion-types';
import type { ModelConfig } from './llm-config';

// ============================================================================
// Thinking-budget ratio + global default
// ============================================================================

/**
 * Thinking effort → budget ratio (budget = (max - min) * ratio + min). Used only
 * by token-budget APIs (Claude budget_tokens, Gemini thinking_budget). OpenAI /
 * DeepSeek discrete reasoning_effort providers pass the level through directly.
 */
export const EFFORT_RATIO: Record<ThinkLevel, number> = {
  none: 0.01,
  minimal: 0.02,
  low: 0.05,
  medium: 0.5,
  high: 0.8,
  xhigh: 0.92,
  max: 0.95,
};

/** Global default max_tokens — used only when an API requires max_tokens set. */
export const DEFAULT_MAX_TOKENS = 4096;

// ============================================================================
// Per-model thinking-token limits (regex pattern → { min, max })
// ============================================================================

export const THINKING_TOKEN_MAP: Record<string, { min: number; max: number }> = {
  // Gemini
  'gemini-2\\.5-flash-lite': { min: 512, max: 24576 },
  'gemini-.*-flash': { min: 0, max: 24576 },
  'gemini-.*-pro': { min: 128, max: 32768 },

  // Qwen
  'qwen3-235b-a22b-thinking': { min: 0, max: 81920 },
  'qwen3-30b-a3b-thinking': { min: 0, max: 81920 },
  'qwen3-vl-235b-a22b-thinking': { min: 0, max: 81920 },
  'qwen3-vl-30b-a3b-thinking': { min: 0, max: 81920 },
  'qwen-plus-2025': { min: 0, max: 38912 },
  'qwen-plus': { min: 0, max: 81920 },
  'qwen-turbo': { min: 0, max: 38912 },
  'qwen-flash': { min: 0, max: 81920 },
  'qwen3-': { min: 1024, max: 38912 },
  qwq: { min: 1024, max: 38912 },

  // Claude (incl. AWS Bedrock, GCP Vertex AI)
  'claude-opus-4[.-]7': { min: 1024, max: 128000 },
  'claude-(sonnet|opus)-4[.-]6': { min: 1024, max: 128000 },
  'claude-3[.-]7.*sonnet': { min: 1024, max: 64000 },
  'claude-(haiku|sonnet|opus)-4[.-]5': { min: 1024, max: 64000 },
  'claude-opus-4[.-]1': { min: 1024, max: 32000 },
  'claude-sonnet-4': { min: 1024, max: 64000 },
  'claude-opus-4': { min: 1024, max: 32000 },
  'claude-3[.-]5-sonnet': { min: 1024, max: 64000 },

  // OpenAI o-series
  'o1-preview': { min: 0, max: 32768 },
  'o1-mini': { min: 0, max: 32768 },
  'o1-pro': { min: 0, max: 32768 },
  'o3-mini': { min: 0, max: 32768 },
  o3: { min: 0, max: 65536 },
  'o4-mini': { min: 0, max: 32768 },

  // GPT-5 series (Response API reasoning models)
  'gpt-5\\.5': { min: 0, max: 128000 },
  'gpt-5\\.4': { min: 0, max: 128000 },
  'gpt-5\\.3': { min: 0, max: 128000 },
  'gpt-5\\.2': { min: 0, max: 65536 },
  'gpt-5\\.1': { min: 0, max: 65536 },
  'gpt-5': { min: 0, max: 65536 },

  // DeepSeek
  'deepseek-v4-pro': { min: 0, max: 32768 },
  'deepseek-v4-flash': { min: 0, max: 32768 },
  'deepseek-r1': { min: 0, max: 32768 },
  'deepseek-reasoner': { min: 0, max: 32768 },

  // Baichuan
  'baichuan-m2': { min: 0, max: 30000 },
  'baichuan-m3': { min: 0, max: 30000 },

  // Grok
  'grok-3': { min: 0, max: 32768 },

  // Zhipu GLM
  'glm.*zero': { min: 0, max: 16384 },

  // Hunyuan
  'hunyuan.*t1': { min: 0, max: 16384 },

  // Doubao
  'doubao.*think': { min: 0, max: 16384 },
};

// ============================================================================
// Reasoning-model detection
// ============================================================================

/** Reasoning-model recognition patterns. */
export const REASONING_MODEL_PATTERNS: RegExp[] = [
  /^o[134](-mini|-preview|-pro)?$/i,
  /^gpt-5(\.\d)?(-pro|-codex|-codex-max)?/i,
  /claude.*3[.-]?5.*sonnet|claude.*sonnet.*3[.-]?5|claude-sonnet-4|claude-opus-4|claude-(haiku|sonnet|opus)-4[.-]?5/i,
  /gemini.*(2\.0|2-|2\.5|3).*flash|gemini.*(2\.5|3).*pro|gemini.*think/i,
  /grok-3/i,
  /qwq|qwen.*qwq|qwen.*thinking/i,
  /deepseek-v4|deepseek.*r1|r1.*deepseek|deepseek-reasoner/i,
  /glm.*zero/i,
  /hunyuan.*t1/i,
  /doubao.*think/i,
  /baichuan-m[23]/i,
];

/** Patterns for models that cannot fully disable thinking. */
export const CANNOT_DISABLE_THINKING_PATTERNS: RegExp[] = [
  /gemini.*3.*pro/i,
  /gemini.*2\.5.*pro/i,
  /^o1-pro$/i,
];

// ============================================================================
// Pure helpers
// ============================================================================

/** Whether the model supports thinking/reasoning. */
export function isReasoningModel(modelId: string): boolean {
  if (!modelId) return false;
  return REASONING_MODEL_PATTERNS.some((pattern) => pattern.test(modelId));
}

/** Whether the model can disable thinking. */
export function canDisableThinking(modelId: string): boolean {
  if (!modelId) return true;
  return !CANNOT_DISABLE_THINKING_PATTERNS.some((pattern) => pattern.test(modelId));
}

/**
 * Resolve the model's thinking-token limit. Prefers a declared
 * `ModelConfig.thinkingTokenLimit`, else falls back to a regex match.
 */
export function findTokenLimit(
  modelOrId: string | ModelConfig,
): { min: number; max: number } | null {
  if (!modelOrId) return null;

  if (typeof modelOrId === 'object') {
    if (modelOrId.thinkingTokenLimit) return modelOrId.thinkingTokenLimit;
    return findTokenLimit(modelOrId.id);
  }

  const lowerModelId = modelOrId.toLowerCase();

  for (const [pattern, limit] of Object.entries(THINKING_TOKEN_MAP)) {
    const regex = new RegExp(pattern, 'i');
    if (regex.test(lowerModelId)) {
      return limit;
    }
  }

  return null;
}

/**
 * Calculate the thinking budget for a model + effort level.
 * Returns undefined when no budget can be computed.
 */
export function calculateThinkingBudget(
  modelId: string,
  level: ThinkLevel,
  userMaxTokens?: number,
): number | undefined {
  if (level === 'none') {
    const tokenLimit = findTokenLimit(modelId);
    if (tokenLimit && tokenLimit.min > 0) {
      return tokenLimit.min;
    }
    return undefined;
  }

  const tokenLimit = findTokenLimit(modelId);
  const ratio = EFFORT_RATIO[level];

  if (!tokenLimit) {
    if (userMaxTokens) {
      const maxBudget = Math.floor(userMaxTokens * 0.75);
      return Math.floor(Math.min(userMaxTokens * ratio, maxBudget));
    }
    return undefined;
  }

  const formulaResult = Math.floor((tokenLimit.max - tokenLimit.min) * ratio + tokenLimit.min);

  if (userMaxTokens !== undefined) {
    const maxBudgetFromUserTokens = Math.floor(userMaxTokens * Math.min(ratio, 0.75));
    return Math.max(tokenLimit.min, Math.min(formulaResult, maxBudgetFromUserTokens));
  }

  return formulaResult;
}

/** Claude max_tokens after subtracting the thinking budget. */
export function getClaudeMaxTokens(
  userMaxTokens: number | undefined,
  thinkingBudget: number | undefined,
): number | undefined {
  if (!userMaxTokens) return undefined;
  if (!thinkingBudget) return userMaxTokens;

  const outputTokens = userMaxTokens - thinkingBudget;
  return outputTokens > 0 ? outputTokens : undefined;
}

/** OpenAI reasoning_effort mapping (pass-through; `max` maps to `high`). */
export function getOpenAIReasoningEffort(level: ThinkLevel): string | undefined {
  switch (level) {
    case 'none':
      return 'none';
    case 'minimal':
      return 'minimal';
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
      return 'xhigh';
    case 'max':
      return 'high';
    default:
      return undefined;
  }
}

/** Gemini thinkingConfig builder. */
export function buildGeminiThinkingConfig(
  modelId: string,
  level: ThinkLevel,
  userMaxTokens?: number,
): { thinking_budget: number } | undefined {
  if (!isReasoningModel(modelId)) {
    return undefined;
  }

  const budget = calculateThinkingBudget(modelId, level, userMaxTokens);
  if (budget === undefined) {
    return undefined;
  }

  return { thinking_budget: budget };
}

/** Anthropic thinking config builder. */
export function buildAnthropicThinking(
  modelId: string,
  level: ThinkLevel,
  userMaxTokens?: number,
): { type: 'enabled'; budget_tokens: number } | undefined {
  if (level === 'none') {
    return undefined;
  }

  const budget = calculateThinkingBudget(modelId, level, userMaxTokens);
  if (!budget || budget < 1024) {
    return { type: 'enabled', budget_tokens: 1024 };
  }

  return { type: 'enabled', budget_tokens: budget };
}

/** Qwen/DeepSeek enable_thinking config builder. */
export function buildQwenThinkingConfig(
  level: ThinkLevel,
  userMaxTokens?: number,
): { enable_thinking: boolean; thinking_budget?: number } {
  if (level === 'none') {
    return { enable_thinking: false };
  }

  const ratio = EFFORT_RATIO[level];
  const budget = userMaxTokens ? Math.floor(userMaxTokens * ratio) : undefined;

  return {
    enable_thinking: true,
    thinking_budget: budget,
  };
}
