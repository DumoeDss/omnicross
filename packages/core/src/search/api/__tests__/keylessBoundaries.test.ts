import type { SearchProvider } from '@omnicross/contracts/search-types';
import { describe, expect, it } from 'vitest';

import { BraveSearchProvider } from '../BraveSearchProvider';
import { ExaSearchProvider } from '../ExaSearchProvider';
import { FirecrawlSearchProvider } from '../FirecrawlSearchProvider';
import { ParallelSearchProvider } from '../ParallelSearchProvider';
import { TinyfishSearchProvider } from '../TinyfishSearchProvider';
import { createSearchApiTransport } from '../transport';
import type { KeylessSearchProviderConfig, SearchApiTransport } from '../types';

const SOURCE = { title: 'Allowed source', url: 'https://allowed.example/article' };
const credentialAdapters: {
  id: string;
  header: string;
  payload: unknown;
  build: (transport: SearchApiTransport) => SearchProvider;
}[] = [
  { id: 'brave', header: 'x-subscription-token', payload: { web: { results: [SOURCE] } }, build: (transport) => new BraveSearchProvider({ apiKey: 'sensitive-key' }, transport) },
  { id: 'exa', header: 'x-api-key', payload: { results: [SOURCE] }, build: (transport) => new ExaSearchProvider({ apiKey: 'sensitive-key' }, transport) },
  { id: 'parallel', header: 'x-api-key', payload: { results: [SOURCE] }, build: (transport) => new ParallelSearchProvider({ apiKey: 'sensitive-key' }, transport) },
  { id: 'tinyfish', header: 'x-api-key', payload: { results: [SOURCE] }, build: (transport) => new TinyfishSearchProvider({ apiKey: 'sensitive-key' }, transport) },
  { id: 'firecrawl', header: 'authorization', payload: { success: true, data: { web: [SOURCE] } }, build: (transport) => new FirecrawlSearchProvider({ apiKey: 'sensitive-key' }, transport) },
];

describe('adapter credentials at redirect boundaries', () => {
  for (const adapter of credentialAdapters) {
    for (const boundary of ['cross-origin', 'https-downgrade'] as const) {
      it(`${adapter.id} permanently strips ${adapter.header} after ${boundary}`, async () => {
        const calls: { url: string; headers: Headers }[] = [];
        let initialUrl = '';
        const transport = createSearchApiTransport({ env: {}, fetch: async (url, init) => {
          calls.push({ url, headers: new Headers(init.headers) });
          if (calls.length === 1) {
            initialUrl = url;
            const target = boundary === 'cross-origin'
              ? 'https://collector.example/redirected'
              : url.replace(/^https:/, 'http:');
            return new Response(null, { status: 307, headers: { location: target } });
          }
          if (calls.length === 2) return new Response(null, { status: 307, headers: { location: initialUrl } });
          return new Response(JSON.stringify(adapter.payload), { headers: { 'content-type': 'application/json' } });
        } });
        expect(await adapter.build(transport).search('public topic', { maxResults: 1 })).toHaveLength(1);
        expect(calls).toHaveLength(3);
        expect(calls[0].headers.get(adapter.header)).toContain('sensitive-key');
        expect(calls[1].headers.get(adapter.header)).toBeNull();
        expect(calls[2].url).toBe(initialUrl);
        expect(calls[2].headers.get(adapter.header)).toBeNull();
      });
    }
  }

  it('retains provider credentials across same-origin redirects', async () => {
    const credentials: (string | null)[] = [];
    const transport = createSearchApiTransport({ env: {}, fetch: async (_url, init) => {
      credentials.push(new Headers(init.headers).get('x-api-key'));
      if (credentials.length === 1) return new Response(null, { status: 307, headers: { location: '/search-next' } });
      return new Response(JSON.stringify({ results: [SOURCE] }));
    } });
    await new ExaSearchProvider({ apiKey: 'sensitive-key' }, transport).search('public topic');
    expect(credentials).toEqual(['sensitive-key', 'sensitive-key']);
  });
});

const keylessAdapters: {
  id: string;
  build: (config: KeylessSearchProviderConfig, transport: SearchApiTransport) => SearchProvider;
}[] = [
  { id: 'exa', build: (config, transport) => new ExaSearchProvider(config, transport) },
  { id: 'parallel', build: (config, transport) => new ParallelSearchProvider(config, transport) },
  { id: 'firecrawl', build: (config, transport) => new FirecrawlSearchProvider(config, transport) },
];

describe('keyless hard exclusions are authoritative in both modes', () => {
  for (const adapter of keylessAdapters) {
    for (const mode of ['public', 'api'] as const) {
      const config = { authMode: mode, apiKey: 'stored-key' };
      function transportFor(items: unknown[]): SearchApiTransport {
        return createSearchApiTransport({ env: {}, fetch: async (_url, init) => {
          if (adapter.id === 'firecrawl') return new Response(JSON.stringify({ success: true, data: { web: items } }));
          const payload = { results: items };
          if (mode === 'api') return new Response(JSON.stringify(payload));
          const request = JSON.parse(init.body as string) as { id: string };
          return new Response(`data: ${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { structuredContent: payload } })}\n\n`);
        } });
      }

      it(`${adapter.id}/${mode} excludes exact and child domains before slicing`, async () => {
        const items = [
          { title: 'Blocked', url: 'https://blocked.example/article' },
          { title: 'Blocked child', url: 'https://docs.blocked.example/article' },
          SOURCE,
          { title: 'Unrelated suffix', url: 'https://notblocked.example/article' },
        ];
        const results = await adapter.build(config, transportFor(items)).search('topic -site:blocked.example', { maxResults: 1 });
        expect(results).toEqual([{ ...SOURCE, content: '' }]);
        const unbounded = await adapter.build(config, transportFor(items)).search('topic -site:blocked.example');
        expect(unbounded.map((source) => source.url)).toEqual([SOURCE.url, 'https://notblocked.example/article']);
      });

      it(`${adapter.id}/${mode} allows valid-but-all-excluded empty results without hiding invalid-only shapes`, async () => {
        const excluded = [{ title: 'Blocked', url: 'https://blocked.example/article' }];
        expect(await adapter.build(config, transportFor(excluded)).search('topic -site:blocked.example')).toEqual([]);
        const invalid = [{ title: 'Missing source URL' }];
        await expect(adapter.build(config, transportFor(invalid)).search('topic -site:blocked.example')).rejects.toMatchObject({ code: 'parse_failed' });
      });

      it(`${adapter.id}/${mode} filters canonical IDNA and terminal-dot variants`, async () => {
        const items = [{ title: 'Blocked international domain', url: 'https://docs.xn--bcher-kva.example./article' }, SOURCE];
        const results = await adapter.build(config, transportFor(items)).search('topic -site:bücher.example');
        expect(results.map((source) => source.url)).toEqual([SOURCE.url]);
      });
    }
  }
});
