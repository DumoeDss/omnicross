/**
 * The runtime-backed legacy port adapter — 阶段5's migration path, tested now
 * so the migration is a rewiring rather than a design exercise.
 */

import type {
  SearchProviderCapabilities,
  SearchProviderContribution,
  SearchProviderId,
  SearchResult,
} from '@omnicross/contracts/search-types';
import { SearchProviderError } from '@omnicross/contracts/search-types';
import type { JinaReaderResponse } from '@omnicross/contracts/websearch-types';
import { describe, expect, it, vi } from 'vitest';

import type { WebSearchBackend } from '../../ports/web-search-backend';
import { createSearchRuntime } from '../runtime';
import { searchRuntimeAsWebSearchBackend } from '../webSearchBackendCompat';

const CAPABILITIES: SearchProviderCapabilities = {
  requiresApiKey: false,
  supportsRegion: false,
  supportsLanguage: false,
  supportsTimeRange: false,
  supportsUrlRead: false,
  supportsCancellation: true,
};

function contribution(
  id: SearchProviderId,
  search: SearchProviderContribution['provider']['search'],
): SearchProviderContribution {
  return { id, source: 'builtin', kind: 'http', provider: { id, search }, capabilities: CAPABILITIES };
}

function hit(): SearchResult {
  return { title: 'Hit', url: 'https://example.com/hit', content: 'snippet' };
}

describe('searchRuntimeAsWebSearchBackend — legacy response shapes', () => {
  it('converts a successful search into a legacy success, preserving the provider', async () => {
    const runtime = createSearchRuntime({
      contributions: [contribution('http-bing', async () => [hit()])],
    });
    const backend = searchRuntimeAsWebSearchBackend(runtime);

    const response = await backend.search('q', 'http-bing' as never, { maxResults: 3 });

    expect(response).toEqual({
      success: true,
      query: 'q',
      results: [{ title: 'Hit', content: 'snippet', url: 'https://example.com/hit' }],
      provider: 'http-bing',
    });
  });

  it('converts an empty result set into a legacy success with no results', async () => {
    const runtime = createSearchRuntime({
      contributions: [contribution('http-bing', async () => [])],
    });
    const backend = searchRuntimeAsWebSearchBackend(runtime);

    const response = await backend.search('q', 'http-bing' as never);

    // Empty is a success in both vocabularies — the adapter must not invent a
    // failure where the runtime reported an authoritative "nothing found".
    expect(response).toEqual({ success: true, query: 'q', results: [], provider: 'http-bing' });
  });

  it('converts a thrown search error into a legacy failure with the taxonomy message', async () => {
    const runtime = createSearchRuntime({
      contributions: [
        contribution('http-bing', async () => {
          throw new SearchProviderError('parse_failed', 'response is not recognizable as a Bing search result page', {
            providerId: 'http-bing',
          });
        }),
      ],
    });
    const backend = searchRuntimeAsWebSearchBackend(runtime);

    const response = await backend.search('q', 'http-bing' as never);

    expect(response).toEqual({
      success: false,
      query: 'q',
      results: [],
      error: 'response is not recognizable as a Bing search result page',
      provider: 'http-bing',
    });
  });

  it('never throws — the legacy shape has no error channel other than success:false', async () => {
    const runtime = createSearchRuntime({ contributions: [] });
    const backend = searchRuntimeAsWebSearchBackend(runtime);

    const response = await backend.search('q', 'tavily' as never);

    expect(response.success).toBe(false);
    expect(response.error).toContain('not registered');
  });
});

describe('searchRuntimeAsWebSearchBackend — pinning and membership', () => {
  it('pins the runtime to the provider the legacy caller named', async () => {
    const bing = vi.fn(async () => [hit()]);
    const ddg = vi.fn(async () => [hit()]);
    const runtime = createSearchRuntime({
      contributions: [contribution('http-bing', bing), contribution('http-duckduckgo', ddg)],
    });
    const backend = searchRuntimeAsWebSearchBackend(runtime);

    await backend.search('q', 'http-duckduckgo' as never);

    // A legacy caller naming a provider made an explicit choice; answering from
    // a different one would send its query somewhere it did not ask for.
    expect(bing).not.toHaveBeenCalled();
    expect(ddg).toHaveBeenCalledTimes(1);
  });

  it('passes legacy options through unmapped', async () => {
    const signal = new AbortController().signal;
    const search = vi.fn(async () => [hit()]);
    const runtime = createSearchRuntime({ contributions: [contribution('http-bing', search)] });
    const backend = searchRuntimeAsWebSearchBackend(runtime);

    await backend.search('q', 'http-bing' as never, { maxResults: 2, timeout: 500, signal });

    expect(search).toHaveBeenCalledWith('q', { maxResults: 2, timeout: 500, signal });
  });

  it('reports provider membership from the registry', () => {
    const runtime = createSearchRuntime({
      contributions: [contribution('http-bing', async () => [])],
    });
    const backend = searchRuntimeAsWebSearchBackend(runtime);

    expect(backend.isProviderEnabled('http-bing' as never)).toBe(true);
    expect(backend.isProviderEnabled('tavily' as never)).toBe(false);

    runtime.registerContribution(contribution('tavily', async () => []));
    expect(backend.isProviderEnabled('tavily' as never)).toBe(true);

    runtime.unregisterContribution('tavily');
    expect(backend.isProviderEnabled('tavily' as never)).toBe(false);
  });
});

describe('searchRuntimeAsWebSearchBackend — readUrl', () => {
  it('names the missing capability instead of pretending to have read a page', async () => {
    const runtime = createSearchRuntime({ contributions: [] });
    const backend = searchRuntimeAsWebSearchBackend(runtime);

    const response = await backend.readUrl('https://example.com/page');

    expect(response).toEqual({
      success: false,
      url: 'https://example.com/page',
      error: 'URL reading is not available through the search runtime adapter',
    });
  });

  it('uses a supplied delegate when one is given', async () => {
    const readUrl = vi.fn(
      async (url: string): Promise<JinaReaderResponse> => ({
        success: true,
        url,
        title: 'Doc',
        content: 'page text',
      }),
    );
    const runtime = createSearchRuntime({ contributions: [] });
    const backend = searchRuntimeAsWebSearchBackend(runtime, { readUrl });

    const response = await backend.readUrl('https://example.com/page', { timeout: 1_000 });

    expect(readUrl).toHaveBeenCalledWith('https://example.com/page', { timeout: 1_000 });
    expect(response.content).toBe('page text');
  });

  it('satisfies the port interface in full', () => {
    const runtime = createSearchRuntime({ contributions: [] });
    const backend: WebSearchBackend = searchRuntimeAsWebSearchBackend(runtime);

    expect(typeof backend.search).toBe('function');
    expect(typeof backend.isProviderEnabled).toBe('function');
    expect(typeof backend.readUrl).toBe('function');
  });
});
