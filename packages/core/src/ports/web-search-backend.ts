/**
 * `WebSearchBackend` — core-owned port for the web-search service the serving
 * core's built-in `web_search` tool executor and the Anthropic proxy hints use.
 *
 * The serving core MUST depend on THIS interface, never on the concrete host
 * `WebSearchService` class as a type. The host already exposes a superset of
 * this surface, so it is passed directly with NO adapter.
 *
 * The surface is EXACTLY the three methods the core invokes
 * (`search`/`isProviderEnabled`/`readUrl`), signatures matching
 * `WebSearchService`. The argument/return types are `@omnicross/contracts`
 * contract types (not host classes), so they cross into a Phase-1 package cleanly.
 *
 * @module ports/web-search-backend
 */

import type {
  JinaReaderResponse,
  WebSearchOptions,
  WebSearchProviderId,
  WebSearchResponse,
} from '@omnicross/contracts/websearch-types';

export interface WebSearchBackend {
  search(
    query: string,
    providerId: WebSearchProviderId,
    options?: WebSearchOptions,
  ): Promise<WebSearchResponse>;

  isProviderEnabled(id: WebSearchProviderId): boolean;

  readUrl(
    url: string,
    options?: { timeout?: number; signal?: AbortSignal; apiKey?: string },
  ): Promise<JinaReaderResponse>;
}
