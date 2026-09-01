/**
 * A legacy `WebSearchBackend` backed by the new runtime — migration scaffolding.
 *
 * **Nothing in Omnicross uses this yet, on purpose.** It exists so 阶段5 can
 * move the remaining `WebSearchBackend` consumers (the Anthropic ingress
 * `webSearchService` hint, anything a host passes in) onto the runtime one at a
 * time instead of in a flag day. Like `@omnicross/contracts/search-compat`, it
 * is Phase-1 debt with a scheduled deletion (阶段8) and is meant to be
 * grep-able as such.
 *
 * The port TYPE stays exactly where it is — Elftia imports
 * `@omnicross/core/ports/web-search-backend` directly — and this module only
 * adds an implementation of it.
 *
 * The legacy conversions are NOT re-derived here: `toLegacyWebSearchResponse`
 * and `searchErrorToLegacyWebSearchResponse` are child 2's single, tested
 * mapping, and having a second one is how the two vocabularies would start to
 * drift.
 *
 * @module search/webSearchBackendCompat
 */

import type {
  JinaReaderResponse,
  WebSearchOptions,
  WebSearchProviderId,
  WebSearchResponse,
} from '@omnicross/contracts/websearch-types';
import {
  searchErrorToLegacyWebSearchResponse,
  toLegacyWebSearchResponse,
} from '@omnicross/contracts/search-compat';
import { toSearchErrorShape } from '@omnicross/contracts/search-types';

import type { WebSearchBackend } from '../ports/web-search-backend';
import type { SearchRuntime } from './runtime';

/** Optional capabilities the runtime itself does not provide. */
export interface SearchRuntimeBackendOptions {
  /**
   * URL reading delegate.
   *
   * The runtime orchestrates `search` only — reading a URL stays with
   * `web_fetch`'s own path until the reader story settles (阶段4+). Without a
   * delegate, `readUrl` answers with a legacy failure response naming the
   * missing capability rather than pretending to have read anything.
   */
  readUrl?: WebSearchBackend['readUrl'];
}

/**
 * Present a {@link SearchRuntime} through the legacy port interface.
 *
 * `search` PINS the runtime to the requested provider: a legacy caller naming a
 * provider is making an explicit choice, and quietly answering from a different
 * one would both surprise it and send its query somewhere it did not ask for.
 * Legacy callers that want fallback get it by looping, exactly as they do today.
 */
export function searchRuntimeAsWebSearchBackend(
  runtime: SearchRuntime,
  options: SearchRuntimeBackendOptions = {},
): WebSearchBackend {
  return {
    async search(
      query: string,
      providerId: WebSearchProviderId,
      searchOptions?: WebSearchOptions,
    ): Promise<WebSearchResponse> {
      try {
        const response = await runtime.search({
          query,
          provider: providerId,
          // `WebSearchOptions` is a strict subset of `SearchOptions` with
          // identical field names — asserted in the contracts tests.
          ...(searchOptions === undefined ? {} : { options: searchOptions }),
        });
        return toLegacyWebSearchResponse(response);
      } catch (error) {
        // The legacy shape has no throw channel: every failure comes back as
        // `success: false` with the taxonomy-derived string.
        return searchErrorToLegacyWebSearchResponse(query, toSearchErrorShape(error));
      }
    },

    isProviderEnabled(id: WebSearchProviderId): boolean {
      return runtime.listProviders().some((descriptor) => descriptor.id === id);
    },

    async readUrl(
      url: string,
      readOptions?: { timeout?: number; signal?: AbortSignal; apiKey?: string },
    ): Promise<JinaReaderResponse> {
      if (options.readUrl !== undefined) return options.readUrl(url, readOptions);
      return {
        success: false,
        url,
        error: 'URL reading is not available through the search runtime adapter',
      };
    },
  };
}
