/**
 * geminiGenerateContentIngress — the ProviderProxy Gemini `generateContent`
 * ingress parser.
 *
 * The gemini-CLI (api-key/relay mode) posts to the Google Generative Language
 * REST surface: `POST <base>/v1beta/models/<model>:generateContent` (non-stream)
 * and `POST <base>/v1beta/models/<model>:streamGenerateContent?alt=sse`
 * (stream). The `:method` suffix on the FINAL path segment is the action, and
 * the model is the segment between `models/` and that `:`. This parser:
 *   1. matches `POST` paths whose final segment contains `:generateContent` or
 *      `:streamGenerateContent`;
 *   2. decodes the Gemini wire body → `UnifiedChatRequest` via
 *      `GeminiTransformer` as the `endpointTransformer` (NOT hand-rolled — reuses
 *      the transformer SSOT, exactly as `openaiResponsesIngress` reuses
 *      `OpenAIResponseTransformer`);
 *   3. runs `executeProviderCall` with `runResponseChain: true`, so the resolved
 *      provider chain encodes Unified → the chosen target Provider's wire on the
 *      request side, and the SAME `GeminiTransformer` re-encodes the response
 *      back to the Gemini wire (`transformResponseIn`) for the CLI.
 *
 * AUTH: the gemini-CLI carries the route token in `x-goog-api-key` (Gemini's
 * default header), NOT `Authorization`. The router reads both; this parser only
 * needs the already-resolved `RouteContext`.
 *
 * PARITY with `openaiResponsesIngress.ts` / `openaiChatIngress.ts`: same per-run
 * `RouteContext` shape, same BYO call-plan, same relay + usage tap. BYO-only in
 * this slice (`authMode: 'subscription'` rejected) — gemini SUBSCRIPTION stays
 * the shape-C `(claude-sdk, sub:gemini)` cell owned by `engine-provider-decouple`
 * and is NEVER routed through this ingress (design D8/R1).
 *
 * @module provider-proxy/ingress/geminiGenerateContentIngress
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
import { recordGeminiNonStreamUsage } from '../usage/recordGeminiUsage';

import {
  getGeminiEndpointTransformer,
  getSharedExecutor,
  relayResponse,
  resolvePoolBoundKey,
  writeError,
} from './providerProxyShared';

/** Final-path-segment action suffix the Gemini REST surface uses. */
const GENERATE_CONTENT_ACTION = ':generateContent';
const STREAM_GENERATE_CONTENT_ACTION = ':streamGenerateContent';

/**
 * Match the Gemini `generateContent` route: `POST` + a path whose FINAL segment
 * contains `:generateContent` or `:streamGenerateContent` (e.g.
 * `/v1beta/models/gemini-2.5-pro:generateContent`). The query (`?alt=sse`) is
 * stripped before matching.
 */
export function isGeminiGenerateContentRequest(
  method: string | undefined,
  url: string | undefined,
): boolean {
  if (method !== 'POST' || !url) return false;
  const path = url.split('?')[0]?.replace(/\/+$/, '') ?? '';
  const lastSegment = path.split('/').pop() ?? '';
  return (
    lastSegment.includes(STREAM_GENERATE_CONTENT_ACTION) ||
    lastSegment.includes(GENERATE_CONTENT_ACTION)
  );
}

/**
 * Whether the request is the streaming variant. True when the final path
 * segment is `:streamGenerateContent` OR the query carries `alt=sse` (the
 * gemini-CLI sends both together; either is sufficient).
 */
export function isGeminiStreamRequest(url: string | undefined): boolean {
  if (!url) return false;
  const [path, query = ''] = url.split('?');
  const lastSegment = (path?.replace(/\/+$/, '') ?? '').split('/').pop() ?? '';
  if (lastSegment.includes(STREAM_GENERATE_CONTENT_ACTION)) return true;
  return /(^|&)alt=sse(&|$)/.test(query);
}

/**
 * Extract the model from a Gemini path: the segment between `models/` and the
 * `:method` action (`/v1beta/models/<model>:generateContent`). Returns
 * `undefined` when no `models/<model>:...` segment is present.
 */
export function extractGeminiModelFromPath(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const path = url.split('?')[0] ?? '';
  const lastSegment = path.replace(/\/+$/, '').split('/').pop() ?? '';
  const colonIdx = lastSegment.indexOf(':');
  if (colonIdx <= 0) return undefined;
  return lastSegment.slice(0, colonIdx);
}

/** The auth-mode-resolved inputs for one `executeProviderCall`. */
interface GeminiCallPlan {
  readonly auth: AuthSource;
  readonly chain: ResolvedTransformerChain;
  readonly transformerProvider: TransformerLLMProvider;
  readonly resolvedModel: string;
  readonly isStream: boolean;
  readonly resolveUrl: (config: RequestConfig) => string;
  readonly upstreamUrl: string;
}

/**
 * Handle one Gemini `generateContent` request for the resolved `RouteContext`.
 * BYO-only in this slice — `authMode: 'subscription'` is rejected (gemini
 * subscription is the shape-C cell owned elsewhere and never reaches here).
 */
export async function handleGeminiGenerateContentRequest(
  res: http.ServerResponse,
  rawBody: string,
  url: string | undefined,
  route: RouteContext,
  deps: ProviderProxyDeps,
): Promise<void> {
  let geminiBody: Record<string, unknown>;
  try {
    geminiBody = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    writeError(res, 400, 'Invalid JSON in request body');
    return;
  }

  if (route.authMode === 'subscription') {
    writeError(res, 502, 'Gemini generateContent ingress does not support subscription auth');
    return;
  }

  // Stream is URL-derived (the Gemini wire body carries no `stream` field). Inject
  // it onto the decoded body so `GeminiTransformer.transformRequestOut` produces a
  // `UnifiedChatRequest` with the right `stream` flag.
  const isStream = isGeminiStreamRequest(url);
  geminiBody.stream = isStream;
  // CLI model-name mapping (ingress quirk): route the CLI's model (in the path)
  // to the route's configured provider model, exactly like the other ingresses.
  const resolvedModel = route.model;
  geminiBody.model = resolvedModel;

  try {
    const plan = await buildByoPlan(res, route, deps, resolvedModel, isStream);
    if (!plan) return;

    const providerResponse = await runPipelineWithPoolReporting(geminiBody, plan);

    const bodyText = await relayResponse(res, providerResponse.response, isStream);
    if (bodyText && deps.usageRecorder) {
      recordGeminiNonStreamUsage(deps.usageRecorder, bodyText, {
        sessionId: route.sessionId,
        providerId: route.providerId ?? 'gemini',
        model: resolvedModel,
        apiKeyId: route.apiKeyId ?? null,
        // request-audit-log: correlate this request's tokens/cost to its audit record.
        auditResponse: res,
      });
    }
  } catch (err) {
    const errMsg = serializeError(err);
    console.error('[ProviderProxy:gemini] Pipeline error:', errMsg);
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
): Promise<GeminiCallPlan | null> {
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
 * Run the shared core ONCE with the Gemini endpoint transformer. The endpoint
 * transformer decodes the Gemini wire → Unified on the request side and
 * re-encodes Unified → Gemini wire on the response side (`runResponseChain:
 * true`), so the relay hands the CLI a Gemini-shaped response regardless of the
 * target provider's wire format.
 */
async function runPipeline(
  geminiBody: Record<string, unknown>,
  plan: GeminiCallPlan,
): Promise<{ response: Response; rawStatus: number | null }> {
  const executor = getSharedExecutor();
  const endpointTransformer = getGeminiEndpointTransformer();
  const { auth, chain, transformerProvider, resolvedModel, isStream, resolveUrl, upstreamUrl } = plan;

  // Pre-resolve auth headers (applyHeaders MAY be async for OAuth refresh while
  // buildHeaders is sync). Auth wins — chain headers never clobber a key the
  // AuthSource set.
  const authHeaders: Record<string, string> = {};
  await auth.applyHeaders(authHeaders, { upstreamUrl, model: resolvedModel });

  let rawStatus: number | null = null;

  const { response } = await executeProviderCall({
    executor,
    request: geminiBody,
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
      console.log(`[ProviderProxy:gemini] -> ${url} model=${resolvedModel} stream=${isStream}`);
      // upstream-proxy: BYO gemini egress honors the global/provider proxy.
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
  geminiBody: Record<string, unknown>,
  plan: GeminiCallPlan,
): Promise<{ response: Response; rawStatus: number | null }> {
  const first = await runPipeline(geminiBody, plan);
  const outcome = await plan.auth.onResult?.(first.rawStatus);
  if (outcome?.rebound) {
    console.log(
      '[ProviderProxy:gemini] pool re-bound key after status',
      first.rawStatus,
      '→ retrying once',
    );
    return runPipeline(geminiBody, plan);
  }
  return first;
}
