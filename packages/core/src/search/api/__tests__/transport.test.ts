/**
 * Shared API transport semantics, driven through the injected fetch seam — no
 * network, no Elftia, no Electron.
 *
 * Covers the status matrix, the manual redirect walk and its per-hop egress
 * validation, the cancel-vs-deadline distinction, and the redaction that stands
 * between Tavily's body-borne API key and a log file.
 *
 * @module search/api/__tests__/transport.test
 */

import { isSearchProviderError, type SearchProviderError } from '@omnicross/contracts/search-types';
import { describe, expect, it } from 'vitest';

import type { Dispatcher } from 'undici';

import { ApiKeyRotator } from '../rotator';
import {
  API_MAX_REDIRECTS,
  apiConfigMissing,
  createSearchApiTransport,
  requireResultArray,
  sanitizeUpstreamText,
  selectApiDispatcher,
} from '../transport';
import { SEARCH_API_TRANSPORT_ID, type SearchApiFetch, type SearchApiRequest } from '../types';

const REQUEST: SearchApiRequest = {
  url: 'https://api.example-search.test/search',
  method: 'GET',
  providerId: 'tavily',
  label: 'Tavily',
  timeoutMs: 5_000,
};

async function failureOf(promise: Promise<unknown>): Promise<SearchProviderError> {
  try {
    await promise;
  } catch (error) {
    if (!isSearchProviderError(error)) throw error;
    return error as SearchProviderError;
  }
  throw new Error('expected the transport call to fail, but it resolved');
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

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

describe('API transport — success path', () => {
  it('returns the parsed JSON payload and sends only the declared headers', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const transport = createSearchApiTransport({
      fetch: (url, init) => {
        seen.push({ url, init });
        return Promise.resolve(json({ results: [{ title: 't' }] }));
      },
    });

    const payload = await transport({
      ...REQUEST,
      method: 'POST',
      headers: { Accept: 'application/json' },
      jsonBody: { query: 'q', max_results: 5 },
    });

    expect(payload).toEqual({ results: [{ title: 't' }] });
    expect(seen).toHaveLength(1);
    expect(seen[0].init.method).toBe('POST');
    expect(seen[0].init.body).toBe(JSON.stringify({ query: 'q', max_results: 5 }));
    // Content-Type comes from the transport (it serialized the body); nothing
    // else is injected, so an adapter's header set is exactly what ships.
    expect(seen[0].init.headers).toEqual({
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
    expect(seen[0].init.redirect).toBe('manual');
  });

  it('sends no Content-Type when there is no body', async () => {
    let headers: Record<string, string> = {};
    const transport = createSearchApiTransport({
      fetch: (_url, init) => {
        headers = init.headers as Record<string, string>;
        return Promise.resolve(json({ data: [] }));
      },
    });

    await transport(REQUEST);
    expect(headers['Content-Type']).toBeUndefined();
  });
});

describe('API transport — status matrix', () => {
  const CASES: Array<[number, string, boolean]> = [
    [401, 'auth_failed', false],
    [403, 'auth_failed', false],
    [429, 'rate_limited', true],
    [500, 'upstream_unavailable', true],
    [503, 'upstream_unavailable', true],
    [400, 'upstream_unavailable', false],
  ];

  it.each(CASES)('maps HTTP %i to %s', async (status, code, retryable) => {
    const transport = createSearchApiTransport({
      fetch: () => Promise.resolve(json({ error: 'nope' }, { status })),
    });

    const error = await failureOf(transport(REQUEST));
    expect(error.code).toBe(code);
    expect(error.retryable).toBe(retryable);
    expect(error.providerId).toBe('tavily');
    expect(error.details?.status).toBe(String(status));
    expect(error.details?.transport).toBe(SEARCH_API_TRANSPORT_ID);
    expect(error.details?.stage).toBe('fetch');
    expect(error.details?.host).toBe('api.example-search.test');
  });

  it('fails a non-JSON success body as parse_failed', async () => {
    const transport = createSearchApiTransport({
      fetch: () => Promise.resolve(json('<html>maintenance</html>')),
    });

    const error = await failureOf(transport(REQUEST));
    expect(error.code).toBe('parse_failed');
    expect(error.details?.stage).toBe('parse');
  });

  it('classifies a connect-layer throw by its errno only', async () => {
    const transport = createSearchApiTransport({
      fetch: () =>
        Promise.reject(
          new TypeError('fetch failed', {
            cause: Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }),
          }),
        ),
    });

    const error = await failureOf(transport(REQUEST));
    expect(error.code).toBe('upstream_unavailable');
    expect(error.details?.stage).toBe('connect');
    expect(error.message).toBe('Tavily request failed (ENOTFOUND)');
  });

  it('fails an oversized body instead of parsing a fragment', async () => {
    const transport = createSearchApiTransport({
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              pull(controller) {
                controller.enqueue(new Uint8Array(512 * 1024));
              },
            }),
          ),
        ),
    });

    const error = await failureOf(transport(REQUEST));
    expect(error.code).toBe('upstream_unavailable');
    expect(error.details?.stage).toBe('body-cap');
  });
});

describe('API transport — redirect walk with per-hop egress validation', () => {
  it('follows public redirects within the cap', async () => {
    const visited: string[] = [];
    const transport = createSearchApiTransport({
      fetch: (url) => {
        visited.push(url);
        return Promise.resolve(
          url.endsWith('/one')
            ? redirect('https://api.example-search.test/two')
            : json({ results: [] }),
        );
      },
    });

    await transport({ ...REQUEST, url: 'https://api.example-search.test/one' });
    expect(visited).toEqual([
      'https://api.example-search.test/one',
      'https://api.example-search.test/two',
    ]);
  });

  it.each([
    ['http://169.254.169.254/', 'metadata'],
    ['http://127.0.0.1/admin', 'loopback'],
    ['http://10.0.0.9/internal', 'private'],
  ])('blocks a redirect to %s BEFORE any request reaches it', async (target, egressClass) => {
    const visited: string[] = [];
    const transport = createSearchApiTransport({
      fetch: (url) => {
        visited.push(url);
        return Promise.resolve(redirect(target));
      },
    });

    const error = await failureOf(transport(REQUEST));
    expect(error.code).toBe('policy_denied');
    expect(error.details?.egressClass).toBe(egressClass);
    // The denied host was never contacted — only the original URL was fetched.
    expect(visited).toEqual([REQUEST.url]);
  });

  it('stamps transport and stage=egress on a denial, on both the initial url and a hop', async () => {
    // Without this the denial reaches `doctor search` as
    // `transport=unknown, stage=unknown`, which is exactly the observability
    // plan §11.4 asks for and the one failure a reader most needs to place.
    const initial = await failureOf(
      createSearchApiTransport({ fetch: () => Promise.resolve(json({})) })({
        ...REQUEST,
        url: 'http://127.0.0.1/search',
      }),
    );
    expect(initial.details?.stage).toBe('egress');
    expect(initial.details?.transport).toBe(SEARCH_API_TRANSPORT_ID);
    expect(initial.details?.host).toBe('127.0.0.1');
    expect(initial.details?.egressClass).toBe('loopback');

    const hop = await failureOf(
      createSearchApiTransport({
        fetch: () => Promise.resolve(redirect('http://169.254.169.254/')),
      })(REQUEST),
    );
    expect(hop.details?.stage).toBe('egress');
    expect(hop.details?.transport).toBe(SEARCH_API_TRANSPORT_ID);
    expect(hop.details?.host).toBe('169.254.169.254');
  });

  it('refuses the initial URL before constructing any request', async () => {
    let called = false;
    const transport = createSearchApiTransport({
      fetch: () => {
        called = true;
        return Promise.resolve(json({}));
      },
    });

    const error = await failureOf(transport({ ...REQUEST, url: 'http://192.168.0.10/search' }));
    expect(error.code).toBe('policy_denied');
    expect(error.providerId).toBe('tavily');
    expect(called).toBe(false);
  });

  it('admits an allowlisted internal host on every hop', async () => {
    const transport = createSearchApiTransport({
      egressPolicy: { allowedPrivateHosts: ['192.168.0.10', 'searx.internal.corp'] },
      fetch: (url) =>
        Promise.resolve(
          url.includes('192.168.0.10') ? redirect('http://searx.internal.corp/s') : json({ results: [] }),
        ),
    });

    await expect(
      transport({ ...REQUEST, url: 'http://192.168.0.10/search', providerId: 'searxng' }),
    ).resolves.toEqual({ results: [] });
  });

  it(`stops after ${API_MAX_REDIRECTS} hops`, async () => {
    let hop = 0;
    const transport = createSearchApiTransport({
      fetch: () => {
        hop += 1;
        return Promise.resolve(redirect(`https://api.example-search.test/hop-${hop}`));
      },
    });

    const error = await failureOf(transport(REQUEST));
    expect(error.code).toBe('upstream_unavailable');
    expect(error.details?.stage).toBe('redirect');
    expect(error.details?.maxRedirects).toBe(String(API_MAX_REDIRECTS));
  });

  it('downgrades POST to GET on 302/303 and preserves it on 307', async () => {
    const methods: Array<string | undefined> = [];
    const bodies: Array<unknown> = [];
    const build = (status: number): SearchApiFetch => {
      let first = true;
      return (_url, init) => {
        methods.push(init.method);
        bodies.push(init.body);
        if (first) {
          first = false;
          return Promise.resolve(redirect('https://api.example-search.test/next', status));
        }
        return Promise.resolve(json({ results: [] }));
      };
    };

    for (const [status, expected] of [
      [302, 'GET'],
      [303, 'GET'],
      [307, 'POST'],
    ] as const) {
      methods.length = 0;
      bodies.length = 0;
      const transport = createSearchApiTransport({ fetch: build(status) });
      await transport({ ...REQUEST, method: 'POST', jsonBody: { query: 'q' } });
      expect(methods).toEqual(['POST', expected]);
      // A downgraded hop must not keep carrying the JSON body.
      expect(bodies[1]).toBe(expected === 'GET' ? undefined : JSON.stringify({ query: 'q' }));
    }
  });

  it('keeps credentials on a SAME-origin hop', async () => {
    const sent: Array<Record<string, string>> = [];
    const transport = createSearchApiTransport({
      fetch: (url, init) => {
        sent.push(init.headers as Record<string, string>);
        return Promise.resolve(
          url.endsWith('/one') ? redirect('https://api.example-search.test/two') : json({ results: [] }),
        );
      },
    });

    await transport({
      ...REQUEST,
      url: 'https://api.example-search.test/one',
      headers: { Authorization: 'Bearer keep-me' },
    });

    expect(sent).toHaveLength(2);
    expect(sent[1].Authorization).toBe('Bearer keep-me');
  });

  it.each([
    ['Authorization', 'Bearer leak-me'],
    ['Authorization', 'Basic dXNlcjpwYXNz'],
    ['Cookie', 'session=leak-me'],
    ['Proxy-Authorization', 'Basic cHJveHk6cHc='],
    ['authorization', 'Bearer lowercase-header'],
  ])('drops %s across a CROSS-origin hop', async (header, value) => {
    // The half of `redirect: 'follow'` the manual walk silently dropped. A
    // hostile — or, over plain http, merely MITM'd — upstream answers
    // `302 Location: https://collector.attacker.example/`, which passes egress
    // validation because it is an ordinary public host. Without stripping, the
    // next request hands it the provider's credential.
    const sent: Array<Record<string, string>> = [];
    const transport = createSearchApiTransport({
      fetch: (url, init) => {
        sent.push(init.headers as Record<string, string>);
        return Promise.resolve(
          url.startsWith('https://api.example-search.test')
            ? redirect('https://collector.attacker.example/collect')
            : json({ results: [] }),
        );
      },
    });

    await transport({ ...REQUEST, headers: { [header]: value } });

    expect(sent).toHaveLength(2);
    const forwarded = JSON.stringify(sent[1]);
    expect(forwarded).not.toContain(value);
    expect(forwarded).not.toContain('leak-me');
    // Non-credential headers still travel, so the walk stays usable.
    expect(sent[0][header]).toBe(value);
  });

  it('does NOT restore a credential when a later hop returns to the origin', async () => {
    // Matches the fetch standard: removal is from the request, permanently —
    // an attacker who can bounce a request out and back must not get the
    // header reinstated.
    const sent: Array<Record<string, string>> = [];
    let hop = 0;
    const transport = createSearchApiTransport({
      fetch: (_url, init) => {
        sent.push(init.headers as Record<string, string>);
        hop += 1;
        if (hop === 1) return Promise.resolve(redirect('https://elsewhere.example/step'));
        if (hop === 2) return Promise.resolve(redirect('https://api.example-search.test/back'));
        return Promise.resolve(json({ results: [] }));
      },
    });

    await transport({ ...REQUEST, headers: { Authorization: 'Bearer round-trip' } });

    expect(sent).toHaveLength(3);
    expect(sent[0].Authorization).toBe('Bearer round-trip');
    expect(sent[1].Authorization).toBeUndefined();
    expect(sent[2].Authorization).toBeUndefined();
  });

  it('treats a port or scheme change as cross-origin', async () => {
    const sent: Array<Record<string, string>> = [];
    const transport = createSearchApiTransport({
      fetch: (url, init) => {
        sent.push(init.headers as Record<string, string>);
        return Promise.resolve(
          url === 'https://api.example-search.test/search'
            ? redirect('https://api.example-search.test:8443/search')
            : json({ results: [] }),
        );
      },
    });

    await transport({ ...REQUEST, headers: { Authorization: 'Bearer port-change' } });
    expect(sent[1].Authorization).toBeUndefined();
  });

  it('ends the walk on a 3xx without a location, then rejects the status', async () => {
    // The walk has nowhere to go, so the 302 becomes the final response — and a
    // redirect is not a usable JSON payload, so the status check refuses it
    // rather than handing an adapter a body it would fail to parse anyway.
    const transport = createSearchApiTransport({
      fetch: () => Promise.resolve(json({ results: [] }, { status: 302 })),
    });

    const error = await failureOf(transport(REQUEST));
    expect(error.code).toBe('upstream_unavailable');
    expect(error.details?.status).toBe('302');
  });
});

describe('API transport — cancellation and deadline', () => {
  it('maps a caller abort to cancelled', async () => {
    const controller = new AbortController();
    const transport = createSearchApiTransport({ fetch: hangingFetch });
    const promise = transport({ ...REQUEST, signal: controller.signal });
    controller.abort();

    const error = await failureOf(promise);
    expect(error.code).toBe('cancelled');
    expect(error.retryable).toBe(false);
  });

  it('maps an expired deadline to timeout, never to cancelled', async () => {
    const transport = createSearchApiTransport({ fetch: hangingFetch });
    const error = await failureOf(transport({ ...REQUEST, timeoutMs: 10 }));
    expect(error.code).toBe('timeout');
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('10ms');
  });

  it('fails immediately when the caller signal is already aborted', async () => {
    const error = await failureOf(
      createSearchApiTransport({ fetch: hangingFetch })({
        ...REQUEST,
        signal: AbortSignal.abort(),
      }),
    );
    expect(error.code).toBe('cancelled');
  });

  it('reports a blocked hop as policy_denied even when the caller also aborted', async () => {
    // A denial is a statement about what we refused to do; cancellation must
    // not erase the only record that an SSRF attempt was stopped.
    const controller = new AbortController();
    const transport = createSearchApiTransport({
      fetch: () => {
        controller.abort();
        return Promise.resolve(redirect('http://169.254.169.254/'));
      },
    });

    const error = await failureOf(transport({ ...REQUEST, signal: controller.signal }));
    expect(error.code).toBe('policy_denied');
  });
});

describe('API transport — redaction', () => {
  const KEY = 'tvly-SECRETKEY-0123456789abcdef';

  it('never lets a body-echoed API key reach a message or details', async () => {
    // The Tavily failure mode this exists for: the key travels in the request
    // body, and a 4xx that quotes the request would hand it to every log.
    const transport = createSearchApiTransport({
      fetch: () =>
        Promise.resolve(
          json(
            {
              detail: `invalid request: {"api_key":"${KEY}","query":"who am i"}`,
              echoed: `Authorization: Bearer ${KEY}`,
            },
            { status: 400 },
          ),
        ),
    });

    const error = await failureOf(
      transport({
        ...REQUEST,
        method: 'POST',
        jsonBody: { api_key: KEY, query: 'who am i' },
        secrets: [KEY],
      }),
    );

    const serialized = `${error.message} ${JSON.stringify(error.details)}`;
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain('SECRETKEY');
    expect(serialized).toContain('[redacted]');
    expect(error.details?.status).toBe('400');
  });

  it('redacts every configured key, not only the one this request rotated onto', async () => {
    const rotator = new ApiKeyRotator();
    const configured = 'key-one-aaaa,key-two-bbbb,key-three-cccc';
    const transport = createSearchApiTransport({
      fetch: () => Promise.resolve(json(`rejected keys: ${configured}`, { status: 401 })),
    });

    const error = await failureOf(
      transport({ ...REQUEST, secrets: rotator.allKeys(configured) }),
    );
    for (const key of rotator.allKeys(configured)) {
      expect(error.message).not.toContain(key);
    }
  });

  it('sanitizes credential-shaped JSON fields even for values it was never told about', () => {
    const text = '{"api_key":"never-configured-abc","password":"hunter2","note":"ok"}';
    const sanitized = sanitizeUpstreamText(text);
    expect(sanitized).not.toContain('never-configured-abc');
    expect(sanitized).not.toContain('hunter2');
    expect(sanitized).toContain('ok');
  });

  it('sanitizes those fields when the echo is an ESCAPED JSON string', () => {
    // An API reporting "here is the request I received" serializes it, so every
    // quote arrives escaped. Found by the leak gate: a SearXNG error quoting a
    // Tavily request carries a key that is not in SearXNG's own secret list, so
    // this pattern is the only thing that can redact it.
    const text = '{"received_request":"{\\"api_key\\":\\"foreign-key-xyz\\",\\"query\\":\\"q\\"}"}';
    const sanitized = sanitizeUpstreamText(text);
    expect(sanitized).not.toContain('foreign-key-xyz');
    expect(sanitized).toContain('[redacted]');
    // The surrounding structure survives, so the diagnostic stays useful.
    expect(sanitized).toContain('received_request');
  });

  it('redacts URLs, collapses whitespace, and caps length after redacting', () => {
    const secret = 'abc123';
    const long = `${'x'.repeat(400)} https://api.test/?key=${secret}\n\n  spaced`;
    const sanitized = sanitizeUpstreamText(long, [secret]);

    expect(sanitized).not.toContain(secret);
    expect(sanitized).not.toContain('https://');
    expect(sanitized.length).toBeLessThanOrEqual(301);
    // Capping AFTER redaction is what stops the cap from bisecting a secret and
    // leaving half of it behind.
    expect(sanitized.startsWith('xxx')).toBe(true);
  });

  it('redacts a percent-encoded echo of the key', () => {
    const secret = 'key/with+chars=';
    expect(sanitizeUpstreamText(`sent ${encodeURIComponent(secret)} ok`, [secret])).not.toContain(
      encodeURIComponent(secret),
    );
  });

  it('handles empty and undefined secrets without mangling the text', () => {
    expect(sanitizeUpstreamText('plain message', [undefined, ''])).toBe('plain message');
    expect(sanitizeUpstreamText('')).toBe('');
  });
});

describe('API transport — payload helpers', () => {
  it('requireResultArray accepts a present-but-empty array', () => {
    expect(requireResultArray({ results: [] }, 'results', 'tavily', 'Tavily')).toEqual([]);
  });

  it.each([[{}], [{ results: null }], [{ results: 'nope' }], [null], ['text']])(
    'requireResultArray fails %j as parse_failed',
    (payload) => {
      try {
        requireResultArray(payload, 'results', 'tavily', 'Tavily');
        throw new Error('expected parse_failed');
      } catch (error) {
        expect(isSearchProviderError(error)).toBe(true);
        expect((error as SearchProviderError).code).toBe('parse_failed');
        expect((error as SearchProviderError).details?.stage).toBe('parse');
      }
    },
  );

  it('apiConfigMissing is a pre-flight config failure', () => {
    const error = apiConfigMissing('searxng', 'Searxng API host is required');
    expect(error.code).toBe('config_missing');
    expect(error.retryable).toBe(false);
    expect(error.details?.stage).toBe('config');
  });
});

describe('API transport — dispatcher precedence', () => {
  it('uses the egress-guarded dispatcher on a direct connection', () => {
    const direct = selectApiDispatcher({});
    expect(direct.proxied).toBe(false);
    expect(direct.dispatcher).toBeDefined();
  });

  it('yields to the proxy dispatcher, giving up address validation by design', () => {
    // The documented limitation, asserted rather than discovered: a proxy
    // resolves DNS itself, so the guarded lookup cannot run. URL-level and
    // per-hop validation still apply — that is what the redirect tests cover.
    const proxied = selectApiDispatcher({ HTTPS_PROXY: 'http://proxy.test:8080' });
    expect(proxied.proxied).toBe(true);
    expect(proxied.dispatcher).not.toBe(selectApiDispatcher({}).dispatcher);
  });

  it('ranks the layered override above the env proxy and above the guarded direct path', () => {
    const sentinel = { sentinel: true } as unknown as Dispatcher;
    const seenUrls: string[] = [];
    const override = (url: string): Dispatcher | undefined => {
      seenUrls.push(url);
      return url === 'https://api.tavily.test/search' ? sentinel : undefined;
    };

    expect(
      selectApiDispatcher({ HTTPS_PROXY: 'http://env.test:1' }, undefined, {
        url: 'https://api.tavily.test/search',
        resolveProxyDispatcher: override,
      }),
    ).toEqual({ dispatcher: sentinel, proxied: true });
    // A target the override declines keeps the pre-existing behavior: env
    // proxy if set, guarded dispatcher otherwise.
    expect(
      selectApiDispatcher({}, undefined, { url: 'https://other.test/', resolveProxyDispatcher: override }),
    ).toEqual(selectApiDispatcher({}));
    expect(seenUrls).toEqual(['https://api.tavily.test/search', 'https://other.test/']);
  });
});

describe('ApiKeyRotator', () => {
  it('returns a single key as-is without rotating', () => {
    const rotator = new ApiKeyRotator();
    expect(rotator.pick('only-key')).toBe('only-key');
    expect(rotator.pick('only-key')).toBe('only-key');
    expect(rotator.countKeys('only-key')).toBe(1);
  });

  it('round-robins across comma-separated keys and wraps', () => {
    const rotator = new ApiKeyRotator();
    const keys = 'a,b,c';
    expect([rotator.pick(keys), rotator.pick(keys), rotator.pick(keys), rotator.pick(keys)]).toEqual(
      ['a', 'b', 'c', 'a'],
    );
  });

  it('wraps defensively when the configured list shrinks', () => {
    const rotator = new ApiKeyRotator();
    rotator.pick('a,b,c');
    rotator.pick('a,b,c');
    expect(rotator.pick('a,b')).toBe('a');
  });

  it('returns an empty string for empty, whitespace, and undefined input', () => {
    const rotator = new ApiKeyRotator();
    for (const raw of [undefined, '', '   ', ',,', ' , ']) {
      expect(rotator.pick(raw)).toBe('');
      expect(rotator.countKeys(raw)).toBe(0);
    }
  });

  it('trims surrounding whitespace and drops empty entries', () => {
    const rotator = new ApiKeyRotator();
    expect(rotator.allKeys(' a , ,b ')).toEqual(['a', 'b']);
  });

  it('reset returns to the first key', () => {
    const rotator = new ApiKeyRotator();
    rotator.pick('a,b');
    rotator.reset();
    expect(rotator.pick('a,b')).toBe('a');
  });
});
