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
  isReasoningModel
} from '@omnicross/contracts/thinking-config';

import type { Logger } from '../ports/logger';
import type { ProviderConfigSource } from '../ports/provider-config-source';

import { resolveApiFormat } from './';

/**
 * Resolve effective max_tokens value with priority:
 * 1. Session settings (if provided)
 * 2. Global model parameters (if enabled)
 * 3. Model's maxTokens from provider config
 * 4. Discovered models cache (from API)
 * 5. undefined - let API use its default
 *
 * Note: Returns undefined to let the API use its own default.
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
  getProvider: (providerId: string) => Promise<LLMProvider | null>,
  logger: Logger,
  providerId: string,
  modelId: string,
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

  // Cap for auto-resolved maxTokens to avoid exceeding context window
  // (input_tokens + max_tokens must be <= context_length)
  // Note: User-specified values (session settings, global params) are NOT capped
  //
  // Bumped 65536 → 131072 (2026-05-06): GLM-5.1 ships a 128k output ceiling
  // and large generated artifacts (full HTML + scaling JS + multi-slide
  // content) can need 30-60k output tokens. The previous 64k cap silently
  // halved the model's capability for any preset-driven session.
  // 200k context − 128k output still leaves 72k for input, which covers
  // even very heavy system prompts.
  const MAX_TOKENS_CAP = 131072;

  // 3. Check model's maxTokens from provider config
  const provider = await getProvider(providerId);
  if (provider) {
    // Check modelConfigs
    const modelConfig = provider.modelConfigs?.find(m => m.id === modelId);
    if (modelConfig?.maxTokens && modelConfig.maxTokens > 0) {
      const cappedMaxTokens = Math.min(modelConfig.maxTokens, MAX_TOKENS_CAP);
      logger.debug('Using model config maxTokens', {
        maxTokens: modelConfig.maxTokens,
        cappedMaxTokens
      });
      return cappedMaxTokens;
    }

    // Check modelGroups
    if (provider.modelGroups) {
      for (const group of provider.modelGroups) {
        const model = group.models?.find(m => m.id === modelId);
        if (model?.maxTokens && model.maxTokens > 0) {
          const cappedMaxTokens = Math.min(model.maxTokens, MAX_TOKENS_CAP);
          logger.debug('Using modelGroup model maxTokens', {
            maxTokens: model.maxTokens,
            cappedMaxTokens
          });
          return cappedMaxTokens;
        }
      }
    }
  }

  // 4. Check discovered models cache (from model discovery API)
  try {
    const discoveredMaxTokens = await llmConfig.getDiscoveredModelMaxTokens(providerId, modelId);
    if (discoveredMaxTokens && discoveredMaxTokens > 0) {
      const cappedMaxTokens = Math.min(discoveredMaxTokens, MAX_TOKENS_CAP);
      logger.debug('Using discovered model maxTokens', {
        discoveredMaxTokens,
        cappedMaxTokens
      });
      return cappedMaxTokens;
    }
  } catch (err) {
    logger.warn('Failed to get discovered model maxTokens', err instanceof Error ? err : undefined);
  }

  // 5. Return undefined to let API use its default
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
  // If thinking is disabled or model doesn't support it
  if (thinkLevel === 'none' || !isReasoningModel(modelId)) {
    return {
      adjustedMaxTokens: maxTokens,
      thinkingBudget: undefined,
      thinkingConfig: undefined
    };
  }

  // Calculate thinking budget based on model and level
  const thinkingBudget = calculateThinkingBudget(modelId, thinkLevel, maxTokens);

  // Get provider to determine type
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
