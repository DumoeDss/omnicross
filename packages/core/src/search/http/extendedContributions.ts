import type {
  SearchProviderCapabilities,
  SearchProviderContribution,
} from '@omnicross/contracts/search-types';

import { MAX_RESULTS } from './engine';
import { HttpEcosiaProvider } from './HttpEcosiaProvider';
import { HttpMojeekProvider } from './HttpMojeekProvider';
import { HttpPublicSearchProvider, type HttpPublicSearchOptions } from './HttpPublicSearchProvider';
import { HttpStartpageProvider } from './HttpStartpageProvider';
import type { SearchHttpTransport } from './types';

/** No region, language or recency claims for the scraped endpoints/aggregate. */
export const EXTENDED_HTTP_SEARCH_CAPABILITIES: Readonly<SearchProviderCapabilities> = Object.freeze({
  requiresApiKey: false,
  supportsRegion: false,
  supportsLanguage: false,
  supportsTimeRange: false,
  supportsUrlRead: false,
  supportsCancellation: true,
  maxResults: MAX_RESULTS,
});

/** New engines are registered here; enablement remains entirely the host's policy. */
export function extendedHttpSearchContributions(
  transport?: SearchHttpTransport,
  options: HttpPublicSearchOptions = {},
): SearchProviderContribution[] {
  return [
    new HttpStartpageProvider(transport),
    new HttpEcosiaProvider(transport),
    new HttpMojeekProvider(transport),
    new HttpPublicSearchProvider(transport, options),
  ].map((provider) => ({
    id: provider.id,
    source: 'builtin',
    kind: 'http',
    provider,
    capabilities: { ...EXTENDED_HTTP_SEARCH_CAPABILITIES },
  }));
}
