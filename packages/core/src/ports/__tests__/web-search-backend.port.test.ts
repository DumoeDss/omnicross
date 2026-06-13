/**
 * Mock-based unit test for the `WebSearchBackend` port (omnicross Phase 0b,
 * task 5.3).
 *
 * Injects a mock `WebSearchBackend` into the serving-core `BuiltinToolExecutor`
 * and asserts the core dispatches `isProviderEnabled`/`search`/`readUrl`
 * correctly, with NO reliance on the concrete host `WebSearchService`.
 */

import type {
  JinaReaderResponse,
  WebSearchProviderId,
  WebSearchResponse,
} from '@omnicross/contracts/websearch-types';
import { describe, expect, it, vi } from 'vitest';

import { BuiltinToolExecutor } from '../../completion/BuiltinToolExecutor';
import type { WebSearchBackend } from '../web-search-backend';

function makeMockBackend(overrides?: {
  enabledProviders?: WebSearchProviderId[];
  searchResult?: WebSearchResponse;
  readUrlResult?: JinaReaderResponse;
}): {
  backend: WebSearchBackend;
  search: ReturnType<typeof vi.fn>;
  isProviderEnabled: ReturnType<typeof vi.fn>;
  readUrl: ReturnType<typeof vi.fn>;
} {
  const enabled = new Set<WebSearchProviderId>(overrides?.enabledProviders ?? ['tavily']);

  const search = vi.fn(
    async (query: string): Promise<WebSearchResponse> =>
      overrides?.searchResult ?? {
        success: true,
        query,
        results: [{ title: 'Hit', url: 'https://example.com', content: 'body' }],
      },
  );
  const isProviderEnabled = vi.fn((id: WebSearchProviderId): boolean => enabled.has(id));
  const readUrl = vi.fn(
    async (url: string): Promise<JinaReaderResponse> =>
      overrides?.readUrlResult ?? { success: true, url, title: 'Doc', content: 'page text' },
  );

  const backend = { search, isProviderEnabled, readUrl } as unknown as WebSearchBackend;
  return { backend, search, isProviderEnabled, readUrl };
}

describe('WebSearchBackend port — mock injection (task 5.3)', () => {
  it('web_search dispatches isProviderEnabled (chain build) then search through the port', async () => {
    const { backend, search, isProviderEnabled } = makeMockBackend({
      enabledProviders: ['tavily'],
    });
    const executor = new BuiltinToolExecutor(backend);

    const res = await executor.execute('web_search', { query: 'omnicross ports', count: 3 });

    expect(isProviderEnabled).toHaveBeenCalled();
    expect(search).toHaveBeenCalledTimes(1);
    // First positional arg is the trimmed query; second is a provider id from the chain.
    expect(search.mock.calls[0][0]).toBe('omnicross ports');
    expect(res.isError).toBe(false);
    expect(JSON.stringify(res.content)).toContain('Hit');
  });

  it('web_fetch dispatches readUrl through the port', async () => {
    const { backend, readUrl } = makeMockBackend({
      readUrlResult: {
        success: true,
        url: 'https://example.com/page',
        title: 'Title',
        content: 'fetched body',
      },
    });
    const executor = new BuiltinToolExecutor(backend);

    const res = await executor.execute('web_fetch', { url: 'https://example.com/page' });

    expect(readUrl).toHaveBeenCalledTimes(1);
    expect(readUrl.mock.calls[0][0]).toBe('https://example.com/page');
    expect(res.isError).toBe(false);
    expect(JSON.stringify(res.content)).toContain('fetched body');
  });
});
