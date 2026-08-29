/**
 * anthropicMessagesByo — the built-in, factory-less Anthropic `/v1/messages`
 * BYO path for the resident `ProviderProxy`.
 *
 * Taken ONLY when `deps.anthropicIngressHandlerFactory` is ABSENT (e.g. the
 * `@omnicross/daemon` standalone embedder, which has zero host dependency
 * and therefore no quirk factory to inject). An embedder that DOES inject the
 * factory takes a byte-identical delegation branch instead — see
 * `anthropicMessagesIngress.ts` — so this path is unreachable there.
 *
 * Mirrors `geminiGenerateContentIngress.ts` 1:1 (the proven factory-less
 * template): `buildByoPlan` → `runPipelineWithPoolReporting`
 * (→ `runPipeline` = `executeProviderCall` with `AnthropicTransformer` as the
 * endpoint transformer + `runResponseChain: true`) → `relayResponse` → optional
 * non-stream usage tap. The ONE structural addition is the same-format fast
 * path: when the target provider's format is `anthropic`, the unified
 * round-trip would strip Anthropic server-tool `type` fields, so we SKIP the
 * endpoint transformer + chain and relay the request body verbatim — the
 * generic kernel of a direct Anthropic request/pass-through MINUS the
 * OAuth-token-swap and the 5h/7d window taps.
 *
 * NO SDK quirk (probe-mock, local web-search interception, callbacks,
 * attribution) lives here — those stay exclusively in any delegated
 * host-injected factory.
 *
 * `authMode: 'subscription'` IS served on this built-in path via a sibling
 * `anthropicSubscriptionPlan.ts`: `buildSubscriptionPlan` +
 * `runPipelineWithSubscriptionRetry` (and a
 * verbatim `runSubscriptionSameFormatFetch` relay for claude pass-through /
 * opencodego anthropic-shape upstreams), mirroring the OpenAI-Responses ingress's
 * BYO-vs-subscription split. The BYO helpers below are UNTOUCHED. The subscription
 * same-format decision is computed from a CORE-LOCAL signal
 * (`profile.mode === 'pass-through'` OR the resolved upstream URL ends in
 * `/v1/messages`) — core imports NOTHING from `@omnicross/subscriptions`.
 */

import type http from 'node:http';

import { isAccountAllowanceExhaustedError } from '../../pipeline/AccountAllowanceScheduling';
import { isBoundAccountSelectionError } from '../../pipeline/BoundAccountSelectionError';
import { getSharedAccountRouteActivity } from '../../pipeline/AccountRouteActivity';
import { getSharedAccountHealth } from '../../pipeline/SubscriptionAccountHealth';
import { getSharedOverloadCounter } from '../../pipeline/ServerOverloadCounter';
import { fetchUpstream } from '../../pipeline/upstreamFetch';

import { serializeError } from '@omnicross/core/serializeError';

import {
  buildProviderApiUrl,
  getProviderHeaders,
  resolveApiFormat,
} from '../../completion';
import { DEFAULT_ANTHROPIC_VERSION } from '../identity/claudeCodeHeaders';
import { LlmConfigProviderAuth } from '../../pipeline/LlmConfigProviderAuth';
import { resolveProviderChain } from '../../pipeline/resolveProviderChain';
import type {
  LLMProvider as TransformerLLMProvider,
} from '../../transformer';
import { injectExtendedContextBeta } from '../../transformer/anthropicBetaInject';
import type { ProviderProxyDeps, RouteContext } from '../types';
import { recordAnthropicNonStreamUsage, recordAnthropicStreamUsage } from '../usage/recordAnthropicUsage';

import {
  type AnthropicByoOptions,
  type AnthropicCallPlan,
  type AnthropicRunResult,
  buildSubscriptionPlan,
  runPipeline,
  runPipelineWithSubscriptionRetry,
} from './anthropicSubscriptionPlan';
import {
  DocumentNotSupportedError,
  prepareAnthropicTranslateBody,
  UnsupportedContentBlockError,
} from './anthropicTranslateBodyPrep';
import { isCodexServerOverloadEvent } from './openaiResponsesIngress';
import {
  aggregateAnthropicSseToJsonBody,
  relayResponse,
  resolvePoolBoundKey,
  writeBoundAccountError,
  writeError,
} from './providerProxyShared';

// Re-export the shared plan/options types so existing importers
// (`anthropicMessagesIngress.ts`, tests) keep their import paths unchanged.
export type { AnthropicByoOptions, AnthropicCallPlan } from './anthropicSubscriptionPlan';

/**
 * Handle one built-in Anthropic `/v1/messages` request for the resolved
 * `RouteContext`. The route's `authMode` selects the BYO or subscription call
 * plan + run wrapper (D1), mirroring the OpenAI-Responses ingress; the relay +
 * non-stream usage tap stay shared.
 */
export async function handleAnthropicMessagesByo(
  res: http.ServerResponse,
  rawBody: string,
  route: RouteContext,
  deps: ProviderProxyDeps,
  options: AnthropicByoOptions = {},
): Promise<void> {
  let anthropicBody: Record<string, unknown>;
  try {
    anthropicBody = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    writeError(res, 400, 'Invalid JSON in request body');
    return;
  }

  // The Anthropic wire carries `stream` in the body (unlike Gemini, where it is
  // URL-derived). Map the CLI/SDK model to the route's configured provider model,
  // exactly like the other ingresses. (Subscription mapping may further rewrite
  // `resolvedModel` inside `buildSubscriptionPlan` via the profile's modelMapper.)
  const isStream = anthropicBody.stream === true;
  const resolvedModel = route.model;
  anthropicBody.model = resolvedModel;

  try {
    const plan =
      route.authMode === 'subscription'
        ? await buildSubscriptionPlan(res, route, deps, anthropicBody, resolvedModel, isStream)
        : await buildByoPlan(res, route, deps, resolvedModel, isStream);
    if (!plan) return;

    // The subscription plan may have rewritten `model` (modelMapper); keep the
    // outbound body in sync with the plan so the transformer path POSTs the
    // resolved model. (The verbatim relay forwards `rawBody`, so this only
    // affects the transformer path.)
    anthropicBody.model = plan.resolvedModel;

    // TRANSLATE-PATH content pre-pass (claude-api-transform-fidelity, D3):
    // documents become extracted-text blocks, unrepresentable blocks 400 —
    // BEFORE the pipeline (the decoder is sync/pure and cannot do budgeted
    // async work). NEVER runs on the same-format verbatim path (the moat).
    // BYO has a single static plan, so the initial sameFormat is final here;
    // SUBSCRIPTION routes run the pre-pass per-ITERATION inside the fallback
    // loop (review C-M3: the opencodego loop recomputes sameFormat per model —
    // prepping to the INITIAL classification would re-drop documents on a
    // translate flip, or leak mutations into a same-format iteration).
    if (route.authMode !== 'subscription' && !plan.sameFormat) {
      await prepareAnthropicTranslateBody(anthropicBody, route.anthropicPdfTextExtractionBudgetMs);
    }
    const prepareTranslateBody =
      route.authMode === 'subscription'
        ? async (body: Record<string, unknown>): Promise<void> => {
            await prepareAnthropicTranslateBody(body, route.anthropicPdfTextExtractionBudgetMs);
          }
        : undefined;

    const providerResponse =
      route.authMode === 'subscription'
        ? await runPipelineWithSubscriptionRetry(anthropicBody, rawBody, plan, route, deps, options, prepareTranslateBody)
        : await runPipelineWithPoolReporting(anthropicBody, rawBody, plan, options);

    // Passthrough (design D4): rewrite the response `model` back to the client's
    // ORIGINAL requested id (`route.requestedModel`) so Claude Code sees
    // `claude-opus-4-8-…` rather than the upstream provider model. `undefined`
    // for internal / delegated traffic ⇒ byte-identical. Usage accounting STAYS
    // on the upstream `plan.resolvedModel`.
    //
    // codex's Responses backend ONLY streams (it 400s on `stream:false`), so the
    // request transformer forces `stream:true` and the response arrives as
    // Anthropic SSE even when the CLIENT asked for a non-streaming message. In
    // that case collapse the SSE into a single buffered `message` JSON (the
    // format a non-streaming client expects) instead of letting `relayResponse`
    // stream the SSE verbatim to a non-streaming consumer.
    const upstreamResponse = providerResponse.response;
    const upstreamSse = (upstreamResponse.headers.get('content-type') ?? '').includes(
      'text/event-stream',
    );
    const actualModel =
      'actualModel' in providerResponse && typeof providerResponse.actualModel === 'string'
        ? providerResponse.actualModel
        : undefined;
    const usageAttribution = {
      sessionId: route.sessionId,
      providerId: route.providerId ?? 'anthropic',
      model: actualModel ?? plan.resolvedModel,
      apiKeyId: route.apiKeyId ?? null,
      routeLease: route.routeLease,
      // request-audit-log: correlate this request's tokens/cost to its audit record.
      auditResponse: res,
    };
    // Streaming usage tap: Anthropic streams split usage across `message_start`
    // (input_tokens) and `message_delta` (output_tokens). Hold the input half and
    // emit the merge on `message_delta`. The aggregate (non-stream-from-sse) path
    // below still uses the buffered non-stream recorder.
    const usageRecorder = deps.usageRecorder;
    let anthropicInputUsage: Record<string, unknown> | undefined;
    const usageTap = usageRecorder
      ? {
          extractUsage(event: Record<string, unknown>): Record<string, unknown> | null | undefined {
            if (event['type'] === 'message_start') {
              const msg = event['message'] as Record<string, unknown> | undefined;
              const u = msg?.['usage'] as Record<string, unknown> | undefined;
              if (u) anthropicInputUsage = u;
              return null;
            }
            if (event['type'] === 'message_delta') {
              const outputUsage = event['usage'] as Record<string, unknown> | undefined;
              if (!outputUsage) return null;
              return { ...anthropicInputUsage, ...outputUsage };
            }
            return null;
          },
          onUsage(rawUsage: Record<string, unknown>): void {
            recordAnthropicStreamUsage(usageRecorder, rawUsage, usageAttribution);
          },
        }
      : undefined;
    // ── Mid-stream event observers (claude-api-transform-fidelity) ───────────
    // R8: on the SUBSCRIPTION TRANSLATE plan mirror the responses ingress's
    // overload detector — a Codex `response.failed` overload event inside a 200
    // stream amends its route-activity row and tallies `endpoint:'messages'` on
    // the shared overload counter. Detection only (never retry); once per
    // request. Scoped to the `codex` provider (review C-m1): the event shape +
    // the sniffed codes are codex-backend specific — a non-codex translate
    // upstream never emits them, so wiring there could only ever false-positive.
    const overloadActivityId = providerResponse.activityRecordId;
    const overloadAccountId = providerResponse.accountId;
    let overloadRecorded = false;
    const codexOverloadDetector =
      plan.isSubscription && !plan.sameFormat && plan.transformerProvider.name === 'codex'
        ? (event: Record<string, unknown>): void => {
            if (overloadRecorded) return;
            // Two shapes reach this tap: the RAW codex event (`response.failed`
            // with `error.code`, when the chain passes it through) and the
            // CONVERTED Anthropic error event whose serialized message carries
            // the codex overload code (B's official in-band error shape).
            let hit = isCodexServerOverloadEvent(event);
            if (!hit && event['type'] === 'error') {
              const message = (event['error'] as Record<string, unknown> | undefined)?.['message'];
              hit =
                typeof message === 'string' &&
                (message.includes('server_is_overloaded') || message.includes('slow_down'));
            }
            if (!hit) return;
            overloadRecorded = true;
            if (overloadActivityId) {
              getSharedAccountRouteActivity().amend(overloadActivityId, {
                streamError: 'server_overloaded',
              });
            }
            if (overloadAccountId) {
              getSharedOverloadCounter().recordOverload({
                providerId: plan.transformerProvider.name,
                accountId: overloadAccountId,
                endpoint: 'messages',
              });
            }
          }
        : undefined;
    // R11③: on the SUBSCRIPTION SAME-FORMAT relay an Anthropic in-band
    // `overloaded_error` event (200 + official error event) marks the account
    // with the same 529 overload-cooldown window as a real 529. Bytes relay
    // unchanged (the observer is read-only); non-overloaded types never fire.
    let inbandOverloadRecorded = false;
    const inbandOverloadObserver =
      plan.isSubscription && plan.sameFormat && overloadAccountId
        ? (event: Record<string, unknown>): void => {
            if (inbandOverloadRecorded || event['type'] !== 'error') return;
            const errorType = (event['error'] as Record<string, unknown> | undefined)?.['type'];
            if (errorType !== 'overloaded_error') return;
            inbandOverloadRecorded = true;
            getSharedAccountHealth().recordUpstreamOutcome(
              plan.transformerProvider.name,
              overloadAccountId,
              { status: 529 },
            );
          }
        : undefined;
    const onSseEvent = codexOverloadDetector ?? inbandOverloadObserver;

    let bodyText: string | null;
    if (!isStream && upstreamSse) {
      bodyText = await aggregateAnthropicSseToJsonBody(upstreamResponse, route.requestedModel);
      res.writeHead(
        upstreamResponse.status && upstreamResponse.status >= 100 ? upstreamResponse.status : 200,
        { 'Content-Type': 'application/json' },
      );
      res.end(bodyText);
    } else {
      bodyText = await relayResponse(res, upstreamResponse, isStream, route.requestedModel, usageTap, onSseEvent);
    }
    if (bodyText && deps.usageRecorder) {
      recordAnthropicNonStreamUsage(deps.usageRecorder, bodyText, usageAttribution);
    }
  } catch (err) {
    // Typed translate-path content errors (D3): explicit 400 with the stable
    // code in the message — A's Anthropic-protocol mark shapes the envelope
    // (`invalid_request_error`); nothing was silently dropped.
    if (err instanceof DocumentNotSupportedError || err instanceof UnsupportedContentBlockError) {
      writeError(res, 400, `${err.message} [code: ${err.code}]`);
      return;
    }
    if (isBoundAccountSelectionError(err)) {
      writeBoundAccountError(res, err);
      return;
    }
    const errMsg = serializeError(err);
    console.error('[ProviderProxy:anthropic] Pipeline error:', errMsg);
    writeError(res, isAccountAllowanceExhaustedError(err) ? 429 : 502, errMsg);
  }
}

/**
 * BYO-key plan — `LlmConfigProviderAuth` over the route's provider row.
 * Exported for the count_tokens handler, which reuses the SAME plan (model
 * resolution, pool-bound key, chain, same-format signal) instead of building
 * a parallel one.
 */
export async function buildByoPlan(
  res: http.ServerResponse,
  route: RouteContext,
  deps: ProviderProxyDeps,
  resolvedModel: string,
  isStream: boolean,
): Promise<AnthropicCallPlan | null> {
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
  // so 429/529/401/403 failover fires (this daemon BYO `/v1/messages` path also
  // goes hot; a factory-PRESENT delegation never reaches here).
  // Otherwise it byte-identically falls back to the provider row's `$ENV`-resolved
  // key. The first-choice key seeds BOTH the auth AND `plan.apiKey` (read by the
  // same-format fast path's `getProviderHeaders`); on a rebind retry the rotated
  // key is threaded explicitly as `runOnce(outcome.newKey)` → `keyOverride`
  // (`plan.apiKey` stays readonly/frozen to the first choice), so the bound key
  // === the key actually sent upstream on every attempt.
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

  // Same-format fast path (D4): an `anthropic`-format target needs the body
  // verbatim (the unified pivot strips server-tool `type` fields). Detect via the
  // route hint OR the provider's resolved format.
  const sameFormat =
    route.targetProviderFormat === 'anthropic' || resolveApiFormat(provider) === 'anthropic';

  return {
    auth,
    chain,
    transformerProvider,
    resolvedModel,
    isStream,
    resolveUrl: (config) => (config.url instanceof URL ? config.url.toString() : byoUrl),
    upstreamUrl: byoUrl,
    sameFormat,
    isSubscription: false,
    provider,
    apiKey,
    extendedContextEnabled: route.anthropicSdkHints?.extendedContext?.enabled ?? false,
  };
}

/**
 * Same-format fast path (D4): the target speaks the `anthropic` wire, so SKIP the
 * endpoint transformer + provider chain and relay the request body VERBATIM —
 * preserving Anthropic-native server-tool `type` fields the unified pivot would
 * strip. Headers = `getProviderHeaders` (canonical `x-api-key` /
 * `anthropic-version`) + `injectExtendedContextBeta` (1M flag) + the caller's
 * forwarded `anthropic-beta` merged on top (LEAD OQ1). Still flows through
 * `runPipelineWithPoolReporting`, so ApiKeyPool failover is preserved.
 *
 * `urlOverride` (optional, last): POST a sibling endpoint under the same
 * Anthropic root instead of the terminal `/v1/messages` — used by the
 * count_tokens passthrough (`<upstream>/v1/messages/count_tokens`). Absent ⇒
 * the generation URL, byte-identical to before.
 */
export async function runSameFormatFetch(
  bodyToSend: string,
  plan: AnthropicCallPlan,
  options: AnthropicByoOptions,
  keyOverride?: string,
  urlOverride?: string,
): Promise<{ response: Response; rawStatus: number | null }> {
  const { provider, apiKey, resolvedModel, isStream, extendedContextEnabled } = plan;
  // BYO-only path: `buildByoPlan` always populates `provider`/`apiKey` (the
  // `runPipelineWithPoolReporting` dispatcher only calls this on a BYO plan).
  if (!provider) {
    throw new Error('[ProviderProxy:anthropic] same-format BYO path requires a provider row');
  }
  // On an ApiKeyPool rebind retry the wrapper passes the rotated key here so the
  // verbatim fetch sends the rebound key (this path bypasses `auth.applyHeaders`,
  // so it cannot pick up the rotated `LlmConfigProviderAuth.apiKey` on its own).
  const effectiveKey = keyOverride ?? apiKey ?? '';
  const headers = getProviderHeaders(provider, effectiveKey);

  // Merge the caller's request-side `anthropic-beta` (LEAD OQ1: DO forward).
  const callerBeta = options.callerAnthropicBeta?.trim();
  if (callerBeta) {
    const existing = headers['anthropic-beta'] ?? headers['Anthropic-Beta'];
    const parts = new Set(
      [existing, callerBeta]
        .filter((v): v is string => typeof v === 'string' && v.length > 0)
        .flatMap((v) => v.split(',').map((s) => s.trim()).filter((s) => s.length > 0)),
    );
    if (parts.size > 0) {
      // Drop any case-variant key so only the canonical lowercase remains.
      delete headers['Anthropic-Beta'];
      headers['anthropic-beta'] = [...parts].join(',');
    }
  }
  // Additively merge the 1M-context flag when the route opted in (idempotent).
  injectExtendedContextBeta(headers, resolvedModel, extendedContextEnabled ?? false);

  // R5 header fidelity: forward the caller's `anthropic-version` VERBATIM (the
  // official gateway protocol), else the official documented default. This
  // deliberately overwrites `getProviderHeaders`' value on the same-format
  // path — a caller-negotiated version always wins.
  const callerVersion = options.callerAnthropicVersion?.trim();
  headers['anthropic-version'] = callerVersion || DEFAULT_ANTHROPIC_VERSION;

  const url = urlOverride ?? buildProviderApiUrl(provider, { model: resolvedModel, stream: isStream });
  console.info(`[ProviderProxy:anthropic] (same-format) -> ${url} model=${resolvedModel} stream=${isStream}`);
  // upstream-proxy: BYO egress honors the global/provider proxy (providerId 'byo').
  const response = await fetchUpstream(
    url,
    { method: 'POST', headers, body: bodyToSend },
    { providerId: 'byo' },
  );
  return { response, rawStatus: response.status };
}

/**
 * The verbatim same-format request body (design D5 / research §5.4). A
 * third-party `anthropic`-wire upstream must receive the RESOLVED provider model,
 * not the client's original id. When the route mapped the client model to a
 * DIFFERENT provider model, POST the re-serialized `anthropicBody` (whose `model`
 * is already `plan.resolvedModel`); otherwise keep the raw client bytes VERBATIM
 * so true Anthropic pass-through (incl. internal resident-proxy same-format
 * traffic, where the model is unchanged) stays byte-identical. The JSON
 * round-trip preserves Anthropic server-tool `type` fields (this is NOT the
 * unified pivot), so no field stripping occurs.
 */
function resolveSameFormatBody(
  anthropicBody: Record<string, unknown>,
  rawBody: string,
  plan: AnthropicCallPlan,
): string {
  let originalModel: string | undefined;
  try {
    const m = (JSON.parse(rawBody) as Record<string, unknown>).model;
    originalModel = typeof m === 'string' ? m : undefined;
  } catch {
    originalModel = undefined;
  }
  return plan.resolvedModel !== originalModel ? JSON.stringify(anthropicBody) : rawBody;
}

/**
 * BYO ApiKeyPool failover wrapper — mirrors the other ingresses'
 * `runPipelineWithPoolReporting`: run; report the RAW upstream status to the pool
 * via `auth.onResult`; on a rebind re-run ONCE so headers are re-applied and the
 * rotated key is picked up. `onResult` no-ops without a pool/session (plain BYO
 * behaves exactly as before). Discarding the first (e.g. 429) response on rebind
 * is safe: the relay happens AFTER this wrapper returns, so the first response's
 * body was never read. BOTH the transformer path and the same-format fast path
 * flow through here, so failover is preserved on both.
 */
async function runPipelineWithPoolReporting(
  anthropicBody: Record<string, unknown>,
  rawBody: string,
  plan: AnthropicCallPlan,
  options: AnthropicByoOptions,
): Promise<AnthropicRunResult> {
  // D5: on the verbatim same-format path, POST the resolved provider model when
  // the route remapped it (else the raw client bytes verbatim). Computed once so
  // an ApiKeyPool rebind retry re-sends the identical body.
  const sameFormatBody = plan.sameFormat
    ? resolveSameFormatBody(anthropicBody, rawBody, plan)
    : rawBody;
  const runOnce = (keyOverride?: string): Promise<AnthropicRunResult> =>
    plan.sameFormat
      ? runSameFormatFetch(sameFormatBody, plan, options, keyOverride)
      : runPipeline(anthropicBody, plan);

  const first = await runOnce();
  const outcome = await plan.auth.onResult?.(first.rawStatus);
  if (outcome?.rebound) {
    console.info(
      '[ProviderProxy:anthropic] pool re-bound key after status',
      first.rawStatus,
      '→ retrying once',
    );
    // Pass the rotated key into the same-format verbatim retry (it bypasses
    // `auth.applyHeaders`, so it cannot pick up the rotated key on its own).
    // The transformer path ignores the override and re-reads the rotated key via
    // `auth.applyHeaders` → `LlmConfigProviderAuth.apiKey`.
    return runOnce(outcome.newKey);
  }
  return first;
}
