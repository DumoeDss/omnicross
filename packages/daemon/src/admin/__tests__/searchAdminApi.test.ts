import type http from 'node:http';
import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import type { OutboundApiServerConfig } from '@omnicross/core/outbound-api/types';
import type { SearchFrontendModes } from '@omnicross/core/search';

import { buildSearchRuntime } from '../../search/SearchAssembly';
import { handleAdminApi, type AdminApiDeps } from '../adminApi';
import type { JsonApiServerSettingsStore } from '../../ports/JsonApiServerSettingsStore';

const KEY_SENTINEL = 'ROUTE_KEY_SENTINEL_do_not_echo';

function response(): { res: http.ServerResponse; status: () => number; json: () => unknown } {
  let code = 0;
  let body = '';
  const res = {
    writeHead: (status: number) => {
      code = status;
    },
    end: (value?: string) => {
      body = value ?? '';
    },
  } as unknown as http.ServerResponse;
  return { res, status: () => code, json: () => JSON.parse(body) as unknown };
}

function searchRequest(method: 'GET' | 'POST', body?: unknown): http.IncomingMessage {
  if (method === 'GET') return { method, url: '/admin/api/search' } as http.IncomingMessage;
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as {
    method?: string;
    url?: string;
  };
  req.method = 'POST';
  req.url = '/admin/api/search';
  return req as unknown as http.IncomingMessage;
}

/** A settings store stub serving ONE frozen config (read-only in these tests). */
function storeStub(config: Partial<OutboundApiServerConfig>): JsonApiServerSettingsStore {
  return {
    get: async () => config,
  } as unknown as JsonApiServerSettingsStore;
}

function modes(overrides: Partial<SearchFrontendModes> = {}): SearchFrontendModes {
  return { codex: 'off', responses: 'native', anthropic: 'native', ...overrides };
}

const PERSISTED = {
  modes: { codex: 'managed', responses: 'native', anthropic: 'native' },
  providers: {
    tavily: { apiKey: KEY_SENTINEL },
    zhipu: { apiKey: KEY_SENTINEL },
  },
  egress: { allowedPrivateHosts: [] },
  policy: { fallbackEnabled: true },
};

describe('GET /admin/api/search/diagnostics', () => {
  it('projects runtime rows plus unconfigured rows, effective modes, and apply semantics — with no secret', async () => {
    // A runtime built from a config that names ONLY tavily — the daemon's
    // single-runtime shape (bootstrap does the same).
    const runtime = buildSearchRuntime({
      modes: modes(),
      providers: { tavily: { apiKey: 'k' } },
      egress: { allowedPrivateHosts: [] },
      policy: { fallbackEnabled: true },
    });
    const out = response();
    await handleAdminApi(searchRequest('GET'), out.res, '/admin/api/search/diagnostics', {
      settingsStore: storeStub({ search: PERSISTED as OutboundApiServerConfig['search'] }),
      searchStatus: { runtime, modes: modes({ responses: 'managed' }) },
    } as unknown as AdminApiDeps);

    expect(out.status()).toBe(200);
    const diagnostics = (out.json() as { diagnostics: {
      rows: Array<{ providerId: string; status?: string; reason?: string }>;
      modes: SearchFrontendModes;
      applySemantics: { codex: string; rest: string };
    } }).diagnostics;

    const ids = diagnostics.rows.map((row) => row.providerId);
    // Running runtime: the http pair + tavily (no status — registered).
    expect(ids).toContain('http-bing');
    expect(ids).toContain('http-duckduckgo');
    expect(ids).toContain('tavily');
    // zhipu is persisted but NOT running (saved after boot) → no row for it
    // here; the UI's pending-restart comparison covers exactly that gap.
    expect(ids).not.toContain('zhipu');
    // Unconfigured rows for the API providers the persisted config omits.
    const jina = diagnostics.rows.find((row) => row.providerId === 'jina');
    expect(jina?.status).toBe('unconfigured');
    expect(jina?.reason).toContain('without a key');
    expect(diagnostics.rows.find((row) => row.providerId === 'searxng')?.status).toBe('unconfigured');
    expect(diagnostics.rows.find((row) => row.providerId === 'z.ai')?.status).toBe('unconfigured');

    // Effective modes: codex from the LIVE config (managed — already applied),
    // responses/anthropic as captured at bootstrap.
    expect(diagnostics.modes).toEqual({ codex: 'managed', responses: 'managed', anthropic: 'native' });
    expect(diagnostics.applySemantics).toEqual({ codex: 'immediate', rest: 'restart' });

    // No secret value ever serializes.
    expect(JSON.stringify(out.json())).not.toContain(KEY_SENTINEL);
  });

  it('returns 501 (not a fabricated snapshot) when the dep is absent', async () => {
    const out = response();
    await handleAdminApi(searchRequest('GET'), out.res, '/admin/api/search/diagnostics', {
      settingsStore: storeStub({}),
    } as unknown as AdminApiDeps);
    expect(out.status()).toBe(501);
  });
});

describe('POST /admin/api/search/test', () => {
  function testDeps(
    fetchImpl: (url: string, init: RequestInit) => Promise<Response> | undefined,
    persisted: unknown = PERSISTED,
  ): AdminApiDeps {
    const runtime = buildSearchRuntime({
      modes: modes(),
      providers: {},
      egress: { allowedPrivateHosts: [] },
      policy: { fallbackEnabled: true },
    });
    return {
      settingsStore: storeStub({ search: persisted as OutboundApiServerConfig['search'] }),
      searchStatus: {
        runtime,
        modes: modes(),
        ...(fetchImpl ? { testFetch: fetchImpl } : {}),
      },
    } as unknown as AdminApiDeps;
  }

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('sends exactly the FIXED public doctor query and reports healthy without result content', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const testFetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body ?? '') });
      return jsonResponse(200, {
        results: [{ title: 'TITLE_SENTINEL', url: 'https://result.example.test/a', content: 'SNIPPET_SENTINEL' }],
      });
    });
    const out = response();
    await handleAdminApi(
      searchRequest('POST', { providerId: 'tavily', query: 'USER_QUERY_SENTINEL' }),
      out.res,
      '/admin/api/search/test',
      testDeps(testFetch as unknown as (url: string, init: RequestInit) => Promise<Response>),
    );

    expect(out.status()).toBe(200);
    const result = (out.json() as { result: { diagnostic: { status: string }; resultCount: number } }).result;
    expect(result.diagnostic.status).toBe('healthy');
    expect(result.resultCount).toBe(1);

    // The fixed doctor query is the ONLY query — a caller-supplied one is ignored.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toContain('mozilla developer network http headers');
    expect(JSON.stringify(calls[0]?.body)).not.toContain('USER_QUERY_SENTINEL');
    // No result title/URL/snippet ever echoes back.
    const serialized = JSON.stringify(out.json());
    expect(serialized).not.toContain('TITLE_SENTINEL');
    expect(serialized).not.toContain('result.example.test');
    expect(serialized).not.toContain('SNIPPET_SENTINEL');
    expect(serialized).not.toContain(KEY_SENTINEL);
  });

  it('refuses an unconfigured provider with a structured error and performs no upstream request', async () => {
    const testFetch = vi.fn();
    const out = response();
    await handleAdminApi(
      searchRequest('POST', { providerId: 'z.ai' }),
      out.res,
      '/admin/api/search/test',
      testDeps(testFetch),
    );
    expect(out.status()).toBe(400);
    expect((out.json() as { error: { message: string } }).error.message).toContain(
      "'z.ai' is not configured",
    );
    expect(testFetch).not.toHaveBeenCalled();
  });

  it('refuses an unknown provider id', async () => {
    const out = response();
    await handleAdminApi(
      searchRequest('POST', { providerId: 'grok' }),
      out.res,
      '/admin/api/search/test',
      testDeps(undefined),
    );
    expect(out.status()).toBe(404);
  });

  it('classifies an egress denial as blocked — an honest observation, not a daemon failure', async () => {
    // A persisted searxng host pointing at loopback: the egress policy refuses
    // it before any connection (no fetch needed).
    const persisted = {
      modes: modes(),
      providers: { searxng: { apiHost: 'http://127.0.0.1:8888' } },
      egress: { allowedPrivateHosts: [] },
      policy: { fallbackEnabled: true },
    };
    const out = response();
    await handleAdminApi(
      searchRequest('POST', { providerId: 'searxng' }),
      out.res,
      '/admin/api/search/test',
      testDeps(undefined, persisted),
    );

    expect(out.status()).toBe(200);
    const diagnostic = (out.json() as { result: { diagnostic: { status: string; reason?: string } } }).result.diagnostic;
    expect(diagnostic.status).toBe('blocked');
    expect(diagnostic.reason).toContain('egress policy');
  });

  it('probes the builtin keyless http pair without any config entry', async () => {
    const testFetch = vi.fn(async () =>
      jsonResponse(200, '<html><body><li class="b_algo"><h2><a href="https://example.test/r">Example</a></h2><p>snippet text</p></li></body></html>'),
    );
    const out = response();
    await handleAdminApi(
      searchRequest('POST', { providerId: 'http-duckduckgo' }),
      out.res,
      '/admin/api/search/test',
      testDeps(testFetch as unknown as (url: string, init: RequestInit) => Promise<Response>),
    );

    expect(out.status()).toBe(200);
    const result = (out.json() as { result: { diagnostic: { status: string } } }).result;
    expect(['healthy', 'degraded', 'blocked', 'failed']).toContain(result.diagnostic.status);
  });

  it('returns 501 when the dep is absent', async () => {
    const out = response();
    await handleAdminApi(searchRequest('POST', { providerId: 'tavily' }), out.res, '/admin/api/search/test', {
      settingsStore: storeStub({}),
    } as unknown as AdminApiDeps);
    expect(out.status()).toBe(501);
  });

  it('rejects a missing providerId', async () => {
    const out = response();
    await handleAdminApi(searchRequest('POST', {}), out.res, '/admin/api/search/test', testDeps(undefined));
    expect(out.status()).toBe(400);
  });
});
