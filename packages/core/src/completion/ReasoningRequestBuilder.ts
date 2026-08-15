import type { ThinkLevel } from '@omnicross/contracts/completion-types';
import type { LLMProvider } from '@omnicross/contracts/llm-config';

import {
  resolveReasoningPlan,
  type ReasoningPlan,
  type ReasoningTarget,
} from '../reasoning/reasoning-plan';

const LEGACY_ANTHROPIC_MAX_TOKENS = 16384;

interface CompletionReasoningOptions {
  model: string;
  thinkLevel?: ThinkLevel;
  maxTokens?: number;
}

function intentFromOptions(options: CompletionReasoningOptions) {
  return options.thinkLevel
    ? { effort: options.thinkLevel, enabled: options.thinkLevel !== 'none' }
    : undefined;
}

export function resolveCompletionReasoningPlan(
  provider: LLMProvider,
  options: CompletionReasoningOptions,
  target: ReasoningTarget,
  requestMaxTokens = options.maxTokens,
): ReasoningPlan | undefined {
  return resolveReasoningPlan({
    intent: intentFromOptions(options),
    model: options.model,
    provider,
    target,
    requestMaxTokens,
  });
}

export function resolveOpenAIEffort(
  provider: LLMProvider,
  options: CompletionReasoningOptions,
  target: 'openai-chat' | 'openai-responses',
): ThinkLevel | undefined {
  const plan = resolveCompletionReasoningPlan(provider, options, target);
  return plan?.kind === 'level' && plan.enabled ? plan.effort : undefined;
}

export interface AnthropicReasoningWire {
  effectiveMaxTokens: number;
  thinking?: Record<string, unknown>;
  outputConfig?: { effort: ThinkLevel };
  legacyBudgetEnabled: boolean;
}

/** Shared streaming/non-streaming Anthropic reasoning wire decisions. */
export function buildAnthropicReasoningWire(
  provider: LLMProvider,
  options: CompletionReasoningOptions,
): AnthropicReasoningWire {
  const configuredMaxTokens = options.maxTokens ?? LEGACY_ANTHROPIC_MAX_TOKENS;
  const legacyBound = Math.min(configuredMaxTokens, LEGACY_ANTHROPIC_MAX_TOKENS);
  const plan = resolveCompletionReasoningPlan(
    provider,
    options,
    'anthropic',
    legacyBound,
  );

  if (plan?.kind === 'level' && plan.enabled) {
    return {
      effectiveMaxTokens: configuredMaxTokens,
      thinking: { type: 'adaptive' },
      outputConfig: { effort: plan.effort },
      legacyBudgetEnabled: false,
    };
  }

  if (plan?.kind === 'budget' && plan.enabled) {
    return {
      effectiveMaxTokens: legacyBound,
      thinking: { type: 'enabled', budget_tokens: plan.budgetTokens },
      legacyBudgetEnabled: true,
    };
  }

  return {
    effectiveMaxTokens: configuredMaxTokens,
    legacyBudgetEnabled: false,
  };
}

/** Shared streaming/non-streaming Gemini thinkingConfig encoding. */
export function buildGeminiThinkingConfig(
  provider: LLMProvider,
  options: CompletionReasoningOptions,
): Record<string, unknown> | undefined {
  const plan = resolveCompletionReasoningPlan(provider, options, 'gemini');
  if (plan?.kind === 'level') {
    return {
      includeThoughts: plan.enabled,
      thinkingLevel: plan.effort,
    };
  }
  if (plan?.kind === 'budget') {
    return {
      includeThoughts: plan.enabled,
      thinkingBudget: plan.budgetTokens,
    };
  }
  return undefined;
}
