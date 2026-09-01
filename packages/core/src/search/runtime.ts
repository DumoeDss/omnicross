/**
 * `SearchRuntime` — the one high-level entry for search in Omnicross.
 *
 * Everything above this line (阶段5's protocol frontends, the daemon, and in
 * Phase 2 the embedding host) calls `search`, `registerContribution`, and
 * `listProviders`; nothing above it builds a provider chain, because the moment
 * two callers can, the fallback order is scattered again. That is the whole
 * point of plan 阶段3.
 *
 * The facade is thin on purpose — a registry, an orchestrator, and the wiring
 * between them. Policy arrives as an argument (runtime default here,
 * per-request pinning on the request); nothing in this module reads a config
 * file or a user setting, which keeps "where does policy come from?" a 阶段5
 * assembly question rather than a contract baked in now.
 *
 * @module search/runtime
 */

import type {
  OrchestratedSearchResponse,
  SearchContributionContext,
  SearchPolicy,
  SearchProviderContribution,
  SearchProviderDescriptor,
  SearchProviderId,
  SearchRequest,
} from '@omnicross/contracts/search-types';

import { builtinHttpSearchContributions } from './http';
import { SearchOrchestrator, type SearchRuntimeEventListener } from './orchestrator';
import { SearchProviderRegistry } from './registry';

/** How a runtime is assembled. Every field has a documented default. */
export interface SearchRuntimeOptions {
  /**
   * Providers to register at construction.
   *
   * Defaults to {@link builtinHttpSearchContributions} — the two keyless HTTP
   * engines. Pass an explicit list (including an empty one) to build a runtime
   * that has only what the caller supplies.
   */
  contributions?: SearchProviderContribution[];
  /** Default policy for every search. Defaults to fallback on, all allowed, unbounded. */
  policy?: SearchPolicy;
  /** Observability listener; receives events carrying a query hash, never a query. */
  onEvent?: SearchRuntimeEventListener;
  /** Let a host contribution replace a builtin one. Default-deny, per plan §7.2. */
  allowBuiltinOverride?: boolean;
}

/**
 * The search entry point.
 *
 * Search, registration, and capability discovery in one object, so a consumer
 * never needs a reference to the registry or the orchestrator underneath.
 */
export interface SearchRuntime {
  /**
   * Run one search.
   *
   * @throws {SearchProviderError} when no provider produced a response. An
   *   empty `results` array is a SUCCESS — a provider reporting that it found
   *   nothing, which is a different answer from failing to look.
   */
  search(request: SearchRequest): Promise<OrchestratedSearchResponse>;
  /** Add a provider (the Phase-2 host registration path). */
  registerContribution(
    contribution: SearchProviderContribution,
    context?: SearchContributionContext,
  ): void;
  /** Remove a provider; returns whether one was removed. */
  unregisterContribution(id: SearchProviderId): boolean;
  /** Serializable descriptors of every registered provider, in candidate order. */
  listProviders(): SearchProviderDescriptor[];
}

/**
 * Build a runtime.
 *
 * Defaults to the builtin HTTP providers with an unrestricted policy: the
 * deliberate 阶段3 stance, since a sensitive default (one provider, egress
 * restricted) only becomes meaningful once user-facing configuration exists to
 * express the choice. Both are reachable today through {@link SearchPolicy}.
 */
export function createSearchRuntime(options: SearchRuntimeOptions = {}): SearchRuntime {
  const registry = new SearchProviderRegistry({
    allowBuiltinOverride: options.allowBuiltinOverride === true,
  });

  for (const contribution of options.contributions ?? builtinHttpSearchContributions()) {
    registry.register(contribution);
  }

  const orchestrator = new SearchOrchestrator(registry, {
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
  });

  return {
    search(request) {
      return orchestrator.search(request);
    },
    registerContribution(contribution, context) {
      registry.register(contribution, context);
    },
    unregisterContribution(id) {
      return registry.unregister(id);
    },
    listProviders() {
      // Descriptors, never contributions: a provider instance carries its
      // transport and (for 阶段4's API providers) its configuration, neither of
      // which belongs in a discovery response that may be serialized.
      return registry.list().map((contribution) => ({
        id: contribution.id,
        source: contribution.source,
        kind: contribution.kind,
        capabilities: { ...contribution.capabilities },
      }));
    },
  };
}
