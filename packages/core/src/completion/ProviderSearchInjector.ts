/**
 * Provider Search Injector
 *
 * Handles provider-specific search parameter injection for Chinese cloud
 * providers that don't use SDK-native search (which is handled by
 * NativeSearchInjector).
 *
 * Supports:
 * - model-param: Adds search parameters to request body (DashScope, Baidu)
 * - builtin-tool: Adds provider-specific tool definitions (Kimi, Volcengine)
 *
 * MCP-based search is handled externally by the MCP tool system.
 * SDK-native search is handled by NativeSearchInjector.
 *
 * @module completion/ProviderSearchInjector
 */

import type { LLMProvider } from '@omnicross/contracts/llm-config';
import type { ProviderSearchConfig } from '@omnicross/contracts/provider-presets';
import { PROVIDER_SEARCH_CONFIGS } from '@omnicross/contracts/provider-presets';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchAugmentation {
  /** Parameters to merge into the request body */
  bodyFields?: Record<string, unknown>;
  /** Tool definitions to append to the tools array */
  additionalTools?: unknown[];
  /** Warning message if search has limitations */
  warning?: string;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Get the search config for a provider.
 */
export function getSearchConfig(provider: LLMProvider): ProviderSearchConfig | null {
  const presetId = provider.presetId || provider.id;

  // Check if the provider has a known search config
  if (presetId in PROVIDER_SEARCH_CONFIGS) {
    return PROVIDER_SEARCH_CONFIGS[presetId];
  }

  return null;
}

// ---------------------------------------------------------------------------
// Augmentation
// ---------------------------------------------------------------------------

/**
 * Build search augmentation for a provider request.
 *
 * @param provider The LLM provider
 * @param modelId The model being used
 * @param hasOtherTools Whether the request already has tool definitions (for FC conflict detection)
 * @returns Search augmentation to apply, or null if no search is available
 */
export function buildProviderSearchAugmentation(
  provider: LLMProvider,
  modelId: string,
  hasOtherTools: boolean,
): SearchAugmentation | null {
  const config = getSearchConfig(provider);
  if (!config) return null;

  // Check if search applies to this model
  if (config.applicableModels && !config.applicableModels.includes(modelId)) {
    return null;
  }

  switch (config.type) {
    case 'model-param': {
      const bodyFields: Record<string, unknown> = {};
      if (config.paramName) {
        bodyFields[config.paramName] = config.paramValue ?? true;
      }
      if (config.extraParams) {
        Object.assign(bodyFields, config.extraParams);
      }
      return { bodyFields };
    }

    case 'builtin-tool': {
      // Check for FC conflict
      if (config.conflictsWithFC && hasOtherTools) {
        return {
          warning: `${provider.name} search conflicts with function calling. Search disabled for this request.`,
        };
      }
      if (config.toolDefinition) {
        return { additionalTools: [config.toolDefinition] };
      }
      return null;
    }

    case 'mcp':
    case 'sdk-native':
    case 'none':
      // These are handled by other systems (MCP or NativeSearchInjector)
      return null;

    default:
      return null;
  }
}

/**
 * Apply search augmentation to a request body.
 */
export function applyProviderSearchAugmentation(
  requestBody: Record<string, unknown>,
  augmentation: SearchAugmentation,
): Record<string, unknown> {
  if (augmentation.bodyFields) {
    Object.assign(requestBody, augmentation.bodyFields);
  }

  if (augmentation.additionalTools?.length) {
    const existing = (requestBody.tools as unknown[]) ?? [];
    requestBody.tools = [...existing, ...augmentation.additionalTools];
  }

  return requestBody;
}
