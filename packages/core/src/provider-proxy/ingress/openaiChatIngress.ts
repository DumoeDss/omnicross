/**
 * openaiChatIngress — the ProviderProxy OpenAI Chat Completions ingress parser.
 *
 * Matches `POST <base>/chat/completions` (any path ENDING in `/chat/completions`,
 * e.g. `/v1/chat/completions`). The qwen / copilot / opencode CLIs all speak the
 * OpenAI Chat Completions wire when redirected at the resident proxy.
 *
 * KEY SEAM CHOICE: the unified pipeline's `UnifiedChatRequest` IS the OpenAI Chat
 * Completions shape (`messages` / `model` / `tools` / `tool_choice` / …, see
 * `transformer/types.ts`). So the ingress decode is IDENTITY — there is NO
 * endpoint transformer here. The parsed wire body is passed straight into
 * `executeProviderCall` as the `request`, and the provider transformer chain
 * (BYO: `resolveProviderChain`; subscription: `resolveSubscriptionChain`) encodes
 * Unified → target wire on the request side and decodes target → Unified (≡ OpenAI
 * Chat Completions) on the response side. This is the same `omit the endpoint
 * transformer` contract the unified ingresses (Adapter / Handler) use: design D7
 * (reuse the pipeline SSOT, no proxy-local converter).
 *
 * PARITY with `openaiResponsesIngress.ts`: same per-run `RouteContext` shape,
 * same BYO + subscription call-plan structure, same relay + usage tap. The ONLY
 * structural differences are (a) no endpoint transformer (identity decode), (b)
 * the BYO URL is the provider's chat-completions URL (`buildProviderApiUrl`
 * default `openai` format), and (c) the subscription plan scopes to the CLAUDE
 * target (openai-chat-bridge, §D1/OQ1).
 *
 * openai-chat-bridge (#11): the `authMode: 'subscription'` branch is no longer a
 * hard 502. It mirrors the Responses ingress's subscription plan
 * (`SubscriptionAuthSource` + `resolveSubscriptionChain` + the profile's route-to
 * `resolveUpstreamUrl`), so an OpenAI-chat client reaches a CLAUDE subscription:
 * the claude profile's `providerTransformerNames: ['anthropic']` re-encode
 * Unified(OpenAI) → Anthropic on the request and decode Anthropic → Unified(OpenAI)
 * on the response — streaming (`convertAnthropicStreamToOpenAI`) and tools
 * (`AnthropicToolHandling`) COVERED BY REUSE, no new translator. Codex / gemini /
 * opencodego subscriptions over THIS ingress are DEFERRED with a clear per-request
 * error (they need shipped-path verification / gemini Code-Assist project
 * resolution that is out of this slice; use the /v1/responses endpoint or a BYO
 * provider instead).
 *
 * @module provider-proxy/ingress/openaiChatIngress
 */

import type http from 'node:http';

import { fetchUpstream } from '../../pipeline/upstreamFetch';

import { serializeError } from '@omnicross/core/serializeError';

import { buildProviderApiUrl } from '../../completion';
import type { AuthSource } from '../../pipeline/AuthSource';
import { executeProviderCall } from '../../pipeline/executeProviderCall';
import { LlmConfigProviderAuth } from '../../pipeline/LlmConfigProviderAuth';
import { resolveProviderChain } from '../../pipeline/resolveProviderChain';
import { resolveSubscriptionChain } from '../../pipeline/resolveSubscriptionChain';
import { SubscriptionAuthSource } from '../../pipeline/SubscriptionAuthSource';
import type {
  LLMProvider as TransformerLLMProvider,
  RequestConfig,
  ResolvedTransformerChain,
  Transformer,
} from '../../transformer';
import type { ProviderProxyDeps, RouteContext } from '../types';
import { recordChatCompletionsNonStreamUsage } from '../usage/recordChatCompletionsUsage';

import {
  getSharedExecutor,
  relayResponse,
  resolvePoolBoundKey,
  writeError,
} from './providerProxyShared';

/**
 * Match the `/chat/completions` route: `POST` + any path ENDING IN
 * `/chat/completions` (NOT hardcoded `/v1/chat/completions`, mirroring the
 * Responses parser's `endsWith('/responses')` contract).
 */
export function isOpenAIChatRequest(
  method: string | undefined,
  url: string | undefined,
): boolean {
  if (method !== 'POST' || !url) return false;
  const path = url.split('?')[0]?.replace(/\/+$/, '') ?? '';
  return path.endsWith('/chat/completions');
}

/**
 * The subscription providers whose route-to chain the chat ingress can soundly
 * bridge in v1 (openai-chat-bridge OQ1). CLAUDE is the proven headline: the
 * profile's `['anthropic']` chain is exactly the documented BYO OpenAI-chat →
 * Anthropic conversion, so streaming + tools come for free. Other subscription
 * providers are deferred at the plan builder with a clear per-request error.
 */
const CHAT_BRIDGE_SUBSCRIPTION_PROVIDERS: ReadonlySet<string> = new Set<string>(['claude']);

/**
 * Identity endpoint fallback for `resolveSubscriptionChain`. The chat ingress
 * runs NO endpoint transformer (Unified ≡ OpenAI Chat Completions), so this
 * no-op transformer is only ever reached when a profile declares no
 * `providerTransformerNames` — in which case the SAME Unified body is forwarded
 * verbatim (correct for an OpenAI-chat-wire upstream). The claude profile
 * declares `['anthropic']`, so this fallback is inert for the shipped target.
 */
const IDENTITY_ENDPOINT_TRANSFORMER: Transformer = { name: 'identity-openai-chat' };

/** The auth-mode-resolved inputs for one `executeProviderCall`. */
interface ChatCallPlan {
  readonly auth: AuthSource;
  readonly chain: ResolvedTransformerChain;
  readonly transformerProvider: TransformerLLMProvider;
  readonly resolvedModel: string;
  readonly isStream: boolean;
  readonly resolveUrl: (config: RequestConfig) => string;
  readonly upstreamUrl: string;
  /** upstream-proxy ctx: the subscription provider id, or `'byo'` for a BYO plan. */
  readonly proxyProviderId: string;
  /** True for the subscription plan (drives the 401-refresh-retry wrapper). */
  readonly isSubscription: boolean;
}

/**
 * Handle one OpenAI Chat Completions request for the resolved `RouteContext`.
 * The route's `authMode` selects the BYO or subscription (openai-chat-bridge)
 * call plan; the shared core stays auth-origin-agnostic.
 */
export async function handleOpenAIChatRequest(
  res: http.ServerResponse,
  rawBody: string,
  route: RouteContext,
  deps: ProviderProxyDeps,
): Promise<void> {
  let chatBody: Record<string, unknown>;
  try {
    chatBody = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    writeError(res, 400, 'Invalid JSON in request body');
    return;
  }

  const isStream = chatBody.stream === true;
  // CLI model-name mapping (ingress quirk): route the CLI's model to the route's
  // configured provider model, exactly like the Responses ingress.
  const resolvedModel = route.model;
  chatBody.model = resolvedModel;

  try {
    const plan =
      route.authMode === 'subscription'
        ? await buildSubscriptionPlan(res, route, deps, resolvedModel, isStream)
        : await buildByoPlan(res, route, deps, resolvedModel, isStream);
    if (!plan) return;

    const providerResponse = plan.isSubscription
      ? await runPipelineWithSubscriptionRetry(chatBody, plan)
      : await runPipelineWithPoolReporting(chatBody, plan);

    const bodyText = await relayResponse(res, providerResponse.response, isStream);
    if (bodyText && deps.usageRecorder) {
      recordChatCompletionsNonStreamUsage(deps.usageRecorder, bodyText, {
        sessionId: route.sessionId,
        providerId: route.providerId ?? 'openai',
        model: resolvedModel,
        apiKeyId: route.apiKeyId ?? null,
        // request-audit-log: correlate this request's tokens/cost to its audit record.
        auditResponse: res,
      });
    }
  } catch (err) {
    const errMsg = serializeError(err);
    console.error('[ProviderProxy:chat] Pipeline error:', errMsg);
    writeError(res, 502, errMsg);
  }
}

/** BYO-key plan — `LlmConfigProviderAuth` over the route's provider row. */
async function buildByoPlan(
  res: http.ServerResponse,
  route: RouteContext,
  deps: ProviderProxyDeps,
  resolvedModel: string,
  isStream: boolean,
): Promise<ChatCallPlan | null> {
  const providerId = route.providerId;
  if (!providerId) {
    writeError(res, 502, 'BYO route is missing a providerId');
    return null;
  }
  const provider = await deps.llmConfig.getProvider(providerId);
  if (!provider) {
    writeError(res, 502, `Provider not found: ${providerId}`);
    return null;
  }

  // First-choice key via the shared pool-seam helper (design D2(b)): when the
  // pool is wired AND the route carries a synthesized `outbound:<keyId>`
  // sessionId, this SEEDS the session binding and returns the pool-selected key
  // so 429/529/401/403 failover fires. Otherwise it byte-identically falls back
  // to the provider row's `$ENV`-resolved key.
  const apiKey = await resolvePoolBoundKey(deps, providerId, provider, route.sessionId);
  if (!apiKey) {
    writeError(res, 502, 'API key not configured');
    return null;
  }

  const auth =
    route.auth ??
    new LlmConfigProviderAuth({
      provider,
      apiKey,
      apiKeyPool: deps.apiKeyPool ?? null,
      providerId,
      sessionId: route.sessionId,
    });

  const { chain } = await resolveProviderChain(deps.llmConfig, providerId, resolvedModel);

  const transformerProvider: TransformerLLMProvider = {
    name: provider.name,
    baseUrl: provider.api_base_url,
    apiKey,
    models: provider.models || [],
  };

  const byoUrl = buildProviderApiUrl(provider, { model: resolvedModel, stream: isStream });

  return {
    auth,
    chain,
    transformerProvider,
    resolvedModel,
    isStream,
    resolveUrl: (config) => (config.url instanceof URL ? config.url.toString() : byoUrl),
    upstreamUrl: byoUrl,
    proxyProviderId: 'byo',
    isSubscription: false,
  };
}

/**
 * Subscription plan (openai-chat-bridge #11) — mirrors the Responses ingress's
 * `buildSubscriptionPlan`, minus the endpoint transformer (the chat wire is
 * Unified, so decode is identity). `SubscriptionAuthSource` over the route's
 * profile; URL via the profile's `resolveUpstreamUrl`; provider chain built from
 * the profile's OWN `providerTransformerNames` via `resolveSubscriptionChain`.
 *
 * For the CLAUDE target the profile's `['anthropic']` names resolve to the
 * `AnthropicTransformer` provider chain — which re-encodes Unified(OpenAI-chat) →
 * Anthropic on the request and decodes Anthropic → Unified(OpenAI-chat) on the
 * response (streaming + tools by reuse). Non-claude subscription providers are
 * DEFERRED here with a clear 502 (they need shipped-path verification / gemini
 * Code-Assist project resolution out of this slice); the client should use the
 * /v1/responses endpoint or a BYO provider instead.
 */
async function buildSubscriptionPlan(
  res: http.ServerResponse,
  route: RouteContext,
  deps: ProviderProxyDeps,
  resolvedModel: string,
  isStream: boolean,
): Promise<ChatCallPlan | null> {
  const profile = route.subscriptionProfile;
  if (!profile) {
    writeError(res, 502, 'Subscription mode requires a subscription profile');
    return null;
  }

  const providerId = profile.authStrategy.providerId;
  if (!CHAT_BRIDGE_SUBSCRIPTION_PROVIDERS.has(providerId)) {
    // Deferred (openai-chat-bridge OQ1): only the claude route-to chain is a
    // proven OpenAI-chat bridge in v1. This is an UNIMPLEMENTED capability, not an
    // upstream failure → 501 (Not Implemented), not 502. Fail clearly rather than
    // half-route.
    writeError(
      res,
      501,
      `the OpenAI-chat→subscription bridge currently supports claude only; ` +
        `subscription provider '${providerId}' is not implemented on this endpoint yet ` +
        `(use the /v1/responses endpoint, a Claude subscription, or a BYO provider)`,
    );
    return null;
  }

  const upstreamUrl = profile.resolveUpstreamUrl?.(resolvedModel);
  if (!upstreamUrl) {
    writeError(res, 502, 'Subscription profile is missing resolveUpstreamUrl');
    return null;
  }

  const auth = route.auth ?? new SubscriptionAuthSource(profile);
  // NO endpoint transformer (identity): the chat wire IS Unified. The identity
  // fallback is inert for claude (it declares `['anthropic']` provider names).
  const chain: ResolvedTransformerChain = resolveSubscriptionChain(
    profile,
    deps.llmConfig.getTransformerService(),
    IDENTITY_ENDPOINT_TRANSFORMER,
  );

  const transformerProvider: TransformerLLMProvider = {
    name: providerId,
    baseUrl: upstreamUrl,
    apiKey: '',
    models: [resolvedModel],
  };

  return {
    auth,
    chain,
    transformerProvider,
    resolvedModel,
    isStream,
    resolveUrl: (config) =>
      config.url instanceof URL
        ? config.url.toString()
        : typeof config.url === 'string'
          ? config.url
          : upstreamUrl,
    upstreamUrl,
    proxyProviderId: providerId,
    isSubscription: true,
  };
}

/**
 * Run the shared core ONCE. NO endpoint transformer (the OpenAI Chat Completions
 * wire ≡ `UnifiedChatRequest`, so decode is identity); the resolved provider
 * chain encodes Unified → target on the request side and target → Unified on the
 * response side. `runResponseChain: true` so the relay receives a chat-completions
 * (Unified-shaped) response regardless of the target provider's wire format.
 * `rawStatus` captures the RAW upstream HTTP status so the subscription 401-retry
 * wrapper can read it.
 */
async function runPipeline(
  chatBody: Record<string, unknown>,
  plan: ChatCallPlan,
): Promise<{ response: Response; rawStatus: number | null }> {
  const executor = getSharedExecutor();
  const { auth, chain, transformerProvider, resolvedModel, isStream, resolveUrl, upstreamUrl } = plan;

  // Pre-resolve auth headers (applyHeaders MAY be async for OAuth refresh while
  // buildHeaders is sync). Auth wins — chain headers never clobber a key the
  // AuthSource set. Capture the selected pooled account so a per-account proxy
  // resolves (no-op for BYO — LlmConfigProviderAuth never reports a selection).
  let proxyAccountId: string | undefined;
  const authHeaders: Record<string, string> = {};
  await auth.applyHeaders(authHeaders, {
    upstreamUrl,
    model: resolvedModel,
    reportSelection: (accountId) => {
      proxyAccountId = accountId;
    },
  });

  let rawStatus: number | null = null;

  const { response } = await executeProviderCall({
    executor,
    request: chatBody,
    provider: transformerProvider,
    chain,
    resolveUrl,
    buildHeaders: (config) => {
      const headers: Record<string, string> = { ...authHeaders };
      if (config.headers) {
        for (const [key, value] of Object.entries(config.headers as Record<string, string | undefined>)) {
          if (value !== undefined && !(key in headers)) headers[key] = value;
        }
      }
      return headers;
    },
    fetchFn: (url, headers, body) => {
      console.log(`[ProviderProxy:chat] -> ${url} model=${resolvedModel} stream=${isStream}`);
      // upstream-proxy: chat egress honors the global/provider (+ per-account for
      // a subscription) proxy.
      return fetchUpstream(
        url,
        { method: 'POST', headers, body: JSON.stringify(body) },
        { providerId: plan.proxyProviderId, accountId: proxyAccountId },
      ).then((r) => {
        rawStatus = r.status;
        return r;
      });
    },
    runResponseChain: true,
  });

  return { response, rawStatus };
}

/**
 * BYO ApiKeyPool failover wrapper — mirrors the host engine adapter's `callWithPoolReporting`
 * (and the Responses ingress's `runPipelineWithSubscriptionRetry`): run; report the
 * RAW upstream status to the pool via `auth.onResult`; on a rebind (429/529/401/403
 * produced a new key, session rotated) re-run ONCE so `runPipeline` re-applies headers
 * and picks up the rotated `LlmConfigProviderAuth.apiKey`. `onResult` no-ops when there
 * is no pool/session (a plain BYO request behaves exactly as before — additive, zero
 * regression). Discarding the first (e.g. 429) response on rebind is safe: the relay
 * happens AFTER this wrapper returns, so the first response's body was never read.
 */
async function runPipelineWithPoolReporting(
  chatBody: Record<string, unknown>,
  plan: ChatCallPlan,
): Promise<{ response: Response; rawStatus: number | null }> {
  const first = await runPipeline(chatBody, plan);
  const outcome = await plan.auth.onResult?.(first.rawStatus);
  if (outcome?.rebound) {
    console.log(
      '[ProviderProxy:chat] pool re-bound key after status',
      first.rawStatus,
      '→ retrying once',
    );
    return runPipeline(chatBody, plan);
  }
  return first;
}

/**
 * Subscription 401-retry-once wrapper (openai-chat-bridge) — mirrors the
 * Responses ingress's wrapper: run; if RAW upstream status was 401 and
 * `auth.onUnauthorized()` resolves true (token refreshed), re-run once;
 * otherwise surface the (already transformed) response.
 */
async function runPipelineWithSubscriptionRetry(
  chatBody: Record<string, unknown>,
  plan: ChatCallPlan,
): Promise<{ response: Response; rawStatus: number | null }> {
  const first = await runPipeline(chatBody, plan);
  if (first.rawStatus !== 401) return first;

  const refreshed = await plan.auth.onUnauthorized?.();
  if (!refreshed) {
    console.warn('[ProviderProxy:chat] 401 not recoverable (onUnauthorized returned false)');
    return first;
  }
  console.log('[ProviderProxy:chat] 401 → token refreshed; retrying once');
  return runPipeline(chatBody, plan);
}
