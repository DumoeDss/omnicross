/**
 * Provider endpoint resolver — single source of truth for "which baseUrl/apiKey
 * does this provider actually use right now?"
 *
 * Three resolution layers, in priority order:
 *   1. `apiModes + selectedApiModeId` — preferred path (introduced by
 *      `provider-api-mode-toggle` change). User customizations on
 *      `api_base_url` / `api_key` always win over the mode default.
 *   2. Legacy `codingPlan.enabled` flag — kept for backward compat with
 *      pre-migration rows that may still have `apiModes` undefined when
 *      preset registry reattach hasn't run for some reason.
 *   3. Plain `api_base_url` / `api_key` — for providers without modes at all.
 *
 * NOTE: this module lives in the contracts package because both the serving
 * core (`CompletionService`) and client UIs (preview hints) need to compute
 * endpoints consistently.
 */

import type { LLMProvider } from './llm-config';

export interface ResolvedEndpoint {
  /** The base URL the request should hit */
  baseUrl: string;
  /** The API key to use; empty string when none configured */
  apiKey: string;
  /** Which mode id resolved (for telemetry / debug only) */
  resolvedModeId?: string;
  /** Which resolution layer fired (for telemetry / debug only) */
  source: 'api-mode' | 'legacy-coding-plan' | 'plain';
}

/**
 * Resolve the endpoint for a provider.
 *
 * Important: when `apiModes` is set and a mode is selected, we still prefer
 * the user-customized `api_base_url` / `api_key` over the mode's defaults,
 * because the UI synchronizes these fields when the user picks a mode (D6 in
 * design.md). A mismatch only happens transiently or after a "Keep
 * customizations" flow — both should round-trip via the user's value.
 */
export function resolveProviderEndpoint(provider: LLMProvider): ResolvedEndpoint {
  // Layer 1: apiModes
  if (provider.apiModes && provider.apiModes.length > 0 && provider.selectedApiModeId) {
    const mode = provider.apiModes.find(m => m.id === provider.selectedApiModeId);
    if (mode) {
      return {
        baseUrl: provider.api_base_url || mode.baseUrl,
        apiKey: provider.api_key || mode.apiKey || '',
        resolvedModeId: mode.id,
        source: 'api-mode',
      };
    }
  }

  // Layer 2: legacy codingPlan field
  if (provider.codingPlan?.enabled && provider.codingPlan.baseUrl) {
    return {
      baseUrl: provider.codingPlan.baseUrl,
      apiKey: provider.codingPlan.apiKey || provider.api_key || '',
      source: 'legacy-coding-plan',
    };
  }

  // Layer 3: plain
  return {
    baseUrl: provider.api_base_url || '',
    apiKey: provider.api_key || '',
    source: 'plain',
  };
}
