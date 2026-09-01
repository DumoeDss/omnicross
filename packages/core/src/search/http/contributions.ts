/**
 * The builtin HTTP search contributions.
 *
 * Everything the registry must not infer is declared here: `source` and `kind`
 * are stated, never derived from the id's spelling, and the capability set is
 * explicit down to the options these engines do NOT honor.
 *
 * `priorityHint` is deliberately absent. Provider ordering is the orchestrator's
 * decision (阶段3); encoding a preference here would recreate exactly the
 * scattered-fallback-order problem the extraction exists to remove.
 *
 * @module search/http/contributions
 */

import type {
  SearchProviderCapabilities,
  SearchProviderContribution,
} from '@omnicross/contracts/search-types';

import { HttpBingProvider, HTTP_BING_PROVIDER_ID } from './HttpBingProvider';
import { HttpDuckDuckGoProvider, HTTP_DUCKDUCKGO_PROVIDER_ID } from './HttpDuckDuckGoProvider';
import { MAX_RESULTS } from './engine';
import type { SearchHttpTransport } from './types';

/**
 * What both keyless HTTP engines can do.
 *
 * `supportsRegion` / `supportsLanguage` / `supportsTimeRange` are false because
 * the scraped endpoints never honored those options; per the contract, a
 * provider ignores an option it does not declare rather than failing.
 */
export const HTTP_SEARCH_CAPABILITIES: Readonly<SearchProviderCapabilities> = Object.freeze({
  requiresApiKey: false,
  supportsRegion: false,
  supportsLanguage: false,
  supportsTimeRange: false,
  supportsUrlRead: false,
  supportsCancellation: true,
  maxResults: MAX_RESULTS,
});

/**
 * Both builtin HTTP providers, ready to hand to a registry.
 *
 * @param transport - optional shared transport for both providers (tests, or a
 *   future alternative client). Omit for the production undici transport.
 */
export function builtinHttpSearchContributions(
  transport?: SearchHttpTransport,
): SearchProviderContribution[] {
  return [
    {
      id: HTTP_BING_PROVIDER_ID,
      source: 'builtin',
      kind: 'http',
      provider: new HttpBingProvider(transport),
      capabilities: { ...HTTP_SEARCH_CAPABILITIES },
    },
    {
      id: HTTP_DUCKDUCKGO_PROVIDER_ID,
      source: 'builtin',
      kind: 'http',
      provider: new HttpDuckDuckGoProvider(transport),
      capabilities: { ...HTTP_SEARCH_CAPABILITIES },
    },
  ];
}
