import { readFileSync } from 'node:fs';

import type { SearchProvider } from '@omnicross/contracts/search-types';
import { describe, expect, it } from 'vitest';

import { ExaSearchProvider } from '../ExaSearchProvider';
import { FirecrawlSearchProvider } from '../FirecrawlSearchProvider';
import { ParallelSearchProvider } from '../ParallelSearchProvider';
import { API_RESPONSE_BYTES, createSearchApiTransport } from '../transport';
import type { KeylessSearchProviderConfig, SearchApiRequest, SearchApiTransport } from '../types';

const EXA_TEXT = readFileSync(new URL('../../../../test-fixtures/api-search/exa-mcp-text.txt', import.meta.url), 'utf8');
const PARALLEL = JSON.parse(readFileSync(new URL('../../../../test-fixtures/api-search/parallel-search.json', import.meta.url), 'utf8')) as unknown;
const FIRECRAWL = JSON.parse(readFileSync(new URL('../../../../test-fixtures/api-search/firecrawl-search.json', import.meta.url), 'utf8')) as unknown;
const QUERY = 'mozilla developer network http headers';

const adapters: {
  id: string;
  publicUrl: string;
  build: (config: KeylessSearchProviderConfig, transport: SearchApiTransport) => SearchProvider;
}[] = [
  { id: 'exa', publicUrl: 'https://mcp.exa.ai/mcp?tools=web_search_exa', build: (config, transport) => new ExaSearchProvider(config, transport) },
  { id: 'parallel', publicUrl: 'https://search.parallel.ai/mcp', build: (config, transport) => new ParallelSearchProvider(config, transport) },
  { id: 'firecrawl', publicUrl: 'https://api.firecrawl.dev/v2/search', build: (config, transport) => new FirecrawlSearchProvider(config, transport) },
];

function successPayload(id: string, request: SearchApiRequest): unknown {
  if (id === 'firecrawl') return FIRECRAWL;
  const body = request.jsonBody as { id: string };
  return {
    jsonrpc: '2.0', id: body.id,
    result: id === 'exa' ? { content: [{ type: 'text', text: EXA_TEXT }] }
      : { content: [{ type: 'text', text: JSON.stringify(PARALLEL) }] },
  };
}

function mcpTransport(result: unknown, sse = false): SearchApiTransport {
  return createSearchApiTransport({
    env: {},
    fetch: async (_url, init) => {
      const request = JSON.parse(init.body as string) as { id: string };
      const envelope = { jsonrpc: '2.0', id: request.id, result };
      const body = sse ? `: keepalive\r\nevent: message\r\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}\r\n\r\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 'unrelated', result: {} })}\r\n\r\ndata: ${JSON.stringify(envelope)}\r\n\r\n` : JSON.stringify(envelope);
      return new Response(body, { headers: { 'content-type': sse ? 'text/event-stream' : 'application/json' } });
    },
  });
}

describe('explicit public search modes', () => {
  for (const adapter of adapters) {
    it(`${adapter.id} ignores stored keys and custom hosts in public mode`, async () => {
      const requests: SearchApiRequest[] = [];
      const transport: SearchApiTransport = async (request) => {
        requests.push(request);
        return successPayload(adapter.id, request);
      };
      const provider = adapter.build({ authMode: 'public', apiKey: 'never-send-this', apiHost: 'https://custom.example.test' }, transport);
      const results = await provider.search(QUERY, { maxResults: 2 });
      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe(adapter.publicUrl);
      if (adapter.id !== 'firecrawl') {
        expect(requests[0].responseMode).toBe('text');
        expect(requests[0].jsonBody).toMatchObject({
          jsonrpc: '2.0',
          id: expect.any(String),
          method: 'tools/call',
          params: adapter.id === 'exa'
            ? { name: 'web_search_exa', arguments: { query: QUERY, numResults: 2 } }
            : { name: 'web_search', arguments: { objective: QUERY, search_queries: [QUERY] } },
        });
      }
      expect(JSON.stringify(requests)).not.toContain('never-send-this');
      expect(JSON.stringify(requests)).not.toContain('custom.example.test');
      expect(results).toHaveLength(2);
      expect(results[1].title).toBe('https://httpwg.org/specs/');
      expect(results[0].content).toContain('HTTP headers pass additional information');
      expect(results[0].content).not.toContain('Published:');
      expect(results[0].content).not.toContain('2026-09-12');
    });

    it(`${adapter.id} fails missing API credentials before invoking transport`, async () => {
      let calls = 0;
      const provider = adapter.build({ authMode: 'api', apiKey: ' , ' }, async () => { calls += 1; return {}; });
      await expect(provider.search(QUERY)).rejects.toMatchObject({ code: 'config_missing', providerId: adapter.id });
      expect(calls).toBe(0);
    });

    it(`${adapter.id} never downgrades rejected API credentials to public access`, async () => {
      const urls: string[] = [];
      const transport = createSearchApiTransport({ env: {}, fetch: async (url) => {
        urls.push(url);
        return new Response('invalid secret-key', { status: 401 });
      } });
      const provider = adapter.build({ apiKey: 'secret-key', apiHost: 'https://custom.example.test' }, transport);
      await expect(provider.search(QUERY)).rejects.toMatchObject({ code: 'auth_failed' });
      expect(urls).toHaveLength(1);
      expect(urls[0]).toContain('custom.example.test');
    });
  }

  it('defaults empty config to anonymous mode', async () => {
    for (const adapter of adapters) {
      const provider = adapter.build({}, async (request) => {
        expect(request.url).toBe(adapter.publicUrl);
        return successPayload(adapter.id, request);
      });
      expect(await provider.search(QUERY)).toHaveLength(2);
    }
  });
});

describe('current authenticated request protocols', () => {
  it('Exa sends REST highlights and a native recency floor with rotating/redacted keys', async () => {
    const requests: SearchApiRequest[] = [];
    const provider = new ExaSearchProvider({ apiKey: 'key-one,key-two', apiHost: 'https://custom.example.test/search/' }, async (request) => {
      requests.push(request);
      return { results: [{ title: 'N/A', url: 'https://example.org', highlights: ['one', 'two'], publishedDate: '2020-01-01' }] };
    });
    expect(await provider.search(QUERY, { maxResults: 100, timeRange: 'week' })).toEqual([{ title: 'https://example.org', url: 'https://example.org', content: 'one\ntwo' }]);
    await provider.search(QUERY);
    expect(requests[0]).toMatchObject({ url: 'https://custom.example.test/search', headers: { 'x-api-key': 'key-one' }, secrets: ['key-one', 'key-two'], jsonBody: { numResults: 10, type: 'auto', contents: { highlights: true }, startPublishedDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) } });
    expect(requests[1].headers).toEqual({ 'x-api-key': 'key-two' });
  });

  it('Parallel uses /v1/search with nested advanced_settings, not beta excerpts', async () => {
    let captured: SearchApiRequest | undefined;
    const provider = new ParallelSearchProvider({ apiKey: 'parallel-key', apiHost: 'https://custom.example.test/v1/' }, async (request) => { captured = request; return PARALLEL; });
    const results = await provider.search(QUERY, { maxResults: 1, timeRange: 'month' });
    expect(results).toHaveLength(1);
    expect(captured).toMatchObject({ url: 'https://custom.example.test/v1/search', headers: { 'x-api-key': 'parallel-key' }, jsonBody: { objective: QUERY, search_queries: [QUERY], mode: 'fast', advanced_settings: { max_results: 1, excerpt_settings: { max_chars_per_result: 10_000 }, source_policy: { after_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) } } } });
    expect(captured?.jsonBody).not.toHaveProperty('excerpts');
    expect(captured?.jsonBody).not.toHaveProperty('source_policy');
  });

  it('Firecrawl sends bearer auth only in API mode and reads only data.web', async () => {
    let captured: SearchApiRequest | undefined;
    const provider = new FirecrawlSearchProvider({ authMode: 'api', apiKey: 'firecrawl-key', apiHost: 'https://custom.example.test/v2' }, async (request) => { captured = request; return FIRECRAWL; });
    const results = await provider.search(QUERY, { timeRange: 'day' });
    expect(results).toHaveLength(2);
    expect(captured).toMatchObject({ url: 'https://custom.example.test/v2/search', headers: { Authorization: 'Bearer firecrawl-key' }, jsonBody: { query: QUERY, sources: [{ type: 'web' }], tbs: 'qdr:d' } });
    expect(results[0].content).not.toContain('full page');
  });
});

describe('MCP JSON and SSE framing', () => {
  for (const sse of [false, true]) {
    it(`parses Exa labeled sources in ${sse ? 'SSE' : 'JSON'} and ignores absent-title metadata`, async () => {
      const provider = new ExaSearchProvider({}, mcpTransport({ content: [{ type: 'text', text: EXA_TEXT }] }, sse));
      const results = await provider.search(QUERY);
      expect(results[1]).toEqual({ title: 'https://httpwg.org/specs/', url: 'https://httpwg.org/specs/', content: 'Specifications maintained by the HTTP Working Group.' });
    });

    it(`parses Parallel structured sources in ${sse ? 'SSE' : 'JSON'}`, async () => {
      const provider = new ParallelSearchProvider({}, mcpTransport({ structuredContent: PARALLEL }, sse));
      expect((await provider.search(QUERY))[0].content).toContain('\nRequest and response');
    });
  }

  for (const build of [ExaSearchProvider, ParallelSearchProvider]) {
    it(`${build.name} rejects a plain answer without source records`, async () => {
      const provider = new build({}, mcpTransport({ content: [{ type: 'text', text: 'The answer is 42.' }] }));
      await expect(provider.search(QUERY)).rejects.toMatchObject({ code: 'parse_failed' });
    });

    it(`${build.name} rejects isError and missing matching response IDs`, async () => {
      const provider = new build({}, mcpTransport({ isError: true, content: [{ type: 'text', text: 'tool unavailable' }] }));
      await expect(provider.search(QUERY)).rejects.toMatchObject({ code: 'upstream_unavailable' });
      const mismatched = new build({}, async () => 'data: {"jsonrpc":"2.0","id":"wrong","result":{"results":[]}}\n\n');
      await expect(mismatched.search(QUERY)).rejects.toMatchObject({ code: 'parse_failed' });
    });
  }

  it('redacts JSONRPC errors without logging payloads or keys', async () => {
    const provider = new ExaSearchProvider({}, async (request) => {
      const body = request.jsonBody as { id: string };
      return JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32603, message: 'Authorization: Bearer secret-value https://upstream.test?apiKey=secret-value' } });
    });
    await expect(provider.search(QUERY)).rejects.toMatchObject({ code: 'upstream_unavailable', message: expect.not.stringContaining('secret-value') });
  });

  it('accepts explicitly empty source arrays but rejects malformed or sourceless records', async () => {
    for (const payload of [{ structuredContent: { results: [] } }, { content: [{ type: 'text', text: '{"results":[]}' }] }]) {
      expect(await new ParallelSearchProvider({}, mcpTransport(payload)).search(QUERY)).toEqual([]);
    }
    for (const payload of [{ structuredContent: { results: 'wrong' } }, { structuredContent: { results: [{ title: 'answer' }] } }, { structuredContent: { results: [{ title: 'bad', url: 'javascript:alert(1)' }] } }]) {
      await expect(new ParallelSearchProvider({}, mcpTransport(payload)).search(QUERY)).rejects.toMatchObject({ code: 'parse_failed' });
    }
  });
});

describe('Firecrawl application failures and shape drift', () => {
  it('rejects success:false and redacts upstream error text', async () => {
    const provider = new FirecrawlSearchProvider({ apiKey: 'private-key' }, async () => ({ success: false, error: 'invalid private-key', data: { web: [] } }));
    await expect(provider.search(QUERY)).rejects.toMatchObject({ code: 'upstream_unavailable', message: expect.not.stringContaining('private-key') });
  });

  it('distinguishes an empty web result from a missing web array', async () => {
    expect(await new FirecrawlSearchProvider({}, async () => ({ success: true, data: { web: [] } })).search(QUERY)).toEqual([]);
    for (const payload of [{ success: true, data: [] }, { success: true, data: { images: [] } }, { answer: 'not sources' }]) {
      await expect(new FirecrawlSearchProvider({}, async () => payload).search(QUERY)).rejects.toMatchObject({ code: 'parse_failed' });
    }
  });
});

describe('text response transport safety', () => {
  it('bounds MCP bodies by bytes just like JSON', async () => {
    const transport = createSearchApiTransport({ env: {}, fetch: async () => new Response('x'.repeat(API_RESPONSE_BYTES + 1)) });
    await expect(new ExaSearchProvider({}, transport).search(QUERY)).rejects.toMatchObject({ code: 'upstream_unavailable', details: { stage: 'body-cap' } });
  });

  it('cancels an SSE body that never closes at its deadline', async () => {
    let cancelled = false;
    const transport = createSearchApiTransport({ env: {}, fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
    await expect(new ExaSearchProvider({}, transport).search(QUERY, { timeout: 5 })).rejects.toMatchObject({ code: 'timeout' });
    expect(cancelled).toBe(true);
  });

  it('preserves caller cancellation while an SSE stream is open', async () => {
    const controller = new AbortController();
    const transport = createSearchApiTransport({ env: {}, fetch: async () => {
      queueMicrotask(() => controller.abort());
      return new Response(new ReadableStream());
    } });
    await expect(new ExaSearchProvider({}, transport).search(QUERY, { signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
  });
});
