/**
 * upstreamFetch tests (upstream-proxy) — the core egress seam.
 *
 * Covers the zero-regression fast path (no resolver / resolver-undefined ⇒ bare
 * fetch, no dispatcher), dispatcher attachment for http/https + socks5, the
 * per-proxy dispatcher cache, and the generation-bump invalidation (old
 * dispatcher disposed). Global `fetch` is stubbed so we assert on the `init` the
 * helper hands it WITHOUT any network.
 *
 * Also covers the debug trace's credential carve-out: an OAuth token exchange /
 * refresh (ctx `redactBodies`) is TRACED — so a failing login is diagnosable —
 * but neither body reaches the file, while relay traffic keeps its verbatim
 * capture.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetUpstreamProxyForTests,
  bumpUpstreamProxyGeneration,
  fetchUpstream,
  resolveUpstreamDispatcher,
  setUpstreamProxyResolver,
} from '../upstreamFetch';
import {
  __resetUpstreamTraceForTests,
  REDACTED_BODY,
  setUpstreamTracePath,
} from '../upstreamTrace';

/** The `dispatcher` the helper attaches (undici-specific, absent from DOM lib). */
function dispatcherOf(init: RequestInit | undefined): unknown {
  return (init as { dispatcher?: unknown } | undefined)?.dispatcher;
}

describe('fetchUpstream', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    __resetUpstreamProxyForTests();
    fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    __resetUpstreamProxyForTests();
    vi.unstubAllGlobals();
  });

  it('is a BARE fetch when no resolver is registered (zero regression)', async () => {
    await fetchUpstream('https://api.example.com', { method: 'POST' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(dispatcherOf(fetchMock.mock.calls[0]?.[1])).toBeUndefined();
  });

  it('is a BARE fetch when the resolver returns undefined', async () => {
    setUpstreamProxyResolver(() => undefined);
    await fetchUpstream('https://api.example.com', { method: 'POST' });
    expect(dispatcherOf(fetchMock.mock.calls[0]?.[1])).toBeUndefined();
  });

  it('attaches a dispatcher for an http proxy', async () => {
    setUpstreamProxyResolver(() => ({ type: 'http', host: '127.0.0.1', port: 8080 }));
    await fetchUpstream('https://api.example.com', { method: 'POST' });
    expect(dispatcherOf(fetchMock.mock.calls[0]?.[1])).toBeDefined();
  });

  it('attaches a dispatcher for a socks5 proxy', async () => {
    setUpstreamProxyResolver(() => ({ type: 'socks5', host: '127.0.0.1', port: 1080 }));
    const d = resolveUpstreamDispatcher({ providerId: 'claude' });
    expect(d).toBeDefined();
  });

  it('supports the { url } proxy shape', async () => {
    setUpstreamProxyResolver(() => ({ url: 'http://user:pass@127.0.0.1:3128' }));
    await fetchUpstream('https://api.example.com', {});
    expect(dispatcherOf(fetchMock.mock.calls[0]?.[1])).toBeDefined();
  });

  it('does not mutate the passed init on the bare path', async () => {
    const init: RequestInit = { method: 'POST', headers: { a: '1' } };
    await fetchUpstream('https://api.example.com', init);
    expect('dispatcher' in init).toBe(false);
  });
});

describe('credential-exchange trace redaction (ctx.redactBodies)', () => {
  const TOKEN = 'SENTINEL-ACCESS-TOKEN';
  const REFRESH = 'SENTINEL-REFRESH-TOKEN';
  const CODE = 'SENTINEL-AUTH-CODE';
  let tmpDir: string;
  let tracePath: string;

  beforeEach(() => {
    __resetUpstreamProxyForTests();
    tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-trace-'));
    tracePath = join(tmpDir, 'upstream-trace.jsonl');
    setUpstreamTracePath(tracePath);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ access_token: TOKEN, refresh_token: REFRESH }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );
  });

  afterEach(() => {
    __resetUpstreamTraceForTests();
    __resetUpstreamProxyForTests();
    vi.unstubAllGlobals();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Poll until the fire-and-forget trace line lands (the write is not awaited). */
  async function readTrace(): Promise<string> {
    for (let i = 0; i < 50; i += 1) {
      if (existsSync(tracePath)) {
        const text = readFileSync(tracePath, 'utf8');
        if (text.trim()) return text;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    return '';
  }

  it('a token exchange IS traced but neither body reaches the file', async () => {
    await fetchUpstream(
      'https://platform.claude.com/v1/oauth/token',
      { method: 'POST', body: JSON.stringify({ code: CODE, code_verifier: 'v' }) },
      { providerId: 'claude', redactBodies: true },
    );

    const text = await readTrace();
    // Traced at all — a failing login must leave evidence.
    expect(text).toContain('platform.claude.com');
    const record = JSON.parse(text.trim()) as {
      status: number;
      requestBody: string;
      responseBody: string;
      responseBytes: number;
    };
    expect(record.status).toBe(200);
    // ...but the credential material is replaced on BOTH legs.
    expect(record.requestBody).toBe(REDACTED_BODY);
    expect(record.responseBody).toBe(REDACTED_BODY);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(REFRESH);
    expect(text).not.toContain(CODE);
    // The real byte count survives (useful, reveals nothing).
    expect(record.responseBytes).toBeGreaterThan(REDACTED_BODY.length);
  });

  it('relay traffic (no redactBodies) still captures bodies VERBATIM', async () => {
    await fetchUpstream(
      'https://api.anthropic.com/v1/messages',
      { method: 'POST', body: '{"prompt":"hello"}' },
      { providerId: 'claude', accountId: 'acc-1' },
    );

    const record = JSON.parse((await readTrace()).trim()) as {
      requestBody: string;
      responseBody: string;
    };
    expect(record.requestBody).toBe('{"prompt":"hello"}');
    expect(record.responseBody).toContain(TOKEN);
  });
});

describe('resolveUpstreamDispatcher cache + generation', () => {
  beforeEach(() => __resetUpstreamProxyForTests());
  afterEach(() => __resetUpstreamProxyForTests());

  it('reuses one dispatcher for the same resolved proxy', () => {
    setUpstreamProxyResolver(() => ({ type: 'http', host: 'proxy.local', port: 8080 }));
    const a = resolveUpstreamDispatcher({ providerId: 'claude' });
    const b = resolveUpstreamDispatcher({ providerId: 'codex' });
    expect(a).toBeDefined();
    expect(a).toBe(b);
  });

  it('builds distinct dispatchers for distinct proxies', () => {
    setUpstreamProxyResolver((ctx) =>
      ctx.providerId === 'claude'
        ? { type: 'http', host: 'a.local', port: 8080 }
        : { type: 'http', host: 'b.local', port: 8080 },
    );
    const a = resolveUpstreamDispatcher({ providerId: 'claude' });
    const b = resolveUpstreamDispatcher({ providerId: 'codex' });
    expect(a).not.toBe(b);
  });

  it('rebuilds + disposes the old dispatcher after a generation bump', () => {
    setUpstreamProxyResolver(() => ({ type: 'http', host: 'proxy.local', port: 8080 }));
    const a = resolveUpstreamDispatcher({ providerId: 'claude' });
    expect(a).toBeDefined();
    const closeSpy = vi.spyOn(a as { close: () => Promise<void> }, 'close').mockResolvedValue(undefined);
    bumpUpstreamProxyGeneration();
    const b = resolveUpstreamDispatcher({ providerId: 'claude' });
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(b).not.toBe(a);
  });

  it('returns undefined when the resolver throws (never breaks egress)', () => {
    setUpstreamProxyResolver(() => {
      throw new Error('boom');
    });
    expect(resolveUpstreamDispatcher({ providerId: 'claude' })).toBeUndefined();
  });
});
