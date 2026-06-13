/**
 * Native Search Types
 *
 * Type definitions for provider-native web search capabilities.
 * Used by NativeSearchInjector to detect and configure built-in
 * search for OpenAI, Anthropic, Google, xAI, and OpenRouter.
 *
 * @module completion/native-search-types
 */

import type { ApiFormat } from './types';

// ============================================================
// Provider Detection
// ============================================================

/** Providers that support native/built-in web search */
export type NativeSearchProvider = 'openai' | 'anthropic' | 'google' | 'xai' | 'openrouter';

/** Result of detecting native search support for a model */
export interface NativeSearchDetectionResult {
  /** Whether the model supports native search */
  supported: boolean;
  /** Which native provider to use, if supported */
  nativeProvider: NativeSearchProvider | null;
}

/**
 * Model ID patterns for detecting native search support.
 * OpenRouter is detected via provider metadata, not model ID.
 */
export const NATIVE_SEARCH_MODEL_PATTERNS: Record<NativeSearchProvider, RegExp[]> = {
  openai: [/^gpt-4/, /^o[134]/, /^gpt-5/],
  // Claude 3.x: claude-3-opus-*, claude-3-5-sonnet-*, etc.
  // Claude 4.x: claude-sonnet-4-*, claude-opus-4-*, claude-haiku-4-*, etc.
  anthropic: [/^claude-/],
  google: [/^gemini-(?:2|3|flash|pro)/],
  xai: [/^grok/],
  openrouter: [], // Detected via provider, not model pattern
};

/**
 * OpenAI models that use Chat Completion endpoint (not Response API).
 * These models use `web_search_options` instead of a `web_search` tool.
 */
export const OPENAI_CHAT_COMPLETION_SEARCH_MODELS = [
  'gpt-4o-search-preview',
  'gpt-4o-mini-search-preview',
  'gpt-5-search-api',
];

/**
 * Models that match a native search pattern but do NOT support web search.
 * These are excluded from auto-detection (but can still be user-overridden).
 *
 * - `gpt-4.1-nano`: Matches `/^gpt-4/` but OpenAI explicitly excludes it
 *   from web search support in the Responses API.
 */
export const NATIVE_SEARCH_EXCLUDED_MODELS = [
  'gpt-4.1-nano',
];

/** Native search tool names that should NOT be executed locally */
export const NATIVE_SEARCH_TOOL_NAMES = [
  'web_search',
  'web_search_20250305',
  'web_search_20260209',
  'google_search',
  'googleSearchRetrieval',
];

// ============================================================
// User Configuration
// ============================================================

/** User-facing configuration for native search */
export interface NativeSearchUserConfig {
  /** Whether native search is enabled */
  enabled: boolean;
  /** Max search results / uses (maps to provider-specific settings) */
  maxResults?: number;
  /** Domains to block (Anthropic) */
  blockedDomains?: string[];
  /** xAI search mode override */
  searchMode?: 'on' | 'off' | 'auto';
  /** xAI search sources */
  sources?: Array<{ type: 'web' | 'x' | 'news' }>;
}

// ============================================================
// Request Augmentation
// ============================================================

/**
 * Request body augmentation produced by NativeSearchInjector.
 *
 * - `additionalTools`: Appended to the tools array in the request body.
 * - `bodyFields`: Merged into the top-level request body.
 */
export interface NativeSearchAugmentation {
  /** Extra tools to append (OpenAI web_search, Anthropic web_search_20250305, Gemini grounding) */
  additionalTools?: unknown[];
  /** Top-level body fields (xAI search_parameters, OpenRouter plugins, OpenAI web_search_options) */
  bodyFields?: Record<string, unknown>;
}

// ============================================================
// API Format to Provider Mapping
// ============================================================

/**
 * Map from API format to potential native search providers.
 *
 * Note: `openai` (Chat Completions) is NOT mapped here because regular models
 * (gpt-4o, o1, etc.) don't support native search via Chat Completions API.
 * Only `gpt-4o-search-preview` models support it (via `web_search_options` body
 * field), and those are handled by a special case in `detectNativeSearch()`.
 *
 * `openai-response` (Responses API) DOES support native `web_search` tool
 * for gpt-4o, o1, o3, o4-mini, etc.
 */
export const API_FORMAT_PROVIDER_MAP: Partial<Record<ApiFormat, NativeSearchProvider>> = {
  'openai-response': 'openai',
  anthropic: 'anthropic',
  google: 'google',
};
