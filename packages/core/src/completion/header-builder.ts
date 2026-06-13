/**
 * Request Header Building Utilities
 *
 * Functions for building correct request headers based on provider format.
 */

import type { LLMProvider } from '@omnicross/contracts/llm-config';

import { isOpenRouterProvider, OPENROUTER_APP_HEADERS } from '../openrouter';

import { resolveApiFormat } from './url-builder';

/**
 * Get request headers based on provider format
 */
export function getProviderHeaders(provider: LLMProvider, apiKey: string): Record<string, string> {
  const format = resolveApiFormat(provider);

  // Base headers by format
  let headers: Record<string, string>;
  switch (format) {
    case 'anthropic':
      headers = {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2025-01-10', // Required for extended thinking feature
      };
      break;
    case 'google':
      headers = {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      };
      break;
    case 'azure-openai':
      headers = {
        'Content-Type': 'application/json',
        'api-key': apiKey,
      };
      break;
    case 'openai':
    case 'openai-response':
    default:
      headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      };
      break;
  }

  // Add OpenRouter app attribution headers if applicable
  if (isOpenRouterProvider(provider)) {
    return { ...headers, ...OPENROUTER_APP_HEADERS };
  }

  return headers;
}
