/**
 * The Codex search route.
 *
 * **Honesty note, and it applies to every assertion in this file.** The Codex
 * `/v1/alpha/search` request-body and response schemas are UNVERIFIED (wire
 * baseline §1.2/§1.3). The golden expectations below pin OMNICROSS's OWN
 * emission so it cannot change unnoticed — they are not, and must never be
 * described as, evidence that a real codex-tui accepts these shapes.
 *
 * @module outbound-api/__tests__/searchRoute.test
 */

import { PassThrough } from 'node:stream';
import type http from 'node:http';

import {
  SearchProviderError,
  type OrchestratedSearchResponse,
  type SearchRequest,
} from '@omnicross/contracts/search-types';
import { describe, expect, it, vi } from 'vitest';

import type { SearchRuntime } from '../../search/runtime';
import {
  handleCodexSearchRequest,
  isCodexSearchRequest,
  parseCodexSearchQuery,
  toCodexSearchResponseBody,
  TOLERATED_QUERY_FIELDS,
} from '../searchRoute';

interface CapturedResponse {
  status: number;
  headers: Record<string, unknown>;
  body: string;
}

function fakeResponse(): { res: http.ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, headers: {}, body: '' };
  const res = {
    headersSent: false,
    writableEnded: false,
    writeHead(status: number, headers: Record<string, unknown> = {}) {
      captured.status = status;
      captured.headers = headers;
      (this as { headersSent: boolean }).headersSent = true;
      return this;
    },
    end(chunk?: string) {
      if (chunk) captured.body += chunk;
      (this as { writableEnded: boolean }).writableEnded = true;
      return this;
    },
    write(chunk: string) {
      captured.body += chunk;
      return true;
    },
  } as unknown as http.ServerResponse;
  return { res, captured };
}

function fakeRequest(body: unknown): http.IncomingMessage {
  const stream = new PassThrough();
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  stream.end(text);
  const req = stream as unknown as http.IncomingMessage;
  req.method = 'POST';
  req.url = '/v1/alpha/search';
  req.headers = {};
  return req;
}

function stubRuntime(
  search: (request: SearchRequest) => Promise<OrchestratedSearchResponse>,
): SearchRuntime {
  return {
    search: vi.fn(search),
    registerContribution: vi.fn(),
    unregisterContribution: vi.fn(() => false),
    listProviders: vi.fn(() => []),
  };
}

function okResponse(query: string): OrchestratedSearchResponse {
  return {
    query,
    providerId: 'http-bing',
    results: [
      { title: 'MDN HTTP headers', url: 'https://developer.mozilla.org/headers', content: 'Reference.' },
    ],
    attempts: [{ providerId: 'http-bing', outcome: 'success', resultCount: 1, durationMs: 12 }],
    fallbackCount: 0,
  };
}

function parseBody(captured: CapturedResponse): Record<string, unknown> {
  return JSON.parse(captured.body) as Record<string, unknown>;
}

describe('isCodexSearchRequest', () => {
  it('matches the baselined path, with or without a base prefix or query string', () => {
    expect(isCodexSearchRequest('POST', '/v1/alpha/search')).toBe(true);
    expect(isCodexSearchRequest('POST', '/gateway/v1/alpha/search?x=1')).toBe(true);
  });

  it('does not match other methods or lookalike paths', () => {
    expect(isCodexSearchRequest('GET', '/v1/alpha/search')).toBe(false);
    expect(isCodexSearchRequest('POST', '/v1/alpha/searchfoo')).toBe(false);
    expect(isCodexSearchRequest('POST', '/v1/search')).toBe(false);
    expect(isCodexSearchRequest('POST', '/v1/responses')).toBe(false);
  });
});

describe('default mode: structured unsupported, never a bare 404', () => {
  it('answers a 4xx JSON body carrying unsupported_capability', async () => {
    const { res, captured } = fakeResponse();
    const runtime = stubRuntime(async () => okResponse('q'));

    await handleCodexSearchRequest(fakeRequest({ query: 'q' }), res, { mode: 'off', runtime });

    expect(captured.status).toBeGreaterThanOrEqual(400);
    expect(captured.status).toBeLessThan(500);
    expect(captured.status).not.toBe(404);
    const body = parseBody(captured);
    expect((body.error as Record<string, unknown>).code).toBe('unsupported_capability');
    expect(captured.body).not.toContain('Unsupported: POST');
    expect(runtime.search).not.toHaveBeenCalled();
  });

  it('treats a missing runtime exactly like mode off', async () => {
    const { res, captured } = fakeResponse();

    await handleCodexSearchRequest(fakeRequest({ query: 'q' }), res, { mode: 'managed' });

    expect((parseBody(captured).error as Record<string, unknown>).code)
      .toBe('unsupported_capability');
  });

  it('refuses `native` too: there is no upstream passthrough for this route', async () => {
    const { res, captured } = fakeResponse();
    const runtime = stubRuntime(async () => okResponse('q'));

    await handleCodexSearchRequest(fakeRequest({ query: 'q' }), res, { mode: 'native', runtime });

    expect((parseBody(captured).error as Record<string, unknown>).code)
      .toBe('unsupported_capability');
    expect(runtime.search).not.toHaveBeenCalled();
  });
});

describe('managed mode', () => {
  it('runs exactly one runtime search and answers the documented shape', async () => {
    const { res, captured } = fakeResponse();
    const runtime = stubRuntime(async (request) => okResponse(request.query));

    await handleCodexSearchRequest(
      fakeRequest({ query: 'mozilla developer network http headers' }),
      res,
      { mode: 'managed', runtime },
    );

    expect(runtime.search).toHaveBeenCalledTimes(1);
    expect(captured.status).toBe(200);
    // GOLDEN — Omnicross's own emission, UNVERIFIED against Codex.
    expect(parseBody(captured)).toEqual({
      object: 'omnicross.search.results',
      query: 'mozilla developer network http headers',
      provider: 'http-bing',
      results: [
        {
          title: 'MDN HTTP headers',
          url: 'https://developer.mozilla.org/headers',
          content: 'Reference.',
        },
      ],
    });
  });

  it('accepts every documented query spelling and no others', async () => {
    for (const field of TOLERATED_QUERY_FIELDS) {
      const { res, captured } = fakeResponse();
      const runtime = stubRuntime(async (request) => okResponse(request.query));

      await handleCodexSearchRequest(fakeRequest({ [field]: 'spelled' }), res, {
        mode: 'managed',
        runtime,
      });

      expect(captured.status, `field ${field}`).toBe(200);
      expect(parseBody(captured).query).toBe('spelled');
    }
  });

  it('ignores fields it has no evidence for rather than interpreting them', async () => {
    const { res, captured } = fakeResponse();
    const runtime = stubRuntime(async (request) => okResponse(request.query));

    await handleCodexSearchRequest(
      fakeRequest({ query: 'q', max_results: 99, mode: 'live', allowed_domains: ['x'] }),
      res,
      { mode: 'managed', runtime },
    );

    expect(captured.status).toBe(200);
    const call = (runtime.search as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as SearchRequest;
    expect(call.query).toBe('q');
    // No invented schema reached the runtime.
    expect(call.options?.maxResults).toBeUndefined();
  });

  it('rejects garbage with a structured error naming what was missing', async () => {
    const cases: unknown[] = [{}, { query: '   ' }, { query: 42 }, [], 'not json at all'];
    for (const input of cases) {
      const { res, captured } = fakeResponse();
      const runtime = stubRuntime(async () => okResponse('q'));

      await handleCodexSearchRequest(fakeRequest(input), res, { mode: 'managed', runtime });

      expect(captured.status, JSON.stringify(input)).toBe(400);
      expect((parseBody(captured).error as Record<string, unknown>).code).toBe('invalid_request');
      expect(runtime.search).not.toHaveBeenCalled();
    }
  });

  it('names the tolerated spellings when no query is present', () => {
    expect(() => parseCodexSearchQuery({})).toThrowError(/'query'.*'q'.*'search_query'/);
  });
});

describe('failure matrix', () => {
  const cases: ReadonlyArray<{ code: string; status: number }> = [
    { code: 'timeout', status: 504 },
    { code: 'upstream_unavailable', status: 502 },
    { code: 'rate_limited', status: 429 },
    { code: 'cancelled', status: 499 },
    { code: 'config_missing', status: 503 },
    { code: 'policy_denied', status: 502 },
  ];

  for (const { code, status } of cases) {
    it(`maps ${code} to a structured ${status}, never a hang or a 404`, async () => {
      const { res, captured } = fakeResponse();
      const runtime = stubRuntime(async () => {
        throw new SearchProviderError(code as 'timeout', 'sanitized failure');
      });

      await handleCodexSearchRequest(fakeRequest({ query: 'q' }), res, {
        mode: 'managed',
        runtime,
      });

      expect(captured.status).toBe(status);
      expect((parseBody(captured).error as Record<string, unknown>).code).toBe(code);
    });
  }

  it('answers a structured error when no provider is available at all', async () => {
    const { res, captured } = fakeResponse();
    const runtime = stubRuntime(async () => {
      throw new SearchProviderError(
        'upstream_unavailable',
        'no eligible search provider was available (0 attempts)',
        { retryable: false },
      );
    });

    await handleCodexSearchRequest(fakeRequest({ query: 'q' }), res, { mode: 'managed', runtime });

    expect(captured.status).toBe(502);
    expect(parseBody(captured)).toMatchObject({
      error: { code: 'upstream_unavailable', message: expect.stringContaining('0 attempts') },
    });
  });

  it('returns an empty result set as a success, not a failure', async () => {
    const { res, captured } = fakeResponse();
    const runtime = stubRuntime(async (request) => ({
      query: request.query,
      providerId: 'http-duckduckgo',
      results: [],
      attempts: [
        { providerId: 'http-duckduckgo', outcome: 'success' as const, resultCount: 0, durationMs: 5 },
      ],
      fallbackCount: 0,
    }));

    await handleCodexSearchRequest(fakeRequest({ query: 'q' }), res, { mode: 'managed', runtime });

    expect(captured.status).toBe(200);
    expect(parseBody(captured)).toMatchObject({ provider: 'http-duckduckgo', results: [] });
  });
});

describe('cancellation', () => {
  it('aborts the runtime walk when the client hangs up mid-search', async () => {
    const { res, captured } = fakeResponse();
    const controller = new AbortController();
    let sawAbortedSignal = false;
    const runtime = stubRuntime(async (request) => {
      // The client goes away while the first provider is still working.
      controller.abort();
      sawAbortedSignal = request.options?.signal?.aborted === true;
      throw new SearchProviderError('cancelled', 'search cancelled by the caller');
    });

    await handleCodexSearchRequest(fakeRequest({ query: 'q' }), res, {
      mode: 'managed',
      runtime,
      signal: controller.signal,
    });

    // The runtime received the live signal, which is what lets the orchestrator
    // end the walk instead of sending the query to the next provider.
    expect(sawAbortedSignal).toBe(true);
    expect(captured.status).toBe(499);
    expect((parseBody(captured).error as Record<string, unknown>).code).toBe('cancelled');
  });

  it('passes the caller`s signal straight through to the runtime request', async () => {
    const { res } = fakeResponse();
    const controller = new AbortController();
    const runtime = stubRuntime(async (request) => {
      expect(request.options?.signal).toBe(controller.signal);
      return okResponse(request.query);
    });

    await handleCodexSearchRequest(fakeRequest({ query: 'q' }), res, {
      mode: 'managed',
      runtime,
      signal: controller.signal,
    });

    expect(runtime.search).toHaveBeenCalledTimes(1);
  });
});

describe('oversize request bodies', () => {
  it('answers a structured 413 before abandoning the connection', async () => {
    const { res, captured } = fakeResponse();
    const runtime = stubRuntime(async () => okResponse('q'));
    // Comfortably past the 256 KiB cap.
    const huge = JSON.stringify({ query: 'q', padding: 'x'.repeat(300 * 1024) });
    const req = fakeRequest(huge);
    const destroy = vi.spyOn(req, 'destroy');

    await handleCodexSearchRequest(req, res, { mode: 'managed', runtime });

    // The structured body must be WRITTEN — destroying `req` first would tear
    // down the socket `res` shares and the client would see a reset instead.
    expect(captured.status).toBe(413);
    expect((parseBody(captured).error as Record<string, unknown>).code).toBe('invalid_request');
    expect(destroy).toHaveBeenCalled();
    expect(runtime.search).not.toHaveBeenCalled();
  });
});

describe('audit capture eligibility (the evidence path the route unblocks)', () => {
  it('hands the raw body and the parsed object to the audit hook', async () => {
    const { res } = fakeResponse();
    const runtime = stubRuntime(async (request) => okResponse(request.query));
    const onRequestBody = vi.fn();

    await handleCodexSearchRequest(fakeRequest({ query: 'q' }), res, {
      mode: 'managed',
      runtime,
      onRequestBody,
    });

    expect(onRequestBody).toHaveBeenCalledTimes(1);
    const [raw, parsed] = onRequestBody.mock.calls[0] as [string, Record<string, unknown>];
    expect(JSON.parse(raw)).toEqual({ query: 'q' });
    expect(parsed).toEqual({ query: 'q' });
  });

  it('reports a body that is not JSON at all — the most informative capture', async () => {
    const { res, captured } = fakeResponse();
    const runtime = stubRuntime(async () => okResponse('q'));
    const onRequestBody = vi.fn();

    await handleCodexSearchRequest(fakeRequest('this is not json'), res, {
      mode: 'managed',
      runtime,
      onRequestBody,
    });

    // A real codex-tui body we cannot parse is exactly what would settle the
    // UNVERIFIED request schema, so it must still reach the audit hook.
    expect(onRequestBody).toHaveBeenCalledTimes(1);
    expect(onRequestBody.mock.calls[0]?.[0]).toBe('this is not json');
    expect(onRequestBody.mock.calls[0]?.[1]).toEqual({});
    expect(captured.status).toBe(400);
  });

  it('still reports the body when the request carries an unrecognized shape', async () => {
    const { res, captured } = fakeResponse();
    const runtime = stubRuntime(async () => okResponse('q'));
    const onRequestBody = vi.fn();

    await handleCodexSearchRequest(fakeRequest({ unexpected: true }), res, {
      mode: 'managed',
      runtime,
      onRequestBody,
    });

    // The evidence is the whole point: an unparseable real-client request is
    // exactly what would settle the UNVERIFIED request schema.
    expect(onRequestBody).toHaveBeenCalledTimes(1);
    expect(captured.status).toBe(400);
  });
});

describe('toCodexSearchResponseBody', () => {
  it('carries provider provenance and drops everything else', () => {
    const body = toCodexSearchResponseBody(okResponse('q'));

    expect(Object.keys(body).sort()).toEqual(['object', 'provider', 'query', 'results']);
    expect(body.provider).toBe('http-bing');
  });
});
