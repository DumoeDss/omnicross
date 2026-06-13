/**
 * OpenRouter Provider Utilities
 *
 * Functions for handling OpenRouter-specific configuration and routing.
 */

import type { LLMProvider, OpenRouterProviderRouting } from '@omnicross/contracts/llm-config';

import { isOpenRouterProvider } from '../openrouter';

/**
 * Get OpenRouter provider routing config from model configuration
 * Returns the provider routing config if the provider is OpenRouter and model has config
 */
export function getOpenRouterProviderConfig(
  provider: LLMProvider,
  modelId: string
): OpenRouterProviderRouting | undefined {
  if (!isOpenRouterProvider(provider)) {
    return undefined;
  }

  // Find model config
  const modelConfig = provider.modelConfigs?.find(m => m.id === modelId);
  return modelConfig?.openRouterProvider;
}

/**
 * Add OpenRouter provider routing to request body if applicable
 */
export function addOpenRouterProviderToRequest(
  requestBody: Record<string, unknown>,
  provider: LLMProvider,
  modelId: string
): Record<string, unknown> {
  const providerRouting = getOpenRouterProviderConfig(provider, modelId);

  if (!providerRouting) {
    return requestBody;
  }

  // Only add non-empty provider config
  const hasConfig = Object.values(providerRouting).some(v =>
    v !== undefined && v !== null && (Array.isArray(v) ? v.length > 0 : true)
  );

  if (!hasConfig) {
    return requestBody;
  }

  return {
    ...requestBody,
    provider: providerRouting
  };
}
