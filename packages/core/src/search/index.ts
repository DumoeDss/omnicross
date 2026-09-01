/**
 * `@omnicross/core/search` — the search runtime (plan 阶段3).
 *
 * The bare subpath the HTTP slice deliberately left unclaimed. Import
 * {@link createSearchRuntime} from here: it is the single high-level entry for
 * running a search, registering a provider, and discovering capabilities, and
 * it owns the ONLY provider-fallback implementation in Omnicross.
 *
 * `@omnicross/core/search/http` stays its own subpath for the two builtin HTTP
 * providers; this module registers them by default so a caller with no
 * configuration still gets a working runtime.
 *
 * Pure Node: no Elftia, no Electron, no host runtime.
 *
 * @module search
 */

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
