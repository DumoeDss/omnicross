/**
 * Native Search Injector
 *
 * Detects provider-native web search support and builds request body
 * augmentations for OpenAI, Anthropic, Google, xAI, and OpenRouter.
 *
 * This module does NOT execute searches — it only prepares the request
 * so the LLM provider's server-side search runs automatically.
 *
 * @module completion/NativeSearchInjector
 */

import type { LLMProvider } from '@omnicross/contracts/llm-config';

import { isOpenRouterProvider } from '../openrouter';

import type {
  NativeSearchAugmentation,
  NativeSearchDetectionResult,
  NativeSearchProvider,
  NativeSearchUserConfig,
} from './native-search-types';
import {
  API_FORMAT_PROVIDER_MAP,
  NATIVE_SEARCH_EXCLUDED_MODELS,
  NATIVE_SEARCH_MODEL_PATTERNS,
  OPENAI_CHAT_COMPLETION_SEARCH_MODELS,
} from './native-search-types';
import type { ApiFormat } from './types';

// ============================================================
// Detection
// ============================================================

/**
 * Detect whether a model supports provider-native web search.
 *
 * Detection order:
 * 1. OpenRouter — detected by provider base URL, not model pattern.
 * 2. xAI — detected by base URL containing `x.ai` or `grok`.
 * 3. Model-pattern match against known providers (OpenAI, Anthropic, Google).
 * 4. If `userExplicit` is true, fall back to API format mapping even
 *    when the model ID doesn't match known patterns (user opted-in).
 */
export function detectNativeSearch(
  modelId: string,
  apiFormat: ApiFormat,
  provider: LLMProvider,
  userExplicit?: boolean
): NativeSearchDetectionResult {
  // 1. OpenRouter: detected via base URL
  if (isOpenRouterProvider(provider)) {
    return { supported: true, nativeProvider: 'openrouter' };
  }

  // 2. xAI: detected via base URL (api.x.ai)
  if (isXaiProvider(provider)) {
    return { supported: true, nativeProvider: 'xai' };
  }

  // 3. Special case: OpenAI Chat Completions search-preview models
  //    These are the only models that support native search in Chat Completions API
  //    (via web_search_options body field, not the web_search tool).
  if (apiFormat === 'openai' && OPENAI_CHAT_COMPLETION_SEARCH_MODELS.some(m => modelId.startsWith(m))) {
    return { supported: true, nativeProvider: 'openai' };
  }

  // 4. Model-pattern match for the resolved API format provider
  const formatProvider = API_FORMAT_PROVIDER_MAP[apiFormat];
  if (formatProvider) {
    const patterns = NATIVE_SEARCH_MODEL_PATTERNS[formatProvider];
    if (patterns.some(re => re.test(modelId))) {
      // Skip models that match patterns but are known to NOT support search
      if (!NATIVE_SEARCH_EXCLUDED_MODELS.some(m => modelId.startsWith(m))) {
        return { supported: true, nativeProvider: formatProvider };
      }
    }
  }

  // 5. User explicitly enabled native search — trust the API format
  if (userExplicit && formatProvider) {
    return { supported: true, nativeProvider: formatProvider };
  }

  return { supported: false, nativeProvider: null };
}

// ============================================================
// Augmentation Builders
// ============================================================

/**
 * Build a {@link NativeSearchAugmentation} for the given provider.
 * Returns `null` if the provider is unknown or config is disabled.
 */
export function buildNativeSearchAugmentation(
  nativeProvider: NativeSearchProvider,
  config: NativeSearchUserConfig,
  _apiFormat: ApiFormat,
  modelId: string
): NativeSearchAugmentation | null {
  if (!config.enabled) return null;

  switch (nativeProvider) {
    case 'openai':
      return buildOpenAIAugmentation(config, modelId);
    case 'anthropic':
      return buildAnthropicAugmentation(config);
    case 'google':
      return buildGoogleAugmentation(modelId);
    case 'xai':
      return buildXaiAugmentation(config);
    case 'openrouter':
      return buildOpenRouterAugmentation(config);
    default:
      return null;
  }
}

// ============================================================
// Apply Augmentation
// ============================================================

/**
 * Merge an augmentation into the request body **in-place**.
 *
 * - `additionalTools` are appended to the existing `tools` array.
 * - `bodyFields` are shallow-merged into the top-level body.
 */
export function applyAugmentation(
  requestBody: Record<string, unknown>,
  augmentation: NativeSearchAugmentation
): Record<string, unknown> {
  if (augmentation.additionalTools?.length) {
    const existing = (requestBody.tools as unknown[]) ?? [];
    requestBody.tools = [...existing, ...augmentation.additionalTools];
  }

  if (augmentation.bodyFields) {
    Object.assign(requestBody, augmentation.bodyFields);
  }

  return requestBody;
}

// ============================================================
// Provider-specific builders (private)
// ============================================================

/**
 * OpenAI web search augmentation.
 *
 * - Search-preview models (gpt-4o-search-preview) use `web_search_options` body field.
 * - Other models (gpt-4o, o1, o3, etc.) use `web_search` tool via Response API.
 */
function buildOpenAIAugmentation(
  config: NativeSearchUserConfig,
  modelId: string
): NativeSearchAugmentation {
  const isChatCompletionSearch = OPENAI_CHAT_COMPLETION_SEARCH_MODELS.some(m =>
    modelId.startsWith(m)
  );

  if (isChatCompletionSearch) {
    return {
      bodyFields: {
        web_search_options: {
          search_context_size: config.maxResults ? mapMaxResultsToContextSize(config.maxResults) : 'medium',
        },
      },
    };
  }

  // Response API — add web_search tool
  return {
    additionalTools: [
      {
        type: 'web_search',
        web_search: {
          search_context_size: config.maxResults ? mapMaxResultsToContextSize(config.maxResults) : 'medium',
        },
      },
    ],
  };
}

/**
 * Anthropic web search augmentation.
 *
 * Uses the `web_search_20250305` tool type with optional `max_uses`
 * and `blocked_domains`.
 */
function buildAnthropicAugmentation(
  config: NativeSearchUserConfig
): NativeSearchAugmentation {
  const toolDef: Record<string, unknown> = {
    type: 'web_search_20250305',
    name: 'web_search',
  };

  if (config.maxResults) {
    toolDef.max_uses = config.maxResults;
  }

  if (config.blockedDomains?.length) {
    toolDef.blocked_domains = config.blockedDomains;
  }

  return { additionalTools: [toolDef] };
}

/**
 * Google Gemini grounding augmentation.
 *
 * Gemini 2.0+ uses `google_search` tool format.
 * Legacy Gemini 1.5 used `googleSearchRetrieval`.
 */
function buildGoogleAugmentation(modelId: string): NativeSearchAugmentation {
  // Gemini 1.5 and earlier use the legacy googleSearchRetrieval format
  const isLegacy = /gemini-1[._]/.test(modelId);

  if (isLegacy) {
    return {
      additionalTools: [
        { googleSearchRetrieval: {} },
      ],
    };
  }

  // Gemini 2.0+ uses the google_search tool
  return {
    additionalTools: [
      { google_search: {} },
    ],
  };
}

/**
 * xAI (Grok) search augmentation.
 *
 * Uses `search_parameters` body field with `mode`, `return_citations`,
 * `max_search_results`, and optional `sources`.
 */
function buildXaiAugmentation(
  config: NativeSearchUserConfig
): NativeSearchAugmentation {
  const searchParams: Record<string, unknown> = {
    mode: config.searchMode ?? 'auto',
    return_citations: true,
    max_search_results: config.maxResults ?? 5,
  };

  if (config.sources?.length) {
    searchParams.sources = config.sources;
  }

  return { bodyFields: { search_parameters: searchParams } };
}

/**
 * OpenRouter plugin-based search augmentation.
 *
 * Uses `plugins` body field to enable the `web` plugin.
 */
function buildOpenRouterAugmentation(
  config: NativeSearchUserConfig
): NativeSearchAugmentation {
  const plugin: Record<string, unknown> = { id: 'web' };

  if (config.maxResults) {
    plugin.max_results = config.maxResults;
  }

  return { bodyFields: { plugins: [plugin] } };
}

// ============================================================
// Helpers
// ============================================================

/** Check if provider base URL indicates xAI */
function isXaiProvider(provider: LLMProvider): boolean {
  const baseUrl = (provider.api_base_url || '').toLowerCase();
  return baseUrl.includes('x.ai') || baseUrl.includes('xai.com');
}

/** Map a numeric maxResults to OpenAI search_context_size */
function mapMaxResultsToContextSize(maxResults: number): 'low' | 'medium' | 'high' {
  if (maxResults <= 2) return 'low';
  if (maxResults <= 5) return 'medium';
  return 'high';
}
