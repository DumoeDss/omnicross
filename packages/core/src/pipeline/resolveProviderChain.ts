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
 * IMPORTANT: body mutations that are proxy-specific (ReasoningTransformer
 * auto-inject, thinkingLevel body-inject) are NOT part of this helper —
 * they remain at each call site as before.
 *
 * @module pipeline/resolveProviderChain
 */

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
 * Semantics (identical to all three former inline copies):
 * 1. Call `llmConfig.resolveTransformerChain(providerId, model)` to get the
 *    cached chain.
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
): Promise<ResolvedProviderChain> {
  const cachedChain = await llmConfig.resolveTransformerChain(providerId, model);
  const mainTransformer = await llmConfig.getMainTransformer(providerId);

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
