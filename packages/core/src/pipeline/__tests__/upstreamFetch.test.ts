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
import { getSharedAccountRouteActivity } from '../AccountRouteActivity';

/** The `dispatcher` the helper attaches (undici-specific, absent from DOM lib). */
function dispatcherOf(init: RequestInit | undefined): unknown {
  return (init as { dispatcher?: unknown } | undefined)?.dispatcher;
}

describe('fetchUpstream', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    __resetUpstreamProxyForTests();
    getSharedAccountRouteActivity().clear();
    fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    __resetUpstreamProxyForTests();
    getSharedAccountRouteActivity().clear();
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

  it('records the actual selected account without request content', async () => {
    await fetchUpstream(
      'https://chatgpt.com/backend-api/codex/responses',
      { method: 'POST', body: 'SENTINEL-PROMPT' },
      {
        providerId: 'codex',
        accountId: 'account-b',
        routeActivity: {
          endpoint: 'responses',
          sessionKey: 'deadbeef',
          sessionSource: 'session-header',
          model: 'gpt-5-codex',
        },
      },
    );

    const records = getSharedAccountRouteActivity().list();
    expect(records).toEqual([
      expect.objectContaining({
        providerId: 'codex',
        accountId: 'account-b',
        sessionKey: 'deadbeef',
        status: 200,
        affinity: 'new',
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain('SENTINEL-PROMPT');
  });

  // ---- Failed-attempt recording: who withdrew the request decides ----------
  //
  // A rejected upstream call normally records a `status: 0` row, which the
  // upstreams view paints as a red "Network error". That is right for a real
  // egress fault and for our OWN total-duration timeout, and WRONG for a request
  // the downstream client withdrew: no account failed, the caller left. These
  // two pin both directions so the discriminator cannot later be widened to a
  // bare `signal.aborted` without a test objecting.

  /** Mirrors the abort reason `createRequestAbortScope` uses for a disconnect. */
  const clientDisconnectReason = Object.assign(new Error('The downstream client disconnected'), {
    name: 'ClientDisconnectError',
    code: 'client_disconnect',
  });
  /** Mirrors `ResponsesRequestTimeoutError` — OUR decision, a real failure. */
  const timeoutReason = Object.assign(new Error('Responses request timed out'), {
    name: 'ResponsesRequestTimeoutError',
    code: 'request_timeout',
  });

  async function fetchRejectingWith(reason: unknown, accountId: string): Promise<void> {
    fetchMock.mockRejectedValueOnce(reason);
    const controller = new AbortController();
    controller.abort(reason);
    await fetchUpstream(
      'https://chatgpt.com/backend-api/codex/responses',
      { method: 'POST', signal: controller.signal },
      {
        providerId: 'codex',
        accountId,
        routeActivity: { endpoint: 'responses', sessionSource: 'none', model: 'gpt-5-codex' },
      },
    ).catch(() => undefined);
  }

  it('records NO activity row when the downstream client withdrew the request', async () => {
    await fetchRejectingWith(clientDisconnectReason, 'account-withdrawn');
    expect(getSharedAccountRouteActivity().list()).toEqual([]);
  });

  it('still records an activity row when OUR timeout aborted the request', async () => {
    await fetchRejectingWith(timeoutReason, 'account-timed-out');
    expect(getSharedAccountRouteActivity().list()).toEqual([
      expect.objectContaining({ providerId: 'codex', accountId: 'account-timed-out', status: 0 }),
    ]);
  });

  it('still records an activity row for a plain egress failure (no signal)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await fetchUpstream(
      'https://chatgpt.com/backend-api/codex/responses',
      { method: 'POST' },
      {
        providerId: 'codex',
        accountId: 'account-econnrefused',
        routeActivity: { endpoint: 'responses', sessionSource: 'none', model: 'gpt-5-codex' },
      },
    ).catch(() => undefined);
    expect(getSharedAccountRouteActivity().list()).toEqual([
      expect.objectContaining({ accountId: 'account-econnrefused', status: 0 }),
    ]);
  });

  it('invokes onRecorded with the freshly-recorded activity row (id usable for amend)', async () => {
    const onRecorded = vi.fn();
    await fetchUpstream(
      'https://chatgpt.com/backend-api/codex/responses',
      { method: 'POST' },
      {
        providerId: 'codex',
        accountId: 'account-c',
        routeActivity: {
          endpoint: 'responses',
          sessionSource: 'session-header',
          model: 'gpt-5-codex',
          onRecorded,
        },
      },
    );
    expect(onRecorded).toHaveBeenCalledTimes(1);
    expect(onRecorded.mock.calls[0]?.[0]).toMatchObject({
      providerId: 'codex',
      accountId: 'account-c',
      status: 200,
    });
    expect(typeof onRecorded.mock.calls[0]?.[0]?.id).toBe('string');
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
