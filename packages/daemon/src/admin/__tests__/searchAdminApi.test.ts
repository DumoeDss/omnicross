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

describe('POST /admin/api/search/query (interactive test panel)', () => {
  function queryDeps(
    fetchImpl: ((url: string, init: RequestInit) => Promise<Response>) | undefined,
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

  function jsonResponseForQuery(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('runs the operator query and returns the doctor diagnostic plus sanitized results', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const testFetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body ?? '') });
      return jsonResponseForQuery(200, {
        results: [
          { title: 'Result title', url: 'https://result.example.test/a', content: 'A snippet' },
        ],
      });
    });
    const out = response();
    await handleAdminApi(
      searchRequest('POST', { providerId: 'tavily', query: 'omnicross search' }),
      out.res,
      '/admin/api/search/query',
      queryDeps(testFetch as unknown as (url: string, init: RequestInit) => Promise<Response>),
    );

    expect(out.status()).toBe(200);
    const result = (
      out.json() as {
        result: {
          diagnostic: { status: string };
          resultCount: number;
          results: Array<{ title: string; url: string; content: string }>;
        };
      }
    ).result;
    expect(result.diagnostic.status).toBe('healthy');
    expect(result.resultCount).toBe(1);
    expect(result.results).toEqual([
      { title: 'Result title', url: 'https://result.example.test/a', content: 'A snippet' },
    ]);

    // The OPERATOR query is the one that goes upstream (not the doctor's fixed
    // one), and the stored key never rides back in the response.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toContain('omnicross search');
    expect(JSON.stringify(out.json())).not.toContain(KEY_SENTINEL);
  });

  it('treats an empty result list as a healthy success with results: []', async () => {
    const testFetch = vi.fn(async () => jsonResponseForQuery(200, { results: [] }));
    const out = response();
    await handleAdminApi(
      searchRequest('POST', { providerId: 'tavily', query: 'obscure string with no matches' }),
      out.res,
      '/admin/api/search/query',
      queryDeps(testFetch as unknown as (url: string, init: RequestInit) => Promise<Response>),
    );

    expect(out.status()).toBe(200);
    const result = (
      out.json() as { result: { diagnostic: { status: string }; resultCount: number; results: unknown[] } }
    ).result;
    // Authoritative empty is a SUCCESS for an operator query (empty-[]-is-
    // success); the fixed-query doctor's zero-implies-drift degraded does NOT
    // apply to the interactive channel.
    expect(result.diagnostic.status).toBe('healthy');
    expect(result.resultCount).toBe(0);
    expect(result.results).toEqual([]);
  });

  it('refuses an unconfigured provider with a structured error and performs no upstream request', async () => {
    const testFetch = vi.fn();
    const out = response();
    await handleAdminApi(
      searchRequest('POST', { providerId: 'z.ai', query: 'anything' }),
      out.res,
      '/admin/api/search/query',
      queryDeps(testFetch as never),
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
      searchRequest('POST', { providerId: 'grok', query: 'anything' }),
      out.res,
      '/admin/api/search/query',
      queryDeps(undefined),
    );
    expect(out.status()).toBe(404);
  });

  it('enforces the query bounds with no upstream request', async () => {
    const testFetch = vi.fn();
    const bad = [
      '', // blank
      '    ', // whitespace-only after trim
      'q'.repeat(257), // over the 256-code-unit cap
      `bad${String.fromCharCode(1)}query`, // control character
    ];
    for (const query of bad) {
      const out = response();
      await handleAdminApi(
        searchRequest('POST', { providerId: 'tavily', query }),
        out.res,
        '/admin/api/search/query',
        queryDeps(testFetch as never),
      );
      expect(out.status(), `query=${JSON.stringify(query)}`).toBe(400);
      expect((out.json() as { error: { message: string } }).error.message).toContain('query');
    }
    expect(testFetch).not.toHaveBeenCalled();
  });

  it('caps the request body at 64 KiB — exactly-at-cap passes the gate, over-cap is a structured 400', async () => {
    const rawSearchRequest = (rawBody: string): http.IncomingMessage => {
      const req = Readable.from([Buffer.from(rawBody, 'utf8')]) as unknown as {
        method?: string;
        url?: string;
      };
      req.method = 'POST';
      req.url = '/admin/api/search';
      return req as unknown as http.IncomingMessage;
    };
    // An exactly-`totalBytes` ASCII body; the ignored `pad` field absorbs the
    // size so providerId/query stay ordinary.
    const sizedBody = (totalBytes: number): string => {
      const prefix = '{"providerId":"z.ai","query":"ok","pad":"';
      const suffix = '"}';
      const pad = Math.max(0, totalBytes - prefix.length - suffix.length);
      return prefix + 'p'.repeat(pad) + suffix;
    };

    // AT CAP: the body reader accepts it — the refusal that follows is the
    // ordinary unconfigured-provider one, proving the body gate passed.
    const atCap = response();
    await handleAdminApi(
      rawSearchRequest(sizedBody(64 * 1024)),
      atCap.res,
      '/admin/api/search/query',
      queryDeps(undefined),
    );
    expect(atCap.status()).toBe(400);
    expect((atCap.json() as { error: { message: string } }).error.message).toContain(
      "'z.ai' is not configured",
    );

    // OVER CAP: refused while streaming, before any validation or upstream.
    const overCap = response();
    await handleAdminApi(
      rawSearchRequest(sizedBody(64 * 1024 + 1)),
      overCap.res,
      '/admin/api/search/query',
      queryDeps(undefined),
    );
    expect(overCap.status()).toBe(400);
    expect((overCap.json() as { error: { message: string } }).error.message).toContain(
      'request body is too large',
    );
  });

  it('strips control characters, caps field lengths, and never returns more than five results', async () => {
    const withControls = `T${String.fromCharCode(2)}i${String.fromCharCode(3)}tle`;
    const testFetch = vi.fn(async () =>
      jsonResponseForQuery(200, {
        results: Array.from({ length: 7 }, (_, i) => ({
          title: withControls + 't'.repeat(600),
          url: 'https://result.example.test/' + 'u'.repeat(3000) + `/${i}`,
          content: 'c'.repeat(2000),
        })),
      }),
    );
    const out = response();
    await handleAdminApi(
      searchRequest('POST', { providerId: 'tavily', query: 'bounded fields' }),
      out.res,
      '/admin/api/search/query',
      queryDeps(testFetch as unknown as (url: string, init: RequestInit) => Promise<Response>),
    );

    expect(out.status()).toBe(200);
    const result = (
      out.json() as {
        result: { resultCount: number; results: Array<{ title: string; url: string; content: string }> };
      }
    ).result;
    expect(result.results).toHaveLength(5);
    expect(result.resultCount).toBe(5);
    const first = result.results[0]!;
    // Controls stripped, then capped at the per-field code-unit limits.
    expect(first.title).toBe('Title' + 't'.repeat(512 - 5));
    expect(first.title.length).toBe(512);
    expect(first.url.length).toBe(2048);
    expect(first.content.length).toBe(1024);
    // No control character survives into any string of the PARSED response
    // (a raw-bytes scan of JSON.stringify output would be vacuous — JSON
    // escapes controls as \uXXXX text).
    const control = new RegExp("[\\u0000-\\u001f\\u007f]");
    const walk = (value: unknown): void => {
      if (typeof value === "string") {
        expect(value, JSON.stringify(value)).not.toMatch(control);
      } else if (Array.isArray(value)) {
        value.forEach(walk);
      } else if (value !== null && typeof value === "object") {
        Object.values(value).forEach(walk);
      }
    };
    walk(out.json());
  });

  it('never echoes the stored key through an upstream error body', async () => {
    // A hostile upstream that quotes the request body back — the exact shape
    // the shared transport's redaction (and this contract test) exists for.
    const testFetch = vi.fn(async () =>
      jsonResponseForQuery(500, {
        error: `invalid api_key "${KEY_SENTINEL}" (request was ${JSON.stringify({ api_key: KEY_SENTINEL })})`,
      }),
    );
    const out = response();
    await handleAdminApi(
      searchRequest('POST', { providerId: 'tavily', query: 'omnicross search' }),
      out.res,
      '/admin/api/search/query',
      queryDeps(testFetch as unknown as (url: string, init: RequestInit) => Promise<Response>),
    );

    expect(out.status()).toBe(200);
    const result = (out.json() as { result: { diagnostic: { status: string }; results?: unknown } }).result;
    expect(result.diagnostic.status).toBe('failed');
    // Diagnostic only — no results on the failure arm, and no key material
    // anywhere in the serialized response.
    expect(result.results).toBeUndefined();
    expect(JSON.stringify(out.json())).not.toContain(KEY_SENTINEL);
  });

  it('classifies an egress denial as blocked — an honest observation with no result content', async () => {
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
      searchRequest('POST', { providerId: 'searxng', query: 'internal docs' }),
      out.res,
      '/admin/api/search/query',
      queryDeps(undefined, persisted),
    );

    expect(out.status()).toBe(200);
    const result = (
      out.json() as { result: { diagnostic: { status: string; reason?: string }; results?: unknown } }
    ).result;
    expect(result.diagnostic.status).toBe('blocked');
    expect(result.diagnostic.reason).toContain('egress policy');
    expect(result.results).toBeUndefined();
  });

  it('returns 501 when the dep is absent', async () => {
    const out = response();
    await handleAdminApi(
      searchRequest('POST', { providerId: 'tavily', query: 'anything' }),
      out.res,
      '/admin/api/search/query',
      { settingsStore: storeStub({}) } as unknown as AdminApiDeps,
    );
    expect(out.status()).toBe(501);
  });
});
