/**
 * The API search contributions.
 *
 * Everything the registry must not infer is declared here: `source` and `kind`
 * are stated, never derived from an id's spelling, and each adapter's
 * capabilities are explicit down to the options it does NOT honor.
 *
 * The gating rule is the important one: a provider absent from `configs`
 * produces NO contribution. It is unconfigured, not broken. A runtime that
 * registered a keyless Tavily would advertise a capability it cannot honor and
 * then burn a fallback attempt discovering that — so the absence is the
 * feature. (`doctor search` still shows those providers as `unconfigured`
 * rows; that is what doctor is for.)
 *
 * `priorityHint` is deliberately absent, as in the HTTP slice: ordering is the
 * orchestrator's decision, and encoding a preference here would recreate the
 * scattered-fallback-order problem the extraction exists to remove.
 *
 * @module search/api/contributions
 */

import type {
  SearchProviderCapabilities,
  SearchProviderContribution,
} from '@omnicross/contracts/search-types';

import type { Dispatcher } from 'undici';

import type { SearchEgressPolicy } from '../egress';
import { JinaSearchProvider, JINA_PROVIDER_ID } from './JinaSearchProvider';
import { SearxngSearchProvider, SEARXNG_PROVIDER_ID } from './SearxngSearchProvider';
import { TavilySearchProvider, TAVILY_PROVIDER_ID } from './TavilySearchProvider';
import { createSearchApiTransport } from './transport';
import type { SearchApiFetch, SearchApiProviderConfigs, SearchApiTransport } from './types';
import { ZhipuSearchProvider, ZAI_PROVIDER_ID, ZHIPU_PROVIDER_ID } from './ZhipuSearchProvider';

/**
 * The capability fields every API adapter shares.
 *
 * `maxResults` is deliberately UNSET across all four. The contract defines it
 * as an upper bound the provider imposes, and none of these APIs documents one
 * — Zhipu's 10 and everyone else's 5 are DEFAULTS, applied when the caller asks
 * for nothing. Declaring a default as a cap would be a false capability.
 */
const SHARED_API_CAPABILITIES = {
  supportsRegion: false,
  supportsLanguage: false,
  supportsTimeRange: false,
  supportsCancellation: true,
} as const satisfies Partial<SearchProviderCapabilities>;

/** Tavily: key required, search only. */
export const TAVILY_CAPABILITIES: Readonly<SearchProviderCapabilities> = Object.freeze({
  ...SHARED_API_CAPABILITIES,
  requiresApiKey: true,
  supportsUrlRead: false,
});

/** Jina: keyless-capable, and the only adapter that can read a URL. */
export const JINA_CAPABILITIES: Readonly<SearchProviderCapabilities> = Object.freeze({
  ...SHARED_API_CAPABILITIES,
  // The search endpoint answers unauthenticated requests (rate-limited), so a
  // key is an upgrade, not a requirement.
  requiresApiKey: false,
  supportsUrlRead: true,
});

/** SearXNG: configured by HOST, not by key. */
export const SEARXNG_CAPABILITIES: Readonly<SearchProviderCapabilities> = Object.freeze({
  ...SHARED_API_CAPABILITIES,
  requiresApiKey: false,
  supportsUrlRead: false,
});

/** Zhipu and Z.AI: key required, search only. */
export const ZHIPU_CAPABILITIES: Readonly<SearchProviderCapabilities> = Object.freeze({
  ...SHARED_API_CAPABILITIES,
  requiresApiKey: true,
  supportsUrlRead: false,
});

/** Knobs for {@link apiSearchContributions}. */
export interface ApiSearchContributionOptions {
  /**
   * Egress policy for every request these providers make. Omit for public-only.
   * An internal SearXNG deployment is enabled by naming its hostname here.
   */
  egressPolicy?: SearchEgressPolicy;
  /** Fetch primitive seam. Omit for the production undici transport. */
  fetchImpl?: SearchApiFetch;
  /**
   * Layered proxy-dispatcher override handed to the shared transport (the
   * daemon's `fetchUpstream` resolver). Only meaningful without `fetchImpl`.
   */
  resolveProxyDispatcher?: (url: string) => Dispatcher | undefined;
}

/**
 * Build contributions for exactly the providers `configs` names.
 *
 * All adapters share ONE transport instance, so the egress policy and the
 * dispatcher cache are shared too.
 *
 * The returned order mirrors Elftia's registry registration order
 * (`tavily, jina, searxng, zhipu, z.ai`), which is what the registry preserves
 * — but note that the ORDER PROVIDERS ARE TRIED is the orchestrator's policy,
 * not this list.
 */
export function apiSearchContributions(
  configs: SearchApiProviderConfigs,
  options: ApiSearchContributionOptions = {},
): SearchProviderContribution[] {
  const transport: SearchApiTransport = createSearchApiTransport({
    fetch: options.fetchImpl,
    egressPolicy: options.egressPolicy,
    resolveProxyDispatcher: options.resolveProxyDispatcher,
  });

  const contributions: SearchProviderContribution[] = [];

  if (configs.tavily) {
    contributions.push({
      id: TAVILY_PROVIDER_ID,
      source: 'builtin',
      kind: 'api',
      provider: new TavilySearchProvider(configs.tavily, transport),
      capabilities: { ...TAVILY_CAPABILITIES },
    });
  }

  if (configs.jina) {
    contributions.push({
      id: JINA_PROVIDER_ID,
      source: 'builtin',
      kind: 'api',
      provider: new JinaSearchProvider(configs.jina, transport),
      capabilities: { ...JINA_CAPABILITIES },
    });
  }

  if (configs.searxng) {
    contributions.push({
      id: SEARXNG_PROVIDER_ID,
      source: 'builtin',
      kind: 'api',
      provider: new SearxngSearchProvider(configs.searxng, transport),
      capabilities: { ...SEARXNG_CAPABILITIES },
    });
  }

  // One class, two ids, two default hosts — the ported shape.
  if (configs.zhipu) {
    contributions.push({
      id: ZHIPU_PROVIDER_ID,
      source: 'builtin',
      kind: 'api',
      provider: new ZhipuSearchProvider(ZHIPU_PROVIDER_ID, configs.zhipu, transport),
      capabilities: { ...ZHIPU_CAPABILITIES },
    });
  }

  if (configs['z.ai']) {
    contributions.push({
      id: ZAI_PROVIDER_ID,
      source: 'builtin',
      kind: 'api',
      provider: new ZhipuSearchProvider(ZAI_PROVIDER_ID, configs['z.ai'], transport),
      capabilities: { ...ZHIPU_CAPABILITIES },
    });
  }

  return contributions;
}
