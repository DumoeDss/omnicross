import {
  applyAlias,
  normalizeModelId,
  resolveModelCapabilities,
} from '@omnicross/contracts/canonical-models';
import type { ResolvedModelCapabilities } from '@omnicross/contracts/canonical-models';
import type { ThinkLevel } from '@omnicross/contracts/completion-types';
import type { ModelConfig } from '@omnicross/contracts/llm-config';
import {
  canDisableThinking,
  EFFORT_RATIO,
  findLegacyTokenLimit,
} from '@omnicross/contracts/thinking-config';

export const THINK_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly ThinkLevel[];

export type ReasoningTarget =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic'
  | 'gemini';

export interface ReasoningIntent {
  effort?: ThinkLevel;
  enabled?: boolean;
  /** Explicit reasoning budget from a normalized request. */
  max_tokens?: number;
}

export type ReasoningPlan =
  | { kind: 'off' }
  | { kind: 'level'; effort: ThinkLevel; enabled: boolean }
  | {
      kind: 'budget';
      effort: ThinkLevel;
      enabled: boolean;
      budgetTokens: number;
    };

export interface ResolveReasoningPlanInput {
  intent?: ReasoningIntent;
  model: string;
  provider?: ReasoningProvider;
  target: ReasoningTarget;
  /** Caller-visible bound used by legacy token-budget APIs. */
  requestMaxTokens?: number;
  /** Preserve a recognized native effort on a same-format round trip. */
  preserveNativeEffort?: boolean;
}

export interface ReasoningRequestLike {
  model: string;
  reasoning?: ReasoningIntent;
  reasoning_effort?: unknown;
}

export interface ResolveRequestReasoningOptions {
  preserveNativeEffort?: boolean;
}

export interface ReasoningProvider {
  name?: string;
  baseUrl?: string;
  api_base_url?: string;
  modelConfigs?: Array<Pick<ModelConfig, 'id'> & Partial<ModelConfig>>;
}
type TokenLimit = { min: number; max: number };
type TokenLimitResolution = {
  limits: TokenLimit;
  source: 'capability' | 'legacy' | 'protocol';
};

const THINK_LEVEL_SET = new Set<string>(THINK_LEVELS);

const ANTHROPIC_FALLBACK_BUDGET: Record<Exclude<ThinkLevel, 'none'>, number> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 32768,
  xhigh: 32768,
  max: 32768,
};

/** Normalize an untrusted wire value onto the shared seven-level domain. */
export function normalizeThinkLevel(value: unknown): ThinkLevel | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.toLowerCase();
  return THINK_LEVEL_SET.has(normalized) ? normalized as ThinkLevel : undefined;
}

/** Read normalized reasoning intent without mutating the request. */
export function extractReasoningIntent(
  request: ReasoningRequestLike,
): ReasoningIntent | undefined {
  const reasoning = request.reasoning;
  if (reasoning) {
    if (reasoning.enabled === false) {
      return { ...reasoning, effort: 'none', enabled: false };
    }

    const effort = normalizeThinkLevel(reasoning.effort);
    if (effort) {
      return { ...reasoning, effort, enabled: effort !== 'none' };
    }

    if (reasoning.enabled === true || isPositiveFinite(reasoning.max_tokens)) {
      return { ...reasoning, effort: 'medium', enabled: true };
    }
    return undefined;
  }

  const nativeEffort = normalizeThinkLevel(request.reasoning_effort);
  if (!nativeEffort) return undefined;
  return { effort: nativeEffort, enabled: nativeEffort !== 'none' };
}

function canonicalModelId(model: string): string {
  return applyAlias(normalizeModelId(model));
}

function findModelOverride(
  targetModel: string,
  modelConfigs: Array<Pick<ModelConfig, 'id'> & Partial<ModelConfig>> | undefined,
): Partial<ModelConfig> | undefined {
  if (!modelConfigs) return undefined;
  const targetId = canonicalModelId(targetModel);
  return modelConfigs.find((config) => config.id === targetModel)
    ?? modelConfigs.find((config) => canonicalModelId(config.id) === targetId);
}

/** Merge canonical metadata with the matching provider-row override. */
export function resolveTargetModelCapabilities(
  targetModel: string,
  provider?: ReasoningProvider,
): ResolvedModelCapabilities {
  const rowOverride = findModelOverride(targetModel, provider?.modelConfigs);
  return resolveModelCapabilities(targetModel, undefined, rowOverride);
}

function nearestSupportedEffort(requested: ThinkLevel, candidates: ThinkLevel[]): ThinkLevel {
  const requestedRatio = EFFORT_RATIO[requested];
  return candidates.reduce((best, candidate) => {
    const distance = Math.abs(EFFORT_RATIO[candidate] - requestedRatio);
    const bestDistance = Math.abs(EFFORT_RATIO[best] - requestedRatio);
    if (distance < bestDistance - Number.EPSILON) return candidate;
    if (Math.abs(distance - bestDistance) <= Number.EPSILON
      && EFFORT_RATIO[candidate] < EFFORT_RATIO[best]) return candidate;
    return best;
  });
}

/** Resolve an enabled effort to the nearest level supported by the target. */
export function resolveReasoningEffort(
  requested: ThinkLevel,
  targetModel: string,
  provider?: ReasoningProvider,
): ThinkLevel {
  if (requested === 'none') return 'none';

  const capabilities = resolveTargetModelCapabilities(targetModel, provider);
  const candidates = capabilities.thinkingLevels
    ?.map(normalizeThinkLevel)
    .filter((level): level is ThinkLevel => level !== undefined && level !== 'none') ?? [];

  if (candidates.includes(requested)) return requested;
  if (capabilities.thinkingLevels?.length && candidates.length === 0) return 'none';
  if (candidates.length === 0) return requested;

  return nearestSupportedEffort(requested, candidates);
}

function protocolFallback(model: string, target: ReasoningTarget): TokenLimit | undefined {
  if (target === 'anthropic') return { min: 1024, max: 128000 };
  if (target === 'gemini') {
    return model.toLowerCase().includes('pro')
      ? { min: 128, max: 32768 }
      : { min: 0, max: 24576 };
  }
  return undefined;
}

function resolveTokenLimit(
  model: string,
  provider: ReasoningProvider | undefined,
  target: ReasoningTarget,
): TokenLimitResolution | undefined {
  const capabilities = resolveTargetModelCapabilities(model, provider);
  if (capabilities.thinkingTokenLimit) {
    return { limits: capabilities.thinkingTokenLimit, source: 'capability' };
  }

  const legacy = findLegacyTokenLimit(model);
  if (legacy) return { limits: legacy, source: 'legacy' };

  const fallback = protocolFallback(model, target);
  return fallback ? { limits: fallback, source: 'protocol' } : undefined;
}

/**
 * Resolve token limits in provider-row → canonical → legacy regex → protocol
 * fallback order. OpenAI discrete targets have no protocol budget fallback.
 */
export function resolveReasoningTokenLimit(
  model: string,
  provider: ReasoningProvider | undefined,
  target: ReasoningTarget,
): TokenLimit | undefined {
  return resolveTokenLimit(model, provider, target)?.limits;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clampBudget(
  rawBudget: number,
  limits: TokenLimit,
  target: 'anthropic' | 'gemini',
  effort: Exclude<ThinkLevel, 'none'>,
  requestMaxTokens?: number,
  explicitBudget = false,
): number | undefined {
  const protocolMin = target === 'anthropic' ? 1024 : 0;
  const min = Math.max(protocolMin, Math.floor(limits.min));
  let max = Math.max(min, Math.floor(limits.max));

  if (isPositiveFinite(requestMaxTokens)) {
    const requestCeiling = target === 'anthropic'
      ? Math.min(
        Math.floor(requestMaxTokens) - 1,
        explicitBudget
          ? Math.floor(requestMaxTokens) - 1
          : Math.max(min, Math.floor(requestMaxTokens * Math.min(EFFORT_RATIO[effort], 0.75))),
      )
      : Math.floor(requestMaxTokens);
    if (requestCeiling < min) return undefined;
    max = Math.min(max, requestCeiling);
  }

  return Math.max(min, Math.min(max, Math.floor(rawBudget)));
}

function resolveBudget(
  intent: ReasoningIntent,
  effort: Exclude<ThinkLevel, 'none'>,
  model: string,
  provider: ReasoningProvider | undefined,
  target: 'anthropic' | 'gemini',
  requestMaxTokens?: number,
): number | undefined {
  const resolved = resolveTokenLimit(model, provider, target);
  if (!resolved) return undefined;

  const { limits, source } = resolved;
  const explicitBudget = isFiniteNumber(intent.max_tokens)
    ? Math.floor(intent.max_tokens)
    : undefined;
  const interpolated = source === 'protocol' && target === 'anthropic'
    ? ANTHROPIC_FALLBACK_BUDGET[effort]
    : Math.floor((limits.max - limits.min) * EFFORT_RATIO[effort] + limits.min);

  return clampBudget(
    explicitBudget ?? interpolated,
    limits,
    target,
    effort,
    requestMaxTokens,
    explicitBudget !== undefined,
  );
}

/**
 * Resolve normalized reasoning intent into one semantic plan. Protocol adapters
 * consume this result and only encode its wire shape.
 */
export function resolveReasoningPlan(
  input: ResolveReasoningPlanInput,
): ReasoningPlan | undefined {
  const normalizedIntent = input.intent
    ? extractReasoningIntent({ model: input.model, reasoning: input.intent })
    : undefined;
  if (!normalizedIntent?.effort) return undefined;

  const capabilities = resolveTargetModelCapabilities(input.model, input.provider);
  const nativeEffort = normalizedIntent.effort;
  // Gemini 2.x effort presets still require numeric thinkingBudget on the
  // native wire; their presence does not imply support for thinkingLevel.
  const modelId = canonicalModelId(input.model);
  const minimaxAdaptive = /^minimax-m(?:2(?:[.-]|$)|3$)/.test(modelId);
  const usesNativeLevels = input.target === 'anthropic' && minimaxAdaptive || (
    !!capabilities.thinkingLevels?.length && (
      input.target === 'anthropic'
        ? modelId.startsWith('claude-')
        : input.target !== 'gemini' || !/^gemini-2(?:[.-]|$)/.test(modelId)
    )
  );

  if (nativeEffort !== 'none' && capabilities.reasoning === false) {
    throw new Error(`Thinking is not supported by ${input.model}`);
  }
  if (nativeEffort === 'none') {
    if (!(capabilities.thinkingLevels?.length
      ? capabilities.thinkingLevels.includes('none')
      : canDisableThinking(modelId))) {
      throw new Error(`Thinking cannot be disabled for ${input.model}`);
    }
    if (input.target === 'gemini' && usesNativeLevels) {
      throw new Error(`Thinking cannot be disabled for ${input.model}; choose a supported thinking level`);
    }

    // Native Chat off support does not establish a Responses effort:none control.
    if (input.target === 'openai-responses' && (
      /kimi|moonshot|mimo|grok/i.test(input.provider?.name ?? '') ||
      /kimi|moonshot|xiaomimimo|api\.x\.ai/i.test(
        input.provider?.baseUrl ?? input.provider?.api_base_url ?? '',
      )
    )) {
      return { kind: 'off' };
    }
    const targetsOpenAI = input.target === 'openai-chat' || input.target === 'openai-responses';
    // Disable-only declarations mark omission rather than a wire effort:none.
    if (targetsOpenAI && capabilities.thinkingLevels?.length
      && capabilities.thinkingLevels.every((level) => level === 'none')) {
      return { kind: 'off' };
    }
    if ((targetsOpenAI && capabilities.reasoning !== false
      && (input.preserveNativeEffort || !capabilities.thinkingLevels?.length))
      || (targetsOpenAI && capabilities.thinkingLevels?.includes('none'))
      || (input.target === 'anthropic'
        && (usesNativeLevels || capabilities.thinkingLevels?.includes('none')))) {
      return { kind: 'level', effort: 'none', enabled: false };
    }

    if (input.target === 'gemini' && !usesNativeLevels) {
      const limits = resolveTokenLimit(input.model, input.provider, input.target)?.limits;
      if (limits?.min === 0) {
        return { kind: 'budget', effort: 'none', enabled: false, budgetTokens: 0 };
      }
    }
    if (input.target === 'anthropic' && !usesNativeLevels) {
      const limits = resolveTokenLimit(input.model, input.provider, input.target);
      // A disabled budget consumes no tokens, independently of its enabled minimum.
      // Protocol fallback alone is not evidence that an unknown model supports it.
      if (limits && limits.source !== 'protocol') {
        return { kind: 'budget', effort: 'none', enabled: false, budgetTokens: 0 };
      }
    }
    if (input.target === 'gemini' && capabilities.reasoning === true) {
      throw new Error(`Thinking cannot be disabled for ${input.model}`);
    }
    return { kind: 'off' };
  }

  // Pro Image thinks automatically, but Google documents no adjustable effort
  // or budget. Do not fabricate a numeric budget from the generic Pro fallback.
  // Provider rows may explicitly declare controls for a different serving API.
  if (input.target === 'gemini'
    && /^gemini-3-pro-image(?:-preview)?$/.test(modelId)
    && !capabilities.thinkingLevels?.length && !capabilities.thinkingTokenLimit) {
    throw new Error(`Thinking effort controls are not supported by ${input.model}; use automatic thinking`);
  }

  if (
    capabilities.thinkingLevels?.length &&
    !capabilities.thinkingLevels.some((level) => level !== 'none')
  ) {
    return { kind: 'off' };
  }

  // DeepSeek documents a discrete mapping rather than nearest-ratio effort.
  // Keep it scoped to the official host; aggregators may expose other controls.
  let requestedEffort = nativeEffort;
  const baseUrl = input.provider?.baseUrl ?? input.provider?.api_base_url;
  if (!input.preserveNativeEffort && baseUrl
    && (input.target === 'openai-chat' || input.target === 'openai-responses')
    && /^(?:deepseek-flash|deepseek-v4-flash|deepseek-v4-pro)$/.test(modelId)) {
    let officialHost = false;
    try {
      officialHost = new URL(baseUrl).hostname === 'api.deepseek.com';
    } catch {
      // An unrecognized endpoint must not opt into vendor-specific semantics.
    }
    if (officialHost) {
      requestedEffort = nativeEffort === 'minimal' || nativeEffort === 'low'
        ? 'low'
        : nativeEffort === 'max' ? 'max' : 'high';
    }
  }

  const effort = input.preserveNativeEffort
    ? nativeEffort
    : resolveReasoningEffort(requestedEffort, input.model, input.provider);

  if (effort === 'none') return { kind: 'off' };

  if (input.target === 'openai-chat' || input.target === 'openai-responses') {
    return { kind: 'level', effort, enabled: true };
  }

  if (usesNativeLevels) {
    if (input.target === 'anthropic' && minimaxAdaptive) return { kind: 'level', effort, enabled: true };
    // Model effort presets can originate on another wire (e.g. Claude via
    // Google's CCA envelope). Intersect them with this wire's legal enum.
    const candidates = capabilities.thinkingLevels?.filter((level) =>
      input.target === 'gemini'
        ? level === 'minimal' || level === 'low' || level === 'medium' || level === 'high'
        : level !== 'none' && level !== 'minimal'
    ) ?? [];
    if (candidates.length === 0) {
      throw new Error(`Thinking levels are not supported by ${input.target} for ${input.model}`);
    }
    return { kind: 'level', effort: nearestSupportedEffort(effort, candidates), enabled: true };
  }

  const budgetTokens = resolveBudget(
    normalizedIntent,
    effort,
    input.model,
    input.provider,
    input.target,
    input.requestMaxTokens,
  );
  if (budgetTokens === undefined) {
    throw new Error(`Cannot enable thinking for ${input.model}: max_tokens must leave room for the minimum thinking budget`);
  }
  return { kind: 'budget', effort, enabled: true, budgetTokens };
}

/**
 * Compatibility facade for callers that still consume a negotiated
 * ReasoningIntent. New request builders should consume `resolveReasoningPlan`.
 */
export function resolveRequestReasoning(
  request: ReasoningRequestLike,
  provider?: ReasoningProvider,
  options: ResolveRequestReasoningOptions = {},
): ReasoningIntent | undefined {
  const intent = extractReasoningIntent(request);
  if (!intent?.effort) return undefined;
  const plan = resolveReasoningPlan({
    intent,
    model: request.model,
    provider,
    target: 'openai-chat',
    preserveNativeEffort: options.preserveNativeEffort,
  });
  if (!plan) return undefined;
  if (plan.kind === 'off') return { ...intent, effort: 'none', enabled: false };
  return { ...intent, effort: plan.effort, enabled: plan.enabled };
}
