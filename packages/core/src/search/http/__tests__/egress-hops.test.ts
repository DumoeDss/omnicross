/**
 * Egress validation on the HTTP slice's redirect walk (plan 阶段4 filling the
 * seam 阶段2 identified and deliberately left open).
 *
 * Deliberately a SEPARATE file: the 阶段2 suites — `transport.test.ts` and
 * `providers.test.ts` — must stay byte-identical, because "the existing fixture
 * suite passes unmodified" is the evidence that this change did not alter HTTP
 * search behavior. Everything new lives here.
 *
 * @module search/http/__tests__/egress-hops.test
 */

import { isSearchProviderError, type SearchProviderError } from '@omnicross/contracts/search-types';
import { describe, expect, it } from 'vitest';

import { createSearchHttpTransport } from '../transport';
import type { SearchHttpFetch } from '../types';

const REQUEST = { timeoutMs: 5_000, maxResponseBytes: 1024 * 1024, providerId: 'http-bing' };

const BING_URL = 'https://www.bing.com/search?q=test';

async function failureOf(promise: Promise<unknown>): Promise<SearchProviderError> {
  try {
    await promise;
  } catch (error) {
    if (!isSearchProviderError(error)) throw error;
    return error as SearchProviderError;
  }
  throw new Error('expected the transport call to fail, but it resolved');
}

function html(body: string): Response {
  return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

/** Record every URL the transport actually asks for. */
function recordingFetch(handler: SearchHttpFetch): { visited: string[]; fetchImpl: SearchHttpFetch } {
  const visited: string[] = [];
  return {
    visited,
    fetchImpl: (url, init) => {
      visited.push(url);
      return handler(url, init);
    },
  };
}

describe('redirect hops pass egress validation', () => {
  it.each([
    ['http://169.254.169.254/latest/meta-data', 'metadata'],
    ['http://127.0.0.1/admin', 'loopback'],
    ['http://10.0.0.5/internal', 'private'],
    ['http://[::1]/', 'loopback'],
    ['http://metadata.google.internal/computeMetadata/v1/', 'metadata'],
  ])('blocks a hop to %s before any request reaches it', async (target, egressClass) => {
    const { visited, fetchImpl } = recordingFetch(() => Promise.resolve(redirectTo(target)));
    const transport = createSearchHttpTransport({ fetch: fetchImpl });

    const error = await failureOf(transport(BING_URL, REQUEST));

    expect(error.code).toBe('policy_denied');
    expect(error.details?.egressClass).toBe(egressClass);
    expect(error.details?.stage).toBe('redirect');
    expect(error.details?.transport).toBe('undici');
    expect(error.providerId).toBe('http-bing');
    expect(error.retryable).toBe(false);
    // The denied host was never contacted.
    expect(visited).toEqual([BING_URL]);
  });

  it('names the denied hostname and nothing else', async () => {
    const { fetchImpl } = recordingFetch(() =>
      Promise.resolve(redirectTo('http://user:pw@169.254.169.254/latest/meta-data?q=secret')),
    );
    const error = await failureOf(createSearchHttpTransport({ fetch: fetchImpl })(BING_URL, REQUEST));

    const serialized = `${error.message} ${JSON.stringify(error.details)}`;
    expect(serialized).toContain('169.254.169.254');
    expect(serialized).not.toContain('pw');
    expect(serialized).not.toContain('secret');
  });

  it('refuses a denied INITIAL url without connecting', async () => {
    const { visited, fetchImpl } = recordingFetch(() => Promise.resolve(html('<html>ok</html>')));
    const error = await failureOf(
      createSearchHttpTransport({ fetch: fetchImpl })('http://192.168.1.1/search', REQUEST),
    );

    expect(error.code).toBe('policy_denied');
    expect(error.details?.stage).toBe('connect');
    expect(visited).toEqual([]);
  });

  it('follows public redirects exactly as before, including the geo-redirect', async () => {
    // `cn.bing.com` is the real redirect this environment sees on every Bing
    // request; it must keep passing untouched under the default policy.
    const { visited, fetchImpl } = recordingFetch((url) =>
      Promise.resolve(
        url.startsWith('https://www.bing.com')
          ? redirectTo('https://cn.bing.com/search?q=test')
          : html('<html><body>results</body></html>'),
      ),
    );

    const resource = await createSearchHttpTransport({ fetch: fetchImpl })(BING_URL, REQUEST);

    expect(visited).toEqual([BING_URL, 'https://cn.bing.com/search?q=test']);
    expect(resource.rawText).toContain('results');
  });

  it('honors an explicit allowlist on both the initial url and a hop', async () => {
    const { fetchImpl } = recordingFetch((url) =>
      Promise.resolve(
        url.includes('10.1.1.1') ? redirectTo('http://mirror.internal.test/page') : html('<html>ok</html>'),
      ),
    );
    const transport = createSearchHttpTransport({
      fetch: fetchImpl,
      egressPolicy: { allowedPrivateHosts: ['10.1.1.1'] },
    });

    await expect(transport('http://10.1.1.1/search', REQUEST)).resolves.toMatchObject({
      status: 200,
    });
  });
});
