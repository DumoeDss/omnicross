/**
 * `ProviderConfigSource` — core-owned port for the provider catalog + routing +
 * transformer-chain reads the serving core needs from its host config service.
 *
 * The serving core (`pipeline` / `transformer` / `provider-proxy` /
 * `completion` / `outbound-api`) MUST depend on THIS interface, never on the
 * host's concrete config-service class as a type. The host supplies the impl
 * at bootstrap (its config service implementing `ProviderConfigSource` is the
 * compile-time assignability guard).
 *
 * The surface is sized to EXACTLY the ten methods the core invokes today —
 * signatures copied verbatim from the host's config service so the host stays
 * structurally assignable with zero behavior change.
 *
 * NOTE (Phase-1 narrowing, omnicross): `getTransformerService()` is a
 * transformer-registry accessor that returns a CORE class (`TransformerService`,
 * not a host class), so exposing it through this port is sound for 0b. It is a
 * separate concern from provider-catalog reads, however; splitting it into its
 * own narrower port is deferred to Phase 1 (see design Q1). Do NOT split now.
 *
 * @module ports/provider-config-source
 */

import type { AgentDefaultModels, GlobalModelParameters, LLMProvider } from '@omnicross/contracts/llm-config';

import type {
  ResolvedTransformerChain,
  Transformer,
  TransformerService,
} from '../transformer';

export interface ProviderConfigSource {
  getProvider(id: string): Promise<LLMProvider | null>;

  /** @deprecated mirror of the host method — router-based routing is a no-op today. */
  resolveRoutedModel(
    providerId: string,
    modelId: string,
  ): Promise<{
    isRouted: boolean;
    actualProviderId: string;
    actualModelId: string;
    routerId?: string;
    routerName?: string;
  } | null>;

  resolveEffectiveModels(): Promise<{
    background?: string;
    vision?: string;
  }>;

  getAgentDefaultModels(): Promise<AgentDefaultModels>;

  hasVisionCapability(providerId: string, modelId: string): Promise<boolean>;

  getGlobalModelParameters(): Promise<GlobalModelParameters>;

  getDiscoveredModelMaxTokens(
    providerId: string,
    modelId: string,
  ): Promise<number | undefined>;

  resolveTransformerChain(
    providerId: string,
    model?: string,
  ): Promise<ResolvedTransformerChain>;

  getMainTransformer(providerId: string): Promise<Transformer | null>;

  getTransformerService(): TransformerService | undefined;
}
