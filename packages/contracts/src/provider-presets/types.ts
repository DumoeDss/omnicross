/**
 * Provider preset types — hand-authored TypeScript (verbatim from the prior
 * flat `provider-presets.ts`). These are re-exported by the module barrel
 * (`index.ts`, via `schema.ts`) so every `@omnicross/contracts/provider-presets`
 * import site is unchanged. The Zod runtime schema lives in `schema.ts`.
 */
import type { ApiFormat, ProviderTemplate } from '../llm-config';

// ============================================================================
// Search Capability Types
// ============================================================================

/**
 * How a provider implements web search:
 * - 'model-param': Search enabled via a request parameter (e.g., enable_search, web_search)
 * - 'builtin-tool': Search provided as a built-in tool definition in the tools array
 * - 'mcp': Search provided via an MCP server
 * - 'sdk-native': Search handled natively by the SDK (e.g., Anthropic server-side tools)
 * - 'none': Provider does not support search
 */
export type SearchCapability = 'model-param' | 'builtin-tool' | 'mcp' | 'sdk-native' | 'none';

/**
 * Provider-specific search configuration
 */
export interface ProviderSearchConfig {
  type: SearchCapability;
  // model-param type
  /** Parameter name to enable search (e.g., 'enable_search', 'web_search') */
  paramName?: string;
  /** Value to set for the parameter (e.g., true, { enable: true }) */
  paramValue?: unknown;
  /** Additional parameters to include when search is enabled */
  extraParams?: Record<string, unknown>;
  // builtin-tool type
  /** Tool definition to inject into the tools array */
  toolDefinition?: Record<string, unknown>;
  /** Whether the built-in search tool conflicts with function calling */
  conflictsWithFC?: boolean;
  // mcp type
  /** MCP server ID that provides the search tool */
  mcpServerId?: string;
  // sdk-native — handled by existing NativeSearchInjector
  // applicable models (null = all)
  /** Models this search config applies to (null or undefined = all models) */
  applicableModels?: string[] | null;
}

// ============================================================================
// API Mode (Plan Switcher)
// ============================================================================

/**
 * Canonical API mode ids. Use these as `ApiMode.id` for built-in plans so the
 * UI can localize labels and so future code can reason about modes by enum.
 */
export const API_MODE_IDS = {
  STANDARD: 'standard',
  CODING_PLAN: 'coding-plan',
  TOKEN_PLAN: 'token-plan',
} as const;

export type ApiModeId = string; // not strictly the const-union — providers may declare custom ids

/**
 * One API endpoint variant on a provider. Providers with multiple modes
 * (standard / coding-plan / token-plan) declare an array of these; the UI
 * renders a switcher and the runtime uses the selected mode's baseUrl/apiKey.
 *
 * Mode-less providers (OpenAI / Anthropic / Gemini / etc.) simply leave
 * `apiModes` undefined — the existing `api_base_url` field is used as-is.
 */
export interface ApiMode {
  /** Stable id within the provider — `'standard' | 'coding-plan' | 'token-plan'` for built-in plans */
  id: ApiModeId;
  /** i18n key (e.g. `apiMode.codingPlan`) or display label fallback */
  label: string;
  /** Endpoint base URL for this mode */
  baseUrl: string;
  /** Optional default API key for this mode (e.g. dashscope coding plan key). When set, switching to
   *  this mode overwrites the provider's `api_key` UI field if no customization is detected. */
  apiKey?: string;
  /** Optional API key prefix hint shown to user (e.g. `'sk-tp-'` for Tencent Token Plan) */
  apiKeyPrefix?: string;
  /** Optional note (i18n key) — e.g. "仅限编程工具调用" */
  note?: string;
}

// ============================================================================
// Coding Plan Configuration
// ============================================================================

/**
 * Coding Plan configuration on a provider.
 * @deprecated Prefer `LLMProvider.apiModes` + `selectedApiModeId`. This field
 *   is retained for backward-compat read paths; runtime endpoint resolution
 *   falls back to it when `apiModes` is undefined.
 */
export interface CodingPlanConfig {
  /** Whether Coding Plan is enabled */
  enabled: boolean;
  /** Coding Plan dedicated Base URL */
  baseUrl?: string;
  /** Coding Plan dedicated API Key (some providers require separate key) */
  apiKey?: string;
  /** Plan description (Lite/Pro etc.) */
  note?: string;
}

// ============================================================================
// Provider Model Mappings (Follow-Provider Feature)
// ============================================================================

/**
 * Model mapping for a provider's model ecosystem.
 * Used by "Follow Provider" feature to auto-select background/vision models.
 */
export interface ProviderModelMapping {
  /** Primary/flagship model */
  primary: string;
  /** Lightweight model for background tasks */
  background: string;
  /** Vision-capable model (null = provider has no vision model) */
  vision: string | null;
}

// ============================================================================
// Provider Preset Templates
// ============================================================================

/**
 * Extended provider template with Coding Plan and preset metadata.
 * Note: there is NO `category` field — the registry is intentionally flat at
 * the public API level. Internal arrays exist only for code organization.
 */
export interface PresetProviderTemplate extends ProviderTemplate {
  /** Preset ID for matching with CODING_PLAN_URL_PRESETS and PROVIDER_MODEL_MAPPINGS */
  presetId: string;
  /**
   * Optional i18n key for the display name (e.g. `presetName.tencent`). When
   * present, clients prefer this over the seed `name` field for list
   * display (so Chinese-named built-in providers render translated in non-zh
   * locales). English-named presets (OpenAI / Anthropic / etc.) leave this
   * undefined — the raw `name` is already locale-neutral. User-customized
   * names (DB row name diverged from preset seed) always win regardless.
   */
  nameKey?: string;
  /**
   * Coding Plan Base URL (if provider supports Coding Plan)
   * @deprecated Prefer `apiModes` — when `apiModes` is declared, this field is
   *   typically derived from `apiModes.find(m => m.id === 'coding-plan')?.baseUrl`.
   *   Retained for backward-compat reads.
   */
  codingPlanBaseUrl?: string;
  /** Whether Coding Plan requires a separate API Key */
  codingPlanSeparateKey?: boolean;
  /** Feature tags for display */
  features?: string[];
  /** Search capability configuration for this provider */
  searchConfig?: ProviderSearchConfig;
  /**
   * Optional list of API endpoint modes (standard / coding-plan / token-plan).
   * Length ≥ 2 makes the UI render a mode switcher next to the API URL field.
   * The first entry MUST have `id: 'standard'` and represents pay-as-you-go.
   */
  apiModes?: ApiMode[];
  /**
   * Additive, reserved per-preset revision (design D2). Defaulted to `1` by the
   * loader when absent. Reserved for future overlay / remote-refresh — no
   * current consumer reads it, and it does NOT affect any returned value.
   */
  revision?: number;
}

// Touch ApiFormat so it remains an intentional import (used by schema.ts'
// drift guard; kept here for the JSDoc reference on apiFormat fields).
export type _PresetApiFormat = ApiFormat;
