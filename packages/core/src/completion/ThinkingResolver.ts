/**
 * ThinkingResolver - Handles thinking budget calculation and max tokens resolution
 *
 * Extracted from CompletionService to isolate thinking/reasoning
 * budget logic and max_tokens resolution across different providers.
 */

import type { ThinkLevel } from '@omnicross/contracts/completion-types';
import type { LLMProvider } from '@omnicross/contracts/llm-config';
import {
  buildAnthropicThinking,
  calculateThinkingBudget,
  DEFAULT_MAX_TOKENS,
  getClaudeMaxTokens,
  isReasoningModel,
} from '@omnicross/contracts/thinking-config';

import type { Logger } from '../ports/logger';
import type { ProviderConfigSource } from '../ports/provider-config-source';

import { resolveApiFormat } from './';

/**
 * Resolve effective max_tokens value with priority:
 * 1. Session settings (if provided)
 * 2. Global model parameters (if enabled)
 * 3. undefined - let API use its default
 *
 * Model-catalog `maxTokens` values describe hard capabilities, not a user's
 * desired per-request output cap. They must never be promoted into request
 * parameters implicitly. Returns undefined to let the API use its own default.
 * Use getRequiredMaxTokens() for providers that require max_tokens (e.g., Anthropic)
 *
 * @param llmConfig - The provider-config source (the host's config service)
 * @param getProvider - Function to get provider by ID
 * @param logger - Logger service instance
 * @param providerId - The provider ID
 * @param modelId - The model ID
 * @param sessionMaxTokens - Session-level maxTokens setting (highest priority)
 * @returns The resolved max_tokens value, or undefined to use API default
 */
export async function resolveEffectiveMaxTokens(
  llmConfig: ProviderConfigSource,
  _getProvider: (providerId: string) => Promise<LLMProvider | null>,
  logger: Logger,
  _providerId: string,
  _modelId: string,
  sessionMaxTokens?: number
): Promise<number | undefined> {
  // 1. Session settings take highest priority
  if (sessionMaxTokens !== undefined && sessionMaxTokens > 0) {
    logger.debug('Using session maxTokens', { sessionMaxTokens });
    return sessionMaxTokens;
  }

  // 2. Check global model parameters
  try {
    const globalParams = await llmConfig.getGlobalModelParameters();
    if (globalParams?.maxTokens?.enabled && globalParams.maxTokens.value > 0) {
      logger.debug('Using global maxTokens', { maxTokens: globalParams.maxTokens.value });
      return globalParams.maxTokens.value;
    }
  } catch (err) {
    logger.warn('Failed to get global params', err instanceof Error ? err : undefined);
  }

  // Capability metadata and discovery results intentionally do not participate
  // here. They are validation inputs, not an instruction to cap every request.
  logger.debug('No maxTokens configured, returning undefined');
  return undefined;
}

/**
 * Get required max_tokens for providers that need it (e.g., Anthropic)
 * Falls back to DEFAULT_MAX_TOKENS if no value is configured
 *
 * @param llmConfig - The provider-config source (the host's config service)
 * @param getProvider - Function to get provider by ID
 * @param logger - Logger service instance
 * @param providerId - The provider ID
 * @param modelId - The model ID
 * @param sessionMaxTokens - Session-level maxTokens setting (highest priority)
 * @returns The resolved max_tokens value (never undefined)
 */
export async function getRequiredMaxTokens(
  llmConfig: ProviderConfigSource,
  getProvider: (providerId: string) => Promise<LLMProvider | null>,
  logger: Logger,
  providerId: string,
  modelId: string,
  sessionMaxTokens?: number
): Promise<number> {
  const resolved = await resolveEffectiveMaxTokens(llmConfig, getProvider, logger, providerId, modelId, sessionMaxTokens);
  if (resolved !== undefined) {
    return resolved;
  }
  logger.debug('Using default maxTokens', { defaultMaxTokens: DEFAULT_MAX_TOKENS });
  return DEFAULT_MAX_TOKENS;
}

/**
 * Calculate thinking budget and adjust max_tokens for the provider
 *
 * For Claude/Anthropic: thinking budget is subtracted from max_tokens
 * For other providers: thinking budget is calculated but max_tokens is not adjusted
 *
 * @param getProvider - Function to get provider by ID
 * @param logger - Logger service instance
 * @param providerId - The provider ID
 * @param modelId - The model ID
 * @param maxTokens - The base max_tokens value
 * @param thinkLevel - The thinking effort level
 * @returns Object containing adjusted max_tokens and thinking budget
 */
export async function resolveThinkingBudget(
  getProvider: (providerId: string) => Promise<LLMProvider | null>,
  logger: Logger,
  providerId: string,
  modelId: string,
  maxTokens: number,
  thinkLevel: ThinkLevel
): Promise<{
  adjustedMaxTokens: number;
  thinkingBudget: number | undefined;
  thinkingConfig: {
    type?: 'enabled' | 'disabled';
    budget_tokens?: number;
  } | undefined;
}> {
  // This exported compatibility API predates target-aware discrete plans. Keep
  // its historical recognition and budget behavior; request builders use the
  // shared ReasoningPlan resolver directly.
  if (thinkLevel === 'none' || !isReasoningModel(modelId)) {
    return {
      adjustedMaxTokens: maxTokens,
      thinkingBudget: undefined,
      thinkingConfig: undefined,
    };
  }

  const thinkingBudget = calculateThinkingBudget(modelId, thinkLevel, maxTokens);

  const provider = await getProvider(providerId);
  const providerName = provider?.name?.toLowerCase() || '';
  const apiFormat = provider ? resolveApiFormat(provider) : 'openai';

  // For Anthropic/Claude: adjust max_tokens by subtracting thinking budget
  if (apiFormat === 'anthropic' || providerName === 'anthropic' || providerName.includes('claude')) {
    const thinkingConfig = buildAnthropicThinking(modelId, thinkLevel, maxTokens);
    const adjustedMaxTokens = getClaudeMaxTokens(maxTokens, thinkingBudget) || maxTokens;

    logger.debug('Claude model thinking budget', {
      thinkingBudget,
      adjustedMaxTokens
    });

    return {
      adjustedMaxTokens,
      thinkingBudget,
      thinkingConfig
    };
  }

  // For other providers: return budget but don't adjust max_tokens
  logger.debug('Non-Claude model thinking budget', { thinkingBudget });

  return {
    adjustedMaxTokens: maxTokens,
    thinkingBudget,
    thinkingConfig: thinkingBudget ? { type: 'enabled', budget_tokens: thinkingBudget } : undefined
  };
}
