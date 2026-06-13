/**
 * REAL-pool failover tests for the BYO ProviderProxy ingresses
 * (omnicross-daemon-parity-poolseam, design D5 proof-obligation 3 + D6).
 *
 * The sibling `ProviderProxy.poolFailover.test.ts` uses a STUB pool whose
 * `reportError` returns a queued `newKey` REGARDLESS of whether a session was
 * ever bound. That stub HID the "second gate": with the real
 * `ApiKeyPoolService`, `reportError` short-circuits (`if (!binding) return null`)
 * unless `getKeyForSession` first SEEDED a binding for the session. Before this
 * knife the BYO ingresses never called `getKeyForSession`, so on the real pool
 * NOTHING rotated. This suite drives the REAL pool end-to-end through the
 * `resolvePoolBoundKey` seam to prove both gates are now passed:
 *
 *   - the first request SEEDS a binding via `getKeyForSession` (so the bound key
 *     === the key actually sent upstream),
 *   - a 429 → `reportError` finds the binding → cools k1 + re-binds k2 → retry
 *     once → 200, upstream's SECOND call carries k2, and `getKeyHealth` shows k1
 *     cooling,
 *   - a 401 → `markAutoDisabled` disables k1 + re-binds k2,
 *   - the synthesized `outbound:<keyId>` route id is STABLE: N requests for the
 *     same id keep `sessionBindings` at exactly one entry (bounded memory),
 *   - single-key pool → upstream gets the one key, exactly one upstream call,
 *   - pool-null route (sessionId === null) → no pool interaction, one upstream
 *     call (byte-identical to pre-seam).
 *
 * Mirrors the loopback-vs-upstream fetch discrimination used by
 * `ProviderProxy.poolFailover.test.ts`.
 *
 * @module provider-proxy/__tests__/ProviderProxy.realPoolFailover.test
 */

import type { ApiKeyEntry } from '@omnicross/contracts/llm-config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderCallContext } from '../../pipeline/executeProviderCall';

// The mock RUNS the ingress's real injected functions: buildHeaders (auth header
// assembly, incl. adopting the rotated key after onResult re-binds) and fetchFn
// (which captures rawStatus in the ingress closure), then relays the fetched
// response verbatim (identity response chain — enough for the failover wiring).
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

import { ApiKeyPoolService } from '../../completion/ApiKeyPoolService';
import type { ProviderConfigSource } from '../../ports';
import { ProviderProxy } from '../ProviderProxy';
import type { ProviderProxyDeps, RouteContext } from '../types';

const openaiProvider = {
  id: 'openai-prov',
  name: 'OpenAI',
  apiFormat: 'openai',
  api_base_url: 'https://api.openai.com',
  api_key: 'sk-row-default',
  models: ['gpt-5'],
  enabled: true,
};

// An Anthropic-format provider so the built-in `/v1/messages` BYO ingress takes
// its same-format VERBATIM fast path (`runSameFormatFetch`, which bypasses
// `auth.applyHeaders` and builds `x-api-key` headers from `plan.apiKey`). Its
// non-loopback base means the fetch stub treats it as upstream.
const anthropicProvider = {
  id: 'anthropic-prov',
  name: 'Anthropic',
  apiFormat: 'anthropic',
  api_base_url: 'https://api.anthropic.com',
  api_key: 'sk-row-default',
  models: ['claude-x'],
  enabled: true,
};

function makeLlmConfig(): ProviderConfigSource {
  return {
    getProvider: vi.fn(async (id: string) =>
      id === 'anthropic-prov' ? anthropicProvider : openaiProvider,
    ),
    resolveTransformerChain: vi.fn(async () => ({ providerTransformers: [], modelTransformers: [] })),
    getMainTransformer: vi.fn(async () => null),
    getTransformerService: () => ({ getTransformer: () => undefined }),
  } as unknown as ProviderConfigSource;
}

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Build an ApiKeyEntry with sane defaults. */
function keyEntry(id: string, apiKey: string, extra: Partial<ApiKeyEntry> = {}): ApiKeyEntry {
  return {
    id,
    providerId: 'openai-prov',
    label: id,
    apiKey,
    enabled: true,
    weight: 1,
    sortOrder: 0,
    ...extra,
  };
}

/**
 * Build a REAL `ApiKeyPoolService` over a mutable in-memory key list. The
 * `markAutoDisabled` callback flips the matching entry's `enabled` to false +
 * invalidates the cache (mirrors the DB-backed disabler) so 401 auto-disable is
 * observable. `resolveKey` is identity ($ENV resolution is exercised separately;
 * here the literal key flows straight to the wire so the upstream stub can pin
 * exactly which key was sent).
 */
function makeRealPool(keys: ApiKeyEntry[]): {
  pool: ApiKeyPoolService;
  disabledIds: () => string[];
} {
  const list = [...keys];
  const disabled: string[] = [];
  const pool = new ApiKeyPoolService(
    async () => list,
    (raw) => raw,
    silentLogger,
    undefined,
    async (keyId: string) => {
      disabled.push(keyId);
      const entry = list.find((k) => k.id === keyId);
      if (entry) entry.enabled = false;
      pool.invalidateCache('openai-prov');
    },
  );
  return { pool, disabledIds: () => disabled };
}

/**
 * Stub global fetch: loopback (127.0.0.1/localhost) → real fetch (the test
 * client hitting the proxy); any other host → the queued upstream status, while
 * recording the auth key each upstream call carried. OpenAI format carries the
 * key in `Authorization: Bearer <key>`; the Anthropic same-format fast path
 * carries it in `x-api-key` — both are captured so the rebound key can be pinned
 * regardless of provider format.
 */
function stubFetchSequence(statuses: number[]): {
  upstreamCalls: () => number;
  keysSeen: () => string[];
  restore: () => void;
} {
  const realFetch = globalThis.fetch.bind(globalThis);
  let idx = 0;
  let upstream = 0;
  const keysSeen: string[] = [];
  const fetchSpy = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const href =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (href.includes('127.0.0.1') || href.includes('localhost')) {
      return realFetch(input as RequestInfo, init);
    }
    // Record the auth key this upstream call carried (Bearer or x-api-key).
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const bearer = (headers['Authorization'] ?? headers['authorization'] ?? '')
      .replace(/^Bearer\s+/i, '')
      .trim();
    const xApiKey = (headers['x-api-key'] ?? headers['X-Api-Key'] ?? '').trim();
    keysSeen.push(bearer || xApiKey);
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
    keysSeen: () => keysSeen,
    restore: () => (globalThis.fetch = realFetch as unknown as typeof globalThis.fetch),
  };
}

describe('ProviderProxy BYO REAL-pool failover (resolvePoolBoundKey two-gate seam)', () => {
  let proxy: ProviderProxy;
  let baseUrl: string;
  const pools: ApiKeyPoolService[] = [];

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
    for (const p of pools.splice(0)) p.dispose();
  });

  function bearer(token: string): Record<string, string> {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  }

  function chatRoute(sessionId: string | null): RouteContext {
    return {
      sessionId,
      targetProviderFormat: 'transform',
      model: 'gpt-5',
      ingressFormat: 'openai-chat',
      authMode: 'byo',
      providerId: 'openai-prov',
    };
  }

  it('seeds a binding to k1 on the first request, then 429 → cool k1 + re-bind k2 → retry → 200 (upstream 2nd call carries k2)', async () => {
    const { pool } = makeRealPool([keyEntry('k1', 'key-1'), keyEntry('k2', 'key-2')]);
    pools.push(pool);
    await startProxy({ llmConfig: makeLlmConfig(), apiKeyPool: pool });
    const { upstreamCalls, keysSeen, restore } = stubFetchSequence([429, 200]);
    try {
      const sessionId = 'outbound:K1';
      const token = proxy.addRoute(chatRoute(sessionId));

      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: bearer(token),
        body: JSON.stringify({ model: 'cli-model', messages: [{ role: 'user', content: 'hi' }] }),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok?: boolean };
      expect(json.ok).toBe(true);

      // Retry-once: two upstream fetches.
      expect(upstreamCalls()).toBe(2);
      // The binding was seeded (gate 2) so reportError actually rotated. The
      // first upstream call used the seeded key; the second used the re-bound key.
      const seen = keysSeen();
      expect(seen.length).toBe(2);
      expect(seen[0]).not.toBe(seen[1]); // rotated
      // The rotated key is the OTHER one of the two.
      expect(new Set(seen)).toEqual(new Set(['key-1', 'key-2']));

      // The key bound first must now be cooling in getKeyHealth.
      const health = await pool.getKeyHealth('openai-prov');
      const coolingIds = Object.keys(health);
      expect(coolingIds.length).toBe(1);
      const cooling = health[coolingIds[0]];
      expect(cooling.lastStatus).toBe(429);
      expect(cooling.until).toBeGreaterThan(Date.now());
    } finally {
      restore();
    }
  });

  it('401 → auto-disable k1 + re-bind k2 → retry → 200', async () => {
    const { pool, disabledIds } = makeRealPool([keyEntry('k1', 'key-1'), keyEntry('k2', 'key-2')]);
    pools.push(pool);
    await startProxy({ llmConfig: makeLlmConfig(), apiKeyPool: pool });
    const { upstreamCalls, keysSeen, restore } = stubFetchSequence([401, 200]);
    try {
      const token = proxy.addRoute(chatRoute('outbound:K1'));

      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: bearer(token),
        body: JSON.stringify({ model: 'cli-model', messages: [{ role: 'user', content: 'hi' }] }),
      });

      expect(res.status).toBe(200);
      expect(upstreamCalls()).toBe(2);
      // The first-seeded key was auto-disabled and the session re-bound.
      expect(disabledIds().length).toBe(1);
      const seen = keysSeen();
      expect(seen[0]).not.toBe(seen[1]);
      expect(new Set(seen)).toEqual(new Set(['key-1', 'key-2']));
    } finally {
      restore();
    }
  });

  it('stable synthesized id → N requests keep sessionBindings bounded to one entry (per-key, not per-request)', async () => {
    const { pool } = makeRealPool([keyEntry('k1', 'key-1'), keyEntry('k2', 'key-2')]);
    pools.push(pool);
    await startProxy({ llmConfig: makeLlmConfig(), apiKeyPool: pool });
    const { restore } = stubFetchSequence([200]);
    try {
      const sessionId = 'outbound:K1';
      for (let i = 0; i < 4; i += 1) {
        const token = proxy.addRoute(chatRoute(sessionId));
        const res = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: bearer(token),
          body: JSON.stringify({ model: 'cli-model', messages: [] }),
        });
        expect(res.status).toBe(200);
        proxy.removeRoute(token);
      }
      // The synthesized id is stable, so the same single binding is reused —
      // sessionBindings does NOT grow with request count (bounded-memory invariant).
      const bindings = (pool as unknown as { sessionBindings: Map<string, unknown> })
        .sessionBindings;
      expect(bindings.size).toBe(1);
      expect(bindings.has(sessionId)).toBe(true);
    } finally {
      restore();
    }
  });

  it('single-key pool → upstream gets the one key + exactly one upstream call (no false rotation)', async () => {
    const { pool } = makeRealPool([keyEntry('only', 'the-only-key')]);
    pools.push(pool);
    await startProxy({ llmConfig: makeLlmConfig(), apiKeyPool: pool });
    const { upstreamCalls, keysSeen, restore } = stubFetchSequence([200]);
    try {
      const token = proxy.addRoute(chatRoute('outbound:K1'));
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: bearer(token),
        body: JSON.stringify({ model: 'cli-model', messages: [] }),
      });
      expect(res.status).toBe(200);
      expect(upstreamCalls()).toBe(1);
      expect(keysSeen()).toEqual(['the-only-key']);
    } finally {
      restore();
    }
  });

  it('pool-null route (sessionId === null) → no pool interaction + exactly one upstream call (byte-identical to pre-seam)', async () => {
    // The pool exists but the ROUTE carries no sessionId (the router only
    // synthesizes one when apiKeyPool is wired; here we model the pool-null
    // semantics by leaving sessionId null on the route — resolvePoolBoundKey
    // then never calls getKeyForSession and falls back to the row key).
    const { pool } = makeRealPool([keyEntry('k1', 'key-1'), keyEntry('k2', 'key-2')]);
    pools.push(pool);
    const getKeySpy = vi.spyOn(pool, 'getKeyForSession');
    const reportErrSpy = vi.spyOn(pool, 'reportError');
    const reportOkSpy = vi.spyOn(pool, 'reportSuccess');
    await startProxy({ llmConfig: makeLlmConfig(), apiKeyPool: pool });
    const { upstreamCalls, keysSeen, restore } = stubFetchSequence([200]);
    try {
      const token = proxy.addRoute(chatRoute(null));
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: bearer(token),
        body: JSON.stringify({ model: 'cli-model', messages: [] }),
      });
      expect(res.status).toBe(200);
      expect(upstreamCalls()).toBe(1);
      // Row key, not a pool key.
      expect(keysSeen()).toEqual(['sk-row-default']);
      // null sessionId → never seeds a binding and onResult short-circuits.
      expect(getKeySpy).not.toHaveBeenCalled();
      expect(reportErrSpy).not.toHaveBeenCalled();
      expect(reportOkSpy).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  /** Anthropic-messages BYO route → built-in factory-less ingress → same-format
   *  VERBATIM fast path (provider apiFormat === 'anthropic'). */
  function anthropicRoute(sessionId: string | null): RouteContext {
    return {
      sessionId,
      targetProviderFormat: 'anthropic',
      model: 'claude-x',
      ingressFormat: 'anthropic-messages',
      authMode: 'byo',
      providerId: 'anthropic-prov',
    };
  }

  // REGRESSION (review round 1): the same-format VERBATIM path bypasses
  // `auth.applyHeaders` and builds `x-api-key` from the plan's key. Before the fix
  // the 429 retry re-sent the STALE first-choice key (plan.apiKey is frozen to
  // k1); the rebind retry now threads `outcome.newKey` explicitly via
  // `runOnce(newKey)` → `keyOverride` so the retry carries the rotated k2.
  it('anthropic same-format BYO: 429 → rebind → VERBATIM retry sends the ROTATED key k2 (not stale k1)', async () => {
    const { pool } = makeRealPool([keyEntry('k1', 'akey-1'), keyEntry('k2', 'akey-2')]);
    pools.push(pool);
    await startProxy({ llmConfig: makeLlmConfig(), apiKeyPool: pool });
    const { upstreamCalls, keysSeen, restore } = stubFetchSequence([429, 200]);
    try {
      const token = proxy.addRoute(anthropicRoute('outbound:K1'));

      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: bearer(token),
        body: JSON.stringify({
          model: 'cli',
          max_tokens: 16,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });

      expect(res.status).toBe(200);
      // Retry-once on the verbatim same-format path.
      expect(upstreamCalls()).toBe(2);
      const seen = keysSeen();
      expect(seen.length).toBe(2);
      // First call = seeded k1 (via x-api-key); retry MUST carry the rotated k2.
      expect(seen[0]).toBe('akey-1');
      expect(seen[1]).toBe('akey-2');
      // k1 cooling after the 429.
      const health = await pool.getKeyHealth('anthropic-prov');
      expect(health['k1']).toBeDefined();
      expect(health['k1'].lastStatus).toBe(429);
      expect(health['k1'].until).toBeGreaterThan(Date.now());
      expect(health['k2']).toBeUndefined();
    } finally {
      restore();
    }
  });
});
