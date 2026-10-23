/**
 * openaiChatIngress — the ProviderProxy OpenAI Chat Completions ingress parser.
 *
 * Matches `POST <base>/chat/completions` (any path ENDING in `/chat/completions`,
 * e.g. `/v1/chat/completions`). The qwen / copilot / opencode CLIs all speak the
 * OpenAI Chat Completions wire when redirected at the resident proxy.
 *
 * OpenAI Chat is close to Unified, but native `reasoning_content` and internal
 * `thinking` are not interchangeable. The Chat endpoint transformer bridges
 * those fields for cross-format calls; a same-format provider bypasses the
 * conversion and retains native fields.
 *
 * BYO and subscription routes share the same request/response pipeline.
 *
 * openai-chat-bridge (#11): the `authMode: 'subscription'` branch is no longer a
 * hard 502. It mirrors the Responses ingress's subscription plan
 * (`SubscriptionAuthSource` + `resolveSubscriptionChain` + the profile's route-to
 * `resolveUpstreamUrl`), so an OpenAI-chat client reaches a CLAUDE / KIMI / GROK /
 * OPENCODEGO subscription: an `['anthropic']` route-to chain (claude, kimi,
 * opencodego's anthropic shape) re-encodes Unified(OpenAI) → Anthropic on the
 * request and decodes Anthropic → Unified(OpenAI) on the response — streaming
 * (`convertAnthropicStreamToOpenAI`) and tools (`AnthropicToolHandling`) COVERED
 * BY REUSE, no new translator; grok's `['openai-response']` and opencodego's
 * per-shape chains encode to their native wires. opencodego additionally threads
 * the opaque per-account config (URL overrides) and applies its scenario
 * `modelMapper` before URL/chain resolution, mirroring the `/v1/messages` path.
 * Codex (Responses body contract) / gemini (Code-Assist project resolution)
 * subscriptions over THIS ingress stay DEFERRED with a clear per-request error.
 *
 * @module provider-proxy/ingress/openaiChatIngress
 */

import { resolveModelRedirect } from '@omnicross/contracts/canonical-models';
import type http from 'node:http';

import { isAccountAllowanceExhaustedError } from '../../pipeline/AccountAllowanceScheduling';
import { isBoundAccountSelectionError } from '../../pipeline/BoundAccountSelectionError';
import { OpenAIOperationError, writeOpenAIOperationError } from '../../openai-operation';
import { fetchUpstream } from '../../pipeline/upstreamFetch';

import { serializeError } from '@omnicross/core/serializeError';

import { buildProviderApiUrl } from '../../completion';
import type { AuthSource } from '../../pipeline/AuthSource';
import { executeProviderCall } from '../../pipeline/executeProviderCall';
import { LlmConfigProviderAuth } from '../../pipeline/LlmConfigProviderAuth';
import { resolveProviderChain, resolveRedirectedModelConfigs } from '../../pipeline/resolveProviderChain';
import { resolveSubscriptionChain } from '../../pipeline/resolveSubscriptionChain';
import { SubscriptionAuthSource, applyModelSelection } from '../../pipeline/SubscriptionAuthSource';
import type {
  LLMProvider as TransformerLLMProvider,
  RequestConfig,
  ResolvedTransformerChain,
  Transformer,
} from '../../transformer';
import type { ProviderProxyDeps, RouteContext } from '../types';
import {
  recordChatCompletionsNonStreamUsage,
  recordChatCompletionsStreamUsage,
} from '../usage/recordChatCompletionsUsage';

import {
  buildSubscriptionRequestSummary,
  subscriptionModelDefaults,
  withSubscriptionDefaults,
  type SubscriptionModelDefaults,
} from './anthropicSubscriptionPlan';
import { fillMissingCodexCliIdentity } from '../identity/codexCliHeaders';
import { deriveSubscriptionSessionKey } from '../matchText';
import { getAntigravityProjectResolver } from '../../auth/GeminiCodeAssistProjectResolver';
import { getGeminiCodeAssistResolver } from '../../ports/gemini-code-assist-resolver';
import {
  type ByoRouteActivityMeta,
  aggregateOpenAIChatChunksToJsonBody,
  buildByoRouteActivityMeta,
  getChatEndpointTransformer,
  getSharedExecutor,
  relayResponse,
  providerForWire,
  resolvePoolBoundKey,
  sniffIsSseResponse,
  writeBoundAccountError,
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
 * bridge — the full built-in catalog. CLAUDE / KIMI / GROK declare static
 * route-to chains (['anthropic'] / ['anthropic'] / ['openai-response']) that
 * are exactly Unified-encoders, so streaming + tools come for free.
 * OPENCODEGO is shape-aware: the profile's `chatBridgeTransformerNames` seam
 * resolves the per-model chain (go/zen half × wire shape) for a Unified
 * caller — including the anthropic shape, where the messages path's `[]`
 * (verbatim) would forward an OpenAI-chat body to an Anthropic endpoint.
 * COPILOT is shape-aware the EASY way: its per-wire names already give the
 * ['anthropic'] ENCODER on the anthropic wire, so the chat plan just consults
 * `resolveProviderTransformerNames`; its account config (apiEndpoint / GHE
 * domain) arrives via `route.subscriptionConfig` like opencodego's.
 * CODEX rides the ['openai-response'] encoder, which owns its body contract
 * (store:false + forced stream:true + typed input parts); a NON-streaming
 * client is served by collapsing the forced SSE back into one chat.completion
 * (see the handler). GEMINI / ANTIGRAVITY resolve their Code-Assist projects
 * per account before the call, mirroring the Responses driver (antigravity
 * via its own dialect resolver); antigravity's transformer owns the URL, so
 * its plan prefers the transformer-emitted `config.url` over the profile's.
 * The gate stays for custom/unknown profile ids (clear 501, never half-route).
 */
const CHAT_BRIDGE_SUBSCRIPTION_PROVIDERS: ReadonlySet<string> = new Set<string>([
  'claude',
  'kimi',
  'grok',
  'opencodego',
  'codex',
  'gemini',
  'copilot',
  'antigravity',
]);


/** The auth-mode-resolved inputs for one `executeProviderCall`. */
interface ChatCallPlan {
  readonly auth: AuthSource;
  /** request-logging P2: the deps the plan was built from (logger-aware egress lines). */
  readonly deps: ProviderProxyDeps;
  /** Per-request preferred subscription account (subscription routes only). */
  readonly preferredAccountId?: string;
  readonly preferredAccountGroup?: string;
  /** Strict by default; pool fallback is an explicit endpoint opt-in. */
  readonly boundAccountFallbackPolicy?: RouteContext['boundAccountFallbackPolicy'];
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
  /** BYO-only: route-activity metadata (provider row id + live key-id resolver). */
  readonly byoActivity?: ByoRouteActivityMeta;
  /** The stable per-conversation content session key (the matchText SSOT anchor
   *  — same derivation as the `/v1/messages` path) fed to `auth.applyHeaders`.
   *  The opencodego strategy derives `x-opencode-session` from it (the go
   *  upstream REJECTS a request without one), and every pooled provider uses it
   *  for sticky account affinity. BYO plans carry the same derivation as the
   *  derived fallback for an opencode.ai provider row (opencodego-egress-identity
   *  BYO half). */
  readonly contentSessionKey?: string;
  /** Route-activity session key fallback: the internal route session id (the
   *  ApiKeyPool binding id). This ingress derives no content session key, so
   *  BOTH kinds group their affinity rows by it. */
  readonly routeSessionId?: string | null;
  /** The caller's `x-opencode-session` value (opencodego-egress-identity) —
   *  forwarded verbatim when a BYO provider row points at opencode.ai;
   *  absent ⇒ the plan's derived session key stands in. */
  readonly callerOpenCodeSession?: string;
  readonly modelDefaults?: SubscriptionModelDefaults;
  readonly resolveModelUrl?: (model: string) => string | undefined;
  readonly rebuildForModel?: (model: string) => Promise<ChatCallPlan | null>;
}

/** Optional inputs threaded from the ingress router (which holds the raw `req`). */
export interface OpenAIChatByoOptions {
  /** The caller's `x-opencode-session` value (opencodego-egress-identity) —
   *  extracted UNGATED at the router; forwarded verbatim to opencode.ai on a
   *  BYO provider row pointing there. `null`/absent for callers that never
   *  set it. */
  readonly callerOpenCodeSession?: string | null;
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
  options: OpenAIChatByoOptions = {},
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
        ? await buildSubscriptionPlan(res, route, deps, chatBody, resolvedModel, isStream)
        : await buildByoPlan(
            res,
            route,
            deps,
            resolvedModel,
            isStream,
            // opencodego-egress-identity (BYO half): the body-anchor session key
            // feeds `x-opencode-session` for an opencode.ai provider row.
            deriveSubscriptionSessionKey(chatBody),
            options.callerOpenCodeSession ?? undefined,
          );
    if (!plan) return;

    let providerResponse = plan.isSubscription
      ? await runPipelineWithSubscriptionRetry(chatBody, plan)
      : await runPipelineWithPoolReporting(chatBody, plan);

    // Non-stream-from-SSE collapse (the codex contract): the Responses encoder
    // forces `stream:true` upstream (the backend 400s otherwise), so a
    // NON-streaming caller's chain output arrives as chat SSE — collapse it
    // into the single `chat.completion` JSON such a client expects. Generic on
    // content-type: any bridged provider that answered a non-stream request
    // with SSE gets the same treatment, and a JSON answer passes through.
    if (!isStream) {
      if (await sniffIsSseResponse(providerResponse.response)) {
        const collapsed = await aggregateOpenAIChatChunksToJsonBody(providerResponse.response);
        if (collapsed !== null) {
          providerResponse = {
            response: new Response(collapsed, {
              status: providerResponse.response.status,
              headers: { 'Content-Type': 'application/json' },
            }),
            rawStatus: providerResponse.rawStatus,
          };
        } else {
          writeError(res, 502, 'upstream streamed no completable chat chunks');
          return;
        }
      }
    }

    const usageAttribution = {
      sessionId: route.sessionId,
      providerId: route.providerId ?? 'openai',
      model: plan.resolvedModel,
      apiKeyId: route.apiKeyId ?? null,
      routeLease: route.routeLease,
      // request-audit-log: correlate this request's tokens/cost to its audit record.
      auditResponse: res,
    };
    // Streaming usage tap: a chat stream only carries `usage` on the final chunk
    // (and only when the client sent `stream_options.include_usage`); without it
    // the tap simply never fires. Byte-identical when no usageRecorder is wired.
    const usageRecorder = deps.usageRecorder;
    const usageTap = usageRecorder
      ? {
          extractUsage(event: Record<string, unknown>): Record<string, unknown> | null | undefined {
            return (event['usage'] as Record<string, unknown> | undefined) ?? null;
          },
          onUsage(rawUsage: Record<string, unknown>): void {
            recordChatCompletionsStreamUsage(usageRecorder, rawUsage, usageAttribution);
          },
        }
      : undefined;
    const bodyText = await relayResponse(
      res,
      providerResponse.response,
      isStream,
      undefined,
      usageTap,
    );
    if (bodyText && deps.usageRecorder) {
      recordChatCompletionsNonStreamUsage(deps.usageRecorder, bodyText, usageAttribution);
    }
  } catch (err) {
    if (err instanceof OpenAIOperationError) {
      writeOpenAIOperationError(res, err);
      return;
    }
    if (isBoundAccountSelectionError(err)) {
      writeBoundAccountError(res, err);
      return;
    }
    const errMsg = serializeError(err);
    console.error('[ProviderProxy:chat] Pipeline error:', errMsg);
    writeError(res, isAccountAllowanceExhaustedError(err) ? 429 : 502, errMsg);
  }
}

/** BYO-key plan — `LlmConfigProviderAuth` over the route's provider row. */
async function buildByoPlan(
  res: http.ServerResponse,
  route: RouteContext,
  deps: ProviderProxyDeps,
  resolvedModel: string,
  isStream: boolean,
  contentSessionKey?: string,
  callerOpenCodeSession?: string,
): Promise<ChatCallPlan | null> {
  const providerId = route.providerId;
  if (!providerId) {
    writeError(res, 502, 'BYO route is missing a providerId');
    return null;
  }
  const storedProvider = await deps.llmConfig.getProvider(providerId);
  if (!storedProvider) {
    writeError(res, 502, `Provider not found: ${providerId}`);
    return null;
  }
  // MULTI-FORMAT FAN-OUT: an openai variant serves this chat-completions wire
  // natively from that base (identity passthrough, no conversion). No variant
  // → the row itself.
  const provider = providerForWire(storedProvider, 'openai');

  // First-choice key via the shared pool-seam helper (design D2(b)): when the
  // pool is wired AND the route carries a synthesized `outbound:<keyId>`
  // sessionId, this SEEDS the session binding and returns the pool-selected key
  // so 429/529/401/403 failover fires. Otherwise it byte-identically falls back
  // to the provider row's `$ENV`-resolved key.
  const apiKey = await resolvePoolBoundKey(
    deps,
    providerId,
    provider,
    route.sessionId,
    route.preferredKeyId,
    route.boundKeyFallbackPolicy,
  );
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

  const { chain } = await resolveProviderChain(
    deps.llmConfig,
    providerId,
    resolvedModel,
    provider === storedProvider ? undefined : getChatEndpointTransformer(),
  );
  const configuredModel = resolvedModel;
  resolvedModel = resolveModelRedirect(resolvedModel);

  const transformerProvider: TransformerLLMProvider = {
    name: provider.name,
    baseUrl: provider.api_base_url,
    apiKey,
    models: provider.models || [],
    modelConfigs: resolveRedirectedModelConfigs(provider.modelConfigs, configuredModel),
  };

  const byoUrl = buildProviderApiUrl(provider, { model: resolvedModel, stream: isStream });

  return {
    deps,
    auth,
    chain,
    transformerProvider,
    resolvedModel,
    isStream,
    resolveUrl: (config) => (config.url instanceof URL ? config.url.toString() : byoUrl),
    upstreamUrl: byoUrl,
    proxyProviderId: 'byo',
    isSubscription: false,
    byoActivity: buildByoRouteActivityMeta(deps, providerId, route.sessionId),
    routeSessionId: route.sessionId ?? null,
    contentSessionKey,
    callerOpenCodeSession,
  };
}

/**
 * Subscription plan — resolves the provider wire independently of the Chat
 * endpoint transformer. URL and chain selection honor the account's endpoint
 * overrides and the profile's per-model wire declaration.
 *
 * For an ANTHROPIC-wire target (claude, kimi, opencodego's anthropic shape) the
 * `['anthropic']` names resolve to the `AnthropicTransformer` provider chain —
 * which re-encodes Unified(OpenAI-chat) → Anthropic on the request and decodes
 * Anthropic → Unified(OpenAI-chat) on the response (streaming + tools by reuse).
 * The opencodego profile's `modelMapper` (scenario routing) is applied BEFORE
 * URL/chain resolution, exactly like the `/v1/messages` plan builder, so the
 * resolved model picks the right half + shape.
 */
async function buildSubscriptionPlan(
  res: http.ServerResponse,
  route: RouteContext,
  deps: ProviderProxyDeps,
  chatBody: Record<string, unknown>,
  resolvedModel: string,
  isStream: boolean,
  selectedModel?: string,
): Promise<ChatCallPlan | null> {
  const profile = route.subscriptionProfile;
  if (!profile) {
    writeError(res, 502, 'Subscription mode requires a subscription profile');
    return null;
  }

  const providerId = profile.authStrategy.providerId;
  if (!CHAT_BRIDGE_SUBSCRIPTION_PROVIDERS.has(providerId)) {
    // Still deferred (openai-chat-bridge OQ1): codex (its /responses body
    // contract — e.g. the enforced store:false — is Responses-path-only today)
    // and gemini (Code-Assist project resolution). This is an UNIMPLEMENTED
    // capability, not an upstream failure → 501 (Not Implemented), not 502.
    // Fail clearly rather than half-route.
    writeError(
      res,
      501,
      `the OpenAI-chat→subscription bridge does not implement subscription provider ` +
        `'${providerId}' on this endpoint yet ` +
        `(use the /v1/responses endpoint, a Claude/Kimi/Grok/OpenCodeGo subscription, or a BYO provider)`,
    );
    return null;
  }

  // Scenario routing (opencodego only — claude/kimi/grok omit `modelMapper`):
  // apply the profile's mapper BEFORE resolving the upstream URL so the
  // resolved model picks the right half + shape, exactly like the
  // `/v1/messages` plan builder. The summary builder is wire-agnostic for an
  // OpenAI-chat body (roles + `.text` content parts flatten identically), so
  // both ingress paths bucket the same request into the same scenario.
  let mappedModel = selectedModel ?? resolvedModel;
  let modelDefaults = subscriptionModelDefaults(route.subscriptionConfig, mappedModel);
  if (selectedModel === undefined && profile.modelMapper) {
    const summary = buildSubscriptionRequestSummary(chatBody);
    const mapped = profile.modelMapper(resolvedModel, summary, route.subscriptionConfig as never);
    mappedModel = mapped.resolvedModel;
    modelDefaults = mapped;
  }
  mappedModel = resolveModelRedirect(mappedModel);

  // D1 parity: thread the opaque per-account config so opencodego honors a user
  // `baseUrl`/`zenBaseUrl` override + the per-model go/zen half.
  const upstreamUrl = profile.resolveUpstreamUrl?.(mappedModel, route.subscriptionConfig as never);
  if (!upstreamUrl) {
    writeError(res, 502, 'Subscription profile is missing resolveUpstreamUrl');
    return null;
  }

  const auth = route.auth ?? new SubscriptionAuthSource(profile);
  // Resolve the target wire independently of the Chat endpoint decoder:
  // opencodego's chat-specific seam first
  // (its anthropic shape needs the `['anthropic']` ENCODER — the messages
  // path's same-shape `[]` means "caller already speaks Anthropic"), then any
  // shape-aware per-wire names (copilot — whose anthropic wire ALREADY names
  // the encoder), else the profile's static `providerTransformerNames`.
  const chatChainNames =
    profile.chatBridgeTransformerNames?.(mappedModel, route.subscriptionConfig) ??
    profile.resolveProviderTransformerNames?.(mappedModel, route.subscriptionConfig);
  const chain: ResolvedTransformerChain = resolveSubscriptionChain(
    profile,
    deps.llmConfig.getTransformerService(),
    getChatEndpointTransformer(),
    chatChainNames,
  );

  const transformerProvider: TransformerLLMProvider = {
    name: providerId,
    baseUrl: upstreamUrl,
    apiKey: '',
    models: [mappedModel],
    responsesDialect: providerId === 'codex' ? 'codex' : undefined,
  };
  const sessionKey = deriveSubscriptionSessionKey(chatBody);

  // The PROFILE's URL is authoritative on the subscription plan — the
  // transformer's `config.url` is host-root-absolute by design (it REPLACES
  // the whole path with `/v1/responses`), which would DROP the path prefix a
  // path-prefixed upstream needs (codex `…/backend-api/codex/responses`,
  // opencode-zen `…/zen/v1/responses`). The profile's `resolveUpstreamUrl`
  // already produced the complete, shape-specific URL. EXCEPTION:
  // ANTIGRAVITY's transformer OWNS the URL (it emits the per-request
  // colon-method endpoint with its envelope) — there `config.url` wins.
  const resolveUrl: ChatCallPlan['resolveUrl'] =
    providerId === 'antigravity'
      ? (config) =>
          config.url instanceof URL
            ? config.url.toString()
            : typeof config.url === 'string'
              ? config.url
              : upstreamUrl
      : () => upstreamUrl;

  return {
    deps,
    auth,
    preferredAccountId: route.preferredAccountId,
    preferredAccountGroup: route.preferredAccountGroup,
    boundAccountFallbackPolicy: route.boundAccountFallbackPolicy,
    chain,
    transformerProvider,
    resolvedModel: mappedModel,
    isStream,
    resolveUrl,
    upstreamUrl,
    proxyProviderId: providerId,
    isSubscription: true,
    contentSessionKey: sessionKey,
    routeSessionId: route.sessionId ?? null,
    modelDefaults,
    resolveModelUrl: (model) => profile.resolveUpstreamUrl?.(model, route.subscriptionConfig as never),
    rebuildForModel: (model) => buildSubscriptionPlan(res, { ...route, auth }, deps, chatBody, resolvedModel, isStream, model),
  };
}

/**
 * Run one request through the Chat endpoint and selected provider wire.
 * Native Chat-to-Chat bypasses the conversion; translated responses normalize
 * reasoning back to `reasoning_content`. Keep the raw status for auth handling.
 */
async function runPipeline(
  chatBody: Record<string, unknown>,
  plan: ChatCallPlan,
): Promise<{ response: Response; rawStatus: number | null }> {
  const executor = getSharedExecutor();
  const selected = await applyModelSelection(plan.auth, {
    upstreamUrl: plan.upstreamUrl,
    model: plan.resolvedModel,
    sessionKey: plan.contentSessionKey,
    callerOpenCodeSession: plan.callerOpenCodeSession,
    preferredAccountId: plan.preferredAccountId,
    preferredAccountGroup: plan.preferredAccountGroup,
    boundAccountFallbackPolicy: plan.boundAccountFallbackPolicy,
  }, plan.resolveModelUrl);
  if ((selected.model !== plan.resolvedModel || selected.configuredModel !== plan.resolvedModel) && plan.rebuildForModel) {
    const rebuilt = await plan.rebuildForModel(selected.configuredModel);
    if (!rebuilt) throw new Error('Subscription profile is missing resolveUpstreamUrl');
    plan = rebuilt;
  }
  const { chain, transformerProvider, resolvedModel, isStream, resolveUrl } = plan;
  const { headers: authHeaders, accountId: proxyAccountId } = selected;
  const requestBody = withSubscriptionDefaults(chatBody, selected.model, plan.modelDefaults, 'max_tokens');
  const bearer = (authHeaders.Authorization ?? authHeaders.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  if (plan.proxyProviderId === 'gemini') {
    transformerProvider.geminiProject = bearer
      ? await getGeminiCodeAssistResolver()?.resolveProject(bearer) : undefined;
  } else if (plan.proxyProviderId === 'antigravity') {
    transformerProvider.geminiProject = bearer
      ? await getAntigravityProjectResolver().resolveProject(bearer) : undefined;
  }

  let rawStatus: number | null = null;

  const { response } = await executeProviderCall({
    executor,
    request: requestBody,
    provider: transformerProvider,
    chain,
    endpointTransformer: getChatEndpointTransformer(),
    resolveUrl,
    buildHeaders: (config) => {
      const headers: Record<string, string> = { ...authHeaders };
      if (config.headers) {
        for (const [key, value] of Object.entries(config.headers as Record<string, string | undefined>)) {
          if (value !== undefined && !(key in headers)) headers[key] = value;
        }
      }
      // Codex identity markers (mirrors the Responses driver's
      // `decorateCodexHeaders`): a bare anonymous request picks up the
      // originator + CLI persona; a caller that brought its own UA keeps it.
      if (plan.proxyProviderId === 'codex') fillMissingCodexCliIdentity(headers);
      return headers;
    },
    fetchFn: (url, headers, body) => {
      if (plan.deps.logger) plan.deps.logger.info('[ProviderProxy:chat] dispatch', { url, model: resolvedModel, stream: isStream });
      else console.log(`[ProviderProxy:chat] -> ${url} model=${resolvedModel} stream=${isStream}`);
      // upstream-proxy: chat egress honors the global/provider (+ per-account for
      // a subscription) proxy. Route-activity row (account for a subscription
      // plan, provider key for BYO) — this ingress derives no content session
      // key, so both kinds group by the route session id.
      const sessionKey = plan.routeSessionId || undefined;
      return fetchUpstream(
        url,
        { method: 'POST', headers, body: JSON.stringify(body) },
        {
          providerId: plan.proxyProviderId,
          accountId: proxyAccountId,
          routeActivity: plan.isSubscription
            ? {
                providerId: plan.proxyProviderId,
                credentialKind: 'subscription-account',
                accountId: proxyAccountId,
                endpoint: 'chat',
                sessionKey,
                sessionSource: sessionKey ? 'route-session-id' : 'none',
                model: resolvedModel,
              }
            : {
                providerId: plan.byoActivity?.providerId ?? transformerProvider.name,
                credentialKind: 'provider-key',
                keyId: plan.byoActivity?.resolveKeyId(),
                endpoint: 'chat',
                sessionKey,
                sessionSource: sessionKey ? 'route-session-id' : 'none',
                model: resolvedModel,
              },
        },
      ).then((r) => {
        rawStatus = r.status;
        return r;
      });
    },
    runResponseChain: true,
    preserveEndpointRequestForResponseChain: true,
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

  const refreshed = await plan.auth.onUnauthorized?.(plan.contentSessionKey);
  if (!refreshed) {
    console.warn('[ProviderProxy:chat] 401 not recoverable (onUnauthorized returned false)');
    return first;
  }
  console.log('[ProviderProxy:chat] 401 → token refreshed; retrying once');
  return runPipeline(chatBody, plan);
}
