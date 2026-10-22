import { normalizeModelId, resolveModelRedirect } from '@omnicross/contracts/canonical-models';
import type { ThinkLevel } from '@omnicross/contracts/completion-types';
import type { LLMProvider } from '@omnicross/contracts/llm-config';
import { resolveRedirectedModelConfigs } from '../pipeline/resolveProviderChain';

import {
  resolveReasoningPlan,
  resolveTargetModelCapabilities,
  type ReasoningPlan,
  type ReasoningTarget,
} from '../reasoning/reasoning-plan';

const LEGACY_ANTHROPIC_MAX_TOKENS = 16384;

interface CompletionReasoningOptions {
  model: string;
  thinkLevel?: ThinkLevel;
  maxTokens?: number;
}

/** Keep the selected legacy configuration while using the replacement on the wire. */
export function resolveCompletionModel<T extends { model: string }>(
  provider: LLMProvider,
  options: T,
): { provider: LLMProvider; options: T } | undefined {
  const model = resolveModelRedirect(options.model);
  if (model === options.model) return undefined;
  const modelConfigs = resolveRedirectedModelConfigs(provider.modelConfigs, options.model);
  return {
    provider: modelConfigs === provider.modelConfigs ? provider : { ...provider, modelConfigs },
    options: { ...options, model },
  };
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
  if (plan?.kind === 'level' && plan.enabled) return plan.effort;
  if (options.thinkLevel === 'none') {
    const levels = resolveTargetModelCapabilities(options.model, provider).thinkingLevels;
    // A disable-only catalog marks models whose API omits effort altogether.
    if (!levels || (levels.includes('none') && levels.some((level) => level !== 'none'))) {
      return 'none';
    }
  }
  return undefined;
}

export interface AnthropicReasoningWire {
  effectiveMaxTokens: number;
  thinking?: { type: 'adaptive' | 'enabled' | 'disabled'; budget_tokens?: number };
  outputConfig?: { effort: ThinkLevel };
  legacyBudgetEnabled: boolean;
}

/** Shared streaming/non-streaming Anthropic reasoning wire decisions. */
export function buildAnthropicReasoningWire(
  provider: LLMProvider,
  options: CompletionReasoningOptions,
): AnthropicReasoningWire {
  const configuredMaxTokens = options.maxTokens ?? LEGACY_ANTHROPIC_MAX_TOKENS;
  const plan = resolveCompletionReasoningPlan(
    provider,
    options,
    'anthropic',
    configuredMaxTokens,
  );

  if (plan?.kind === 'level' && plan.enabled) {
    return {
      effectiveMaxTokens: configuredMaxTokens,
      thinking: { type: 'adaptive' },
      ...(/^minimax-m(?:2(?:[.-]|$)|3$)/.test(normalizeModelId(options.model))
        ? {}
        : { outputConfig: { effort: plan.effort } }),
      legacyBudgetEnabled: false,
    };
  }

  if (plan?.kind === 'budget' && plan.enabled) {
    return {
      effectiveMaxTokens: configuredMaxTokens,
      thinking: { type: 'enabled', budget_tokens: plan.budgetTokens },
      legacyBudgetEnabled: true,
    };
  }

  return {
    effectiveMaxTokens: configuredMaxTokens,
    ...(options.thinkLevel === 'none' ? { thinking: { type: 'disabled' } } : {}),
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
