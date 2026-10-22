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

function buildVersionedApiUrl(baseUrl: string, endpoint: string): string {
  const url = new URL(baseUrl);
  let path = url.pathname.replace(/\/+$/, '');
  if (!path.endsWith(`/${endpoint}`)) {
    if (!/\/v\d+(?:beta\d*)?$/.test(path)) path += '/v1';
    path += `/${endpoint}`;
  }
  url.pathname = path;
  return url.toString();
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
  return buildVersionedApiUrl(baseUrl, 'chat/completions');
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
  return buildVersionedApiUrl(baseUrl, 'messages');
}

/**
 * Build a Gemini model-action URL from a host, version root, models collection,
 * or complete model endpoint. The resolved route owns the model and action.
 */
export function buildGeminiModelActionUrl(baseUrl: string, model: string, action: string): string {
  const url = new URL(baseUrl);
  let path = url.pathname.replace(/\/+$/, '');
  const modelRoot = path.indexOf('/models/');
  if (modelRoot >= 0) path = path.slice(0, modelRoot);
  else if (path.endsWith('/models')) path = path.slice(0, -'/models'.length);
  if (!/\/v\d+(?:beta\d*)?(?:$|\/)/.test(path)) path += '/v1beta';
  const [method, query] = action.split('?');
  url.pathname = `${path}/models/${model.replace(/^models\//, '')}:${method}`;
  url.searchParams.delete('alt');
  for (const [key, value] of new URLSearchParams(query)) url.searchParams.set(key, value);
  return url.toString();
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
  const url = new URL(endpoint);
  url.pathname = url.pathname.replace(/\/+$/, '').replace(
    /\/openai(?:\/(?:v\d+|deployments\/[^/]+\/chat\/completions))?$/, '',
  );
  return url.toString().replace(/\/(?=[?#]|$)/, '');
}

/**
 * Build Azure OpenAI API URL
 * Format: {endpoint}/openai/deployments/{deploymentName}/chat/completions?api-version={version}
 * @param baseUrl - Azure endpoint (e.g., https://my-resource.openai.azure.com)
 * @param model - Deployment name (used as model in Azure)
 * @param apiVersion - API version (e.g., 2024-08-01-preview)
 */
export function buildAzureOpenAIApiUrl(baseUrl: string, model: string, apiVersion: string): string {
  const url = new URL(normalizeAzureEndpoint(baseUrl));
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/openai/deployments/${encodeURIComponent(model)}/chat/completions`;
  url.searchParams.set('api-version', apiVersion);
  return url.toString();
}

/**
 * Build OpenAI Responses API URL
 * Format: {baseUrl}/v1/responses
 */
export function buildOpenAIResponseApiUrl(baseUrl: string): string {
  return buildVersionedApiUrl(baseUrl, 'responses');
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
