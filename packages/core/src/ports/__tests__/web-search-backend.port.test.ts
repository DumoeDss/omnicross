/**
 * Mock-based unit test for the `WebSearchBackend` port and the delegation
 * contract of the serving-core `BuiltinToolExecutor`.
 *
 * The port still carries `web_fetch`'s URL reading, and those assertions are
 * unchanged from before 阶段3. `web_search` no longer goes through the port at
 * all: it delegates to a `SearchRuntime`, and what this file pins is that the
 * executor makes exactly ONE runtime call with no provider loop of its own —
 * the structural reason a request can never fall back twice.
 *
 * It also pins the surface Elftia's `ElftiaBuiltinToolExecutor` compiles
 * against, which no other test covers: single-argument construction, the
 * `execute` signature, and the `Unknown built-in tool` default arm it reaches
 * through `super`.
 */

import type {
  OrchestratedSearchResponse,
  SearchRequest,
} from '@omnicross/contracts/search-types';
import { SearchProviderError } from '@omnicross/contracts/search-types';
import type {
  JinaReaderResponse,
  WebSearchProviderId,
  WebSearchResponse,
} from '@omnicross/contracts/websearch-types';
import { describe, expect, it, vi } from 'vitest';

import { BuiltinToolExecutor, getBuiltinSearchTools } from '../../completion/BuiltinToolExecutor';
import type { SearchRuntime } from '../../search/runtime';
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

/** A runtime that answers with whatever the test supplies, and records the request. */
function makeFakeRuntime(answer: () => Promise<OrchestratedSearchResponse>): {
  runtime: SearchRuntime;
  search: ReturnType<typeof vi.fn>;
} {
  const search = vi.fn(async (_request: SearchRequest) => answer());
  const runtime = {
    search,
    registerContribution: vi.fn(),
    unregisterContribution: vi.fn(() => false),
    listProviders: vi.fn(() => []),
  } as unknown as SearchRuntime;
  return { runtime, search };
}

function orchestrated(
  overrides: Partial<OrchestratedSearchResponse> = {},
): OrchestratedSearchResponse {
  return {
    query: 'omnicross ports',
    providerId: 'http-bing',
    results: [{ title: 'Hit', url: 'https://example.com', content: 'body' }],
    attempts: [
      { providerId: 'http-bing', outcome: 'success', resultCount: 1, durationMs: 12 },
    ],
    fallbackCount: 0,
    ...overrides,
  };
}

describe('BuiltinToolExecutor — web_search delegates to the runtime', () => {
  it('issues exactly one runtime call and never touches the legacy port', async () => {
    const { backend, search: portSearch, isProviderEnabled } = makeMockBackend();
    const { runtime, search: runtimeSearch } = makeFakeRuntime(async () => orchestrated());
    const executor = new BuiltinToolExecutor(backend, runtime);

    const res = await executor.execute('web_search', { query: 'omnicross ports', count: 3 });

    expect(runtimeSearch).toHaveBeenCalledTimes(1);
    expect(runtimeSearch.mock.calls[0][0]).toEqual({
      query: 'omnicross ports',
      options: { maxResults: 3 },
    });
    // The provider walk lives in the orchestrator now; the tool has no chain.
    expect(portSearch).not.toHaveBeenCalled();
    expect(isProviderEnabled).not.toHaveBeenCalled();

    expect(res.isError).toBe(false);
    expect(JSON.stringify(res.content)).toContain('Hit');
  });

  it('clamps count to [1,10] at the tool boundary before delegating', async () => {
    const { backend } = makeMockBackend();
    const { runtime, search } = makeFakeRuntime(async () => orchestrated());
    const executor = new BuiltinToolExecutor(backend, runtime);

    await executor.execute('web_search', { query: 'q', count: 99 });
    await executor.execute('web_search', { query: 'q', count: 0 });
    await executor.execute('web_search', { query: 'q' });

    expect(search.mock.calls.map((call) => call[0].options.maxResults)).toEqual([10, 1, 5]);
  });

  it('formats results as the numbered list its callers already parse', async () => {
    const { backend } = makeMockBackend();
    const { runtime } = makeFakeRuntime(async () =>
      orchestrated({
        results: [
          { title: 'First', url: 'https://example.com/1', content: 'one' },
          { title: 'Second', url: 'https://example.com/2', content: '' },
        ],
      }),
    );
    const executor = new BuiltinToolExecutor(backend, runtime);

    const res = await executor.execute('web_search', { query: 'q' });

    expect(res.content[0]).toEqual({
      type: 'text',
      text: '1. First\n   URL: https://example.com/1\n   one\n\n2. Second\n   URL: https://example.com/2\n   ',
    });
  });

  it('reports an empty result set as no results, not as an error', async () => {
    const { backend } = makeMockBackend();
    const { runtime } = makeFakeRuntime(async () =>
      orchestrated({
        results: [],
        attempts: [{ providerId: 'http-bing', outcome: 'success', resultCount: 0, durationMs: 8 }],
      }),
    );
    const executor = new BuiltinToolExecutor(backend, runtime);

    const res = await executor.execute('web_search', { query: 'nothing at all' });

    expect(res.isError).toBe(false);
    expect(res.content[0]).toEqual({
      type: 'text',
      text: 'No results found for "nothing at all" after trying 1 provider(s). Try rephrasing your search.',
    });
  });

  it('turns a thrown search failure into sanitized text with isError false', async () => {
    const { backend } = makeMockBackend();
    const { runtime } = makeFakeRuntime(async () => {
      throw new SearchProviderError('timeout', 'search failed after 2 attempt(s)', {
        details: { attempts: 'http-bing:parse_failed,http-duckduckgo:timeout' },
      });
    });
    const executor = new BuiltinToolExecutor(backend, runtime);

    const res = await executor.execute('web_search', { query: 'q' });

    expect(res.isError).toBe(false);
    expect(res.content[0]).toEqual({
      type: 'text',
      text: 'Search failed (timeout): search failed after 2 attempt(s)',
    });
  });

  it('rejects a blank query before reaching the runtime', async () => {
    const { backend } = makeMockBackend();
    const { runtime, search } = makeFakeRuntime(async () => orchestrated());
    const executor = new BuiltinToolExecutor(backend, runtime);

    const res = await executor.execute('web_search', { query: '   ' });

    expect(res.isError).toBe(true);
    expect(search).not.toHaveBeenCalled();
  });

  it('builds a default runtime over the builtin HTTP providers when none is injected', async () => {
    const { backend } = makeMockBackend();
    const executor = new BuiltinToolExecutor(backend);

    // Reaching the private accessor deliberately: the lazy import is otherwise
    // only exercised by a real network search, and a broken specifier would
    // surface as a runtime failure in production instead of here.
    const internals = executor as unknown as { getRuntime(): Promise<SearchRuntime> };
    const runtime = await internals.getRuntime();

    expect(runtime.listProviders().map((descriptor) => descriptor.id)).toEqual([
      'http-bing',
      'http-duckduckgo',
    ]);
    // Built once, then reused.
    expect(await internals.getRuntime()).toBe(runtime);
  });

  it('builds only one default runtime when concurrent searches race for it', async () => {
    const { backend } = makeMockBackend();
    const executor = new BuiltinToolExecutor(backend);
    const internals = executor as unknown as { getRuntime(): Promise<SearchRuntime> };

    const [first, second, third] = await Promise.all([
      internals.getRuntime(),
      internals.getRuntime(),
      internals.getRuntime(),
    ]);

    // The promise is memoized, not just its result — otherwise each concurrent
    // caller builds its own runtime and the last write wins.
    expect(second).toBe(first);
    expect(third).toBe(first);
  });
});

describe('WebSearchBackend port — mock injection (task 5.3)', () => {
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

describe('the surface a host subclass compiles against', () => {
  // Mirrors Elftia's `ElftiaBuiltinToolExecutor`: single-argument `super`, an
  // overridden `execute` that intercepts the web builtins, and `super.execute`
  // for everything else.
  class HostBuiltinToolExecutor extends BuiltinToolExecutor {
    constructor(webSearch: WebSearchBackend) {
      super(webSearch);
    }

    override async execute(toolName: string, args: Record<string, unknown>) {
      if (toolName === 'web_search') {
        return { isError: false, content: [{ type: 'text' as const, text: 'handled by host' }] };
      }
      return super.execute(toolName, args);
    }
  }

  it('constructs with only a backend and intercepts before the base implementation', async () => {
    const { backend, search } = makeMockBackend();
    const executor = new HostBuiltinToolExecutor(backend);

    const res = await executor.execute('web_search', { query: 'q' });

    expect(res.content[0]).toEqual({ type: 'text', text: 'handled by host' });
    expect(search).not.toHaveBeenCalled();
  });

  it('keeps the Unknown built-in tool default arm reachable through super', async () => {
    const { backend } = makeMockBackend();
    const executor = new HostBuiltinToolExecutor(backend);

    const res = await executor.execute('unknown_tool', {});

    expect(res).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'Unknown built-in tool: unknown_tool' }],
    });
  });

  it('still exports the two builtin tool definitions', () => {
    const tools = getBuiltinSearchTools();

    expect(tools.map((tool) => tool.name)).toEqual(['web_search', 'web_fetch']);
    expect(tools.map((tool) => tool.id)).toEqual(['builtin__web_search', 'builtin__web_fetch']);
    expect(tools.every((tool) => tool.serverId === 'builtin' && tool.isBuiltIn)).toBe(true);
  });
});
