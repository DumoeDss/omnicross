/**
 * Wire-contract and failure-behavior tests for the four ported API adapters.
 *
 * The request-construction assertions are the port's proof of fidelity: method,
 * URL, headers and body are compared against the hash-verified Elftia
 * originals. Response mapping runs against the committed fixtures in
 * `packages/core/test-fixtures/api-search/`. Plain Node process — no Elftia, no
 * Electron, no network.
 *
 * @module search/api/__tests__/providers.test
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { isSearchProviderError, type SearchProviderError } from '@omnicross/contracts/search-types';
import { describe, expect, it } from 'vitest';

import { JinaReaderClient } from '../JinaReaderClient';
import { JinaSearchProvider, JINA_DEFAULT_HOST } from '../JinaSearchProvider';
import { SearxngSearchProvider } from '../SearxngSearchProvider';
import { TavilySearchProvider, TAVILY_DEFAULT_HOST } from '../TavilySearchProvider';
import { createSearchApiTransport } from '../transport';
import type { SearchApiFetch } from '../types';
import {
  normalizeZhipuApiUrl,
  ZhipuSearchProvider,
  ZAI_PROVIDER_ID,
  ZHIPU_PROVIDER_ID,
} from '../ZhipuSearchProvider';

const FIXTURES = new URL('../../../../test-fixtures/api-search/', import.meta.url);

/** The one public query every fixture was written against (see the README). */
const QUERY = 'mozilla developer network http headers';

function fixture(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, FIXTURES)), 'utf8');
}

interface Captured {
  url: string;
  init: RequestInit;
}

/** A recording fetch that answers every request with one canned response. */
function harness(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): { calls: Captured[]; fetchImpl: SearchApiFetch } {
  const calls: Captured[] = [];
  const fetchImpl: SearchApiFetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { calls, fetchImpl };
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

function headersOf(call: Captured): Record<string, string> {
  return call.init.headers as Record<string, string>;
}

function bodyOf(call: Captured): Record<string, unknown> {
  return JSON.parse(call.init.body as string) as Record<string, unknown>;
}

async function failureOf(promise: Promise<unknown>): Promise<SearchProviderError> {
  try {
    await promise;
  } catch (error) {
    if (!isSearchProviderError(error)) throw error;
    return error as SearchProviderError;
  }
  throw new Error('expected the search to fail, but it resolved');
}

type Transport = ReturnType<typeof createSearchApiTransport>;

/** Adapter builders, so every table can construct against a test transport. */
const buildTavily = (transport?: Transport): TavilySearchProvider =>
  new TavilySearchProvider({ apiKey: 'k' }, transport);
const buildJina = (transport?: Transport): JinaSearchProvider =>
  new JinaSearchProvider({ apiKey: 'k' }, transport);
const buildSearxng = (transport?: Transport): SearxngSearchProvider =>
  new SearxngSearchProvider({ apiHost: 'https://searx.example.test' }, transport);
const buildZhipu = (transport?: Transport): ZhipuSearchProvider =>
  new ZhipuSearchProvider(ZHIPU_PROVIDER_ID, { apiKey: 'k' }, transport);

/** A fetch that never settles until its signal aborts. */
const hangingFetch: SearchApiFetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    const signal = init.signal as AbortSignal | null | undefined;
    const abort = (): void => {
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
  });

describe('Tavily — request construction', () => {
  it('POSTs the baseline body to the default host, key in the BODY', async () => {
    const { calls, fetchImpl } = harness(() => jsonResponse(fixture('tavily/tavily-search-empty.synthetic.json')));
    const provider = new TavilySearchProvider(
      { apiKey: 'test-key' },
      createSearchApiTransport({ fetch: fetchImpl }),
    );

    await provider.search(QUERY);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${TAVILY_DEFAULT_HOST}/search`);
    expect(calls[0].init.method).toBe('POST');
    expect(headersOf(calls[0])).toEqual({ 'Content-Type': 'application/json' });
    expect(bodyOf(calls[0])).toEqual({
      api_key: 'test-key',
      query: QUERY,
      max_results: 5,
      search_depth: 'advanced',
      include_answer: false,
      include_raw_content: false,
    });
  });

  it('honors an apiHost override and the caller maxResults', async () => {
    const { calls, fetchImpl } = harness(() => jsonResponse(fixture('tavily/tavily-search-empty.synthetic.json')));
    const provider = new TavilySearchProvider(
      { apiKey: 'k', apiHost: 'https://tavily.example.test/v1' },
      createSearchApiTransport({ fetch: fetchImpl }),
    );

    await provider.search(QUERY, { maxResults: 3 });

    expect(calls[0].url).toBe('https://tavily.example.test/v1/search');
    expect(bodyOf(calls[0]).max_results).toBe(3);
  });

  it('rotates round-robin across comma-separated keys', async () => {
    const { calls, fetchImpl } = harness(() => jsonResponse(fixture('tavily/tavily-search-empty.synthetic.json')));
    const provider = new TavilySearchProvider(
      { apiKey: 'one,two' },
      createSearchApiTransport({ fetch: fetchImpl }),
    );

    await provider.search(QUERY);
    await provider.search(QUERY);
    await provider.search(QUERY);

    expect(calls.map((call) => bodyOf(call).api_key)).toEqual(['one', 'two', 'one']);
  });
});

describe('Jina — request construction', () => {
  it('GETs the encoded query with Accept and no auth when keyless', async () => {
    const { calls, fetchImpl } = harness(() => jsonResponse(fixture('jina/jina-search-empty.synthetic.json')));
    const provider = new JinaSearchProvider({}, createSearchApiTransport({ fetch: fetchImpl }));

    await provider.search(QUERY);

    expect(calls[0].url).toBe(`${JINA_DEFAULT_HOST}/${encodeURIComponent(QUERY)}`);
    expect(calls[0].init.method).toBe('GET');
    expect(headersOf(calls[0])).toEqual({ Accept: 'application/json' });
    expect(calls[0].init.body).toBeUndefined();
  });

  it('adds Bearer auth when a key is configured', async () => {
    const { calls, fetchImpl } = harness(() => jsonResponse(fixture('jina/jina-search-empty.synthetic.json')));
    const provider = new JinaSearchProvider(
      { apiKey: 'jina-key' },
      createSearchApiTransport({ fetch: fetchImpl }),
    );

    await provider.search(QUERY);
    expect(headersOf(calls[0]).Authorization).toBe('Bearer jina-key');
  });

  it('sends X-Engine: direct ONLY when page content is requested', async () => {
    const { calls, fetchImpl } = harness(() => jsonResponse(fixture('jina/jina-search-empty.synthetic.json')));
    const provider = new JinaSearchProvider({}, createSearchApiTransport({ fetch: fetchImpl }));

    await provider.search(QUERY);
    await provider.search(QUERY, { fetchPageContent: true });

    expect(headersOf(calls[0])['X-Engine']).toBeUndefined();
    expect(headersOf(calls[1])['X-Engine']).toBe('direct');
  });
});

describe('SearXNG — request construction', () => {
  const host = 'https://searx.example.test';

  it('GETs /search with the baseline query parameters', async () => {
    const { calls, fetchImpl } = harness(() => jsonResponse(fixture('searxng/searxng-search-empty.synthetic.json')));
    const provider = new SearxngSearchProvider(
      { apiHost: host },
      createSearchApiTransport({ fetch: fetchImpl }),
    );

    await provider.search(QUERY);

    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe(`${host}/search`);
    expect(url.searchParams.get('q')).toBe(QUERY);
    expect(url.searchParams.get('format')).toBe('json');
    expect(url.searchParams.get('pageno')).toBe('1');
    expect(headersOf(calls[0])).toEqual({ Accept: 'application/json' });
  });

  it('sends Basic auth only when BOTH credentials are present', async () => {
    const respond = (): Response => jsonResponse(fixture('searxng/searxng-search-empty.synthetic.json'));

    const both = harness(respond);
    await new SearxngSearchProvider(
      { apiHost: host, basicAuthUsername: 'user', basicAuthPassword: 'pass' },
      createSearchApiTransport({ fetch: both.fetchImpl }),
    ).search(QUERY);
    expect(headersOf(both.calls[0]).Authorization).toBe(
      `Basic ${Buffer.from('user:pass').toString('base64')}`,
    );

    for (const partial of [
      { basicAuthUsername: 'user' },
      { basicAuthPassword: 'pass' },
      {},
    ]) {
      const half = harness(respond);
      await new SearxngSearchProvider(
        { apiHost: host, ...partial },
        createSearchApiTransport({ fetch: half.fetchImpl }),
      ).search(QUERY);
      expect(headersOf(half.calls[0]).Authorization).toBeUndefined();
    }
  });

  it('never forwards its Basic credential to a cross-origin redirect target', async () => {
    // SearXNG is the likeliest victim of this: instances are commonly reached
    // over plain http on a private network, so a redirect can be injected by
    // anything on the path, and the Basic blob decodes straight back to the
    // operator's username and password.
    const { calls, fetchImpl } = harness((url) =>
      Promise.resolve(
        url.startsWith(host)
          ? new Response(null, {
              status: 302,
              headers: { location: 'https://collector.attacker.example/collect' },
            })
          : jsonResponse(fixture('searxng/searxng-search-empty.synthetic.json')),
      ),
    );

    await new SearxngSearchProvider(
      { apiHost: host, basicAuthUsername: 'operator', basicAuthPassword: 'hunter2' },
      createSearchApiTransport({ fetch: fetchImpl }),
    ).search(QUERY);

    expect(calls).toHaveLength(2);
    expect(headersOf(calls[0]).Authorization).toContain('Basic ');
    expect(headersOf(calls[1]).Authorization).toBeUndefined();
    expect(JSON.stringify(calls[1])).not.toContain(
      Buffer.from('operator:hunter2').toString('base64'),
    );
  });
});

describe('Zhipu / Z.AI — request construction', () => {
  it.each([
    [ZHIPU_PROVIDER_ID, 'https://open.bigmodel.cn/api/paas/v4/web_search'],
    [ZAI_PROVIDER_ID, 'https://api.z.ai/api/paas/v4/web_search'],
  ])('%s posts to its own default host', async (id, expectedUrl) => {
    const { calls, fetchImpl } = harness(() => jsonResponse(fixture('zhipu/zhipu-search-empty.synthetic.json')));
    const provider = new ZhipuSearchProvider(
      id,
      { apiKey: 'zk' },
      createSearchApiTransport({ fetch: fetchImpl }),
    );

    await provider.search(QUERY);

    expect(calls[0].url).toBe(expectedUrl);
    expect(calls[0].init.method).toBe('POST');
    expect(headersOf(calls[0])).toEqual({
      Authorization: 'Bearer zk',
      'Content-Type': 'application/json',
    });
    // The divergent default: 10, where every other adapter uses 5.
    expect(bodyOf(calls[0])).toEqual({
      search_query: QUERY,
      search_engine: 'search_pro',
      count: 10,
    });
  });

  it.each([
    ['https://api.z.ai/api/paas/v4/web_search', 'https://api.z.ai/api/paas/v4/web_search'],
    ['https://api.z.ai/api/paas/v4', 'https://api.z.ai/api/paas/v4/web_search'],
    ['https://api.z.ai/api/paas/v1', 'https://api.z.ai/api/paas/v1/web_search'],
    ['https://api.z.ai/api/paas', 'https://api.z.ai/api/paas/v4/web_search'],
    ['https://api.z.ai/api/paas/v4/', 'https://api.z.ai/api/paas/v4/web_search'],
    ['https://api.z.ai/api/paas/v4///', 'https://api.z.ai/api/paas/v4/web_search'],
    ['https://self.hosted.test', 'https://self.hosted.test/v4/web_search'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeZhipuApiUrl(input)).toBe(expected);
  });

  it('routes an apiHost override through the normalizer', async () => {
    const { calls, fetchImpl } = harness(() => jsonResponse(fixture('zhipu/zhipu-search-empty.synthetic.json')));
    await new ZhipuSearchProvider(
      ZHIPU_PROVIDER_ID,
      { apiKey: 'zk', apiHost: 'https://zhipu.example.test/api/paas' },
      createSearchApiTransport({ fetch: fetchImpl }),
    ).search(QUERY);

    expect(calls[0].url).toBe('https://zhipu.example.test/api/paas/v4/web_search');
  });
});

describe('Response mapping', () => {
  it('Tavily maps title/url/content and does not slice client-side', async () => {
    const { fetchImpl } = harness(() => jsonResponse(fixture('tavily/tavily-search-success.synthetic.json')));
    const results = await new TavilySearchProvider(
      { apiKey: 'k' },
      createSearchApiTransport({ fetch: fetchImpl }),
    ).search(QUERY, { maxResults: 2 });

    // The API honors `max_results`; the baseline maps whatever comes back.
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({
      title: 'HTTP headers - HTTP | MDN',
      url: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers',
      content:
        'HTTP headers let the client and the server pass additional information with a message in a request or response.',
    });
  });

  it('Jina falls back from content to description', async () => {
    const { fetchImpl } = harness(() => jsonResponse(fixture('jina/jina-search-success.synthetic.json')));
    const results = await new JinaSearchProvider(
      {},
      createSearchApiTransport({ fetch: fetchImpl }),
    ).search(QUERY);

    expect(results[0].content).toContain('HTTP headers let the client');
    expect(results[1].content).toBe('This item carries only a description, never a content field.');
    // An empty `content` also falls through to `description` — `||`, not `??`.
    expect(results[2].content).toBe('Content is present but empty, so the description is used instead.');
  });

  it('SearXNG maps a missing content field to an empty string', async () => {
    const { fetchImpl } = harness(() => jsonResponse(fixture('searxng/searxng-search-success.synthetic.json')));
    const results = await new SearxngSearchProvider(
      { apiHost: 'https://searx.example.test' },
      createSearchApiTransport({ fetch: fetchImpl }),
    ).search(QUERY);

    expect(results[1]).toEqual({
      title: 'HTTP Semantics (RFC 9110)',
      url: 'https://www.rfc-editor.org/rfc/rfc9110.html',
      content: '',
    });
  });

  it('Zhipu reads the URL from `link`, not `url`', async () => {
    const { fetchImpl } = harness(() => jsonResponse(fixture('zhipu/zhipu-search-success.synthetic.json')));
    const results = await new ZhipuSearchProvider(
      ZHIPU_PROVIDER_ID,
      { apiKey: 'zk' },
      createSearchApiTransport({ fetch: fetchImpl }),
    ).search(QUERY);

    expect(results[0].url).toBe('https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers');
    expect(results.every((result) => result.url !== '')).toBe(true);
  });

  it.each([
    ['tavily/tavily-search-empty.synthetic.json', buildTavily],
    ['jina/jina-search-empty.synthetic.json', buildJina],
    ['searxng/searxng-search-empty.synthetic.json', buildSearxng],
    ['zhipu/zhipu-search-empty.synthetic.json', buildZhipu],
  ])('%s is an authoritative empty result set, not a failure', async (file, build) => {
    const { fetchImpl } = harness(() => jsonResponse(fixture(file)));
    await expect(
      build(createSearchApiTransport({ fetch: fetchImpl })).search(QUERY),
    ).resolves.toEqual([]);
  });

  it('slices client-side for the three adapters that do', async () => {
    const many = (field: string, items: unknown[]): string => JSON.stringify({ [field]: items });
    const rows = Array.from({ length: 8 }, (_unused, index) => ({
      title: `t${index}`,
      url: `https://example.test/${index}`,
      link: `https://example.test/${index}`,
      content: 'c',
    }));

    const cases = [
      ['data', buildJina, 5],
      ['results', buildSearxng, 5],
      ['search_result', buildZhipu, 8],
    ] as const;

    for (const [field, build, expected] of cases) {
      const { fetchImpl } = harness(() => jsonResponse(many(field, rows)));
      const results = await build(createSearchApiTransport({ fetch: fetchImpl })).search(QUERY);
      // Zhipu's default of 10 leaves all 8 rows; the others cut to 5.
      expect(results).toHaveLength(expected);
    }
  });
});

describe('Pre-flight config_missing', () => {
  it.each([
    ['Tavily missing key', 'tavily', (t: Transport) => new TavilySearchProvider({ apiKey: '' }, t)],
    [
      'Tavily whitespace-only key',
      'tavily',
      (t: Transport) => new TavilySearchProvider({ apiKey: '  ,  ' }, t),
    ],
    [
      'Zhipu missing key',
      ZHIPU_PROVIDER_ID,
      (t: Transport) => new ZhipuSearchProvider(ZHIPU_PROVIDER_ID, { apiKey: '' }, t),
    ],
    [
      'Z.AI missing key',
      ZAI_PROVIDER_ID,
      (t: Transport) => new ZhipuSearchProvider(ZAI_PROVIDER_ID, { apiKey: '' }, t),
    ],
    [
      'SearXNG missing host',
      'searxng',
      (t: Transport) => new SearxngSearchProvider({ apiHost: '' }, t),
    ],
  ])('%s fails before any network IO', async (_name, expectedId, build) => {
    let called = false;
    const transport = createSearchApiTransport({
      fetch: () => {
        called = true;
        return Promise.resolve(jsonResponse('{}'));
      },
    });

    const error = await failureOf(build(transport).search(QUERY));
    expect(error.code).toBe('config_missing');
    expect(error.details?.stage).toBe('config');
    expect(error.providerId).toBe(expectedId);
    expect(called).toBe(false);
  });

  it('Jina has NO config_missing — keyless is a supported mode', async () => {
    const { fetchImpl } = harness(() => jsonResponse(fixture('jina/jina-search-empty.synthetic.json')));
    await expect(
      new JinaSearchProvider({}, createSearchApiTransport({ fetch: fetchImpl })).search(QUERY),
    ).resolves.toEqual([]);
  });
});

describe('Failure-injection matrix', () => {
  const adapters = [
    ['tavily', buildTavily],
    ['jina', buildJina],
    ['searxng', buildSearxng],
    ['zhipu', buildZhipu],
  ] as const;

  const statusCases = [
    [401, 'auth_failed'],
    [403, 'auth_failed'],
    [429, 'rate_limited'],
    [500, 'upstream_unavailable'],
  ] as const;

  for (const [id, build] of adapters) {
    it.each(statusCases)(`${id}: HTTP %i maps to %s`, async (status, code) => {
      const { fetchImpl } = harness(() => jsonResponse('{"error":"denied"}', status));
      const error = await failureOf(build(createSearchApiTransport({ fetch: fetchImpl })).search(QUERY));
      expect(error.code).toBe(code);
      expect(error.providerId).toBe(id);
      expect(error.details?.status).toBe(String(status));
    });

    it(`${id}: malformed JSON maps to parse_failed`, async () => {
      const { fetchImpl } = harness(() => jsonResponse('not json at all'));
      const error = await failureOf(build(createSearchApiTransport({ fetch: fetchImpl })).search(QUERY));
      expect(error.code).toBe('parse_failed');
      expect(error.providerId).toBe(id);
    });

    it(`${id}: a shape-mismatched body maps to parse_failed`, async () => {
      // Elftia tolerates this on three of the four adapters and returns an
      // empty-but-successful search; here a changed shape is drift, not
      // "nothing found". Recorded divergence for 阶段5.
      const { fetchImpl } = harness(() => jsonResponse('{"unexpected":{"shape":true}}'));
      const error = await failureOf(build(createSearchApiTransport({ fetch: fetchImpl })).search(QUERY));
      expect(error.code).toBe('parse_failed');
      expect(error.details?.stage).toBe('parse');
    });

    it(`${id}: a caller abort maps to cancelled`, async () => {
      const controller = new AbortController();
      const promise = build(createSearchApiTransport({ fetch: hangingFetch })).search(QUERY, {
        signal: controller.signal,
      });
      controller.abort();
      const error = await failureOf(promise);
      expect(error.code).toBe('cancelled');
      expect(error.providerId).toBe(id);
    });

    it(`${id}: an expired deadline maps to timeout`, async () => {
      const error = await failureOf(
        build(createSearchApiTransport({ fetch: hangingFetch })).search(QUERY, { timeout: 10 }),
      );
      expect(error.code).toBe('timeout');
      expect(error.providerId).toBe(id);
    });
  }
});

describe('Jina reader client', () => {
  const URL_TO_READ = 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers';

  it('GETs the encoded URL on the fixed reader host', async () => {
    const { calls, fetchImpl } = harness(() => jsonResponse(fixture('jina/jina-reader-success.synthetic.json')));
    const result = await new JinaReaderClient(
      { apiKey: 'reader-key' },
      createSearchApiTransport({ fetch: fetchImpl }),
    ).readUrl(URL_TO_READ);

    expect(calls[0].url).toBe(`https://r.jina.ai/${encodeURIComponent(URL_TO_READ)}`);
    expect(calls[0].init.method).toBe('GET');
    expect(headersOf(calls[0])).toEqual({
      Accept: 'application/json',
      Authorization: 'Bearer reader-key',
    });
    expect(result).toEqual({
      url: URL_TO_READ,
      title: 'HTTP headers - HTTP | MDN',
      content: expect.stringContaining('HTTP headers let the client'),
    });
  });

  it('runs keyless without an Authorization header', async () => {
    const { calls, fetchImpl } = harness(() => jsonResponse(fixture('jina/jina-reader-success.synthetic.json')));
    await new JinaReaderClient({}, createSearchApiTransport({ fetch: fetchImpl })).readUrl(URL_TO_READ);
    expect(headersOf(calls[0]).Authorization).toBeUndefined();
  });

  it('falls back to top-level title/content and omits absent fields', async () => {
    const { fetchImpl } = harness(() =>
      jsonResponse('{"title":"Top level title","content":"Top level content"}'),
    );
    await expect(
      new JinaReaderClient({}, createSearchApiTransport({ fetch: fetchImpl })).readUrl(URL_TO_READ),
    ).resolves.toEqual({ url: URL_TO_READ, title: 'Top level title', content: 'Top level content' });

    const bare = harness(() => jsonResponse('{}'));
    await expect(
      new JinaReaderClient({}, createSearchApiTransport({ fetch: bare.fetchImpl })).readUrl(URL_TO_READ),
    ).resolves.toEqual({ url: URL_TO_READ });
  });

  it('THROWS taxonomy errors instead of the baseline in-band failure shape', async () => {
    const unauthorized = harness(() =>
      jsonResponse(fixture('jina/jina-error-unauthorized.synthetic.json'), 401),
    );
    const authError = await failureOf(
      new JinaReaderClient({ apiKey: 'k' }, createSearchApiTransport({ fetch: unauthorized.fetchImpl })).readUrl(
        URL_TO_READ,
      ),
    );
    expect(authError.code).toBe('auth_failed');
    expect(authError.providerId).toBe('jina');
    // No `{ success: false }` anywhere: the failure channel is the throw.
    expect(authError).toBeInstanceOf(Error);

    const timedOut = await failureOf(
      new JinaReaderClient({}, createSearchApiTransport({ fetch: hangingFetch })).readUrl(URL_TO_READ, {
        timeout: 10,
      }),
    );
    expect(timedOut.code).toBe('timeout');
  });
});
