/**
 * resolveSubscriptionChain — shared subscription provider-chain resolver.
 *
 * Cross-vendor subscription "route-to" generalization (task #29). The Codex /
 * OpenAI-Responses ingress subscription plan used to HARD-CODE its provider
 * transformer chain to a single `OpenAIResponseTransformer`, ignoring the
 * subscription profile's own `providerTransformerNames`. That only produced
 * Responses-API bytes upstream — correct for the codex/ChatGPT subscription
 * (whose profile chain IS `['openai-response']`), but WRONG for any
 * subscription whose upstream speaks a non-Responses wire.
 *
 * This helper mirrors `SubscriptionDispatcher.resolveTransformers`: it resolves
 * the profile's transformer NAMES into instances via the shared
 * `TransformerService` (the SAME registry the Anthropic-ingress dispatcher uses),
 * so the Responses ingress re-encodes Unified → the target wire exactly like the
 * BYO plan's `resolveProviderChain`. The endpoint transformer stays
 * `OpenAIResponseTransformer` (the ingress wire is Responses) — so the full
 * exchange is:
 *
 *   Responses → (OpenAIResponseTransformer decode) → Unified
 *             → (profile providerTransformers encode) → target wire → upstream
 *   target wire → (profile providerTransformers decode) → Unified
 *             → (OpenAIResponseTransformer encode) → Responses → Codex CLI
 *
 * BYTE-IDENTICAL codex preservation: the codex profile's
 * `providerTransformerNames` is `['openai-response']`, which resolves to the
 * SAME `OpenAIResponseTransformer` instance the ingress already used — so the
 * codex case is unchanged. The fallback (empty/missing names) ALSO yields the
 * shared `OpenAIResponseTransformer`, so a profile that omits names behaves as
 * before.
 *
 * @module pipeline/resolveSubscriptionChain
 */

import type { TransformerService } from '../transformer/TransformerService';
import type { ResolvedTransformerChain, Transformer } from '../transformer/types';

import type { SubscriptionAuthProfile } from './SubscriptionAuthSource';

/**
 * Resolve a single transformer name → instance via the `TransformerService`,
 * materializing a constructor if the registry stored one (mirrors
 * `SubscriptionDispatcher.resolveTransformers`). Returns `null` for an
 * unregistered name (the caller warns + skips).
 */
function resolveOne(
  transformerService: TransformerService,
  name: string,
): Transformer | null {
  const t = transformerService.getTransformer(name);
  if (!t) return null;
  // The registry may hold a ctor class (BuiltinTransformers registers classes)
  // or an instance. Materialize a ctor; pass through an instance.
  return typeof t === 'function' ? new (t as new () => Transformer)() : t;
}

/**
 * Resolve a subscription profile's provider/model transformer chain.
 *
 * @param profile               the subscription profile (carries the names).
 * @param transformerService    the shared registry (from `llmConfig.getTransformerService()`).
 * @param fallbackEndpoint      the shared `OpenAIResponseTransformer` instance,
 *                              used when the profile declares NO provider names
 *                              (preserves the prior hard-coded behavior).
 * @param overrideNames         OPTIONAL explicit provider transformer names that
 *                              SUPERSEDE the profile's static
 *                              `providerTransformerNames` — the opencodego zen
 *                              seam (Phase 3) feeds the shape-resolved chain here
 *                              (e.g. `['openai-response']` / `['gemini']`). When
 *                              `undefined` the static field is read exactly as
 *                              before (codex byte-identity). An explicit EMPTY
 *                              array means "no provider chain" (the zen anthropic
 *                              shape — though that path is same-format and never
 *                              calls this) and falls back to `[fallbackEndpoint]`
 *                              like the absent-names case.
 *
 * @returns the resolved chain. `providerTransformers` is the resolved provider
 *   names (or `[fallbackEndpoint]` when none declared); `modelTransformers` is the
 *   profile's resolved model names (usually empty).
 */
export function resolveSubscriptionChain(
  profile: SubscriptionAuthProfile,
  transformerService: TransformerService | undefined,
  fallbackEndpoint: Transformer,
  overrideNames?: readonly string[],
): ResolvedTransformerChain {
  const providerNames = overrideNames ?? profile.providerTransformerNames ?? [];
  const modelNames = profile.modelTransformerNames ?? [];

  // No declared provider chain → behave exactly as the previous hard-coded
  // `[openai-response]` plan (re-encode Unified → Responses for the upstream).
  if (providerNames.length === 0) {
    return { providerTransformers: [fallbackEndpoint], modelTransformers: [] };
  }

  // Names are declared but we have no registry to resolve them — surface a
  // clear error rather than silently mis-routing (the gate should never let an
  // unresolvable profile reach here, but fail loud if it does).
  if (!transformerService) {
    throw new Error(
      '[resolveSubscriptionChain] profile declares providerTransformerNames but no TransformerService is wired',
    );
  }

  const providerTransformers: Transformer[] = [];
  for (const name of providerNames) {
    const instance = resolveOne(transformerService, name);
    if (!instance) {
      console.warn(`[resolveSubscriptionChain] Transformer not registered: ${name}`);
      continue;
    }
    providerTransformers.push(instance);
  }

  const modelTransformers: Transformer[] = [];
  for (const name of modelNames) {
    const instance = resolveOne(transformerService, name);
    if (!instance) {
      console.warn(`[resolveSubscriptionChain] Model transformer not registered: ${name}`);
      continue;
    }
    modelTransformers.push(instance);
  }

  // If every declared name failed to resolve, fall back to the endpoint
  // transformer so the call still produces Responses bytes (better than an
  // empty chain that would forward Unified verbatim).
  if (providerTransformers.length === 0) {
    return { providerTransformers: [fallbackEndpoint], modelTransformers };
  }

  return { providerTransformers, modelTransformers };
}
