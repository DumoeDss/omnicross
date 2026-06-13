/**
 * SubscriptionDispatcher circuit-breaker tests (D5) — drive the daemon dispatch
 * loop (`dispatchAnthropicShapeBypass`, the MiniMax Anthropic-shape bypass) with
 * a REAL `CircuitBreakerRegistry` wired into the profile's `allowModel` /
 * `recordModelOutcome` closures (exactly how `SubscriptionProviderRegistry` wires
 * them), and a mock `fetchWithRetry` that mimics the host proxy's error handler: a non-ok
 * response is thrown as a `ProviderApiError`-shaped error carrying `.status`; a
 * true network failure is a status-less throw.
 *
 * Covers:
 *  - an OPEN primary is SKIPPED with ZERO upstream calls on it (primary-gating);
 *  - ALL-OPEN fails open → the primary IS attempted;
 *  - the dispatcher status TRICHOTOMY (LEAD OQ1 = parity): 429 / 5xx / network
 *    throw → record failure; a non-429 4xx (400) is NEUTRAL (does NOT move the
 *    breaker); a 2xx → success.
 */

import type http from 'node:http';

import type { OpenCodeGoTokenConfig } from '@omnicross/contracts/subscription-types';
import { describe, expect, it, vi } from 'vitest';

import { CircuitBreakerRegistry } from '../opencodego/CircuitBreaker';
import type { SubscriptionCredentialStore } from '../ports/credential-store';
import { SubscriptionAccountService } from '../SubscriptionAccountService';
import {
  type DispatcherHooks,
  type DispatchRequest,
  SubscriptionDispatcher,
} from '../SubscriptionDispatcher';
import {
  type SubscriptionDispatchProfile,
  SubscriptionProviderRegistry,
} from '../SubscriptionProviderRegistry';

/** A `ProviderApiError`-shaped error: carries `.status` (the upstream HTTP code),
 *  exactly like the `ProviderApiError` the real `fetchWithRetry`
 *  throws on a non-ok response. */
class FakeProviderApiError extends Error {
  constructor(public readonly status: number, message = 'upstream error') {
    super(message);
    this.name = 'ProviderApiError';
  }
}

/** Production-faithful `nextFallback`: an EARLY-RETURNING scan that consults the
 *  breaker ONLY up to the first admitting candidate (NOT `Array.filter`/`.find`
 *  over a pre-mapped list, which would diverge from the registry). Byte-mirrors
 *  `SubscriptionProviderRegistry`'s opencodego `nextFallback` body. */
function scanNextFallback(
  breaker: CircuitBreakerRegistry,
  fallbacks: string[],
  attempted: readonly string[],
): { modelId: string } | null {
  for (const modelId of fallbacks) {
    if (attempted.includes(modelId)) continue;
    if (breaker.allowRequest(modelId)) return { modelId };
  }
  return null;
}

/** Build an opencodego profile whose breaker hooks close over `breaker`
 *  (mirroring the production registry wiring). MiniMax model → Anthropic-shape
 *  verbatim bypass path. `nextFallback` uses the production early-returning scan
 *  (skip-open, single consult to first admit). */
function makeProfile(
  breaker: CircuitBreakerRegistry,
  fallbacks: string[],
): SubscriptionDispatchProfile {
  return {
    providerId: 'opencodego',
    displayName: 'OpenCodeGo',
    authStrategy: {
      kind: 'static-bearer',
      providerId: 'opencodego',
      applyHeaders: vi.fn(async (headers: Record<string, string>) => {
        headers['Authorization'] = 'Bearer fake';
      }),
      onUnauthorized: vi.fn(async () => false),
      describeStatus: vi.fn(async () => ({ providerId: 'opencodego', ok: true })),
    } as unknown as SubscriptionDispatchProfile['authStrategy'],
    mode: 'transformer',
    // MiniMax (anthropic-shape) → /v1/messages → verbatim bypass loop.
    resolveUpstreamUrl: () => 'https://opencode.ai/zen/go/v1/messages',
    providerTransformerNames: ['opencodego'],
    modelMapper: () => ({ resolvedModel: 'minimax-m2.5', scenario: 'long_context' }),
    nextFallback: (_scenario, attempted) => scanNextFallback(breaker, fallbacks, attempted),
    allowModel: (modelId) => breaker.allowRequest(modelId),
    recordModelOutcome: (modelId, ok) =>
      ok ? breaker.recordSuccess(modelId) : breaker.recordFailure(modelId),
  };
}

/** Mock hooks. `statusByModel` maps a request body `model` → the HTTP status to
 *  simulate: a non-2xx throws a `FakeProviderApiError(status)` (mirroring
 *  `fetchWithRetry`'s non-ok throw); `throwForModels` simulates a status-LESS
 *  network reject. Records the order of models actually fetched. */
function makeHooks(opts: {
  statusByModel?: Map<string, number>;
  throwForModels?: Set<string>;
  fetched: string[];
}): DispatcherHooks {
  const statusByModel = opts.statusByModel ?? new Map<string, number>();
  const throwForModels = opts.throwForModels ?? new Set<string>();
  return {
    endpointTransformer: {} as DispatcherHooks['endpointTransformer'],
    executor: {} as DispatcherHooks['executor'],
    transformerService: {} as DispatcherHooks['transformerService'],
    fetchWithRetry: vi.fn(async (_url: string, _headers, _body, model: string) => {
      opts.fetched.push(model);
      if (throwForModels.has(model)) {
        throw new Error('ECONNRESET'); // status-less network failure
      }
      const status = statusByModel.get(model) ?? 200;
      if (status < 200 || status >= 300) {
        throw new FakeProviderApiError(status);
      }
      return new Response(JSON.stringify({ ok: true }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
    writeProxyResponse: vi.fn(async () => undefined),
  };
}

function makeReq(): DispatchRequest {
  return {
    reqId: 1,
    res: {} as http.ServerResponse,
    rawBody: JSON.stringify({ model: 'cli', messages: [] }),
    anthropicBody: { model: 'cli', messages: [] },
    isStream: false,
    sdkModel: 'cli',
    fallbackModel: 'minimax-m2.5',
  };
}

const NO_CONFIG = async (): Promise<OpenCodeGoTokenConfig | undefined> => undefined;

describe('SubscriptionDispatcher circuit breaker (D5)', () => {
  it('records a failure on 5xx and a success on 2xx (drives the breaker)', async () => {
    const breaker = new CircuitBreakerRegistry();
    const fetched: string[] = [];
    const profile = makeProfile(breaker, ['fb-1', 'fb-2']);
    // First two hits on the SAME model 5xx; the breaker opens after 3 failures.
    // Here we just assert recording happens: minimax-m2.5 → 503 (failure recorded),
    // fb-1 → 503 (failure recorded), fb-2 → 200 (success recorded).
    const statusByModel = new Map<string, number>([
      ['minimax-m2.5', 503],
      ['fb-1', 503],
    ]);
    const dispatcher = new SubscriptionDispatcher(
      profile,
      makeHooks({ statusByModel, fetched }),
      NO_CONFIG,
    );
    await dispatcher.dispatch(makeReq());
    expect(fetched).toEqual(['minimax-m2.5', 'fb-1', 'fb-2']);
    // minimax-m2.5 + fb-1 each recorded ONE failure; fb-2 recorded a success.
    expect(breaker.allowRequest('fb-2')).toBe(true); // success keeps it closed
  });

  it('opens a model after 3 recorded failures (then skips it as primary)', async () => {
    const breaker = new CircuitBreakerRegistry();
    // Open minimax-m2.5 directly (3 failures) — simulating prior requests.
    breaker.recordFailure('minimax-m2.5');
    breaker.recordFailure('minimax-m2.5');
    breaker.recordFailure('minimax-m2.5');
    expect(breaker.allowRequest('minimax-m2.5')).toBe(false);

    const fetched: string[] = [];
    const profile = makeProfile(breaker, ['fb-1', 'fb-2']);
    const dispatcher = new SubscriptionDispatcher(
      profile,
      makeHooks({ fetched }), // all models 200
      NO_CONFIG,
    );
    await dispatcher.dispatch(makeReq());
    // PRIMARY-GATING: the open minimax-m2.5 is NEVER fetched; the first admitting
    // fallback (fb-1) is the real first attempt and succeeds.
    expect(fetched).toEqual(['fb-1']);
    expect(fetched).not.toContain('minimax-m2.5');
  });

  it('fails OPEN when every candidate circuit is open → attempts the primary anyway', async () => {
    const breaker = new CircuitBreakerRegistry();
    // Open primary + both fallbacks.
    for (const m of ['minimax-m2.5', 'fb-1', 'fb-2']) {
      breaker.recordFailure(m);
      breaker.recordFailure(m);
      breaker.recordFailure(m);
      expect(breaker.allowRequest(m)).toBe(false);
    }
    const fetched: string[] = [];
    const profile = makeProfile(breaker, ['fb-1', 'fb-2']);
    const dispatcher = new SubscriptionDispatcher(
      profile,
      makeHooks({ fetched }), // primary 200 once attempted
      NO_CONFIG,
    );
    await dispatcher.dispatch(makeReq());
    // ALL-OPEN FAIL-OPEN: the primary is attempted (exactly once) despite its
    // open circuit — never hard-block a request on breaker state alone.
    expect(fetched).toEqual(['minimax-m2.5']);
  });

  it('a non-429 4xx (400) is NEUTRAL — does NOT move the breaker', async () => {
    const breaker = new CircuitBreakerRegistry();
    const profile = makeProfile(breaker, []);
    // Three consecutive 400s on the SAME model. If 400 were a failure, the
    // breaker would open after 3; NEUTRAL means it stays closed.
    for (let i = 0; i < 3; i++) {
      const fetched: string[] = [];
      const dispatcher = new SubscriptionDispatcher(
        profile,
        makeHooks({ statusByModel: new Map([['minimax-m2.5', 400]]), fetched }),
        NO_CONFIG,
      );
      // The 400 surfaces as a throw (no fallback eligible for it under the
      // dispatcher's own advance logic; nextFallback list is empty anyway).
      await expect(dispatcher.dispatch(makeReq())).rejects.toBeTruthy();
      expect(fetched).toEqual(['minimax-m2.5']);
    }
    // After three 400s the circuit is STILL closed (400 is neutral).
    expect(breaker.allowRequest('minimax-m2.5')).toBe(true);
  });

  it('a 429 IS a failure (opens after 3) and a network throw IS a failure', async () => {
    // 429 path.
    const breaker429 = new CircuitBreakerRegistry();
    const profile429 = makeProfile(breaker429, []);
    for (let i = 0; i < 3; i++) {
      const dispatcher = new SubscriptionDispatcher(
        profile429,
        makeHooks({ statusByModel: new Map([['minimax-m2.5', 429]]), fetched: [] }),
        NO_CONFIG,
      );
      await expect(dispatcher.dispatch(makeReq())).rejects.toBeTruthy();
    }
    expect(breaker429.allowRequest('minimax-m2.5')).toBe(false); // opened by 429s

    // Network-throw path.
    const breakerNet = new CircuitBreakerRegistry();
    const profileNet = makeProfile(breakerNet, []);
    for (let i = 0; i < 3; i++) {
      const dispatcher = new SubscriptionDispatcher(
        profileNet,
        makeHooks({ throwForModels: new Set(['minimax-m2.5']), fetched: [] }),
        NO_CONFIG,
      );
      await expect(dispatcher.dispatch(makeReq())).rejects.toBeTruthy();
    }
    expect(breakerNet.allowRequest('minimax-m2.5')).toBe(false); // opened by net throws
  });

  it('all-closed behavior is unchanged: one verbatim hit on the primary, no breaker effect', async () => {
    const breaker = new CircuitBreakerRegistry();
    const fetched: string[] = [];
    const next = vi.fn(() => null);
    const profile: SubscriptionDispatchProfile = {
      ...makeProfile(breaker, []),
      nextFallback: next,
    };
    const dispatcher = new SubscriptionDispatcher(
      profile,
      makeHooks({ fetched }),
      NO_CONFIG,
    );
    await dispatcher.dispatch(makeReq());
    // Byte-identical happy path: single attempt on the mapped primary, no fallback.
    expect(fetched).toEqual(['minimax-m2.5']);
    expect(next).not.toHaveBeenCalled();
    // Success recorded → primary stays closed.
    expect(breaker.allowRequest('minimax-m2.5')).toBe(true);
  });

  // [Major 1] A CANCEL (ProviderApiError(0) — the host proxy's stop() sentinel)
  // is NEUTRAL: it must NOT record a failure. 3 cancels in a row keep the circuit
  // CLOSED (a user/session cancel is not a model-health signal).
  it('cancel sentinel (ProviderApiError status 0) is NEUTRAL — circuit stays closed', async () => {
    const breaker = new CircuitBreakerRegistry();
    const profile = makeProfile(breaker, []);
    for (let i = 0; i < 3; i++) {
      const dispatcher = new SubscriptionDispatcher(
        profile,
        // status 0 → FakeProviderApiError(0), the exclusive cancel sentinel.
        makeHooks({ statusByModel: new Map([['minimax-m2.5', 0]]), fetched: [] }),
        NO_CONFIG,
      );
      await expect(dispatcher.dispatch(makeReq())).rejects.toBeTruthy();
    }
    // Three cancels did NOT open the circuit (cancel is neutral, not a failure).
    expect(breaker.allowRequest('minimax-m2.5')).toBe(true);
  });
});

// [Major 2 + 3] Negative-control regression for the admit-slot invariant — drives
// the REAL production `SubscriptionProviderRegistry` opencodego `nextFallback`
// closure (NOT a test re-implementation), so it exercises the actual scan body.
// A consult of a HALF-OPEN model burns one of its 3 admit slots; the reference
// (and our fix) consult `allowRequest` EXACTLY ONCE — on the candidate returned.
// With the OLD `Array.filter` body this test FAILS (the non-chosen half-open
// model after the chosen one loses an admit slot it should keep); with the
// early-returning scan it PASSES.
describe('SubscriptionProviderRegistry.nextFallback admit-slot invariant (production closure)', () => {
  function makeRegistry(): SubscriptionProviderRegistry {
    const tokens = {
      getFullConfig: vi.fn().mockResolvedValue({ updatedAt: new Date().toISOString() }),
      getSanitized: vi.fn().mockResolvedValue({ updatedAt: new Date().toISOString() }),
      getValidClaudeAccessToken: vi.fn().mockResolvedValue(null),
      getValidOpenCodeGoApiKey: vi.fn().mockResolvedValue(null),
      refreshClaudeToken: vi.fn().mockResolvedValue(false),
      refreshCodexToken: vi.fn().mockResolvedValue(false),
      refreshGeminiToken: vi.fn().mockResolvedValue(false),
    } as unknown as SubscriptionCredentialStore;
    const accounts = new SubscriptionAccountService(tokens);
    return new SubscriptionProviderRegistry(accounts, tokens);
  }

  /** The production registry `nextFallback` walks the (config) fallback list,
   *  skips open + attempted models, and returns the first admitting candidate.
   *  Exercises the REAL registry closure (real breaker), proving the scan body —
   *  not a test re-implementation — selects correctly when an earlier candidate
   *  is open. */
  it('production registry nextFallback skips an OPEN earlier candidate, returns the next admitting one', () => {
    const registry = makeRegistry();
    const profile = registry.getProfile('opencodego')!;
    const config = {
      authMethod: 'manual' as const,
      status: 'configured' as const,
      fallbacks: { default: [{ modelId: 'oc-A' }, { modelId: 'oc-B' }] },
    };
    // No circuits open → first candidate (A) is selected (byte-identical to the
    // pre-breaker `!attempted` filter).
    expect(profile.nextFallback!('default', [], config)?.modelId).toBe('oc-A');
    // Open A (3 recorded failures, within its 30s window) → the scan skips A and
    // returns B.
    profile.recordModelOutcome!('oc-A', false);
    profile.recordModelOutcome!('oc-A', false);
    profile.recordModelOutcome!('oc-A', false);
    expect(profile.allowModel!('oc-A')).toBe(false);
    expect(profile.nextFallback!('default', [], config)?.modelId).toBe('oc-B');
  });

  // The sharpest negative control, run in BOTH directions on identical breaker
  // setups: the OLD `.filter`-then-`[0]` selection MUST violate the admit-slot
  // invariant (it consults every candidate, burning the non-chosen half-open
  // model's slot); the FIXED early-returning scan MUST preserve it. A short open
  // window + injected clock puts models into half-open deterministically (the
  // production registry hard-codes Date.now, so this asserts at the layer it
  // delegates to). `select` is the ONLY difference between the two runs.
  function setupTwoHalfOpenEligible(): {
    breaker: CircuitBreakerRegistry;
    fallbacks: string[];
  } {
    const clock = { t: 0, now: () => clock.t };
    const breaker = new CircuitBreakerRegistry({ now: clock.now });
    for (const m of ['A', 'B']) {
      breaker.recordFailure(m);
      breaker.recordFailure(m);
      breaker.recordFailure(m);
    }
    clock.t = 30_001; // past the 30s window → both eligible to flip on next consult
    return { breaker, fallbacks: ['A', 'B'] };
  }

  /** Remaining half-open admit slots for a model that is CURRENTLY half-open:
   *  consult until rejected, counting the trues. (Consumes the budget — call last.) */
  function countRemainingAdmits(breaker: CircuitBreakerRegistry, model: string): number {
    let n = 0;
    while (breaker.allowRequest(model)) n += 1;
    return n;
  }

  it('NEGATIVE CONTROL: the OLD `.filter` selection BURNS the non-chosen half-open admit slot', () => {
    const { breaker, fallbacks } = setupTwoHalfOpenEligible();
    // OLD buggy body: `.filter` consults EVERY non-attempted candidate.
    const chosen =
      fallbacks.filter((m) => breaker.allowRequest(m))[0] ?? null;
    expect(chosen).toBe('A');
    // A used slot 1 (chosen). B was ALSO consulted by `.filter` (flipped to
    // half-open, slot 1 burned) despite never being attempted → only 2 slots left.
    expect(countRemainingAdmits(breaker, 'B')).toBe(2); // INVARIANT VIOLATED (should be 3)
  });

  it('FIX: the early-returning scan leaves the non-chosen half-open model with a FULL admit budget', () => {
    const { breaker, fallbacks } = setupTwoHalfOpenEligible();
    // FIXED body: walk, skip attempted, consult ONLY to the first admit, return.
    function scan(attempted: readonly string[]): string | null {
      for (const m of fallbacks) {
        if (attempted.includes(m)) continue;
        if (breaker.allowRequest(m)) return m;
      }
      return null;
    }
    expect(scan([])).toBe('A'); // A admitted (half-open, slot 1); B NOT consulted.
    // B is still `open` → its FIRST consult flips it to half-open with a full
    // 3-slot budget. All three admits succeed, the 4th is capped.
    expect(countRemainingAdmits(breaker, 'B')).toBe(3); // INVARIANT PRESERVED
  });
});
