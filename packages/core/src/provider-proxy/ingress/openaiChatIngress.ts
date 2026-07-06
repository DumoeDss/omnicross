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
 * resolved by `resolveProviderChain` (e.g. AnthropicTransformer for an Anthropic
 * target, GeminiTransformer for a Gemini target, or none for an OpenAI target)
 * encodes Unified → target wire on the request side and decodes target → Unified
 * (≡ OpenAI Chat Completions) on the response side. This is the same `omit the
 * endpoint transformer` contract the unified ingresses (Adapter / Handler) use:
 * design D7 (reuse the pipeline SSOT, no proxy-local converter).
 *
 * PARITY with `openaiResponsesIngress.ts`: same per-run `RouteContext` shape,
 * same BYO call-plan structure, same relay + usage tap. The ONLY structural
 * differences are (a) no endpoint transformer (identity decode), (b) the BYO
 * URL is the provider's chat-completions URL (`buildProviderApiUrl` default
 * `openai` format), and (c) no subscription plan — the genuinely-new
 * chat-completions backends (qwen/copilot/opencode) are api-key/relay only in
 * this slice (their subscriptions, if any, are out of scope).
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
import type {
  LLMProvider as TransformerLLMProvider,
  RequestConfig,
  ResolvedTransformerChain,
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

/** The auth-mode-resolved inputs for one `executeProviderCall`. */
interface ChatCallPlan {
  readonly auth: AuthSource;
  readonly chain: ResolvedTransformerChain;
  readonly transformerProvider: TransformerLLMProvider;
  readonly resolvedModel: string;
  readonly isStream: boolean;
  readonly resolveUrl: (config: RequestConfig) => string;
  readonly upstreamUrl: string;
}

/**
 * Handle one OpenAI Chat Completions request for the resolved `RouteContext`.
 * BYO-only in this slice — `authMode: 'subscription'` is rejected (the
 * chat-completions backends added here are api-key/relay only).
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

  if (route.authMode === 'subscription') {
    writeError(res, 502, 'OpenAI Chat Completions ingress does not support subscription auth');
    return;
  }

  const isStream = chatBody.stream === true;
  // CLI model-name mapping (ingress quirk): route the CLI's model to the route's
  // configured provider model, exactly like the Responses ingress.
  const resolvedModel = route.model;
  chatBody.model = resolvedModel;

  try {
    const plan = await buildByoPlan(res, route, deps, resolvedModel, isStream);
    if (!plan) return;

    const providerResponse = await runPipelineWithPoolReporting(chatBody, plan);

    const bodyText = await relayResponse(res, providerResponse.response, isStream);
    if (bodyText && deps.usageRecorder) {
      recordChatCompletionsNonStreamUsage(deps.usageRecorder, bodyText, {
        sessionId: route.sessionId,
        providerId: route.providerId ?? 'openai',
        model: resolvedModel,
        apiKeyId: route.apiKeyId ?? null,
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
  };
}

/**
 * Run the shared core ONCE. NO endpoint transformer (the OpenAI Chat Completions
 * wire ≡ `UnifiedChatRequest`, so decode is identity); the resolved provider
 * chain encodes Unified → target on the request side and target → Unified on the
 * response side. `runResponseChain: true` so the relay receives a chat-completions
 * (Unified-shaped) response regardless of the target provider's wire format.
 */
async function runPipeline(
  chatBody: Record<string, unknown>,
  plan: ChatCallPlan,
): Promise<{ response: Response; rawStatus: number | null }> {
  const executor = getSharedExecutor();
  const { auth, chain, transformerProvider, resolvedModel, isStream, resolveUrl, upstreamUrl } = plan;

  // Pre-resolve auth headers (applyHeaders MAY be async for OAuth refresh while
  // buildHeaders is sync). Auth wins — chain headers never clobber a key the
  // AuthSource set.
  const authHeaders: Record<string, string> = {};
  await auth.applyHeaders(authHeaders, { upstreamUrl, model: resolvedModel });

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
      // upstream-proxy: BYO chat egress honors the global/provider proxy.
      return fetchUpstream(
        url,
        { method: 'POST', headers, body: JSON.stringify(body) },
        { providerId: 'byo' },
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
