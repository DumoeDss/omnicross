/**
 * SubscriptionDispatcher ZEN tests (opencodego-zen-provider, Phase 2 gate 2.4).
 *
 * Drives the daemon `/v1/responses` dispatch path for the four zen wire shapes
 * through the REAL registry profile (real `resolveUpstreamUrl` +
 * `resolveProviderTransformerNames`), the REAL `TransformerChainExecutor`, and the
 * REAL transformers (`openai-response`, `gemini`, `opencodego`) against an
 * in-process fake `fetchWithRetry` that records the FINAL url/headers/body. The
 * auth strategy mirrors `StaticBearerAuthStrategy` (Bearer always; + x-api-key iff
 * the URL contains `/v1/messages`).
 *
 * Asserts per shape: the upstream URL, the Bearer-only vs Bearer+x-api-key auth,
 * and that the resolved chain ran (the transformer-supplied `config.url` wins for
 * responses + gemini; the gemini per-model colon-method URL is built by the gemini
 * transformer). `// UNVERIFIED (no live zen key)` — the byte-acceptance of real
 * opencode-zen is proven only by the in-process fake; the wiring + the bytes we
 * control are real.
 */

import type http from 'node:http';

import type { OpenCodeGoTokenConfig } from '@omnicross/contracts/subscription-types';
import { getAnthropicEndpointTransformer, getSharedExecutor } from '@omnicross/core/provider-proxy/ingress/providerProxyShared';
import { GeminiTransformer } from '@omnicross/core/transformer/transformers/GeminiTransformer';
import { OpenAIResponseTransformer } from '@omnicross/core/transformer/transformers/OpenAIResponseTransformer';
import { OpenCodeGoTransformer } from '@omnicross/core/transformer/transformers/OpenCodeGoTransformer';
import type { Transformer } from '@omnicross/core/transformer/types';
import { describe, expect, it, vi } from 'vitest';

import type { SubscriptionCredentialStore } from '../ports/credential-store';
import { SubscriptionAccountService } from '../SubscriptionAccountService';
import {
  type DispatcherHooks,
  type DispatchRequest,
  SubscriptionDispatcher,
} from '../SubscriptionDispatcher';
import { SubscriptionProviderRegistry } from '../SubscriptionProviderRegistry';

const OC_KEY = 'fake-oc-zen-key';

/** Real transformers, looked up by name (the names the zen seam resolves to). */
const TRANSFORMERS: Record<string, Transformer> = {
  'openai-response': new OpenAIResponseTransformer(),
  gemini: new GeminiTransformer(),
  opencodego: new OpenCodeGoTransformer(),
};

/** Canned wire responses the response chain decodes back toward the Anthropic
 *  wire (the dispatcher's endpoint transformer is `AnthropicTransformer`). */
const OPENAI_COMPLETION = {
  id: 'chatcmpl-mock',
  object: 'chat.completion',
  created: 1,
  model: 'mock',
  choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

const RESPONSES_PAYLOAD = {
  id: 'resp-mock',
  object: 'response',
  created_at: 1,
  status: 'completed',
  model: 'mock',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'pong' }] }],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
};

const GEMINI_PAYLOAD = {
  candidates: [{ content: { parts: [{ text: 'pong' }], role: 'model' }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
};

/** Pick a canned body for a recorded URL (branch like the boot-smoke mock). */
function cannedFor(url: string): unknown {
  if (url.includes('/v1/responses')) return RESPONSES_PAYLOAD;
  if (url.includes('/v1/models/')) return GEMINI_PAYLOAD;
  return OPENAI_COMPLETION;
}

interface Captured {
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

function mockTokens(config: OpenCodeGoTokenConfig): SubscriptionCredentialStore {
  return {
    getFullConfig: vi.fn().mockResolvedValue({ opencodego: config, updatedAt: 'x' }),
    getSanitized: vi.fn().mockResolvedValue({ updatedAt: 'x' }),
    getValidClaudeAccessToken: vi.fn().mockResolvedValue(null),
    getValidOpenCodeGoApiKey: vi.fn().mockResolvedValue(OC_KEY),
    refreshClaudeToken: vi.fn().mockResolvedValue(false),
    refreshCodexToken: vi.fn().mockResolvedValue(false),
    refreshGeminiToken: vi.fn().mockResolvedValue(false),
  } as unknown as SubscriptionCredentialStore;
}

/** A real registry built over the mock store (so the REAL opencodego profile +
 *  REAL StaticBearerAuthStrategy reading `getValidOpenCodeGoApiKey` are used). */
function makeRegistry(config: OpenCodeGoTokenConfig): SubscriptionProviderRegistry {
  const tokens = mockTokens(config);
  const accounts = new SubscriptionAccountService(tokens);
  return new SubscriptionProviderRegistry(accounts, tokens);
}

function makeHooks(captured: Captured): DispatcherHooks {
  return {
    endpointTransformer: getAnthropicEndpointTransformer(),
    executor: getSharedExecutor(),
    transformerService: {
      getTransformer: (name: string) => TRANSFORMERS[name],
    } as unknown as DispatcherHooks['transformerService'],
    fetchWithRetry: vi.fn(async (url: string, headers: Record<string, string>, body: unknown) => {
      captured.url = url;
      captured.headers = headers;
      captured.body = body;
      return new Response(JSON.stringify(cannedFor(url)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
    writeProxyResponse: vi.fn(async () => undefined),
  };
}

function makeReq(model: string, isStream = false): DispatchRequest {
  return {
    reqId: 1,
    res: {} as http.ServerResponse,
    rawBody: JSON.stringify({ model: 'cli', messages: [{ role: 'user', content: 'ping' }] }),
    anthropicBody: {
      model: 'cli',
      max_tokens: 16,
      stream: isStream,
      messages: [{ role: 'user', content: 'ping' }],
    },
    isStream,
    sdkModel: 'cli',
    fallbackModel: model,
  };
}

/** Build a zen config whose `default` scenario maps to a `provider:'zen'` model. */
function zenConfig(modelId: string): OpenCodeGoTokenConfig {
  return {
    authMethod: 'manual',
    status: 'configured',
    apiKey: OC_KEY,
    modelMap: { default: { modelId, provider: 'zen' } },
  };
}

async function dispatchZen(
  modelId: string,
  captured: Captured,
  isStream = false,
): Promise<void> {
  const config = zenConfig(modelId);
  const registry = makeRegistry(config);
  const profile = registry.getProfile('opencodego')!;
  const dispatcher = new SubscriptionDispatcher(
    profile,
    makeHooks(captured),
    async () => config,
  );
  await dispatcher.dispatch(makeReq(modelId, isStream));
}

describe('SubscriptionDispatcher zen shapes (daemon /v1/responses path)', () => {
  it('zen responses (gpt-5-codex) → /zen/v1/responses, Bearer-only, Responses body', async () => {
    const captured: Captured = {};
    await dispatchZen('gpt-5-codex', captured);
    expect(captured.url).toBe('https://opencode.ai/zen/v1/responses');
    expect(captured.headers?.Authorization ?? captured.headers?.authorization).toBe(`Bearer ${OC_KEY}`);
    expect(captured.headers?.['x-api-key']).toBeUndefined();
    // The openai-response chain re-encoded Unified → Responses (body has `input`).
    expect(captured.body).toBeTruthy();
    expect(JSON.stringify(captured.body)).toContain('input');
  });

  it('zen gemini (non-stream) → /zen/v1/models/{id}:generateContent, Bearer-only', async () => {
    const captured: Captured = {};
    await dispatchZen('gemini-3-flash', captured, false);
    // The gemini transformer's config.url WON (per-model colon-method, non-stream).
    expect(captured.url).toBe(
      'https://opencode.ai/zen/v1/models/gemini-3-flash:generateContent',
    );
    expect(captured.headers?.Authorization ?? captured.headers?.authorization).toBe(`Bearer ${OC_KEY}`);
    expect(captured.headers?.['x-api-key']).toBeUndefined();
  });

  it('zen gemini (stream) → :streamGenerateContent?alt=sse, Bearer-only', async () => {
    const captured: Captured = {};
    await dispatchZen('gemini-3-flash', captured, true);
    expect(captured.url).toBe(
      'https://opencode.ai/zen/v1/models/gemini-3-flash:streamGenerateContent?alt=sse',
    );
    expect(captured.headers?.Authorization ?? captured.headers?.authorization).toBe(`Bearer ${OC_KEY}`);
    expect(captured.headers?.['x-api-key']).toBeUndefined();
  });

  it('zen anthropic (claude) → verbatim bypass at /zen/v1/messages, Bearer + x-api-key', async () => {
    const captured: Captured = {};
    await dispatchZen('claude-sonnet-4.5', captured);
    expect(captured.url).toBe('https://opencode.ai/zen/v1/messages');
    expect(captured.headers?.Authorization ?? captured.headers?.authorization).toBe(`Bearer ${OC_KEY}`);
    // Anthropic-shape URL → StaticBearerAuthStrategy adds x-api-key.
    expect(captured.headers?.['x-api-key']).toBe(OC_KEY);
    // Verbatim bypass: the body is the (model-rewritten) Anthropic body, NOT a
    // transformer-encoded Responses/Chat body.
    expect((captured.body as { messages?: unknown }).messages).toBeTruthy();
  });

  it('zen chat (qwen3.6-plus) → opencodego chain at /zen/v1/chat/completions, Bearer-only', async () => {
    const captured: Captured = {};
    await dispatchZen('qwen3.6-plus', captured);
    expect(captured.url).toBe('https://opencode.ai/zen/v1/chat/completions');
    expect(captured.headers?.Authorization ?? captured.headers?.authorization).toBe(`Bearer ${OC_KEY}`);
    expect(captured.headers?.['x-api-key']).toBeUndefined();
  });

  // Minor (QA): zenBaseUrl override → the dispatched URL uses the override host
  // for a zen shape (the resolver picks the zen-half override slot).
  it('zenBaseUrl override → dispatched URL uses the override host (zen responses)', async () => {
    const captured: Captured = {};
    const config: OpenCodeGoTokenConfig = {
      authMethod: 'manual',
      status: 'configured',
      apiKey: OC_KEY,
      // A go-half override that must NOT leak onto the zen model.
      baseUrl: 'https://my-go.example.com',
      zenBaseUrl: 'https://my-zen.example.com',
      modelMap: { default: { modelId: 'gpt-5-codex', provider: 'zen' } },
    };
    const registry = makeRegistry(config);
    const profile = registry.getProfile('opencodego')!;
    const dispatcher = new SubscriptionDispatcher(profile, makeHooks(captured), async () => config);
    await dispatcher.dispatch(makeReq('gpt-5-codex'));
    // zenBaseUrl host + the responses path (the responses chain keeps the profile
    // upstreamUrl, so the override host is honored end-to-end).
    expect(captured.url).toBe('https://my-zen.example.com/v1/responses');
    expect(captured.headers?.['x-api-key']).toBeUndefined();
  });
});

// ── Fallback + per-id breaker recording on the DISPATCHER path ─────────────────
// A zen-responses PRIMARY fails (mock 503) → a fallback succeeds, and the breaker
// records the outcome PER modelId. We wrap the REAL registry profile to spy on
// `recordModelOutcome` while keeping resolveUpstreamUrl /
// resolveProviderTransformerNames / modelMapper / nextFallback REAL.
//
// IMPORTANT — DISPATCHER vs CORE asymmetry (documented limitation, NOT my change):
// the daemon `SubscriptionDispatcher.dispatchTransformerChain` loop resolves the
// upstream URL + provider chain + transformerProvider ONCE before the loop and
// only swaps `currentModel` per fallback — it does NOT re-resolve URL/shape/chain
// per fallback model. So a fallback that would FLIP the half/shape (zen-responses
// → go-chat) still POSTs the fallback model to the PRIMARY's URL+chain on this
// path. The TRUE per-iteration cross-half re-resolution lives on the core
// `/v1/messages` path (`buildSubscriptionIterationPlan` rebuilds per model — see
// `ProviderProxy.anthropicSubscription.test.ts` 3.6/3.6b). This test therefore
// uses a SAME-shape fallback (zen-responses → zen-responses) so the dispatcher's
// single-resolution behavior is correct, and asserts the per-id breaker recording
// (which DOES work per fallback). The half-flip on the dispatcher path is recorded
// as a pre-existing limitation in design.md "Open Questions".

/** A `ProviderApiError`-shaped error carrying `.status` (mirrors the real
 *  `fetchWithRetry`'s non-ok throw — the dispatcher reads `err.status`). */
class FakeProviderApiError extends Error {
  constructor(public readonly status: number) {
    super(`upstream ${status}`);
    this.name = 'ProviderApiError';
  }
}

describe('SubscriptionDispatcher zen fallback + per-id breaker (daemon path)', () => {
  it('zen responses primary 5xx → zen-responses fallback succeeds; breaker records per-id', async () => {
    // Primary = zen responses (gpt-5-codex); fallback = another zen-responses
    // model (gpt-5.1-codex) — SAME shape, so the dispatcher's single URL/chain
    // resolution is correct for both. The fallback flip across HALVES is covered
    // on the core path (see header note).
    const config: OpenCodeGoTokenConfig = {
      authMethod: 'manual',
      status: 'configured',
      apiKey: OC_KEY,
      modelMap: { default: { modelId: 'gpt-5-codex', provider: 'zen' } },
      fallbacks: { default: [{ modelId: 'gpt-5.1-codex', provider: 'zen' }] },
    };
    const registry = makeRegistry(config);
    const realProfile = registry.getProfile('opencodego')!;
    const recorded: Array<{ id: string; ok: boolean }> = [];
    const profile = {
      ...realProfile,
      recordModelOutcome: (id: string, ok: boolean) => {
        recorded.push({ id, ok });
        realProfile.recordModelOutcome?.(id, ok);
      },
    };

    // Record EVERY hit; the FIRST throws 503, the rest 200.
    const hits: Array<{ url: string; model: string; hadApiKey: boolean }> = [];
    const hooks: DispatcherHooks = {
      endpointTransformer: getAnthropicEndpointTransformer(),
      executor: getSharedExecutor(),
      transformerService: {
        getTransformer: (name: string) => TRANSFORMERS[name],
      } as unknown as DispatcherHooks['transformerService'],
      fetchWithRetry: vi.fn(
        async (url: string, headers: Record<string, string>, _body: unknown, model: string) => {
          hits.push({ url, model, hadApiKey: headers['x-api-key'] !== undefined });
          if (hits.length === 1) throw new FakeProviderApiError(503);
          return new Response(JSON.stringify(cannedFor(url)), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      ),
      writeProxyResponse: vi.fn(async () => undefined),
    };

    const dispatcher = new SubscriptionDispatcher(profile, hooks, async () => config);
    await dispatcher.dispatch(makeReq('gpt-5-codex'));

    expect(hits).toHaveLength(2);
    // Both hits target the zen responses endpoint (same shape, Bearer-only).
    expect(hits[0].url).toBe('https://opencode.ai/zen/v1/responses');
    expect(hits[1].url).toBe('https://opencode.ai/zen/v1/responses');
    expect(hits[0].model).toBe('gpt-5-codex');
    expect(hits[1].model).toBe('gpt-5.1-codex');
    expect(hits[0].hadApiKey).toBe(false);
    expect(hits[1].hadApiKey).toBe(false);
    // Breaker recorded DISTINCT per-id outcomes (primary failure, fallback success).
    expect(recorded).toEqual([
      { id: 'gpt-5-codex', ok: false },
      { id: 'gpt-5.1-codex', ok: true },
    ]);
  });
});
