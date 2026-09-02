/**
 * `@omnicross/core/search` — the search runtime (plan 阶段3).
 *
 * The bare subpath the HTTP slice deliberately left unclaimed. Import
 * {@link createSearchRuntime} from here: it is the single high-level entry for
 * running a search, registering a provider, and discovering capabilities, and
 * it owns the ONLY provider-fallback implementation in Omnicross.
 *
 * `@omnicross/core/search/http` stays its own subpath for the two builtin HTTP
 * providers, and `@omnicross/core/search/api` for the keyed API providers; this
 * module registers the HTTP pair by default so a caller with no configuration
 * still gets a working runtime.
 *
 * The SSRF egress policy (`./egress`) ships from HERE rather than claiming a
 * subpath of its own: both provider trees depend on it, so a third registration
 * surface would buy nothing, and a policy that lives beside the runtime is
 * harder to forget than one hidden under a transport.
 *
 * Pure Node: no Elftia, no Electron, no host runtime.
 *
 * @module search
 */

export {
  assertEgressAddressAllowed,
  createEgressGuardedDispatcher,
  createEgressGuardedLookup,
  DEFAULT_SEARCH_EGRESS_POLICY,
  findEgressDenial,
  validateEgressUrl,
  type EgressDenialReason,
  type EgressDnsLookup,
  type SearchEgressPolicy,
} from './egress';
export {
  DEFAULT_SEARCH_FRONTEND_MODES,
  isSearchFrontendMode,
  normalizeSearchFrontendModes,
  SEARCH_FRONTEND_MODES,
  SEARCH_UNSUPPORTED_CAPABILITY_CODE,
  searchErrorHttpStatus,
  SEARCH_FRONTEND_NAMES,
  validateSearchFrontendModes,
  type SearchFrontendMode,
  type SearchFrontendModes,
  type SearchFrontendName,
} from './frontends';
export {
  DEFAULT_NORMALIZED_MAX_RESULTS,
  isDirectResultUrl,
  normalizeSearchResults,
  normalizedResultLimit,
} from './normalize';
export {
  hashSearchQuery,
  SearchOrchestrator,
  type SearchOrchestratorOptions,
  type SearchRuntimeEventListener,
} from './orchestrator';
export {
  SearchProviderRegistry,
  SearchRegistryError,
  type SearchProviderRegistryOptions,
} from './registry';
export {
  createSearchRuntime,
  type SearchRuntime,
  type SearchRuntimeOptions,
} from './runtime';
export {
  searchRuntimeAsWebSearchBackend,
  type SearchRuntimeBackendOptions,
} from './webSearchBackendCompat';
