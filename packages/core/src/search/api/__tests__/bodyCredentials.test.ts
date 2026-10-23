import { describe, expect, it } from 'vitest';

import { TavilySearchProvider } from '../TavilySearchProvider';
import { createSearchApiTransport } from '../transport';

const SUCCESS = { results: [{ title: 'Source', url: 'https://source.example/article', content: 'A source excerpt.' }] };

describe('body credential redirect boundaries', () => {
  for (const status of [307, 308]) {
    for (const key of ['tavily-body-secret', 'quoted"body\\secret\nvalue']) {
      it(`blocks Tavily ${status} cross-origin forwarding of ${key.includes('"') ? 'JSON-escaped' : 'plain'} keys`, async () => {
        const calls: { url: string; init: RequestInit }[] = [];
        const transport = createSearchApiTransport({ env: {}, fetch: async (url, init) => {
          calls.push({ url, init });
          if (calls.length === 1) return new Response(null, { status, headers: { location: 'https://collector.example/search' } });
          return new Response(JSON.stringify(SUCCESS));
        } });
        const provider = new TavilySearchProvider({ apiKey: key }, transport);
        await expect(provider.search('public topic')).rejects.toMatchObject({
          code: 'policy_denied',
          retryable: false,
          message: 'Tavily refused a cross-origin redirect carrying body credentials',
          details: { stage: 'redirect' },
        });
        expect(calls).toHaveLength(1);
        expect(JSON.parse(calls[0].init.body as string)).toHaveProperty('api_key', key);
      });
    }

    it(`blocks Tavily ${status} body credentials on an HTTPS-to-HTTP downgrade`, async () => {
      let calls = 0;
      const transport = createSearchApiTransport({ env: {}, fetch: async () => {
        calls += 1;
        return new Response(null, { status, headers: { location: 'http://api.tavily.com/search' } });
      } });
      await expect(new TavilySearchProvider({ apiKey: 'tavily-body-secret' }, transport).search('public topic')).rejects.toMatchObject({ code: 'policy_denied' });
      expect(calls).toBe(1);
    });

    it(`preserves Tavily ${status} body credentials only across same-origin redirects`, async () => {
      const calls: { url: string; init: RequestInit }[] = [];
      const transport = createSearchApiTransport({ env: {}, fetch: async (url, init) => {
        calls.push({ url, init });
        if (calls.length === 1) return new Response(null, { status, headers: { location: '/search-next' } });
        return new Response(JSON.stringify(SUCCESS));
      } });
      expect(await new TavilySearchProvider({ apiKey: 'tavily-body-secret' }, transport).search('public topic')).toEqual(SUCCESS.results);
      expect(calls).toHaveLength(2);
      expect(calls[1].init.method).toBe('POST');
      expect(calls[1].init.body).toBe(calls[0].init.body);
    });
  }

  for (const status of [301, 302, 303]) {
    it(`allows Tavily ${status} cross-origin redirects only after dropping the body`, async () => {
      const calls: { url: string; init: RequestInit }[] = [];
      const transport = createSearchApiTransport({ env: {}, fetch: async (url, init) => {
        calls.push({ url, init });
        if (calls.length === 1) return new Response(null, { status, headers: { location: 'https://collector.example/search' } });
        return new Response(JSON.stringify(SUCCESS));
      } });
      expect(await new TavilySearchProvider({ apiKey: 'tavily-body-secret' }, transport).search('public topic')).toEqual(SUCCESS.results);
      expect(calls).toHaveLength(2);
      expect(calls[1].init.method).toBe('GET');
      expect(calls[1].init.body).toBeUndefined();
      expect(new Headers(calls[1].init.headers).has('content-type')).toBe(false);
    });
  }
});
