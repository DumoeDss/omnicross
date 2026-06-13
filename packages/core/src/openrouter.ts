/**
 * OpenRouter-specific serving-core helpers.
 *
 * Relocated from the host `config-service/utils.ts` (LLM serving-core
 * extraction, omnicross-phase1) so the serving core does not reach back into a
 * host module. The host `config-service/utils.ts` re-imports and re-exports
 * these from `@omnicross/core` so its own consumers are unchanged.
 */

import type { LLMProvider } from '@omnicross/contracts/llm-config';

/**
 * Check if provider is OpenRouter based on base URL
 */
export function isOpenRouterProvider(provider: LLMProvider): boolean {
  const baseUrl = (provider.api_base_url || '').toLowerCase();
  return baseUrl.includes('openrouter.ai');
}

/**
 * OpenRouter app attribution headers
 * See: https://openrouter.ai/docs/app-attribution
 */
export const OPENROUTER_APP_HEADERS = {
  'HTTP-Referer': 'https://omnicross.dev',
  'X-Title': 'omnicross',
};
