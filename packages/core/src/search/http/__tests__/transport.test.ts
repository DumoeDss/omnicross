/**
 * Transport semantics for the HTTP search slice, driven through the injected
 * fetch seam — no network, no Elftia, no Electron.
 *
 * Covers the spec's failure classes: connect error, refused status, redirect
 * overflow, body cap, challenge page, plus the cancel-vs-deadline distinction
 * and the "details stay sanitized" rule.
 *
 * @module search/http/__tests__/transport.test
 */

import { isSearchProviderError, type SearchProviderError } from '@omnicross/contracts/search-types';
import type { Dispatcher } from 'undici';
import { describe, expect, it } from 'vitest';

import { SEARCH_BROWSER_HEADERS } from '../headers';
import { getSearchProxyDispatcher, resolveSearchProxySettings } from '../proxy';
import { createSearchHttpTransport, MAX_REDIRECTS, selectHttpDispatcher } from '../transport';
import { SEARCH_HTTP_TRANSPORT_ID, type SearchHttpFetch } from '../types';

const REQUEST = { timeoutMs: 5_000, maxResponseBytes: 1024 * 1024, providerId: 'http-bing' };

/** Capture the error a transport call throws, failing loudly if it succeeds. */
async function failureOf(promise: Promise<unknown>): Promise<SearchProviderError> {
  try {
    await promise;
  } catch (error) {
    if (!isSearchProviderError(error)) throw error;
    return error as SearchProviderError;
  }
  throw new Error('expected the transport call to fail, but it resolved');
}

function html(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
    ...init,
  });
}

/** A fetch that never settles until its signal aborts. */
const hangingFetch: SearchHttpFetch = (_url, init) =>
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

describe('search HTTP transport — success path', () => {
  it('sends the pinned browser header profile on every hop', async () => {
    const sent: Array<Record<string, string>> = [];
    const transport = createSearchHttpTransport({
      fetch: (url, init) => {
        sent.push(init.headers as Record<string, string>);
        return Promise.resolve(
          url.endsWith('/one')
            ? new Response(null, { status: 302, headers: { location: 'https://example.test/two' } })
            : html('<html><body>ok</body></html>'),
        );
      },
    });

    const resource = await transport('https://example.test/one', REQUEST);

    expect(sent).toHaveLength(2);
    for (const headers of sent) {
      expect(headers['User-Agent']).toBe(SEARCH_BROWSER_HEADERS['User-Agent']);
      expect(headers['User-Agent']).toContain('Chrome/144.0.0.0');
      expect(headers['Accept-Language']).toBe('en-US,en;q=0.9');
      expect(headers['Sec-Fetch-Mode']).toBe('navigate');
      // undici owns encoding negotiation and the decode; we must not claim it.
      expect(headers['Accept-Encoding']).toBeUndefined();
    }
    // Fewer-than-cap redirects are followed through to the final URL.
    expect(resource.finalUrl).toBe('https://example.test/two');
    expect(resource.status).toBe(200);
    expect(resource.rawText).toContain('ok');
  });

  it('releases each redirect hop’s body instead of leaving it to GC', async () => {
    // A redirect body is never read; leaving it unconsumed pins the undici
    // connection until finalization.
    let cancelledHops = 0;
    const transport = createSearchHttpTransport({
      fetch: (url) =>
        Promise.resolve(
          url.endsWith('/hop')
            ? html('<html>final</html>')
            : new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(new Uint8Array([1, 2, 3]));
                  },
                  cancel() {
                    cancelledHops += 1;
                  },
                }),
                { status: 302, headers: { location: 'https://example.test/hop' } },
              ),
        ),
    });

    await transport('https://example.test/start', REQUEST);

    expect(cancelledHops).toBe(1);
  });

  it('returns a 3xx without a Location header as the final response', async () => {
    const transport = createSearchHttpTransport({
      // A redirect the server never completed: there is nowhere to follow to,
      // so this response IS the answer rather than a redirect-cap failure.
      fetch: () => Promise.resolve(html('<html>no location</html>', { status: 302 })),
    });

    const resource = await transport('https://example.test/', REQUEST);

    expect(resource.status).toBe(302);
    expect(resource.finalUrl).toBe('https://example.test/');
    expect(resource.rawText).toContain('no location');
  });

  it('decodes a non-UTF-8 body using the declared charset', async () => {
    // "abc" in windows-1252 with a byte (0xE9 = é) that is invalid UTF-8.
    const bytes = new Uint8Array([0x61, 0xe9, 0x63]);
    const transport = createSearchHttpTransport({
      fetch: () =>
        Promise.resolve(
          new Response(bytes, { headers: { 'content-type': 'text/html; charset=windows-1252' } }),
        ),
    });

    const resource = await transport('https://example.test/', REQUEST);

    expect(resource.rawText).toBe('aéc');
  });

  it('falls back to a <meta> charset when the header declares none', async () => {
    // The header path is covered above; this is the prolog-sniffing path, which
    // is what actually saves a GBK/Shift-JIS page from decoding to U+FFFD.
    const prolog = '<html><head><meta charset="windows-1252"></head><body>a';
    const bytes = Uint8Array.from([
      ...Buffer.from(prolog, 'latin1'),
      0xe9,
      ...Buffer.from('c</body></html>', 'latin1'),
    ]);
    const transport = createSearchHttpTransport({
      fetch: () => Promise.resolve(new Response(bytes, { headers: { 'content-type': 'text/html' } })),
    });

    const resource = await transport('https://example.test/', REQUEST);

    expect(resource.rawText).toContain('aéc');
  });
});

describe('search HTTP transport — failure taxonomy', () => {
  it('fails with stage "redirect" beyond the hop cap', async () => {
    let hops = 0;
    const transport = createSearchHttpTransport({
      fetch: () => {
        hops += 1;
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: 'https://example.test/next' } }),
        );
      },
    });

    const error = await failureOf(transport('https://example.test/', REQUEST));

    expect(error.code).toBe('upstream_unavailable');
    expect(error.details?.stage).toBe('redirect');
    expect(error.details?.transport).toBe(SEARCH_HTTP_TRANSPORT_ID);
    expect(error.retryable).toBe(false);
    expect(hops).toBe(MAX_REDIRECTS + 1);
  });

  it('fails with stage "body-cap" and stops reading mid-stream', async () => {
    const chunk = new Uint8Array(64);
    let chunksPulled = 0;
    let cancelled = false;
    const transport = createSearchHttpTransport({
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                chunksPulled += 1;
                controller.enqueue(chunk);
              },
              cancel() {
                cancelled = true;
              },
            }),
          ),
        ),
    });

    const error = await failureOf(
      transport('https://example.test/', { ...REQUEST, maxResponseBytes: 128 }),
    );

    expect(error.code).toBe('upstream_unavailable');
    expect(error.details?.stage).toBe('body-cap');
    expect(error.details?.maxResponseBytes).toBe('128');
    expect(cancelled).toBe(true);
    // 128-byte cap over 64-byte chunks: the third chunk trips it, nothing more.
    expect(chunksPulled).toBeLessThanOrEqual(4);
  });

  it('fails with stage "connect" when the request never produces a response', async () => {
    const transport = createSearchHttpTransport({
      fetch: () => {
        const cause = new Error('getaddrinfo ENOTFOUND example.test');
        (cause as Error & { code?: string }).code = 'ENOTFOUND';
        return Promise.reject(Object.assign(new Error('fetch failed'), { cause }));
      },
    });

    const error = await failureOf(transport('https://example.test/', REQUEST));

    expect(error.code).toBe('upstream_unavailable');
    expect(error.details?.stage).toBe('connect');
    expect(error.message).toBe('network request failed (ENOTFOUND)');
    expect(error.retryable).toBe(true);
  });

  it('fails with stage "fetch" on a refused status, without inventing rate_limited', async () => {
    for (const status of [401, 403, 407, 429]) {
      const transport = createSearchHttpTransport({
        fetch: () => Promise.resolve(html('<html><body>nope</body></html>', { status })),
      });

      const error = await failureOf(transport('https://example.test/', REQUEST));

      expect(error.code).toBe('upstream_unavailable');
      expect(error.details?.stage).toBe('fetch');
      expect(error.details?.status).toBe(String(status));
    }
  });

  it('fails with stage "challenge" on a bot-challenge shell', async () => {
    const transport = createSearchHttpTransport({
      fetch: () =>
        Promise.resolve(
          html('<html><head><title>Just a moment...</title></head><body></body></html>'),
        ),
    });

    const error = await failureOf(transport('https://example.test/', REQUEST));

    expect(error.code).toBe('upstream_unavailable');
    expect(error.details?.stage).toBe('challenge');
    expect(error.retryable).toBe(false);
  });

  it('separates cancellation from the deadline', async () => {
    const transport = createSearchHttpTransport({ fetch: hangingFetch });

    const controller = new AbortController();
    const cancelled = failureOf(
      transport('https://example.test/', { ...REQUEST, signal: controller.signal }),
    );
    controller.abort();
    expect((await cancelled).code).toBe('cancelled');
    expect((await cancelled).retryable).toBe(false);

    const timedOut = await failureOf(transport('https://example.test/', { ...REQUEST, timeoutMs: 20 }));
    expect(timedOut.code).toBe('timeout');
    expect(timedOut.retryable).toBe(true);
  });

  it('reports an already-aborted signal as cancelled, never as a timeout', async () => {
    const transport = createSearchHttpTransport({ fetch: hangingFetch });
    const error = await failureOf(
      transport('https://example.test/', { ...REQUEST, signal: AbortSignal.abort() }),
    );

    expect(error.code).toBe('cancelled');
  });
});

describe('search HTTP transport — observability and sanitization', () => {
  it('stamps transport and stage on every failure class', async () => {
    const cases: Array<[string, SearchHttpFetch]> = [
      ['connect', () => Promise.reject(new Error('fetch failed'))],
      ['fetch', () => Promise.resolve(html('x', { status: 403 }))],
      [
        'redirect',
        () =>
          Promise.resolve(
            new Response(null, { status: 301, headers: { location: 'https://example.test/loop' } }),
          ),
      ],
      ['challenge', () => Promise.resolve(html('<html><title>Access denied</title></html>'))],
    ];

    for (const [stage, fetchImpl] of cases) {
      const error = await failureOf(
        createSearchHttpTransport({ fetch: fetchImpl })('https://example.test/', REQUEST),
      );
      expect(error.details?.transport).toBe('undici');
      expect(error.details?.stage).toBe(stage);
      expect(error.providerId).toBe('http-bing');
    }
  });

  it('never leaks the proxy URL, its credentials, or request headers into a failure', async () => {
    const transport = createSearchHttpTransport({
      fetch: () => Promise.reject(new Error('fetch failed')),
      env: {
        http_proxy: 'http://proxy-user:sup3r-secret@proxy.internal:8080',
        https_proxy: 'http://proxy-user:sup3r-secret@proxy.internal:8080',
        no_proxy: 'localhost',
      },
    });

    const error = await failureOf(transport('https://user:pw@example.test/search?q=private', REQUEST));
    const serialized = `${error.message} ${JSON.stringify(error.details)}`;

    for (const secret of ['sup3r-secret', 'proxy-user', 'proxy.internal', 'pw', 'q=private']) {
      expect(serialized).not.toContain(secret);
    }
    // Hostname only — never the path or query, which carry the user's search.
    expect(error.details?.host).toBe('example.test');
    expect(serialized).not.toContain('User-Agent');
  });

  it('reuses one dispatcher per proxy signature and rebuilds it when that changes', () => {
    const settings = { httpProxy: 'http://cache.test:1', httpsProxy: 'http://cache.test:1' };

    const first = getSearchProxyDispatcher(settings);
    // A structurally equal but distinct object must still hit the cache: the
    // key is the settings signature, not object identity.
    expect(getSearchProxyDispatcher({ ...settings })).toBe(first);
    expect(getSearchProxyDispatcher({ ...settings, noProxy: 'localhost' })).not.toBe(first);
  });

  it('puts the layered override ahead of the env proxy, consulted with the exact URL', () => {
    const sentinel = { sentinel: true } as unknown as Dispatcher;
    const seenUrls: string[] = [];
    const override = (url: string): Dispatcher | undefined => {
      seenUrls.push(url);
      return url === 'https://html.duckduckgo.com/html/' ? sentinel : undefined;
    };

    // Both vars set: with only HTTPS_PROXY the settings lack `httpProxy`, and
    // undici's EnvHttpProxyAgent would then read THIS process's real env for
    // the http half — a leak of the runner's machine into the fixture.
    const env = { HTTPS_PROXY: 'http://env.test:1', HTTP_PROXY: 'http://env.test:1' };

    // The override wins even when the env layer would also configure a proxy.
    expect(
      selectHttpDispatcher(env, 'https://html.duckduckgo.com/html/', override),
    ).toBe(sentinel);
    // A target the override declines falls back to the env layer…
    expect(selectHttpDispatcher(env, 'https://other.test/', override)).toBe(
      getSearchProxyDispatcher({ httpProxy: 'http://env.test:1', httpsProxy: 'http://env.test:1' }),
    );
    // …and to nothing at all when no layer applies.
    expect(selectHttpDispatcher({}, 'https://other.test/', override)).toBeUndefined();
    expect(seenUrls).toEqual([
      'https://html.duckduckgo.com/html/',
      'https://other.test/',
      'https://other.test/',
    ]);
  });

  it('resolves proxy environment variables in either case, preferring the specific over all_proxy', () => {
    expect(resolveSearchProxySettings({})).toBeUndefined();
    expect(resolveSearchProxySettings({ ALL_PROXY: '  ' })).toBeUndefined();
    expect(
      resolveSearchProxySettings({
        all_proxy: 'http://all.test:1',
        HTTPS_PROXY: 'http://https.test:2',
        NO_PROXY: 'localhost,.internal',
      }),
    ).toEqual({
      httpProxy: 'http://all.test:1',
      httpsProxy: 'http://https.test:2',
      noProxy: 'localhost,.internal',
    });
  });
});
