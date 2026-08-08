/**
 * fetchPort.test.ts — timeout behavior of the token-endpoint POST helpers.
 *
 * A token exchange that never gets a response (proxy hung on the CONNECT, route
 * black-holed, a server that accepts the TCP connection then goes silent) must
 * fail fast with a clear error instead of leaving the OAuth flow `pending` until
 * the caller's outer session TTL. The mock below honors `init.signal` the way
 * the real `fetch` does, so the AbortController-based timeout actually fires.
 */
import { describe, expect, it, vi } from 'vitest';

import type { FetchLike } from '../fetchPort';
import { postForm, postJson } from '../fetchPort';

/**
 * A FetchLike that NEVER resolves on its own but rejects as soon as its
 * `init.signal` aborts — mirroring real `fetch` semantics. Without honoring the
 * signal the abort would be a no-op and the test would hang forever.
 */
function hangingFetch(): FetchLike {
  return vi.fn((_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init.signal;
      if (!signal) return;
      if (signal.aborted) reject(signal.reason ?? new Error('Aborted'));
      else signal.addEventListener('abort', () => reject(signal.reason ?? new Error('Aborted')), { once: true });
    }),
  );
}

describe('token-endpoint timeout (postForm / postJson)', () => {
  it('postForm rejects with a timeout error when the endpoint never responds', async () => {
    await expect(
      postForm(hangingFetch(), 'https://token.test/token', new URLSearchParams({ a: '1' }), 'parse fail', 50),
    ).rejects.toThrow(/timed out/i);
  });

  it('postJson rejects with a timeout error when the endpoint never responds', async () => {
    await expect(
      postJson(hangingFetch(), 'https://token.test/token', { a: '1' }, 'parse fail', {}, 50),
    ).rejects.toThrow(/timed out/i);
  });

  it('a non-timeout fetch error is rethrown unchanged', async () => {
    const failing: FetchLike = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(
      postForm(failing, 'https://token.test/token', new URLSearchParams({ a: '1' }), 'parse fail', 1000),
    ).rejects.toThrow('ECONNREFUSED');
  });

  it('the timeout does not trip when the endpoint answers in time', async () => {
    const ok: FetchLike = vi.fn(async () => new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), {
      headers: { 'Content-Type': 'application/json' },
    }));
    const out = await postForm(ok, 'https://token.test/token', new URLSearchParams({ a: '1' }), 'parse fail', 5000);
    expect(out.access_token).toBe('at');
  });
});
