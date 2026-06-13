/**
 * API URL Building Utilities
 *
 * Functions for building correct API URLs based on provider format.
 */

import type { LLMProvider } from '@omnicross/contracts/llm-config';

import type { ApiFormat } from './types';

/**
 * Resolve API format from provider configuration
 *
 * Priority:
 * 1. apiFormat (v3 preferred field)
 * 2. chatApiFormat (legacy v3 field)
 * 3. apiType if it's an explicit format (claudecode/anthropic/google)
 * 4. Default to openai
 *
 * Note: This enables implicit routing - the API format determines which
 * transformer is automatically applied without explicit router configuration.
 */
export function resolveApiFormat(provider: LLMProvider): ApiFormat {
  // Use apiFormat (v3 preferred) if available
  if (provider.apiFormat) {
    return provider.apiFormat;
  }

  // Fallback to chatApiFormat (legacy v3)
  if (provider.chatApiFormat) {
    return provider.chatApiFormat;
  }

  // apiType 'claudecode' and 'anthropic' are explicit format specifications
  if (provider.apiType === 'claudecode' || provider.apiType === 'anthropic') {
    return 'anthropic';
  }
  if (provider.apiType === 'google') {
    return 'google';
  }

  // Default to OpenAI format
  return 'openai';
}

/**
 * Build OpenAI Chat Completions API URL
 * Handles various input formats:
 * - https://api.openai.com → https://api.openai.com/v1/chat/completions
 * - https://api.openai.com/v1/chat/completions → unchanged
 * - https://api.deepseek.com/v1 → https://api.deepseek.com/v1/chat/completions
 * - https://api.z.ai/api/coding/paas/v4 → https://api.z.ai/api/coding/paas/v4/chat/completions
 */
export function buildOpenAIApiUrl(baseUrl: string): string {
  const url = baseUrl.replace(/\/+$/, '');

  // Check if URL already ends with /chat/completions
  if (url.endsWith('/chat/completions')) {
    return url;
  }

  // Check if URL ends with /v{number} (e.g., /v1, /v4) - append /chat/completions only
  // Provider has already specified their API version
  if (/\/v\d+$/.test(url)) {
    return url + '/chat/completions';
  }

  // Check if URL already contains /chat/completions somewhere
  if (url.includes('/chat/completions')) {
    return url;
  }

  // Append full path with default /v1
  return url + '/v1/chat/completions';
}

/**
 * Build Anthropic Messages API URL
 * Handles various input formats:
 * - https://api.anthropic.com → https://api.anthropic.com/v1/messages
 * - https://api.anthropic.com/v1/messages → unchanged
 * - https://api.z.ai/api/anthropic → https://api.z.ai/api/anthropic/v1/messages
 * - https://api.z.ai/api/anthropic/v2 → https://api.z.ai/api/anthropic/v2/messages
 */
export function buildAnthropicApiUrl(baseUrl: string): string {
  const url = baseUrl.replace(/\/+$/, '');

  // Check if URL already ends with /messages
  if (url.endsWith('/messages')) {
    return url;
  }

  // Check if URL already contains /messages somewhere
  if (url.includes('/messages')) {
    return url;
  }

  // Check if URL ends with /v{number} (e.g., /v1, /v2) - append /messages only
  // Provider has already specified their API version
  if (/\/v\d+$/.test(url)) {
    return url + '/messages';
  }

  // Append full path with default /v1
  return url + '/v1/messages';
}

/**
 * Build a Gemini /v1beta/models/{model}:{action} URL with base-URL normalization.
 * Strips trailing slashes, skips appending /v1beta if the base already has a version path,
 * and returns the URL as-is if it already contains /models/.
 */
export function buildGeminiModelActionUrl(baseUrl: string, model: string, action: string): string {
  let url = baseUrl.replace(/\/+$/, '');

  // Check if URL already contains /models/ (user provided full path)
  if (url.includes('/models/')) {
    return url;
  }

  // Check if URL already has a version path (e.g., /v1beta, /v1, /v2)
  // If not, add /v1beta (default Gemini API version)
  if (!/\/v\d+(?:beta)?(?:$|\/)/.test(url)) {
    url += '/v1beta';
  }

  return `${url}/models/${model}:${action}`;
}

/**
 * Build Google Gemini API URL
 * Gemini uses a dynamic URL structure: /v1beta/models/{model}:generateContent or :streamGenerateContent
 * @param baseUrl - Base URL (e.g., https://generativelanguage.googleapis.com)
 * @param model - Model name (e.g., gemini-2.0-flash)
 * @param stream - Whether to use streaming endpoint
 */
export function buildGeminiApiUrl(baseUrl: string, model: string, stream: boolean): string {
  const action = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
  return buildGeminiModelActionUrl(baseUrl, model, action);
}

/**
 * Normalize Azure OpenAI endpoint
 * Strips trailing /, /openai, /openai/v1 etc.
 */
export function normalizeAzureEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, '').replace(/\/openai(\/v\d+)?$/, '');
}

/**
 * Build Azure OpenAI API URL
 * Format: {endpoint}/openai/deployments/{deploymentName}/chat/completions?api-version={version}
 * @param baseUrl - Azure endpoint (e.g., https://my-resource.openai.azure.com)
 * @param model - Deployment name (used as model in Azure)
 * @param apiVersion - API version (e.g., 2024-08-01-preview)
 */
export function buildAzureOpenAIApiUrl(baseUrl: string, model: string, apiVersion: string): string {
  const endpoint = normalizeAzureEndpoint(baseUrl);
  return `${endpoint}/openai/deployments/${model}/chat/completions?api-version=${apiVersion}`;
}

/**
 * Build OpenAI Responses API URL
 * Format: {baseUrl}/v1/responses
 */
export function buildOpenAIResponseApiUrl(baseUrl: string): string {
  const url = baseUrl.replace(/\/+$/, '');

  // Already ends with /responses
  if (url.endsWith('/responses')) {
    return url;
  }

  // Has /v1 already
  if (/\/v\d+$/.test(url)) {
    return url + '/responses';
  }

  return url + '/v1/responses';
}

/**
 * Resolve the effective base URL and API key for a provider.
 *
 * Delegates to the shared `resolveProviderEndpoint` which honors (in order):
 *   1. `apiModes + selectedApiModeId` — the new mode switcher path
 *   2. legacy `codingPlan.enabled` flag
 *   3. plain `api_base_url` / `api_key`
 *
 * Re-exported here for backward compat with existing callers in this folder.
 */
import { resolveProviderEndpoint as resolveProviderEndpointShared } from '@omnicross/contracts/endpoint-resolver';
export const resolveProviderEndpoint = resolveProviderEndpointShared;

/**
 * Build API URL based on provider format and options
 * This is the main entry point for URL building
 */
export function buildProviderApiUrl(
  provider: LLMProvider,
  options: { model?: string; stream?: boolean } = {}
): string {
  const format = resolveApiFormat(provider);
  const { baseUrl } = resolveProviderEndpoint(provider);

  switch (format) {
    case 'anthropic':
      return buildAnthropicApiUrl(baseUrl);
    case 'google':
      return buildGeminiApiUrl(baseUrl, options.model || '', options.stream || false);
    case 'azure-openai':
      return buildAzureOpenAIApiUrl(baseUrl, options.model || '', provider.apiVersion || '2024-08-01-preview');
    case 'openai-response':
      return buildOpenAIResponseApiUrl(baseUrl);
    case 'openai':
    default:
      return buildOpenAIApiUrl(baseUrl);
  }
}
