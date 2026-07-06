/**
 * openaiResponsesIngress — the ProviderProxy OpenAI-Responses ingress parser.
 *
 * Matches `POST <base>/responses` (any path ending in `/responses`, per the
 * codex `base_url=.../openai` + `wire_api="responses"` contract) and routes the
 * decoded Responses-API request through the shared `executeProviderCall` core
 * with `endpointTransformer = OpenAIResponseTransformer` + `runResponseChain`.
 *
 * PARITY: this is the host's pre-existing codex request-handler logic, re-expressed
 * against a per-run `RouteContext` instead of per-instance construction. The call-plan
 * builders (BYO + subscription), the model mapping, the 401-refresh-retry, and
 * the relay are preserved byte-for-byte in shape; the ONLY difference is that
 * the auth + provider id come from the looked-up `RouteContext` rather than a
 * per-session proxy constructor. No CRS conversion code is used (design D7).
 *
 * @module provider-proxy/ingress/openaiResponsesIngress
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
import { getGeminiCodeAssistResolver } from '../../ports/gemini-code-assist-resolver';
import type {
  LLMProvider as TransformerLLMProvider,
  RequestConfig,
  ResolvedTransformerChain,
} from '../../transformer';
import type { ProviderProxyDeps, RouteContext } from '../types';
import { recordResponsesNonStreamUsage } from '../usage/recordResponsesUsage';

import {
  getResponsesEndpointTransformer,
  getSharedExecutor,
  relayResponse,
  resolvePoolBoundKey,
  writeError,
} from './providerProxyShared';

/**
 * Match the codex `/responses` route: `POST` + any path ENDING IN `/responses`
 * (NOT hardcoded `/v1/responses`). Identical to the host's codex
 * request matcher.
 */
export function isOpenAIResponsesRequest(
  method: string | undefined,
  url: string | undefined,
): boolean {
  if (method !== 'POST' || !url) return false;
  const path = url.split('?')[0]?.replace(/\/+$/, '') ?? '';
  return path.endsWith('/responses');
}

/** The auth-mode-resolved inputs for one `executeProviderCall` (mirrors the host's codex call plan). */
interface ResponsesCallPlan {
  readonly auth: AuthSource;
  readonly chain: ResolvedTransformerChain;
  readonly transformerProvider: TransformerLLMProvider;
  readonly resolvedModel: string;
  readonly isStream: boolean;
  readonly resolveUrl: (config: RequestConfig) => string;
  readonly upstreamUrl: string;
  /** upstream-proxy ctx: the subscription provider id, or `'byo'` for a BYO plan. */
  readonly proxyProviderId: string;
}

/**
 * Handle one OpenAI-Responses request for the resolved `RouteContext`. The
 * route's `authMode` selects the BYO or subscription call plan; the shared core
 * stays auth-origin-agnostic.
 */
export async function handleOpenAIResponsesRequest(
  res: http.ServerResponse,
  rawBody: string,
  route: RouteContext,
  deps: ProviderProxyDeps,
): Promise<void> {
  let responsesBody: Record<string, unknown>;
  try {
    responsesBody = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    writeError(res, 400, 'Invalid JSON in request body');
    return;
  }

  const isStream = responsesBody.stream === true;
  // Codex model-name mapping (ingress quirk): route the CLI's model to the
  // route's configured provider model.
  const resolvedModel = route.model;
  responsesBody.model = resolvedModel;

  try {
    const plan =
      route.authMode === 'subscription'
        ? await buildSubscriptionPlan(res, route, deps, resolvedModel, isStream)
        : await buildByoPlan(res, route, deps, resolvedModel, isStream);
    if (!plan) return;

    const providerResponse =
      route.authMode === 'subscription'
        ? await runPipelineWithSubscriptionRetry(responsesBody, plan)
        : await runPipelineWithPoolReporting(responsesBody, plan);

    // Passthrough (design D4): rewrite the response `model` back to the client's
    // ORIGINAL requested id (`route.requestedModel`) so Codex sees `gpt-5-codex-…`
    // rather than the upstream provider model. `undefined` for internal traffic
    // ⇒ byte-identical. Usage accounting STAYS on the upstream `resolvedModel`.
    const bodyText = await relayResponse(res, providerResponse.response, isStream, route.requestedModel);
    if (bodyText && deps.usageRecorder) {
      recordResponsesNonStreamUsage(deps.usageRecorder, bodyText, {
        sessionId: route.sessionId,
        providerId: route.providerId ?? 'codex',
        model: resolvedModel,
        apiKeyId: route.apiKeyId ?? null,
        // request-audit-log: correlate this request's tokens/cost to its audit record.
        auditResponse: res,
      });
    }
  } catch (err) {
    const errMsg = serializeError(err);
    console.error('[ProviderProxy:responses] Pipeline error:', errMsg);
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
): Promise<ResponsesCallPlan | null> {
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
  };
}

/**
 * Subscription (OAuth / bearer) plan — `SubscriptionAuthSource` over the route's
 * profile; URL via the profile's `resolveUpstreamUrl`; provider chain built from
 * the profile's OWN `providerTransformerNames` (cross-vendor route-to, task #29)
 * so Unified is re-encoded to the upstream's wire — Responses for codex
 * (`['openai-response']`, byte-identical to before), OpenAI-chat for opencodego
 * (`['opencodego']`), etc. Falls back to the Responses endpoint transformer when
 * the profile declares no names. Mirrors how `buildByoPlan` resolves the
 * provider's real chain.
 */
async function buildSubscriptionPlan(
  res: http.ServerResponse,
  route: RouteContext,
  deps: ProviderProxyDeps,
  resolvedModel: string,
  isStream: boolean,
): Promise<ResponsesCallPlan | null> {
  const profile = route.subscriptionProfile;
  if (!profile) {
    writeError(res, 502, 'Subscription mode requires a codex subscription profile');
    return null;
  }
  const upstreamUrl = profile.resolveUpstreamUrl?.(resolvedModel);
  if (!upstreamUrl) {
    writeError(res, 502, 'Subscription profile is missing resolveUpstreamUrl');
    return null;
  }

  const auth = route.auth ?? new SubscriptionAuthSource(profile);
  const chain: ResolvedTransformerChain = resolveSubscriptionChain(
    profile,
    deps.llmConfig.getTransformerService(),
    getResponsesEndpointTransformer(),
  );

  const transformerProvider: TransformerLLMProvider = {
    name: profile.authStrategy.providerId,
    baseUrl: upstreamUrl,
    apiKey: '',
    models: [resolvedModel],
  };

  // Gemini Code Assist: resolve (once per account) + thread the project id onto
  // the transformer provider so `GeminiCodeAssistTransformer` embeds it in the
  // top-level envelope. Defensive — a handshake failure surfaces a clear 502.
  // SEAM CHOICE (route-to / resident-proxy ingress path): we stash the resolved
  // project on the `transformerProvider` object (the SAME seam the
  // SubscriptionDispatcher uses) because the transformer reads `provider.*` but
  // gets only `logger`/`providerName` on the `TransformerContext`. Adding one
  // optional `geminiProject` field to `LLMProvider` is the least-invasive way to
  // pass per-account data the chain can read, without widening the executor API.
  if (profile.authStrategy.providerId === 'gemini') {
    try {
      transformerProvider.geminiProject = await resolveGeminiCodeAssistProject(profile);
    } catch (err) {
      writeError(res, 502, serializeError(err));
      return null;
    }
  }

  return {
    auth,
    chain,
    transformerProvider,
    resolvedModel,
    isStream,
    // Prefer the transformer-supplied URL (Code Assist carries the correct
    // stream vs non-stream colon-method URL in `config.url`); fall back to the
    // profile's `resolveUpstreamUrl` for non-Code-Assist subscriptions.
    resolveUrl: (config) =>
      config.url instanceof URL
        ? config.url.toString()
        : typeof config.url === 'string'
          ? config.url
          : upstreamUrl,
    upstreamUrl,
    proxyProviderId: profile.authStrategy.providerId,
  };
}

/**
 * Resolve the Code Assist project for the gemini subscription profile. Reads the
 * current gemini OAuth access token via the profile's auth strategy (which holds
 * the token store), then runs the cached handshake. Returns `undefined` for a
 * fresh free-tier account (valid — no project in the envelope).
 */
async function resolveGeminiCodeAssistProject(
  profile: { authStrategy: { applyHeaders: (h: Record<string, string>) => Promise<void> } },
): Promise<string | undefined> {
  // Pull the Bearer the auth strategy would inject, so we don't need a separate
  // token-store handle here — the strategy is the single source of the token.
  const probe: Record<string, string> = {};
  await profile.authStrategy.applyHeaders(probe);
  const bearer = probe.Authorization ?? probe.authorization ?? '';
  const accessToken = bearer.replace(/^Bearer\s+/i, '').trim();
  if (!accessToken) return undefined;
  // The concrete resolver is HOST-CLEAN and lives in the serving core
  // (`@omnicross/core/auth/GeminiCodeAssistProjectResolver`); each embedder
  // injects it via the core port at bootstrap.
  // A null resolver (e.g. an unwired unit test, or an embedder that left the
  // slot unwired) yields `undefined`, matching the fresh-free-tier no-project case.
  const resolver = getGeminiCodeAssistResolver();
  if (!resolver) return undefined;
  return resolver.resolveProject(accessToken);
}

/**
 * Run the shared core ONCE with the Responses endpoint transformer. `rawStatus`
 * captures the RAW upstream HTTP status from the fetchFn closure (the response
 * chain rebuilds a fresh 200), so the subscription 401-retry wrapper can read it.
 */
async function runPipeline(
  responsesBody: Record<string, unknown>,
  plan: ResponsesCallPlan,
): Promise<{ response: Response; rawStatus: number | null }> {
  const executor = getSharedExecutor();
  const endpointTransformer = getResponsesEndpointTransformer();
  const { auth, chain, transformerProvider, resolvedModel, isStream, resolveUrl, upstreamUrl } = plan;

  // Pre-resolve auth headers (applyHeaders MAY be async for OAuth refresh while
  // buildHeaders is sync). Auth wins — chain headers never clobber a key the
  // AuthSource set.
  // upstream-proxy: capture the selected pooled account so per-account proxy
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
    request: responsesBody,
    provider: transformerProvider,
    chain,
    endpointTransformer,
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
      console.log(`[ProviderProxy:responses] -> ${url} model=${resolvedModel} stream=${isStream}`);
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
 * (and the sibling `runPipelineWithSubscriptionRetry`): run; report the RAW upstream
 * status to the pool via `auth.onResult`; on a rebind (429/529/401/403 produced a new
 * key, session rotated) re-run ONCE so `runPipeline` re-applies headers and picks up
 * the rotated `LlmConfigProviderAuth.apiKey`. `onResult` no-ops when there is no
 * pool/session (a plain BYO request behaves exactly as before — additive, zero
 * regression). Discarding the first (e.g. 429) response on rebind is safe: the relay
 * happens AFTER this wrapper returns, so the first response's body was never read.
 */
async function runPipelineWithPoolReporting(
  responsesBody: Record<string, unknown>,
  plan: ResponsesCallPlan,
): Promise<{ response: Response; rawStatus: number | null }> {
  const first = await runPipeline(responsesBody, plan);
  const outcome = await plan.auth.onResult?.(first.rawStatus);
  if (outcome?.rebound) {
    console.log(
      '[ProviderProxy:responses] pool re-bound key after status',
      first.rawStatus,
      '→ retrying once',
    );
    return runPipeline(responsesBody, plan);
  }
  return first;
}

/**
 * Subscription 401-retry-once wrapper — mirrors
 * the host's codex subscription-retry wrapper: run; if RAW upstream
 * status was 401 and `auth.onUnauthorized()` resolves true (token refreshed),
 * re-run once; otherwise surface the (already transformed) response.
 */
async function runPipelineWithSubscriptionRetry(
  responsesBody: Record<string, unknown>,
  plan: ResponsesCallPlan,
): Promise<{ response: Response; rawStatus: number | null }> {
  const first = await runPipeline(responsesBody, plan);
  if (first.rawStatus !== 401) return first;

  const refreshed = await plan.auth.onUnauthorized?.();
  if (!refreshed) {
    console.warn('[ProviderProxy:responses] 401 not recoverable (onUnauthorized returned false)');
    return first;
  }
  console.log('[ProviderProxy:responses] 401 → token refreshed; retrying once');
  return runPipeline(responsesBody, plan);
}
