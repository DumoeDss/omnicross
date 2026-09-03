/**
 * Fixture-driven regression tests for `http-bing` / `http-duckduckgo`.
 *
 * The committed captures in `packages/core/test-fixtures/http-search/` are the
 * regression spine: every parser behavior, every failure class, and the
 * three-way empty/parse-failure/challenge distinction is asserted against them
 * through the injected transport seam. Plain Node process — no Elftia, no
 * Electron, no network.
 *
 * @module search/http/__tests__/providers.test
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { isSearchProviderError, type SearchProviderError } from '@omnicross/contracts/search-types';
import { describe, expect, it } from 'vitest';

import { builtinHttpSearchContributions, HTTP_SEARCH_CAPABILITIES } from '../contributions';
import { clampMaxResults } from '../engine';
import { HttpBingProvider } from '../HttpBingProvider';
import { HttpDuckDuckGoProvider } from '../HttpDuckDuckGoProvider';
import { searchHttpError } from '../errors';
import type { SearchHttpRequest, SearchHttpResource, SearchHttpTransport } from '../types';

const FIXTURES = new URL('../../../../test-fixtures/http-search/', import.meta.url);

function fixture(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, FIXTURES)), 'utf8');
}

/** The queries the fixtures were captured with (fixture README, "Provenance"). */
const BING_NORMAL_QUERY = 'mozilla developer network http headers';
const HTTP_QUERY = 'hypertext transfer protocol';

const NON_SERP_PAGE =
  '<!DOCTYPE html><html><head><title>Example Domain</title></head>' +
  '<body><div><p>This domain is for use in illustrative examples.</p></div></body></html>';

interface PageStub {
  body: string;
  status?: number;
  finalUrl?: string;
}

interface RecordedAttempt {
  url: string;
  timeoutMs: number;
  maxResponseBytes: number;
}

interface StubTransport {
  transport: SearchHttpTransport;
  attempts: RecordedAttempt[];
}

/** Serve a page (or throw) per candidate URL, recording what was asked for. */
function stubTransport(handler: (url: string) => PageStub | Error): StubTransport {
  const attempts: RecordedAttempt[] = [];
  const transport: SearchHttpTransport = async (url, request: SearchHttpRequest) => {
    attempts.push({ url, timeoutMs: request.timeoutMs, maxResponseBytes: request.maxResponseBytes });
    if (request.signal?.aborted) {
      throw searchHttpError('cancelled', 'aborted', {
        stage: 'fetch',
        providerId: request.providerId,
      });
    }
    const page = handler(url);
    if (page instanceof Error) throw page;
    return {
      finalUrl: page.finalUrl ?? url,
      status: page.status ?? 200,
      contentType: 'text/html; charset=utf-8',
      rawText: page.body,
    } satisfies SearchHttpResource;
  };
  return { transport, attempts };
}

/** Always serve the same page, whatever the candidate URL. */
function servingAll(page: PageStub): StubTransport {
  return stubTransport(() => page);
}

/** The URL Bing geo-redirects to in the capture environment, carrying `q`. */
function bingFinalUrl(query: string): string {
  return `https://cn.bing.com/search?q=${encodeURIComponent(query)}`;
}

async function failureOf(promise: Promise<unknown>): Promise<SearchProviderError> {
  try {
    await promise;
  } catch (error) {
    if (!isSearchProviderError(error)) throw error;
    return error;
  }
  throw new Error('expected search() to reject, but it resolved');
}

describe('HttpBingProvider — extraction', () => {
  it('parses the captured trust-passing SERP, honoring the maxResults clamp', async () => {
    const { transport } = servingAll({
      body: fixture('bing/bing-serp-normal.html'),
      finalUrl: bingFinalUrl(BING_NORMAL_QUERY),
    });
    const provider = new HttpBingProvider(transport);

    const defaults = await provider.search(BING_NORMAL_QUERY);
    expect(defaults).toHaveLength(5);
    expect(defaults[0]).toEqual({
      title: 'Mozilla 产品 - Mozilla — Mozilla',
      url: 'https://www.mozilla.org/zh-CN/products/',
      content: expect.stringContaining('Mozilla'),
    });
    expect(defaults.every((result) => /^https:\/\//.test(result.url))).toBe(true);

    expect(await provider.search(BING_NORMAL_QUERY, { maxResults: 10 })).toHaveLength(10);
    // The clamp is [1, 10] with a default of 5.
    expect(await provider.search(BING_NORMAL_QUERY, { maxResults: 0 })).toHaveLength(1);
    expect(await provider.search(BING_NORMAL_QUERY, { maxResults: 500 })).toHaveLength(10);
  });

  it('unwraps /ck/a?u=a1<base64url> links and falls back on unusable payloads', async () => {
    const { transport } = servingAll({
      body: fixture('bing/bing-serp-ck-redirect.synthetic.html'),
      finalUrl: bingFinalUrl(HTTP_QUERY),
    });

    const results = await new HttpBingProvider(transport).search(HTTP_QUERY, { maxResults: 10 });

    expect(results.map((result) => result.url)).toEqual([
      'https://en.wikipedia.org/wiki/HTTP',
      'https://developer.mozilla.org/en-US/docs/Web/HTTP',
      'https://www.rfc-editor.org/rfc/rfc9110.html',
      // `u=b2…` — no `a1` prefix, so the absolute /ck/a href stands.
      'https://www.bing.com/ck/a?%21=&u=b2aHR0cHM6Ly9leGFtcGxlLm9yZy9ub3QtYTEtcHJlZml4ZWQ&ntb=1',
      // `u=a1…` decoding to a relative path — not http(s), same fallback.
      'https://www.bing.com/ck/a?%21=&u=a1L3JlbGF0aXZlL3BhdGgvb25seQ&ntb=1',
    ]);
    expect(results[0].title).toBe('Hypertext Transfer Protocol - Wikipedia');
  });
});

describe('HttpDuckDuckGoProvider — extraction', () => {
  it('parses the captured html layout and unwraps uddg redirects', async () => {
    const { transport, attempts } = servingAll({ body: fixture('duckduckgo/ddg-html-serp.html') });

    const results = await new HttpDuckDuckGoProvider(transport).search(HTTP_QUERY);

    expect(results).toHaveLength(5);
    expect(results[0]).toEqual({
      title: 'HTTP - Wikipedia',
      url: 'https://en.wikipedia.org/wiki/HTTP',
      content: expect.stringContaining('HTTP'),
    });
    // The html endpoint answered, so the lite endpoint is never touched.
    expect(attempts).toHaveLength(1);
    expect(attempts[0].url).toContain('html.duckduckgo.com');
  });

  it('falls back to the lite layout only when the html endpoint yields nothing', async () => {
    const { transport, attempts } = stubTransport((url) =>
      url.includes('lite.duckduckgo.com')
        ? { body: fixture('duckduckgo/ddg-lite-serp.html') }
        : { body: fixture('duckduckgo/ddg-html-serp-empty.synthetic.html') },
    );

    const results = await new HttpDuckDuckGoProvider(transport).search('weather forecast tomorrow');

    expect(attempts.map((attempt) => new URL(attempt.url).hostname)).toEqual([
      'html.duckduckgo.com',
      'lite.duckduckgo.com',
    ]);
    expect(results).toHaveLength(5);
    expect(results[0]).toEqual({
      title: 'Weather Tomorrow for Tokyo, Tokyo, Japan | AccuWeather',
      url: 'https://www.accuweather.com/en/jp/tokyo/226396/weather-tomorrow/226396',
      content: expect.any(String),
    });
  });

  it('splits the shared deadline evenly across the remaining candidates', async () => {
    const { transport, attempts } = servingAll({ body: NON_SERP_PAGE });

    await failureOf(new HttpDuckDuckGoProvider(transport).search(HTTP_QUERY, { timeout: 1000 }));

    expect(attempts).toHaveLength(2);
    // First of two candidates gets half the budget; the last one gets the rest.
    expect(attempts[0].timeoutMs).toBeGreaterThan(400);
    expect(attempts[0].timeoutMs).toBeLessThanOrEqual(500);
    expect(attempts[1].timeoutMs).toBeGreaterThan(attempts[0].timeoutMs);
    // The 2 MiB search-layer body cap, not the 5 MiB fetch-layer default.
    expect(attempts[0].maxResponseBytes).toBe(2 * 1024 * 1024);
  });
});

describe('three-way outcome distinction', () => {
  it('returns [] for a recognized SERP with zero organic results', async () => {
    const bing = servingAll({
      body: fixture('bing/bing-serp-empty.synthetic.html'),
      finalUrl: bingFinalUrl('zzqxwv nonexistent query string'),
    });
    await expect(
      new HttpBingProvider(bing.transport).search('zzqxwv nonexistent query string'),
    ).resolves.toEqual([]);

    const ddg = servingAll({ body: fixture('duckduckgo/ddg-html-serp-empty.synthetic.html') });
    await expect(
      new HttpDuckDuckGoProvider(ddg.transport).search('zzqxwv nonexistent query string'),
    ).resolves.toEqual([]);
    // Both candidates were spent looking before the empty answer was accepted.
    expect(ddg.attempts).toHaveLength(2);
  });

  it('throws parse_failed for a page that is not the engine’s SERP', async () => {
    for (const provider of [
      new HttpBingProvider(servingAll({ body: NON_SERP_PAGE }).transport),
      new HttpDuckDuckGoProvider(servingAll({ body: NON_SERP_PAGE }).transport),
    ]) {
      const error = await failureOf(provider.search(HTTP_QUERY));
      expect(error.code).toBe('parse_failed');
      expect(error.details?.stage).toBe('parse');
      expect(error.retryable).toBe(false);
    }
  });

  it('throws with stage "challenge" for the captured DuckDuckGo 202 shell', async () => {
    const { transport } = servingAll({
      body: fixture('duckduckgo/ddg-lite-challenge-202.html'),
      status: 202,
    });

    const error = await failureOf(new HttpDuckDuckGoProvider(transport).search(HTTP_QUERY));

    expect(error.code).toBe('upstream_unavailable');
    expect(error.details?.stage).toBe('challenge');
    expect(error.details?.status).toBe('202');
    // A challenge is not a rate-limit protocol: no retry-after, no quota, no key.
    expect(error.retryable).toBe(false);
  });

  it('throws with stage "trust" for the captured Bing decoy page', async () => {
    const { transport } = servingAll({
      body: fixture('bing/bing-serp-untrusted-decoy.html'),
      finalUrl: bingFinalUrl(HTTP_QUERY),
    });

    const error = await failureOf(new HttpBingProvider(transport).search(HTTP_QUERY));

    expect(error.code).toBe('upstream_unavailable');
    expect(error.details?.stage).toBe('trust');
    expect(error.message).toContain('zero query-term hits');
  });

  it('checks trust before deciding empty-vs-unrecognized', async () => {
    // The decoy page IS structurally a Bing SERP with parseable results; only
    // the trust check stands between it and a successful-looking answer.
    const { transport } = servingAll({
      body: fixture('bing/bing-serp-untrusted-decoy.html'),
      finalUrl: bingFinalUrl(HTTP_QUERY),
    });
    const error = await failureOf(new HttpBingProvider(transport).search(HTTP_QUERY));
    expect(error.details?.stage).not.toBe('parse');
  });
});

describe('cancellation, timeouts, and error identity', () => {
  it('surfaces caller aborts as cancelled without spending another candidate', async () => {
    const { transport, attempts } = servingAll({ body: fixture('duckduckgo/ddg-html-serp.html') });
    const controller = new AbortController();
    controller.abort();

    const error = await failureOf(
      new HttpDuckDuckGoProvider(transport).search(HTTP_QUERY, { signal: controller.signal }),
    );

    expect(error.code).toBe('cancelled');
    expect(attempts).toHaveLength(0);
  });

  it('propagates a transport timeout without retrying past the deadline', async () => {
    const { transport } = stubTransport(() =>
      searchHttpError('timeout', 'search request exceeded its budget', { stage: 'fetch' }),
    );

    const error = await failureOf(new HttpBingProvider(transport).search(HTTP_QUERY));

    expect(error.code).toBe('timeout');
  });

  it('stamps providerId, transport and stage on every failure', async () => {
    const cases: Array<[string, () => Promise<unknown>]> = [
      [
        'http-bing',
        () => new HttpBingProvider(servingAll({ body: NON_SERP_PAGE }).transport).search('x'),
      ],
      [
        'http-duckduckgo',
        () =>
          new HttpDuckDuckGoProvider(
            servingAll({ body: fixture('duckduckgo/ddg-lite-challenge-202.html'), status: 202 })
              .transport,
          ).search('x'),
      ],
      [
        'http-duckduckgo',
        () =>
          new HttpDuckDuckGoProvider(
            stubTransport(() => new Error('some injected transport blew up')).transport,
          ).search('x'),
      ],
    ];

    for (const [providerId, run] of cases) {
      const error = await failureOf(run());
      expect(error.providerId).toBe(providerId);
      expect(error.details?.transport).toBe('undici');
      expect(error.details?.stage).toBeDefined();
    }
  });

  it('clamps maxResults independently of any transport', () => {
    expect(clampMaxResults(undefined)).toBe(5);
    expect(clampMaxResults(0)).toBe(1);
    expect(clampMaxResults(-3)).toBe(1);
    expect(clampMaxResults(7)).toBe(7);
    expect(clampMaxResults(99)).toBe(10);
  });
});

describe('builtin contributions', () => {
  it('declares source, kind and capabilities explicitly, with no ordering hint', () => {
    const contributions = builtinHttpSearchContributions();

    expect(contributions.map((contribution) => contribution.id)).toEqual([
      'http-bing',
      'http-duckduckgo',
    ]);
    for (const contribution of contributions) {
      expect(contribution.source).toBe('builtin');
      expect(contribution.kind).toBe('http');
      expect(contribution.provider.id).toBe(contribution.id);
      expect(contribution.capabilities).toEqual({
        requiresApiKey: false,
        supportsRegion: false,
        supportsLanguage: false,
        supportsTimeRange: false,
        supportsUrlRead: false,
        supportsCancellation: true,
        maxResults: 10,
      });
      // Ordering is 阶段3's decision — the key must be ABSENT, not undefined.
      expect('priorityHint' in contribution).toBe(false);
      expect(contribution.provider.readUrl).toBeUndefined();
    }
    expect(HTTP_SEARCH_CAPABILITIES.requiresApiKey).toBe(false);
  });

  it('constructs standalone with zero configuration and routes an injected transport', async () => {
    expect(new HttpBingProvider().id).toBe('http-bing');
    expect(new HttpDuckDuckGoProvider().id).toBe('http-duckduckgo');

    const { transport, attempts } = servingAll({ body: fixture('duckduckgo/ddg-html-serp.html') });
    const [, duckduckgo] = builtinHttpSearchContributions(transport);
    await duckduckgo.provider.search(HTTP_QUERY);

    expect(attempts).toHaveLength(1);
  });

  it('honors the declared supportsCancellation capability', async () => {
    const { transport } = servingAll({ body: fixture('duckduckgo/ddg-html-serp.html') });
    const [bing] = builtinHttpSearchContributions(transport);
    expect(bing.capabilities.supportsCancellation).toBe(true);

    const error = await failureOf(bing.provider.search(HTTP_QUERY, { signal: AbortSignal.abort() }));
    expect(error.code).toBe('cancelled');
  });
});

describe('module boundaries', () => {
  it('imports no Elftia package and no Electron; impit+undici are the only clients', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const sources = readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((entry) => entry.endsWith('.ts') && !entry.includes('__tests__'))
      .map((entry) => readFileSync(`${root}/${entry}`, 'utf8'));
    expect(sources.length).toBeGreaterThan(8);

    // Every way a module can be pulled in — static, side-effect, dynamic, CJS.
    // Matching SPECIFIERS (not prose) keeps documentation free to name Electron
    // while explaining why it stays out.
    const specifierPatterns = [
      /(?:^|\s)(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]/gm,
      /(?:^|\s)import\s*['"]([^'"]+)['"]/gm,
      /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ];
    const allowedBareImports = new Set([
      '@omnicross/contracts/search-types',
      '@omnicross/contracts/account-tokens-types',
      'undici',
      // The browser-impersonating client (Elftia's verified transport), with
      // undici as the explicit fallback when its platform binary is missing —
      // the combination plan §阶段2 sanctions.
      'impit',
      'jsdom',
      'entities',
    ]);

    const specifiers = sources.flatMap((source) =>
      specifierPatterns.flatMap((pattern) => [...source.matchAll(pattern)].map((m) => m[1])),
    );
    // Guards against a silently non-matching regex passing this test vacuously.
    expect(specifiers.length).toBeGreaterThan(10);

    for (const specifier of specifiers) {
      expect(specifier).not.toMatch(/elftia|electron/i);
      if (specifier.startsWith('.')) continue;
      expect(allowedBareImports.has(specifier) || specifier.startsWith('node:')).toBe(true);
    }
  });
});
