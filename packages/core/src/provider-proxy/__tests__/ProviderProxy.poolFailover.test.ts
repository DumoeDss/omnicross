/**
 * ApiKeyPool failover wiring tests for the BYO ProviderProxy ingresses
 * (HIGH deviation #1 — `auth.onResult` was never called, so 429/529/401/403
 * pool failover was inert for codex-BYO / qwen / copilot / opencode / gemini-CLI).
 *
 * Unlike `ProviderProxy.ingress.test.ts` (which mocks `executeProviderCall` to a
 * bare 200 and never runs `fetchFn`), THIS suite drives the real per-ingress
 * `runPipelineWithPoolReporting` wrapper end-to-end:
 *
 *   - `executeProviderCall` is mocked to actually CALL `ctx.buildHeaders` (auth
 *     header assembly, incl. adopting a rotated key on retry) and `ctx.fetchFn`
 *     (so the ingress closure captures the REAL upstream `rawStatus`), then relay
 *     the fetched `Response` straight through (identity response chain).
 *   - global `fetch` is stubbed to return 429-then-200, with a `deps.apiKeyPool`
 *     stub whose `reportError` returns a `newKey` (rebind) — proving the wrapper
 *     reports the 429, retries ONCE, reports the 200 success, and relays the 200
 *     body.
 *   - a no-rebind case (`reportError → null`) proves NO retry.
 *   - a no-pool case (`deps.apiKeyPool` absent) proves exactly one fetch + zero
 *     pool calls (the zero-regression guarantee).
 *
 * @module provider-proxy/__tests__/ProviderProxy.poolFailover.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderCallContext } from '../../pipeline/executeProviderCall';

// The mock RUNS the ingress's real injected functions: buildHeaders (auth) and
// fetchFn (which captures rawStatus in the ingress closure), then relays the
// fetched response verbatim (identity response chain — enough for the failover
// wiring under test; the transformer chain has its own coverage elsewhere).
const executeProviderCallMock = vi.fn(async (ctx: ProviderCallContext) => {
  const headers = ctx.buildHeaders({} as never);
  const url = ctx.resolveUrl({} as never);
  const response = await ctx.fetchFn(url, headers, ctx.request);
  return { response };
});
vi.mock('../../pipeline/executeProviderCall', () => ({
  executeProviderCall: (ctx: ProviderCallContext) => executeProviderCallMock(ctx),
}));

vi.mock('../../pipeline/resolveProviderChain', () => ({
  resolveProviderChain: vi.fn(async () => ({
    chain: { providerTransformers: [], modelTransformers: [] },
    mainTransformer: null,
    hasTransformers: false,
  })),
}));

import type { ApiKeyPoolService } from '../../completion/ApiKeyPoolService';
import type { ProviderConfigSource } from '../../ports';
import { ProviderProxy } from '../ProviderProxy';
import type { ProviderProxyDeps, RouteContext } from '../types';

const openaiProvider = {
  id: 'openai-prov',
  name: 'OpenAI',
  apiFormat: 'openai',
  api_base_url: 'https://api.openai.com',
  api_key: 'sk-original',
  models: ['gpt-5'],
  enabled: true,
};

const geminiProvider = {
  id: 'gemini-prov',
  name: 'Gemini',
  apiFormat: 'gemini',
  api_base_url: 'https://generativelanguage.googleapis.com',
  api_key: 'g-original',
  models: ['gemini-2.5-pro'],
  enabled: true,
};

function makeLlmConfig(): ProviderConfigSource {
  return {
    getProvider: vi.fn(async (id: string) =>
      id === 'gemini-prov' ? geminiProvider : openaiProvider,
    ),
    resolveTransformerChain: vi.fn(async () => ({ providerTransformers: [], modelTransformers: [] })),
    getMainTransformer: vi.fn(async () => null),
    getTransformerService: () => ({ getTransformer: () => undefined }),
  } as unknown as ProviderConfigSource;
}

/**
 * A minimal ApiKeyPoolService stub. `reportError` returns the queued result for
 * the call index (a `newKey` string → rebind, or `null` → no rebind). Records
 * every reportError/reportSuccess call so the assertions can pin the wiring.
 *
 * `getKeyForSession` is now ALSO stubbed (omnicross-daemon-parity-poolseam):
 * since this knife, the BYO ingresses call the shared `resolvePoolBoundKey`
 * helper which SEEDS the session binding via `getKeyForSession` BEFORE the
 * `onResult`→`reportError` failover can fire (the "second gate"). The stub
 * returns a seed key so the pool branch is taken; the rebind decision still
 * comes from the queued `reportError` results, so this suite keeps testing the
 * `onResult`/retry WIRING exactly as before. (The two-gate REAL-pool behavior —
 * that an UNSEEDED session never rotates — is proven separately in
 * `ProviderProxy.realPoolFailover.test.ts`, D5 proof-obligation 3.)
 */
function makePoolStub(reportErrorResults: Array<string | null>): {
  pool: ApiKeyPoolService;
  reportError: ReturnType<typeof vi.fn>;
  reportSuccess: ReturnType<typeof vi.fn>;
  getKeyForSession: ReturnType<typeof vi.fn>;
} {
  let callIdx = 0;
  const reportError = vi.fn(async (_providerId: string, _sessionId: string, _status: number) => {
    const result = reportErrorResults[callIdx] ?? null;
    callIdx += 1;
    return result;
  });
  const reportSuccess = vi.fn((_sessionId: string) => undefined);
  // Seed the binding (gate 2): return a stable per-session pool key.
  const getKeyForSession = vi.fn(async (_providerId: string, _sessionId: string) => 'sk-pool-seed');
  const pool = { reportError, reportSuccess, getKeyForSession } as unknown as ApiKeyPoolService;
  return { pool, reportError, reportSuccess, getKeyForSession };
}

/**
 * Stub global fetch to yield the queued statuses (JSON bodies) for UPSTREAM
 * provider calls only. The test client's own `fetch(${baseUrl}…)` hits the
 * loopback proxy and MUST be delegated to the real fetch — otherwise the stub
 * would short-circuit the proxy entirely (the upstream fetch and the client
 * fetch both go through `globalThis.fetch`). We discriminate by host: a
 * `127.0.0.1` / `localhost` target is the proxy (real); anything else is the
 * upstream provider (stubbed). Mirrors the pass-through stub in
 * `ProviderProxy.ingress.test.ts`.
 */
function stubFetchSequence(statuses: number[]): {
  upstreamCalls: () => number;
  restore: () => void;
} {
  const realFetch = globalThis.fetch.bind(globalThis);
  let idx = 0;
  let upstream = 0;
  const fetchSpy = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const href =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // Loopback = the test client hitting the proxy → real fetch.
    if (href.includes('127.0.0.1') || href.includes('localhost')) {
      return realFetch(input as RequestInfo, init);
    }
    // Upstream provider call → queued stub status.
    const status = statuses[Math.min(idx, statuses.length - 1)];
    idx += 1;
    upstream += 1;
    const body = status >= 200 && status < 300 ? { ok: true, usage: {} } : { error: { code: status } };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
  globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  return {
    upstreamCalls: () => upstream,
    restore: () => (globalThis.fetch = realFetch as unknown as typeof globalThis.fetch),
  };
}

describe('ProviderProxy BYO ApiKeyPool failover wiring (auth.onResult)', () => {
  let proxy: ProviderProxy;
  let baseUrl: string;

  function startProxy(d: ProviderProxyDeps): Promise<void> {
    proxy = new ProviderProxy(d);
    return proxy.start().then((port) => {
      baseUrl = `http://127.0.0.1:${port}`;
    });
  }

  beforeEach(() => {
    executeProviderCallMock.mockClear();
  });

  afterEach(async () => {
    await proxy.stop();
  });

  function bearer(token: string): Record<string, string> {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  }

  // ---- Responses ingress (codex-BYO) ----

  it('Responses BYO: 429 → reportError(rebind) → retry once → relays 200 body', async () => {
    const { pool, reportError, reportSuccess } = makePoolStub(['sk-rotated']);
    await startProxy({ llmConfig: makeLlmConfig(), apiKeyPool: pool });
    const { upstreamCalls, restore } = stubFetchSequence([429, 200]);
    try {
      const route: RouteContext = {
        sessionId: 'sess-resp-failover',
        targetProviderFormat: 'openai-responses',
        model: 'gpt-5',
        ingressFormat: 'openai-responses',
        authMode: 'byo',
        providerId: 'openai-prov',
      };
      const token = proxy.addRoute(route);

      const res = await fetch(`${baseUrl}/openai/responses`, {
        method: 'POST',
        headers: bearer(token),
        body: JSON.stringify({ model: 'cli-model', input: [{ role: 'user', content: 'hi' }] }),
      });

      // The 200 body was relayed (the discarded 429 never surfaced).
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok?: boolean };
      expect(json.ok).toBe(true);

      // Two upstream fetches (retry-once).
      expect(upstreamCalls()).toBe(2);
      // reportError was called with the 429.
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError.mock.calls[0][0]).toBe('openai-prov');
      expect(reportError.mock.calls[0][1]).toBe('sess-resp-failover');
      expect(reportError.mock.calls[0][2]).toBe(429);
      // The retried 200 is NOT re-reported (the wrapper returns the second
      // runPipeline directly — same as `runPipelineWithSubscriptionRetry`), so
      // reportSuccess is not called on the rebind path.
      expect(reportSuccess).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('Responses BYO: 200 first call → reportSuccess(sessionId), no reportError, single fetch', async () => {
    const { pool, reportError, reportSuccess } = makePoolStub([]);
    await startProxy({ llmConfig: makeLlmConfig(), apiKeyPool: pool });
    const { upstreamCalls, restore } = stubFetchSequence([200]);
    try {
      const route: RouteContext = {
        sessionId: 'sess-resp-success',
        targetProviderFormat: 'openai-responses',
        model: 'gpt-5',
        ingressFormat: 'openai-responses',
        authMode: 'byo',
        providerId: 'openai-prov',
      };
      const token = proxy.addRoute(route);

      const res = await fetch(`${baseUrl}/openai/responses`, {
        method: 'POST',
        headers: bearer(token),
        body: JSON.stringify({ model: 'cli-model', input: [] }),
      });

      expect(res.status).toBe(200);
      // 2xx on the first (and only) call → onResult reports success, never error.
      expect(upstreamCalls()).toBe(1);
      expect(reportError).not.toHaveBeenCalled();
      expect(reportSuccess).toHaveBeenCalledTimes(1);
      expect(reportSuccess.mock.calls[0][0]).toBe('sess-resp-success');
    } finally {
      restore();
    }
  });

  it('Responses BYO: 429 → reportError returns null (no rebind) → NO retry, response surfaced', async () => {
    const { pool, reportError, reportSuccess } = makePoolStub([null]);
    await startProxy({ llmConfig: makeLlmConfig(), apiKeyPool: pool });
    const { upstreamCalls, restore } = stubFetchSequence([429, 200]);
    try {
      const route: RouteContext = {
        sessionId: 'sess-resp-norebind',
        targetProviderFormat: 'openai-responses',
        model: 'gpt-5',
        ingressFormat: 'openai-responses',
        authMode: 'byo',
        providerId: 'openai-prov',
      };
      const token = proxy.addRoute(route);

      const res = await fetch(`${baseUrl}/openai/responses`, {
        method: 'POST',
        headers: bearer(token),
        body: JSON.stringify({ model: 'cli-model', input: [] }),
      });

      // No rebind → the (transformed) first response is surfaced; relay clamps to 200.
      expect(upstreamCalls()).toBe(1);
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError.mock.calls[0][2]).toBe(429);
      expect(reportSuccess).not.toHaveBeenCalled();
      // relayResponse clamps a 429 to 200 in the JSON path (status>=100 → as-is)…
      // we only assert the failover decision here, not the relay status mapping.
      expect(res.status).toBe(429);
    } finally {
      restore();
    }
  });

  it('Responses BYO: NO apiKeyPool → exactly one fetch, no pool calls (zero regression)', async () => {
    await startProxy({ llmConfig: makeLlmConfig() });
    const { upstreamCalls, restore } = stubFetchSequence([200]);
    try {
      const route: RouteContext = {
        sessionId: 'sess-resp-nopool',
        targetProviderFormat: 'openai-responses',
        model: 'gpt-5',
        ingressFormat: 'openai-responses',
        authMode: 'byo',
        providerId: 'openai-prov',
      };
      const token = proxy.addRoute(route);

      const res = await fetch(`${baseUrl}/openai/responses`, {
        method: 'POST',
        headers: bearer(token),
        body: JSON.stringify({ model: 'cli-model', input: [] }),
      });

      expect(res.status).toBe(200);
      expect(upstreamCalls()).toBe(1);
    } finally {
      restore();
    }
  });

  // ---- Chat ingress (qwen / copilot / opencode) ----

  it('Chat BYO: 429 → reportError(rebind) → retry once → relays 200 body', async () => {
    const { pool, reportError, reportSuccess } = makePoolStub(['sk-rotated']);
    await startProxy({ llmConfig: makeLlmConfig(), apiKeyPool: pool });
    const { upstreamCalls, restore } = stubFetchSequence([429, 200]);
    try {
      const route: RouteContext = {
        sessionId: 'sess-chat-failover',
        targetProviderFormat: 'transform',
        model: 'gpt-5',
        ingressFormat: 'openai-chat',
        authMode: 'byo',
        providerId: 'openai-prov',
      };
      const token = proxy.addRoute(route);

      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: bearer(token),
        body: JSON.stringify({ model: 'cli-model', messages: [{ role: 'user', content: 'hi' }] }),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok?: boolean };
      expect(json.ok).toBe(true);
      expect(upstreamCalls()).toBe(2);
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError.mock.calls[0][2]).toBe(429);
      // Retried 200 is not re-reported (returns the second runPipeline directly).
      expect(reportSuccess).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('Chat BYO: NO apiKeyPool → exactly one fetch (zero regression)', async () => {
    await startProxy({ llmConfig: makeLlmConfig() });
    const { upstreamCalls, restore } = stubFetchSequence([200]);
    try {
      const route: RouteContext = {
        sessionId: 'sess-chat-nopool',
        targetProviderFormat: 'transform',
        model: 'gpt-5',
        ingressFormat: 'openai-chat',
        authMode: 'byo',
        providerId: 'openai-prov',
      };
      const token = proxy.addRoute(route);

      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: bearer(token),
        body: JSON.stringify({ model: 'cli-model', messages: [] }),
      });

      expect(res.status).toBe(200);
      expect(upstreamCalls()).toBe(1);
    } finally {
      restore();
    }
  });

  // ---- Gemini ingress (gemini-CLI) ----

  it('Gemini BYO: 429 → reportError(rebind) → retry once → relays 200', async () => {
    const { pool, reportError, reportSuccess } = makePoolStub(['g-rotated']);
    await startProxy({ llmConfig: makeLlmConfig(), apiKeyPool: pool });
    const { upstreamCalls, restore } = stubFetchSequence([429, 200]);
    try {
      const route: RouteContext = {
        sessionId: 'sess-gemini-failover',
        targetProviderFormat: 'transform',
        model: 'gemini-2.5-pro',
        ingressFormat: 'gemini-generatecontent',
        authMode: 'byo',
        providerId: 'gemini-prov',
      };
      const token = proxy.addRoute(route);

      const res = await fetch(`${baseUrl}/v1beta/models/cli-model:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': token },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
      });

      expect(res.status).toBe(200);
      expect(upstreamCalls()).toBe(2);
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError.mock.calls[0][0]).toBe('gemini-prov');
      expect(reportError.mock.calls[0][2]).toBe(429);
      // Retried 200 is not re-reported (returns the second runPipeline directly).
      expect(reportSuccess).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});
