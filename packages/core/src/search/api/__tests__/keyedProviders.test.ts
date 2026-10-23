import type { SearchProvider } from '@omnicross/contracts/search-types';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SearchOrchestrator } from '../../orchestrator';
import { SearchProviderRegistry } from '../../registry';
import { BochaSearchProvider } from '../BochaSearchProvider';
import { BraveSearchProvider } from '../BraveSearchProvider';
import { KagiSearchProvider } from '../KagiSearchProvider';
import { KimiSearchProvider } from '../KimiSearchProvider';
import { OLLAMA_CAPABILITIES, OllamaSearchProvider } from '../OllamaSearchProvider';
import { SYNTHETIC_CAPABILITIES, SyntheticSearchProvider } from '../SyntheticSearchProvider';
import { TinyfishSearchProvider } from '../TinyfishSearchProvider';
import { createSearchApiTransport } from '../transport';
import type { KeyedSearchProviderConfig, SearchApiRequest, SearchApiTransport } from '../types';

interface AdapterCase {
  id: string;
  create: (config: KeyedSearchProviderConfig, transport: SearchApiTransport) => SearchProvider;
  envelope: (items: unknown[]) => unknown;
  item: (url: unknown, title?: unknown, content?: unknown) => unknown;
  keyHeader: string;
  bearer: boolean;
  defaultLimit: number;
  cap: number;
}

const adapters: AdapterCase[] = [
  { id: 'brave', create: (c, t) => new BraveSearchProvider(c, t), envelope: (items) => ({ web: { results: items } }),
    item: (url, title = 'Title', content = 'Snippet') => ({ url, title, description: content }),
    keyHeader: 'X-Subscription-Token', bearer: false, defaultLimit: 10, cap: 20 },
  { id: 'kagi', create: (c, t) => new KagiSearchProvider(c, t), envelope: (items) => ({ data: { search: items } }),
    item: (url, title = 'Title', content = 'Snippet') => ({ url, title, snippet: content }),
    keyHeader: 'Authorization', bearer: true, defaultLimit: 10, cap: 100 },
  { id: 'kimi', create: (c, t) => new KimiSearchProvider(c, t), envelope: (items) => ({ search_results: items }),
    item: (url, title = 'Title', content = 'Snippet') => ({ url, title, snippet: content }),
    keyHeader: 'Authorization', bearer: true, defaultLimit: 10, cap: 20 },
  { id: 'synthetic', create: (c, t) => new SyntheticSearchProvider(c, t), envelope: (items) => ({ results: items }),
    item: (url, title = 'Title', content = 'Snippet') => ({ url, title, text: content }),
    keyHeader: 'Authorization', bearer: true, defaultLimit: 10, cap: 100 },
  { id: 'ollama', create: (c, t) => new OllamaSearchProvider(c, t), envelope: (items) => ({ results: items }),
    item: (url, title = 'Title', content = 'Snippet') => ({ url, title, content }),
    keyHeader: 'Authorization', bearer: true, defaultLimit: 5, cap: 10 },
  { id: 'tinyfish', create: (c, t) => new TinyfishSearchProvider(c, t), envelope: (items) => ({ results: items }),
    item: (url, title = 'Title', content = 'Snippet') => ({ url, title, snippet: content }),
    keyHeader: 'X-API-Key', bearer: false, defaultLimit: 10, cap: 20 },
  { id: 'bocha', create: (c, t) => new BochaSearchProvider(c, t), envelope: (items) => ({ code: 200, data: { webPages: { value: items } } }),
    item: (url, title = 'Title', content = 'Snippet') => ({ url, name: title, summary: content }),
    keyHeader: 'Authorization', bearer: true, defaultLimit: 10, cap: 50 },
];

function recorded(payload: unknown): { calls: SearchApiRequest[]; transport: SearchApiTransport } {
  const calls: SearchApiRequest[] = [];
  return { calls, transport: async (request) => { calls.push(request); return payload; } };
}

function requestLimit(request: SearchApiRequest): unknown {
  const url = new URL(request.url);
  const body = request.jsonBody as Record<string, unknown> | undefined;
  if (request.providerId === 'synthetic') return undefined;
  return body?.limit ?? body?.max_results ?? body?.count ?? Number(url.searchParams.get(request.providerId === 'brave' ? 'count' : 'num_results'));
}

afterEach(() => vi.useRealTimers());

describe.each(adapters)('$id keyed search boundaries', (adapter) => {
  it('rejects missing or comma-only credentials before calling any transport', async () => {
    const transport = vi.fn<SearchApiTransport>();
    for (const apiKey of ['', ' ,  , ']) {
      await expect(adapter.create({ apiKey }, transport).search('query')).rejects.toMatchObject({
        code: 'config_missing', providerId: adapter.id, details: { stage: 'config' },
      });
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it('rotates credentials, passes all keys for redaction, and propagates cancellation', async () => {
    const { calls, transport } = recorded(adapter.envelope([]));
    const signal = new AbortController().signal;
    const provider = adapter.create({ apiKey: ' secret-alpha, secret-beta ' }, transport);
    for (let index = 0; index < 3; index += 1) await provider.search('query', { signal, timeout: 4_321 });
    expect(calls.map((call) => call.headers?.[adapter.keyHeader])).toEqual(
      ['secret-alpha', 'secret-beta', 'secret-alpha'].map((key) => adapter.bearer ? `Bearer ${key}` : key),
    );
    for (const call of calls) {
      expect(call.secrets).toEqual(['secret-alpha', 'secret-beta']);
      expect(call.signal).toBe(signal);
      expect(call.timeoutMs).toBeGreaterThan(0);
      expect(call.timeoutMs).toBeLessThanOrEqual(4_321);
    }
  });

  it.each([401, 403, 429, 503])('maps HTTP %i and redacts every configured credential', async (status) => {
    const transport = createSearchApiTransport({ fetch: async () => new Response('secret-alpha secret-beta', { status }) });
    let failure: unknown;
    try { await adapter.create({ apiKey: 'secret-alpha,secret-beta' }, transport).search('query'); }
    catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: status === 429 ? 'rate_limited' : status === 503 ? 'upstream_unavailable' : 'auth_failed', providerId: adapter.id });
    expect(String(failure)).not.toContain('secret-alpha');
    expect(String(failure)).not.toContain('secret-beta');
  });

  it('rejects malformed envelopes, but accepts a genuine empty result set', async () => {
    for (const malformed of [null, [], { results: 'not an array' }]) {
      await expect(adapter.create({ apiKey: 'key' }, async () => malformed).search('query')).rejects.toMatchObject({ code: 'parse_failed' });
    }
    await expect(adapter.create({ apiKey: 'key' }, async () => adapter.envelope([])).search('query')).resolves.toEqual([]);
  });

  it('rejects nonempty arrays containing only malformed sources, without rejecting genuine policy-filtered emptiness', async () => {
    const invalid = adapter.envelope([null, 42, {}, adapter.item('javascript:alert(1)'), adapter.item('not a URL')]);
    await expect(adapter.create({ apiKey: 'key' }, async () => invalid).search('query'))
      .rejects.toMatchObject({ code: 'parse_failed', providerId: adapter.id });
    const filtered = adapter.envelope([adapter.item('https://sub.blocked.test./source')]);
    await expect(adapter.create({ apiKey: 'key' }, async () => filtered).search('query -site:blocked.test')).resolves.toEqual([]);
  });

  it('enforces all local exclusions beyond the native wire cap and canonicalizes DNS dots and IDNA', async () => {
    const exclusions = Array.from({ length: 51 }, (_, index) => `-site:excluded-${index}.test`);
    const payload = adapter.envelope([
      adapter.item('https://excluded-50.test./source'),
      adapter.item('https://sub.xn--bcher-kva.test./source'),
      adapter.item('https://allowed.test/source'),
    ]);
    const results = await adapter.create({ apiKey: 'key' }, async () => payload)
      .search(`query ${exclusions.join(' ')} -site:BÜCHER.test.`);
    expect(results.map((result) => result.url)).toEqual(['https://allowed.test/source']);
  });

  it('normalizes real sources, rejects unsafe links, deduplicates and enforces excluded subdomains', async () => {
    const payload = adapter.envelope([
      null, 42, adapter.item('javascript:alert(1)'), adapter.item('file:///etc/passwd'),
      adapter.item('https://user:password@example.test/'), adapter.item('not a URL'),
      adapter.item('https://blocked.test/a'), adapter.item('https://sub.blocked.test/b'),
      adapter.item('https://allowed.test/a', '<b>Real title</b>', '<em>A snippet</em>'),
      adapter.item('https://allowed.test/a', 'Duplicate'), adapter.item('https://allowed.test/b', 'N/A', 42),
    ]);
    const results = await adapter.create({ apiKey: 'key' }, async () => payload).search('query -site:blocked.test');
    expect(results).toEqual([
      { url: 'https://allowed.test/a', title: 'Real title', content: 'A snippet' },
      { url: 'https://allowed.test/b', title: 'https://allowed.test/b', content: '' },
    ]);
  });

  it.each([undefined, -10, 2.9, Number.NaN, Number.POSITIVE_INFINITY, 1_000])('bounds requested result count %s both locally and on the wire', async (maxResults) => {
    const items = Array.from({ length: 120 }, (_, index) => adapter.item(`https://result.test/${index}`));
    const { calls, transport } = recorded(adapter.envelope(items));
    const results = await adapter.create({ apiKey: 'key' }, transport).search('query', { maxResults });
    const expected = maxResults === undefined || !Number.isFinite(maxResults)
      ? adapter.defaultLimit : Math.max(1, Math.min(adapter.cap, Math.floor(maxResults)));
    expect(results).toHaveLength(expected);
    expect(requestLimit(calls[0])).toBe(adapter.id === 'synthetic' ? undefined : adapter.id === 'tinyfish' ? Math.min(expected, 10) : expected);
  });

  it('preserves explicit custom hosts while retaining the shared egress policy', async () => {
    const { calls, transport } = recorded(adapter.envelope([]));
    await adapter.create({ apiKey: 'key', apiHost: 'https://custom.example.test/proxy/' }, transport).search('query');
    expect(new URL(calls[0].url).origin).toBe('https://custom.example.test');
    expect(new URL(calls[0].url).pathname).toMatch(/^\/proxy(?:\/|$)/);
    const fetch = vi.fn(async () => new Response('{}'));
    await expect(adapter.create({ apiKey: 'key', apiHost: 'http://127.0.0.1:8080' }, createSearchApiTransport({ fetch })).search('query'))
      .rejects.toMatchObject({ code: 'policy_denied' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not append a complete endpoint twice', async () => {
    const first = recorded(adapter.envelope([]));
    await adapter.create({ apiKey: 'key' }, first.transport).search('query');
    const endpoint = new URL(first.calls[0].url);
    endpoint.search = '';
    const second = recorded(adapter.envelope([]));
    await adapter.create({ apiKey: 'key', apiHost: endpoint.toString() }, second.transport).search('query');
    expect(new URL(second.calls[0].url).pathname).toBe(endpoint.pathname);
  });
});

it('Brave maps market, language and recency into native search parameters and retains extra snippets', async () => {
  const { calls, transport } = recorded({ web: { results: [{ title: 'Title', url: 'https://source.test/', description: 'First', extra_snippets: ['Second', null] }] } });
  const results = await new BraveSearchProvider({ apiKey: 'key' }, transport).search('query', { region: 'us', language: 'zh-HANS', timeRange: 'week' });
  const params = new URL(calls[0].url).searchParams;
  expect(params.get('country')).toBe('US');
  expect(params.get('search_lang')).toBe('zh-hans');
  expect(params.get('freshness')).toBe('pw');
  expect(results[0].content).toBe('First Second');
});

it('Kagi consumes categorized v1 sources rather than answers and clamps calendar recency', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-31T15:00:00Z'));
  const { calls, transport } = recorded({ data: {
    search: [{ title: 'Search', url: 'https://search.test/', snippet: 'Source' }],
    video: [{ title: 'Video', url: 'https://video.test/' }],
    news: [{ title: 'News', url: 'https://news.test/' }],
    infobox: [{ title: 'Info', url: 'https://info.test/' }],
    direct_answer: [{ title: 'Uncited answer' }],
  } });
  const results = await new KagiSearchProvider({ apiKey: 'key' }, transport).search('query', { timeRange: 'month' });
  expect(results.map((result) => result.title)).toEqual(['Search', 'Video', 'News', 'Info']);
  expect(calls[0].jsonBody).toEqual({ query: 'query', workflow: 'search', limit: 10, filters: { after: '2026-02-28' } });
});

it.each([
  { payload: { error: [{ code: 401, message: 'secret-alpha' }] }, code: 'auth_failed' },
  { payload: { error: [{ code: 429 }] }, code: 'rate_limited' },
])('Kagi treats a successful-HTTP error envelope as a typed failure', async ({ payload, code }) => {
  await expect(new KagiSearchProvider({ apiKey: 'secret-alpha' }, async () => payload).search('query'))
    .rejects.toMatchObject({ code, message: 'Kagi rejected the search request' });
});

it('Kimi uses the coding search protocol, includes optional crawled content and bounds server timeout', async () => {
  const { calls, transport } = recorded({ search_results: [{ url: 'https://kimi-source.test/', title: 'Title', content: 'Crawled page' }] });
  const results = await new KimiSearchProvider({ apiKey: 'key' }, transport).search('query', { fetchPageContent: true, timeout: 90_000 });
  expect(calls[0].url).toBe('https://api.kimi.com/coding/v1/search');
  expect(calls[0].jsonBody).toEqual({ text_query: 'query', limit: 10, enable_page_crawling: true, timeout_seconds: 30 });
  expect(results[0].content).toBe('Crawled page');
});

it('Ollama uses hosted web_search, not a localhost chat endpoint', async () => {
  const { calls, transport } = recorded({ results: [] });
  await new OllamaSearchProvider({ apiKey: 'key' }, transport).search('query');
  expect(calls[0].url).toBe('https://ollama.com/api/web_search');
  expect(calls[0].jsonBody).toEqual({ query: 'query', max_results: 5 });
});

it('Synthetic sends only supported query fields rather than invented filters', async () => {
  const { calls, transport } = recorded({ results: [] });
  await new SyntheticSearchProvider({ apiKey: 'key' }, transport).search('query', { timeRange: 'day', region: 'US', language: 'en' });
  expect(calls[0].jsonBody).toEqual({ query: 'query' });
});

it('Bocha maps official web-search freshness and summaries and rejects body-level auth failures', async () => {
  const { calls, transport } = recorded({ code: 200, data: { webPages: { value: [{ name: 'Title', url: 'https://bocha-source.test/', summary: '', snippet: 'Fallback snippet' }] } } });
  const results = await new BochaSearchProvider({ apiKey: 'key' }, transport).search('query', { timeRange: 'year', maxResults: 999 });
  expect(calls[0].url).toBe('https://api.bocha.cn/v1/web-search');
  expect(calls[0].jsonBody).toEqual({ query: 'query', freshness: 'oneYear', summary: true, count: 50 });
  expect(results[0].content).toBe('Fallback snippet');
  await expect(new BochaSearchProvider({ apiKey: 'key' }, async () => ({ code: 403, message: 'key', data: {} })).search('query'))
    .rejects.toMatchObject({ code: 'auth_failed', message: 'Bocha rejected the search request' });
});

it('Tinyfish paginates zero-based, deduplicates pages, and maps native filters', async () => {
  const calls: SearchApiRequest[] = [];
  const provider = new TinyfishSearchProvider({ apiKey: 'alpha,beta' }, async (request) => {
    calls.push(request);
    const page = Number(new URL(request.url).searchParams.get('page'));
    return { results: Array.from({ length: 10 }, (_, index) => ({ title: `Result ${index}`, url: `https://result.test/${page === 0 ? index : index + 5}`, snippet: 'Snippet' })) };
  });
  const results = await provider.search('query site:allowed.test -site:blocked.test', { maxResults: 15, region: 'it', language: 'IT', timeRange: 'day' });
  expect(results).toHaveLength(15);
  expect(calls.map((call) => new URL(call.url).searchParams.get('page'))).toEqual(['0', '1']);
  expect(calls.map((call) => call.headers?.['X-API-Key'])).toEqual(['alpha', 'alpha']);
  const params = new URL(calls[0].url).searchParams;
  expect(params.get('recency_minutes')).toBe('1440');
  expect(params.get('location')).toBe('IT');
  expect(params.get('language')).toBe('it');
  expect(params.get('include_domains')).toBe('allowed.test');
  expect(params.get('exclude_domains')).toBe('blocked.test');
});

it('Tinyfish stops repeated full pages at its pagination bound', async () => {
  let count = 0;
  const provider = new TinyfishSearchProvider({ apiKey: 'key' }, async () => {
    count += 1;
    return { results: Array.from({ length: 10 }, (_, index) => ({ title: 'Title', url: `https://result.test/${index}` })) };
  });
  await expect(provider.search('query', { maxResults: 20 })).resolves.toHaveLength(10);
  expect(count).toBe(11);
});

it.each(['timeout', 'cancelled'] as const)('Tinyfish applies one overall pagination budget and stops on %s', async (code) => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const controller = new AbortController();
  let count = 0;
  const provider = new TinyfishSearchProvider({ apiKey: 'key' }, async () => {
    count += 1;
    if (code === 'cancelled') controller.abort();
    else vi.setSystemTime(3_000);
    return { results: Array.from({ length: 10 }, (_, index) => ({ title: 'Title', url: `https://result.test/${index}` })) };
  });
  await expect(provider.search('query', { maxResults: 20, timeout: 1_000, signal: controller.signal })).rejects.toMatchObject({ code });
  expect(count).toBe(1);
});

describe.each(adapters)('$id transport interruption', (adapter) => {
  it('preserves a caller cancellation as cancelled rather than an upstream error', async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = createSearchApiTransport({
      fetch: async (_url, init) => {
        if (init.signal?.aborted) throw new Error('aborted');
        throw new Error('expected an already aborted request');
      },
    });
    await expect(adapter.create({ apiKey: 'key' }, transport).search('query', { signal: controller.signal }))
      .rejects.toMatchObject({ code: 'cancelled', retryable: false });
  });

  it('turns a real transport deadline into a typed timeout', async () => {
    const transport = createSearchApiTransport({
      fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        const abort = (): void => reject(new Error('aborted'));
        if (init.signal?.aborted) abort();
        else init.signal?.addEventListener('abort', abort, { once: true });
      }),
    });
    await expect(adapter.create({ apiKey: 'key' }, transport).search('query', { timeout: 5 }))
      .rejects.toMatchObject({ code: 'timeout', retryable: true });
  });
});

it('falls back after an invalid-only upstream search response instead of reporting an empty success', async () => {
  const registry = new SearchProviderRegistry();
  const synthetic = new SyntheticSearchProvider({ apiKey: 'key' }, async () => ({
    results: [{ title: 'Malformed source', url: 'javascript:alert(1)' }],
  }));
  const ollama = new OllamaSearchProvider({ apiKey: 'key' }, async () => ({
    results: [{ title: 'Actual source', url: 'https://fallback.test/source', content: 'Snippet' }],
  }));
  registry.register({ id: synthetic.id, source: 'builtin', kind: 'api', provider: synthetic, capabilities: SYNTHETIC_CAPABILITIES });
  registry.register({ id: ollama.id, source: 'builtin', kind: 'api', provider: ollama, capabilities: OLLAMA_CAPABILITIES });
  const response = await new SearchOrchestrator(registry).search({ query: 'query' });
  expect(response.providerId).toBe('ollama');
  expect(response.results).toEqual([{ title: 'Actual source', url: 'https://fallback.test/source', content: 'Snippet' }]);
  expect(response.attempts).toMatchObject([
    { providerId: 'synthetic', outcome: 'failed', errorCode: 'parse_failed' },
    { providerId: 'ollama', outcome: 'success', resultCount: 1 },
  ]);
  expect(response.fallbackCount).toBe(1);
});
