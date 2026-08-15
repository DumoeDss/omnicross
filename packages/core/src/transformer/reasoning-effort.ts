import { resolveModelCapabilities, normalizeModelId } from '@omnicross/contracts/canonical-models';
import type { ThinkLevel } from '@omnicross/contracts/completion-types';
import type { ModelConfig } from '@omnicross/contracts/llm-config';
import { EFFORT_RATIO } from '@omnicross/contracts/thinking-config';

import type { LLMProvider, ReasoningConfig, UnifiedChatRequest } from './types';

export interface ResolveRequestReasoningOptions {
  /** Preserve a recognized native effort instead of applying target capability mapping. */
  preserveNativeEffort?: boolean;
}

export const THINK_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly ThinkLevel[];

const THINK_LEVEL_SET = new Set<string>(THINK_LEVELS);

/** Normalize an untrusted wire value onto the shared seven-level domain. */
export function normalizeThinkLevel(value: unknown): ThinkLevel | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.toLowerCase();
  return THINK_LEVEL_SET.has(normalized) ? normalized as ThinkLevel : undefined;
}

/**
 * Read normalized reasoning intent without mutating the request.
 *
 * OpenAI Chat input is deliberately identity-shaped, so its native top-level
 * `reasoning_effort` is consulted only when no unified `reasoning` object was
 * decoded by an endpoint transformer.
 */
export function extractReasoningIntent(request: UnifiedChatRequest): ReasoningConfig | undefined {
  const reasoning = request.reasoning;
  if (reasoning) {
    if (reasoning.enabled === false) {
      return { ...reasoning, effort: 'none', enabled: false };
    }

    const effort = normalizeThinkLevel(reasoning.effort);
    if (effort) {
      return { ...reasoning, effort, enabled: effort !== 'none' };
    }

    // Legacy unified callers may express enabled budget reasoning without a
    // discrete effort. Preserve their established medium default.
    if (reasoning.enabled === true ||
        (typeof reasoning.max_tokens === 'number' && reasoning.max_tokens > 0)) {
      return { ...reasoning, effort: 'medium', enabled: true };
    }
    return undefined;
  }

  const nativeEffort = normalizeThinkLevel(
    (request as unknown as Record<string, unknown>).reasoning_effort,
  );
  if (!nativeEffort) return undefined;
  return { effort: nativeEffort, enabled: nativeEffort !== 'none' };
}

function findModelOverride(
  targetModel: string,
  modelConfigs: Array<Pick<ModelConfig, 'id'> & Partial<ModelConfig>> | undefined,
): Partial<ModelConfig> | undefined {
  if (!modelConfigs) return undefined;
  const normalizedTarget = normalizeModelId(targetModel);
  return modelConfigs.find((config) =>
    config.id === targetModel || normalizeModelId(config.id) === normalizedTarget
  );
}

/** Merge canonical metadata with the matching provider row override. */
export function resolveTargetModelCapabilities(
  targetModel: string,
  provider?: Pick<LLMProvider, 'modelConfigs'>,
) {
  const rowOverride = findModelOverride(targetModel, provider?.modelConfigs);
  return resolveModelCapabilities(targetModel, undefined, rowOverride);
}

/** Resolve an enabled effort to the nearest level supported by the target. */
export function resolveReasoningEffort(
  requested: ThinkLevel,
  targetModel: string,
  provider?: Pick<LLMProvider, 'modelConfigs'>,
): ThinkLevel {
  if (requested === 'none') return 'none';

  const capabilities = resolveTargetModelCapabilities(targetModel, provider);
  const candidates = capabilities.thinkingLevels?.filter((level) => level !== 'none') ?? [];

  if (candidates.includes(requested)) return requested;
  if (candidates.length === 0) return requested;

  const requestedRatio = EFFORT_RATIO[requested];
  return candidates.reduce((best, candidate) => {
    const distance = Math.abs(EFFORT_RATIO[candidate] - requestedRatio);
    const bestDistance = Math.abs(EFFORT_RATIO[best] - requestedRatio);
    if (distance < bestDistance - Number.EPSILON) return candidate;
    if (Math.abs(distance - bestDistance) <= Number.EPSILON &&
        EFFORT_RATIO[candidate] < EFFORT_RATIO[best]) {
      return candidate;
    }
    return best;
  });
}

/** Extract and negotiate a request's reasoning intent for a target encoder. */
export function resolveRequestReasoning(
  request: UnifiedChatRequest,
  provider?: Pick<LLMProvider, 'modelConfigs'>,
  options: ResolveRequestReasoningOptions = {},
): ReasoningConfig | undefined {
  const intent = extractReasoningIntent(request);
  if (!intent?.effort) return undefined;
  const effort = options.preserveNativeEffort
    ? intent.effort
    : resolveReasoningEffort(intent.effort, request.model, provider);
  return { ...intent, effort, enabled: effort !== 'none' };
}
