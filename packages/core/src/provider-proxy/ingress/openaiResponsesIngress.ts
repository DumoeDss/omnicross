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
 * per-session proxy constructor (design D7).
 *
 * @module provider-proxy/ingress/openaiResponsesIngress
 */

import type http from 'node:http';

import type { UsageCacheKeySource } from '@omnicross/contracts/usage-stats-types';

import { isAccountAllowanceExhaustedError } from '../../pipeline/AccountAllowanceScheduling';
import { isBoundAccountSelectionError } from '../../pipeline/BoundAccountSelectionError';
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
import {
  codexAcceptHeader,
  DEFAULT_CODEX_CLI_HEADERS,
  extractCodexClientHeaders,
} from '../identity/codexCliHeaders';
import { fillMissingHeaders } from '../identity/headerMerge';
import {
  deriveGatewaySessionKey,
  type DerivedSessionKey,
  type SessionKeySource,
  type SessionRequestHeaders,
} from '../matchText';
import type { ProviderProxyDeps, RouteContext } from '../types';
import { recordResponsesNonStreamUsage, recordResponsesStreamUsage } from '../usage/recordResponsesUsage';

import {
  getResponsesEndpointTransformer,
  getSharedExecutor,
  relayResponse,
  resolvePoolBoundKey,
  writeBoundAccountError,
  writeError,
} from './providerProxyShared';
import { markCodexUsageLimitExhaustion } from './codexUsageLimitDetection';
import { getSharedAccountRouteActivity } from '../../pipeline/AccountRouteActivity';
import { getSharedOverloadCounter } from '../../pipeline/ServerOverloadCounter';

/**
 * SSE `response.failed` `error.code` values that mean the Codex/OpenAI backend
 * itself is overloaded (account-independent capacity) — NOT a quota/usage wall.
 * Mirrors Codex CLI's own classifier (`codex-api/src/sse/responses.rs:669`).
 * Delivered INSIDE a `200` stream, which is why the route-activity HTTP-status
 * layer never sees them and the existing 429-quota retry does not fire.
 */
const SERVER_OVERLOADED_CODES = new Set(['server_is_overloaded', 'slow_down']);

/**
 * True when a parsed Responses-API SSE event is the server-overload failure.
 * Detection only — the caller RECORDS/annotates but never retries (overload is
 * account-independent; retrying on another account won't help and may worsen it).
 * Exported for unit testing.
 */
export function isCodexServerOverloadEvent(event: Record<string, unknown>): boolean {
  if (event['type'] !== 'response.failed') return false;
  const error = (event['response'] as Record<string, unknown> | undefined)?.['error'] as
    | Record<string, unknown>
    | undefined;
  const code = error?.['code'];
  return typeof code === 'string' && SERVER_OVERLOADED_CODES.has(code);
}

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
export interface ResponsesCallPlan {
  readonly auth: AuthSource;
  /** Stable per-conversation account-pool affinity key. */
  readonly sessionKey?: string;
  /** Safe diagnostic describing which hashed session identifier won. */
  readonly sessionSource?: SessionKeySource;
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
  /**
   * The caller's forwardable Codex CLI headers (`originator` / UA / `version` /
   * `openai-beta` / `session_id`). Populated for the codex SUBSCRIPTION plan
   * only; a BYO plan leaves it undefined so its outbound headers stay
   * byte-identical.
   */
  readonly callerClientHeaders?: Record<string, string>;
}

interface PromptCacheKeyAttribution {
  readonly cacheKeySource: UsageCacheKeySource;
  readonly cacheKeyInjected: boolean;
}

type InjectedCacheKeySource = Exclude<UsageCacheKeySource, 'client' | 'none'>;

const SAFE_INJECTED_CACHE_KEY_SOURCES = new Set<SessionKeySource>([
  'session-header',
  'thread-header',
  'body-session-id',
  'body-thread-id',
  'content-fingerprint',
]);

function isSafeInjectedCacheKeySource(
  source: SessionKeySource,
): source is InjectedCacheKeySource {
  return SAFE_INJECTED_CACHE_KEY_SOURCES.has(source);
}

/**
 * Preserve a caller-provided cache key, or attach a stable opaque key for a
 * Codex request only when it was derived from conversation-specific metadata.
 * Route/API-key fallbacks are deliberately excluded because they would merge
 * unrelated conversations into one upstream cache namespace.
 */
export function ensureCodexPromptCacheKey(
  body: Record<string, unknown>,
  proxyProviderId: string,
  derivedSession: DerivedSessionKey,
): PromptCacheKeyAttribution {
  if (typeof body.prompt_cache_key === 'string' && body.prompt_cache_key.trim()) {
    return { cacheKeySource: 'client', cacheKeyInjected: false };
  }
  if (
    proxyProviderId !== 'codex' ||
    !isSafeInjectedCacheKeySource(derivedSession.source)
  ) {
    return { cacheKeySource: 'none', cacheKeyInjected: false };
  }

  body.prompt_cache_key = `omnicross:${derivedSession.source}:${derivedSession.key}`;
  return {
    cacheKeySource: derivedSession.source,
    cacheKeyInjected: true,
  };
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
  requestHeaders: SessionRequestHeaders = {},
): Promise<void> {
  let responsesBody: Record<string, unknown>;
  try {
    responsesBody = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    writeError(res, 400, 'Invalid JSON in request body');
    return;
  }

  const isStream = responsesBody.stream === true;
  const derivedSession = deriveGatewaySessionKey(responsesBody, requestHeaders, {
    endpoint: 'responses',
    // A verified outbound key is the strongest route-local fallback. Resident
    // proxy callers without one still get a stable run/session bucket; the
    // final `anonymous` fallback is handled inside the shared utility.
    fallbackKey: route.apiKeyId ?? route.sessionId ?? undefined,
  });
  const sessionKey = derivedSession.key;
  // Codex model-name mapping (ingress quirk): route the CLI's model to the
  // route's configured provider model.
  const resolvedModel = route.model;
  responsesBody.model = resolvedModel;

  try {
    const plan =
      route.authMode === 'subscription'
        ? await buildSubscriptionPlan(
            res,
            route,
            deps,
            resolvedModel,
            isStream,
            sessionKey,
            derivedSession.source,
            requestHeaders,
          )
        : await buildByoPlan(res, route, deps, resolvedModel, isStream);
    if (!plan) return;

    const cacheKeyAttribution = ensureCodexPromptCacheKey(
      responsesBody,
      plan.proxyProviderId,
      derivedSession,
    );

    let providerResponse =
      route.authMode === 'subscription'
        ? await runPipelineWithSubscriptionRetry(responsesBody, plan)
        : await runPipelineWithPoolReporting(responsesBody, plan);
    // Codex weekly usage-limit wall: BEFORE relaying, detect the wall, mark the
    // serving account, and retry on another pool member so THIS request is served
    // (not just the next one). The mark excludes the account from selection, and
    // the affinity short-circuit only honors a sticky account while it is still
    // schedulable — so the retry routes to a different account. Subscription codex
    // only: BYO / non-codex never report an accountId and skip this untouched.
    providerResponse = await retryAroundCodexUsageLimit(responsesBody, plan, providerResponse);

    // Passthrough (design D4): rewrite the response `model` back to the client's
    // ORIGINAL requested id (`route.requestedModel`) so Codex sees `gpt-5-codex-…`
    // rather than the upstream provider model. `undefined` for internal traffic
    // ⇒ byte-identical. Usage accounting stays on the actual selected account model.
    const usageAttribution = {
      sessionId: route.sessionId,
      providerId: route.providerId ?? 'codex',
      model: providerResponse.actualModel ?? resolvedModel,
      apiKeyId: route.apiKeyId ?? null,
      routeLease: route.routeLease,
      cacheKeySource: cacheKeyAttribution.cacheKeySource,
      cacheKeyInjected: cacheKeyAttribution.cacheKeyInjected,
      // request-audit-log: correlate this request's tokens/cost to its audit record.
      auditResponse: res,
    };
    // Streaming usage tap: the codex backend forces `stream:true`, so without
    // this the non-stream recorder below never fires (relayResponse returns null
    // for streams) and Codex turns produce zero usage/dashboard rows. The tap
    // pulls `usage` out of the terminal `response.completed` event.
    const usageRecorder = deps.usageRecorder;
    const usageTap = usageRecorder
      ? {
          extractUsage(event: Record<string, unknown>): Record<string, unknown> | null | undefined {
            if (event['type'] !== 'response.completed') return null;
            const response = event['response'] as Record<string, unknown> | undefined;
            const usage = response?.['usage'] as Record<string, unknown> | undefined;
            return usage ?? null;
          },
          onUsage(rawUsage: Record<string, unknown>): void {
            recordResponsesStreamUsage(usageRecorder, rawUsage, usageAttribution);
          },
        }
      : undefined;
    // Server-overload visibility: a Codex `response.failed` overload event
    // arrives INSIDE this 200 stream (see isCodexServerOverloadEvent). It is
    // account-independent capacity — we do NOT retry/divert, but we DO record:
    // backfill the route-activity row (so a 200 that failed mid-stream is no
    // longer disguised as healthy) and tally it on the overload counter (trend).
    // The flag makes each effect fire at most once per request even if multiple
    // failure events appear in the stream.
    const overloadActivityId = providerResponse.activityRecordId;
    const overloadAccountId = providerResponse.accountId;
    const overloadProviderId = plan.proxyProviderId;
    let overloadRecorded = false;
    const overloadDetector = (event: Record<string, unknown>): void => {
      if (overloadRecorded || !isCodexServerOverloadEvent(event)) return;
      overloadRecorded = true;
      if (overloadActivityId) {
        getSharedAccountRouteActivity().amend(overloadActivityId, {
          streamError: 'server_overloaded',
        });
      }
      if (overloadAccountId) {
        getSharedOverloadCounter().recordOverload({
          providerId: overloadProviderId,
          accountId: overloadAccountId,
          endpoint: 'responses',
        });
      }
    };
    const bodyText = await relayResponse(
      res,
      providerResponse.response,
      isStream,
      route.requestedModel,
      usageTap,
      overloadDetector,
    );
    if (bodyText && deps.usageRecorder) {
      recordResponsesNonStreamUsage(deps.usageRecorder, bodyText, usageAttribution);
    }
  } catch (err) {
    if (isBoundAccountSelectionError(err)) {
      writeBoundAccountError(res, err);
      return;
    }
    const errMsg = serializeError(err);
    console.error('[ProviderProxy:responses] Pipeline error:', errMsg);
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

  const { chain } = await resolveProviderChain(deps.llmConfig, providerId, resolvedModel);

  const transformerProvider: TransformerLLMProvider = {
    name: provider.name,
    baseUrl: provider.api_base_url,
    apiKey,
    models: provider.models || [],
    modelConfigs: provider.modelConfigs,
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
  sessionKey: string,
  sessionSource: SessionKeySource,
  requestHeaders: SessionRequestHeaders,
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
      transformerProvider.geminiProject = await resolveGeminiCodeAssistProject(profile, {
        sessionKey,
        preferredAccountId: route.preferredAccountId,
        preferredAccountGroup: route.preferredAccountGroup,
        boundAccountFallbackPolicy: route.boundAccountFallbackPolicy,
      });
    } catch (err) {
      if (isBoundAccountSelectionError(err)) {
        writeBoundAccountError(res, err);
        return null;
      }
      writeError(res, 502, serializeError(err));
      return null;
    }
  }

  return {
    auth,
    sessionKey,
    sessionSource,
    preferredAccountId: route.preferredAccountId,
    preferredAccountGroup: route.preferredAccountGroup,
    boundAccountFallbackPolicy: route.boundAccountFallbackPolicy,
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
    // Only the codex backend understands these; other subscription providers
    // (gemini Code Assist) share this relay and must not receive them.
    callerClientHeaders:
      profile.authStrategy.providerId === 'codex'
        ? extractCodexClientHeaders(requestHeaders)
        : undefined,
  };
}

/**
 * Resolve the Code Assist project for the gemini subscription profile. Reads the
 * current gemini OAuth access token via the profile's auth strategy (which holds
 * the token store), then runs the cached handshake. Returns `undefined` for a
 * fresh free-tier account (valid — no project in the envelope).
 */
async function resolveGeminiCodeAssistProject(
  profile: {
    authStrategy: {
      applyHeaders: (
        h: Record<string, string>,
        hints?: {
          sessionKey?: string;
          preferredAccountId?: string;
          preferredAccountGroup?: string;
          boundAccountFallbackPolicy?: RouteContext['boundAccountFallbackPolicy'];
        },
      ) => Promise<void>;
    };
  },
  hints: {
    sessionKey?: string;
    preferredAccountId?: string;
    preferredAccountGroup?: string;
    boundAccountFallbackPolicy?: RouteContext['boundAccountFallbackPolicy'];
  },
): Promise<string | undefined> {
  // Pull the Bearer the auth strategy would inject, so we don't need a separate
  // token-store handle here — the strategy is the single source of the token.
  const probe: Record<string, string> = {};
  await profile.authStrategy.applyHeaders(probe, hints);
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
): Promise<PipelineResult> {
  const executor = getSharedExecutor();
  const endpointTransformer = getResponsesEndpointTransformer();
  const { auth, sessionKey, chain, transformerProvider, resolvedModel, isStream, resolveUrl, upstreamUrl } = plan;

  // Pre-resolve auth headers (applyHeaders MAY be async for OAuth refresh while
  // buildHeaders is sync). Auth wins — chain headers never clobber a key the
  // AuthSource set.
  // upstream-proxy: capture the selected pooled account so per-account proxy
  // resolves (no-op for BYO — LlmConfigProviderAuth never reports a selection).
  let proxyAccountId: string | undefined;
  let actualModel = resolvedModel;
  // route-activity record id for THIS attempt, captured from the fetch seam so a
  // mid-stream overload event can later amend the row that stamped the 200.
  let activityRecordId: string | undefined;
  const authHeaders: Record<string, string> = {};
  await auth.applyHeaders(authHeaders, {
    upstreamUrl,
    model: resolvedModel,
    sessionKey,
    preferredAccountId: plan.preferredAccountId,
    preferredAccountGroup: plan.preferredAccountGroup,
    boundAccountFallbackPolicy: plan.boundAccountFallbackPolicy,
    reportSelection: (accountId, _isActive, remappedModel) => {
      proxyAccountId = accountId;
      if (remappedModel) actualModel = remappedModel;
    },
  });

  responsesBody.model = actualModel;
  transformerProvider.models = [actualModel];
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
      // Codex CLI client markers — SUBSCRIPTION ONLY. This relay is shared with
      // BYO OpenAI-compatible endpoints, which must stay byte-identical (sending
      // them `originator: codex_cli_rs` would be wrong). Before this the codex
      // subscription relay sent only `content-type` + `Authorization`, carrying
      // none of the markers a real codex CLI sends.
      //
      // `fillMissingHeaders` never overwrites, so a genuine Codex CLI's own
      // values win and the defaults only cover what it did not send.
      if (plan.proxyProviderId === 'codex') {
        fillMissingHeaders(headers, plan.callerClientHeaders ?? {});
        fillMissingHeaders(headers, DEFAULT_CODEX_CLI_HEADERS);
        fillMissingHeaders(headers, { accept: codexAcceptHeader(isStream) });
      }
      return headers;
    },
    fetchFn: (url, headers, body) => {
      console.log(`[ProviderProxy:responses] -> ${url} model=${actualModel} stream=${isStream}`);
      return fetchUpstream(
        url,
        { method: 'POST', headers, body: JSON.stringify(body) },
        {
          providerId: plan.proxyProviderId,
          accountId: proxyAccountId,
          routeActivity: plan.proxyProviderId === 'byo'
            ? undefined
            : {
                endpoint: 'responses',
                sessionKey,
                sessionSource: plan.sessionSource ?? 'none',
                model: actualModel,
                onRecorded: (record) => {
                  activityRecordId = record.id;
                },
              },
        },
      ).then((r) => {
        rawStatus = r.status;
        return r;
      });
    },
    runResponseChain: true,
  });

  return { response, rawStatus, accountId: proxyAccountId, actualModel, activityRecordId };
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
): Promise<PipelineResult> {
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
): Promise<PipelineResult> {
  const first = await runPipeline(responsesBody, plan);
  if (first.rawStatus !== 401) return first;

  const refreshed = await plan.auth.onUnauthorized?.(plan.sessionKey);
  if (!refreshed) {
    console.warn('[ProviderProxy:responses] 401 not recoverable (onUnauthorized returned false)');
    return first;
  }
  console.log('[ProviderProxy:responses] 401 → token refreshed; retrying once');
  return runPipeline(responsesBody, plan);
}

/** The runPipeline result shape (shared by every wrapper above). */
type PipelineResult = {
  response: Response;
  rawStatus: number | null;
  accountId: string | undefined;
  actualModel?: string;
  /**
   * The route-activity record id for THIS attempt, so a post-hoc mid-stream
   * fact (e.g. an overload event in the 200 SSE body) can `amend` the SAME row
   * that `fetchUpstream` stamped with the 200 status. Undefined on BYO / when
   * no route-activity record was created.
   */
  activityRecordId: string | undefined;
};

/**
 * Cap on consecutive quota-exhausted accounts retried for ONE inbound request.
 * Each retry is one upstream round-trip, so this bounds tail latency when several
 * accounts are simultaneously exhausted (the common case is one). Accounts beyond
 * this cap are marked on subsequent requests and converge out of rotation.
 */
const MAX_QUOTA_RETRIES = 3;

/**
 * Whether a result is a subscription-codex 429 — the weekly usage-limit / quota
 * wall status. The mark + retry fires on this; other errors (500/401/…) have
 * their own handling and pass through untouched. `accountId` is set only on the
 * subscription path (BYO never reports one), so BYO is excluded for free.
 */
function isCodexAccountQuota429(plan: ResponsesCallPlan, result: PipelineResult): boolean {
  return (
    plan.proxyProviderId === 'codex' &&
    !!result.accountId &&
    result.rawStatus === 429
  );
}

/**
 * Codex weekly usage-limit retry: when an attempt returns 429, mark the serving
 * account (deadline resolved from the allowance snapshot's exhausted window, the
 * body's "try again" date, or a short default — see codexUsageLimitDetection)
 * and re-run on another pool member, looping until one succeeds, a non-429
 * surfaces, or {@link MAX_QUOTA_RETRIES} is reached. Runs BEFORE the relay so the
 * client receives the successful retry rather than the wall.
 *
 * The mark is what makes the retry switch accounts: it gates the 429 account out
 * of selection, and the affinity short-circuit only honors a sticky account while
 * it is still schedulable. Detection keys off the 429 status + the structured
 * allowance snapshot (NOT the body text — the Codex CLI renders the human message
 * itself, so the raw 429 body need not carry the prose markers).
 *
 * Exported + `runAttempt`-injectable so the loop can be tested without the full
 * pipeline; production passes the real subscription wrapper.
 */
export async function retryAroundCodexUsageLimit(
  responsesBody: Record<string, unknown>,
  plan: ResponsesCallPlan,
  first: PipelineResult,
  runAttempt: (responsesBody: Record<string, unknown>, plan: ResponsesCallPlan) => Promise<PipelineResult> = runPipelineWithSubscriptionRetry,
): Promise<PipelineResult> {
  if (!isCodexAccountQuota429(plan, first)) return first;
  let current = first;
  for (let attempt = 0; attempt < MAX_QUOTA_RETRIES; attempt++) {
    // `current` is a 429: read its body only to help resolve the cooldown
    // deadline, then mark + discard it (the retry's result is what gets relayed).
    const errorBody = await current.response.text().catch(() => '');
    markCodexUsageLimitExhaustion(current.accountId, errorBody);
    const next = await runAttempt(responsesBody, plan);
    if (!isCodexAccountQuota429(plan, next)) return next; // success or non-429 → relay as-is
    current = next; // another 429 (another exhausted account) → mark + retry again
  }
  // Cap reached: `current` is an UNREAD 429 → the caller relays it verbatim.
  return current;
}
