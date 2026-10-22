/**
 * resolveProviderChain — shared transformer-chain resolution helper.
 *
 * Phase 0 of the `provider-request-pipeline` OpenSpec change.
 * All three consumer paths (TransformerHandler, the host engine adapter,
 * and the wire-format proxy handler) previously duplicated the same
 * resolveTransformerChain + getMainTransformer + shallow-copy + unshift
 * block verbatim. This module extracts that single shared helper so the
 * logic lives in exactly one place.
 *
 * IMPORTANT: body mutations that are proxy-specific (thinkingLevel body-inject)
 * are NOT part of this helper — they remain at each call site as before.
 *
 * @module pipeline/resolveProviderChain
 */

import { resolveModelRedirect } from '@omnicross/contracts/canonical-models';
import type { ProviderConfigSource } from '../ports/provider-config-source';
import type { Transformer } from '../transformer';

/** The resolved chain returned by each consumer. */
export interface ResolvedProviderChain {
  chain: {
    providerTransformers: Transformer[];
    modelTransformers: Transformer[];
  };
  /**
   * The main transformer resolved for this provider, or `null` when none
   * is configured. Callers that need the transformer name (e.g. to pass
   * into `getProviderCacheCaps` as `mainTransformerName`) can read
   * `mainTransformer?.name` from this field.
   */
  mainTransformer: Transformer | null;
  /**
   * `true` when there is at least one transformer in either array — used
   * by callers to gate the transformer-chain path vs the direct-API
   * fallback.
   */
  hasTransformers: boolean;
}

/**
 * Resolve the full transformer chain for a provider + model combination.
 *
 * Resolution order:
 * 1. Retain an explicitly configured legacy model row; when it is absent,
 *    use a configured redirect target's chain. Resolve the cached chain.
 * 2. Call `llmConfig.getMainTransformer(providerId)` to get the main
 *    transformer (e.g. GeminiTransformer for Google providers).
 * 3. Shallow-copy both arrays so the cached reference is not mutated.
 * 4. `unshift` the main transformer into `providerTransformers` unless a
 *    transformer with the same `.name` is already present.
 * 5. Compute `hasTransformers`.
 */
export async function resolveProviderChain(
  llmConfig: ProviderConfigSource,
  providerId: string,
  model: string,
  mainTransformerOverride?: Transformer,
): Promise<ResolvedProviderChain> {
  const redirectedModel = resolveModelRedirect(model);
  if (redirectedModel !== model) {
    const provider = await llmConfig.getProvider(providerId);
    const configs = provider?.modelConfigs;
    if (!configs?.some((entry) => entry.id === model) && configs?.some((entry) => entry.id === redirectedModel)) {
      model = redirectedModel;
    }
  }
  const cachedChain = await llmConfig.resolveTransformerChain(providerId, model);
  const mainTransformer = mainTransformerOverride ?? await llmConfig.getMainTransformer(providerId);

  // Shallow copy to avoid mutating the cached chain object.
  // (resolveTransformerChain returns a cached reference — mutating it would
  // accumulate duplicate transformers across requests.)
  const chain = {
    providerTransformers: [...cachedChain.providerTransformers],
    modelTransformers: [...cachedChain.modelTransformers],
  };

  // Add mainTransformer to provider chain if not already present (match by name).
  if (mainTransformer) {
    const alreadyInChain = chain.providerTransformers.some(
      (t) => t.name === mainTransformer.name,
    );
    if (!alreadyInChain) {
      chain.providerTransformers.unshift(mainTransformer);
    }
  }

  const hasTransformers =
    chain.providerTransformers.length > 0 || chain.modelTransformers.length > 0;

  return { chain, mainTransformer, hasTransformers };
}

/** Retain the selected legacy row's explicit overrides under its wire model ID. */
export function resolveRedirectedModelConfigs<T extends { id: string }>(
  modelConfigs: T[] | undefined,
  configuredModel: string,
): T[] | undefined {
  const model = resolveModelRedirect(configuredModel);
  if (model === configuredModel) return modelConfigs;
  const configured = modelConfigs?.find((entry) => entry.id === configuredModel);
  if (!configured) return modelConfigs;
  return [
    { ...configured, id: model },
    ...modelConfigs!.filter((entry) => entry.id !== configuredModel && entry.id !== model),
  ];
}
