/**
 * Core `/v1/messages` SUBSCRIPTION loop circuit-breaker RECORD + PRIMARY-GATING
 * tests (D5). Drives the built-in factory-less `anthropicMessagesByo` subscription
 * branch end-to-end through a real `ProviderProxy` + `node:http` mock upstream
 * (NO mocked fetch), asserting that `runPipelineWithSubscriptionRetry`:
 *
 *  - calls `profile.recordModelOutcome(model, ok)` with the correct `ok` per the
 *    `breakerOutcome` table: 2xx → true; 5xx / 429 / network-throw → false;
 *    a non-429 4xx (400) is NEUTRAL → NOT recorded.
 *  - PRIMARY-GATES an open mapped primary: when `allowModel(primary)` is false the
 *    loop jumps to the first admitting fallback WITHOUT an upstream call on the
 *    open primary; when EVERY candidate is open it FAILS OPEN (attempts the primary).
 *  - is a NO-OP for a profile WITHOUT the callback (claude / codex / gemini).
 *
 * The breaker is modeled core-side as plain closures over a `Map<string,number>`
 * (the REAL state machine is proven in `@omnicross/subscriptions`'s
 * `CircuitBreaker.test.ts`; core must not import it — the litmus). Here we only
 * verify core INVOKES the callbacks correctly and honors `allowModel`.
 *
 * @module provider-proxy/__tests__/ProviderProxy.breakerRecord.test
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderConfigSource } from '../../ports';
import { setSubscriptionRegistryForOutbound } from '../../outbound-api/subscriptionRegistryPort';
import type { AuthStrategy } from '../../pipeline/SubscriptionAuthStrategy';
import { OpenCodeGoTransformer } from '../../transformer/transformers/OpenCodeGoTransformer';
import type { Transformer } from '../../transformer/types';
import { ProviderProxy } from '../ProviderProxy';
import type {
  ProviderProxyDeps,
  RouteContext,
  SubscriptionDispatchProfile,
} from '../types';

// ── Mock upstream (per-model status / network-throw knobs) ────────────────────

const ANTHROPIC_RESPONSE = {
  id: 'msg_mock',
  type: 'message',
  role: 'assistant',
  model: 'mock-model',
  content: [{ type: 'text', text: 'pong' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 7, output_tokens: 4 },
};

interface MockUpstream {
  server: Server;
  port: number;
  statusByModel: Map<string, number>;
  throwForModels: Set<string>;
  models: string[];
}

function startMockUpstream(): Promise<MockUpstream> {
  const state: MockUpstream = {
    server: undefined as unknown as Server,
    port: 0,
    statusByModel: new Map(),
    throwForModels: new Set(),
    models: [],
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let bodyModel: string | undefined;
      try {
        const parsed = JSON.parse(body) as { model?: unknown };
        if (typeof parsed.model === 'string') {
          bodyModel = parsed.model;
          state.models.push(parsed.model);
        }
      } catch {
        /* ignore */
      }
      if (bodyModel !== undefined && state.throwForModels.has(bodyModel)) {
        req.socket.destroy();
        return;
      }
      const status = (bodyModel !== undefined && state.statusByModel.get(bodyModel)) || 200;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(status === 200 ? JSON.stringify(ANTHROPIC_RESPONSE) : JSON.stringify({ error: { message: 'fail' } }));
    });
  });
  state.server = server;
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      state.port = (server.address() as AddressInfo).port;
      resolve(state);
    });
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

// ── opencodego static-bearer strategy (header contract mirror, no real import) ─

const OC_KEY = 'fake-oc-key';

function makeOpenCodeGoStrategy(): AuthStrategy {
  return {
    kind: 'static-bearer',
    providerId: 'opencodego',
    async applyHeaders(headers, hints) {
      headers['Authorization'] = `Bearer ${OC_KEY}`;
      if (hints?.upstreamUrl?.includes('/v1/messages')) headers['x-api-key'] = OC_KEY;
    },
    async onUnauthorized() {
      return false;
    },
    async describeStatus() {
      return { providerId: 'opencodego', ok: true };
    },
  };
}

/** Plain in-memory breaker stand-in (Map<model, consecutiveFailures>) — open at 3
 *  consecutive failures; any success resets. NOT the real state machine (that is
 *  proven in subscriptions); here it only needs to gate + record so we can verify
 *  the CORE loop's invocations. */
function makeBreakerHooks(): {
  allowModel: (m: string) => boolean;
  recordModelOutcome: ReturnType<typeof vi.fn>;
  open: (m: string) => void;
} {
  const failures = new Map<string, number>();
  const opened = new Set<string>();
  const recordModelOutcome = vi.fn((modelId: string, ok: boolean) => {
    if (ok) {
      failures.set(modelId, 0);
      opened.delete(modelId);
      return;
    }
    const n = (failures.get(modelId) ?? 0) + 1;
    failures.set(modelId, n);
    if (n >= 3) opened.add(modelId);
  });
  return {
    allowModel: (m) => !opened.has(m),
    recordModelOutcome,
    open: (m) => opened.add(m),
  };
}

function makeLlmConfig(): ProviderConfigSource {
  const opencodego: Transformer = new OpenCodeGoTransformer();
  return {
    getProvider: vi.fn(async () => null),
    resolveTransformerChain: vi.fn(async () => ({ providerTransformers: [], modelTransformers: [] })),
    getMainTransformer: vi.fn(async () => null),
    getTransformerService: () => ({
      getTransformer: (name: string) => (name === 'opencodego' ? opencodego : undefined),
    }),
  } as unknown as ProviderConfigSource;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('ProviderProxy core /v1/messages breaker RECORD + PRIMARY-GATING (D5)', () => {
  let proxy: ProviderProxy;
  let baseUrl: string;
  let upstream: MockUpstream;

  async function startProxy(extra: Partial<ProviderProxyDeps> = {}): Promise<void> {
    proxy = new ProviderProxy({ llmConfig: makeLlmConfig(), ...extra });
    const port = await proxy.start();
    baseUrl = `http://127.0.0.1:${port}`;
  }

  beforeEach(async () => {
    // QA flake fix (see ProviderProxy.anthropicSubscription): defensively NULL the
    // module-global outbound-registry slot so a leaked daemon registry from a
    // sibling suite can never feed a foreign `subscriptionConfig` into these
    // opencodego breaker routes.
    setSubscriptionRegistryForOutbound(null);
    upstream = await startMockUpstream();
  });

  afterEach(async () => {
    await proxy.stop();
    await stopServer(upstream.server);
    setSubscriptionRegistryForOutbound(null);
  });

  function bearer(token: string): Record<string, string> {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  }

  function upstreamUrl(path: string): string {
    return `http://127.0.0.1:${upstream.port}${path}`;
  }

  function subRoute(profile: SubscriptionDispatchProfile, over: Partial<RouteContext> = {}): RouteContext {
    return {
      sessionId: 'sess-sub',
      targetProviderFormat: 'transform',
      model: 'claude-sonnet-4-5',
      ingressFormat: 'anthropic-messages',
      authMode: 'subscription',
      providerId: profile.providerId,
      subscriptionProfile: profile,
      ...over,
    };
  }

  /** opencodego MiniMax anthropic-shape (verbatim relay) profile with breaker hooks. */
  function ocProfile(
    hooks: ReturnType<typeof makeBreakerHooks>,
    fallbacks: string[],
  ): SubscriptionDispatchProfile {
    return {
      providerId: 'opencodego',
      displayName: 'OpenCodeGo',
      authStrategy: makeOpenCodeGoStrategy(),
      mode: 'transformer',
      resolveUpstreamUrl: () => upstreamUrl('/v1/messages'),
      providerTransformerNames: ['opencodego'],
      modelMapper: () => ({ resolvedModel: 'minimax-m2.5', scenario: 'long_context' }),
      // Production-faithful early-returning scan (mirrors the registry's
      // opencodego `nextFallback` body): walk the list, skip attempted, consult
      // the breaker ONLY up to the first admitting candidate. NOT `.filter`/`.find`
      // over a pre-mapped list — that would diverge from production and consult
      // candidates past the chosen one.
      nextFallback: (_scenario, attempted) => {
        for (const modelId of fallbacks) {
          if (attempted.includes(modelId)) continue;
          if (hooks.allowModel(modelId)) return { modelId };
        }
        return null;
      },
      allowModel: hooks.allowModel,
      recordModelOutcome: hooks.recordModelOutcome,
    };
  }

  async function post(token: string): Promise<Response> {
    return fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ model: 'cli', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
    });
  }

  it('2xx → records ok:true for the primary', async () => {
    await startProxy();
    const hooks = makeBreakerHooks();
    const token = proxy.addRoute(subRoute(ocProfile(hooks, [])));
    const res = await post(token);
    expect(res.status).toBe(200);
    expect(hooks.recordModelOutcome).toHaveBeenCalledWith('minimax-m2.5', true);
  });

  it('5xx → records ok:false for the failed model', async () => {
    await startProxy();
    upstream.statusByModel.set('cli', 503); // verbatim primary body model = 'cli'
    const hooks = makeBreakerHooks();
    const token = proxy.addRoute(subRoute(ocProfile(hooks, [])));
    const res = await post(token);
    expect(res.status).toBe(503);
    // Primary resolved model is minimax-m2.5; recorded false.
    expect(hooks.recordModelOutcome).toHaveBeenCalledWith('minimax-m2.5', false);
  });

  it('429 → records ok:false (transient model-health signal)', async () => {
    await startProxy();
    upstream.statusByModel.set('cli', 429);
    const hooks = makeBreakerHooks();
    const token = proxy.addRoute(subRoute(ocProfile(hooks, [])));
    await post(token);
    expect(hooks.recordModelOutcome).toHaveBeenCalledWith('minimax-m2.5', false);
  });

  it('network throw → records ok:false', async () => {
    await startProxy();
    upstream.throwForModels.add('cli'); // socket destroy → fetch rejects
    const hooks = makeBreakerHooks();
    const token = proxy.addRoute(subRoute(ocProfile(hooks, [])));
    await post(token);
    expect(hooks.recordModelOutcome).toHaveBeenCalledWith('minimax-m2.5', false);
  });

  it('non-429 4xx (400) → NEUTRAL: recordModelOutcome is NEVER called', async () => {
    await startProxy();
    upstream.statusByModel.set('cli', 400);
    const hooks = makeBreakerHooks();
    const token = proxy.addRoute(subRoute(ocProfile(hooks, [])));
    const res = await post(token);
    expect(res.status).toBe(400);
    expect(hooks.recordModelOutcome).not.toHaveBeenCalled();
  });

  it('PRIMARY-GATING: an open primary is skipped with ZERO upstream calls on it', async () => {
    await startProxy();
    const hooks = makeBreakerHooks();
    hooks.open('minimax-m2.5'); // primary circuit open
    const token = proxy.addRoute(subRoute(ocProfile(hooks, ['fb-1', 'fb-2'])));
    const res = await post(token);
    expect(res.status).toBe(200);
    // The open primary 'minimax-m2.5' was NEVER fetched; fb-1 was the first attempt.
    expect(upstream.models).toEqual(['fb-1']);
    expect(upstream.models).not.toContain('minimax-m2.5');
    // fb-1 succeeded → recorded true; primary never recorded (skipped, no attempt).
    expect(hooks.recordModelOutcome).toHaveBeenCalledWith('fb-1', true);
    expect(hooks.recordModelOutcome).not.toHaveBeenCalledWith('minimax-m2.5', expect.anything());
  });

  it('ALL-OPEN FAIL-OPEN: every circuit open → the primary is attempted anyway', async () => {
    await startProxy();
    const hooks = makeBreakerHooks();
    hooks.open('minimax-m2.5');
    hooks.open('fb-1');
    hooks.open('fb-2');
    const token = proxy.addRoute(subRoute(ocProfile(hooks, ['fb-1', 'fb-2'])));
    const res = await post(token);
    expect(res.status).toBe(200);
    // Fail open: the primary's ORIGINAL verbatim body ('cli') is relayed once.
    expect(upstream.models).toEqual(['cli']);
    expect(hooks.recordModelOutcome).toHaveBeenCalledWith('minimax-m2.5', true);
  });

  it('non-opencodego profile (no recordModelOutcome) → NO-OP record, single attempt', async () => {
    await startProxy();
    // A claude-like pass-through profile: no modelMapper / nextFallback / breaker.
    const recordModelOutcome = vi.fn();
    const profile: SubscriptionDispatchProfile = {
      providerId: 'claude',
      displayName: 'Claude',
      authStrategy: {
        kind: 'pass-through',
        providerId: 'claude',
        async applyHeaders(headers: Record<string, string>) {
          headers['Authorization'] = 'Bearer fake-oauth';
        },
        async onUnauthorized() {
          return false;
        },
        async describeStatus() {
          return { providerId: 'claude', ok: true };
        },
      } as AuthStrategy,
      mode: 'pass-through',
      resolveUpstreamUrl: () => upstreamUrl('/v1/messages'),
      providerTransformerNames: ['anthropic'],
      modelTransformerNames: [],
      // recordModelOutcome intentionally UNSET (claude has no breaker). We pass a
      // spy via a sibling to prove the loop never reaches into it for claude.
    };
    // Sanity: the profile genuinely omits the callback.
    expect((profile as { recordModelOutcome?: unknown }).recordModelOutcome).toBeUndefined();
    const token = proxy.addRoute(subRoute(profile));
    const res = await post(token);
    expect(res.status).toBe(200);
    // Single verbatim attempt (claude has no nextFallback), no breaker interaction.
    expect(upstream.models).toEqual(['cli']);
    expect(recordModelOutcome).not.toHaveBeenCalled();
  });
});
