/**
 * anthropicMessagesIngress — the ProviderProxy Anthropic-Messages ingress.
 *
 * Matches `POST .../v1/messages` and forks on whether a quirk-stack factory is
 * injected:
 *
 * - **factory PRESENT** → DELEGATES the request wholesale to the
 *   host's existing per-session handler — re-constructed PER REQUEST from
 *   the per-run `RouteContext` ("delegate for parity"). This is intentionally
 *   NOT a re-implementation of the Anthropic path: the delegated handler keeps
 *   owning probe-mock, local web-search
 *   interception, thinkingLevel / 1M-context-beta injection, subscription
 *   dispatch, the pass-through (claude-code OAuth) branch, AND its own upstream
 *   fetch — so the 5h/7d window header taps inside the host's stream manager keep
 *   working unchanged. That zero-regression parity (BYTE-IDENTICAL to the
 *   pre-change behavior) is the whole reason for delegating.
 *
 * - **factory ABSENT (`@omnicross/daemon` BYO)** → instead of returning 502, runs
 *   the built-in, factory-less Anthropic BYO path in `anthropicMessagesByo.ts`
 *   (`omnicross-anthropic-byo-ingress`), which serves `/v1/messages` over the
 *   route's LLM-config provider row with ZERO host dependency. NONE of the
 *   SDK quirks above run on that path.
 *
 * Construction of the handler trio is factored into the host's
 * request-handler factory, which mirrors the host proxy-server
 * constructor byte-for-byte. The only difference vs. the
 * old per-session proxy is WHERE the params come from: the looked-up
 * `RouteContext.anthropicSdkHints` instead of a per-session constructor.
 *
 * D7 conversion-SSOT is ALREADY MET — NOT a follow-up. The delegated
 * host handler routes its conversion through the SAME shared pipeline
 * SSOT every other ingress uses: `executeProviderCall` +
 * `AnthropicTransformer` as the endpoint transformer. There is NO second
 * conversion stack here (the CRS conversion code was never ported). All four
 * ingresses converge on `executeProviderCall`: Anthropic via this delegation,
 * and Responses / OpenAI-Chat / Gemini directly.
 *
 * The Anthropic SDK quirks (probe-mock, local web-search interception,
 * thinkingLevel / 1M-context-beta injection, subscription dispatch, the 5h/7d
 * window header taps) INTENTIONALLY remain at the ingress — they are ingress
 * concerns under the design's ingress-vs-core split (the same principle that
 * keeps the Codex-CLI quirks in the Codex ingress). They are deliberately NOT
 * folded into the pipeline core; doing so would violate ingress-vs-core and
 * couple the shared core to one ingress's wire idiosyncrasies.
 *
 * @module provider-proxy/ingress/anthropicMessagesIngress
 */

import type http from 'node:http';

import { captureCallerIdentity } from '../identity/fingerprintHeaders';
import { getSharedIdentityStore } from '../identity/SubscriptionIdentityStore';
import type { ProviderProxyDeps, RouteContext } from '../types';

import { handleAnthropicMessagesByo } from './anthropicMessagesByo';
import { readBody, writeError } from './providerProxyShared';

/** Match `POST` + any path containing `/v1/messages` (parity with the host handler). */
export function isAnthropicMessagesRequest(
  method: string | undefined,
  url: string | undefined,
): boolean {
  return method === 'POST' && !!url && url.includes('/v1/messages');
}

/**
 * Handle one Anthropic-Messages request.
 *
 * - **factory PRESENT** → delegate to a host-built per-request handler
 *   built from the route's `anthropicSdkHints`, passing the raw `req` straight
 *   through — the delegated handler reads the body itself and drives the full
 *   SDK-quirk + transformer/pass-through/subscription pipeline. This branch is
 *   evaluated FIRST and is BYTE-IDENTICAL to the pre-change behavior.
 * - **factory ABSENT (`@omnicross/daemon` BYO)** → instead of 502, read the body
 *   here and run the built-in factory-less BYO path (`handleAnthropicMessagesByo`,
 *   `omnicross-anthropic-byo-ingress`). Zero host dependency.
 */
export async function handleAnthropicMessagesRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  route: RouteContext,
  deps: ProviderProxyDeps,
): Promise<void> {
  const handlerFactory = deps.anthropicIngressHandlerFactory;

  // ── factory ABSENT → built-in factory-less BYO path (was 502). ─────────────
  // The delegation guards below (anthropicSdkHints / providerId) are quirk-stack
  // preconditions for the DELEGATED handler only; the built-in BYO path runs its
  // own guards inside `handleAnthropicMessagesByo` (providerId, JSON, key), so it
  // is reached BEFORE those delegation-only guards.
  if (!handlerFactory) {
    // Read the body HERE (the delegation path keeps passing the un-pre-read
    // `req`; only this fallthrough consumes the stream). Forward the caller's
    // request-side `anthropic-beta` for the same-format fast path (LEAD OQ1).
    const rawBody = await readBody(req);
    const callerBetaRaw = req.headers['anthropic-beta'];
    const callerAnthropicBeta = Array.isArray(callerBetaRaw) ? callerBetaRaw.join(',') : callerBetaRaw;
    // subscription-client-fingerprint #7: capture the caller's WHITELISTED
    // fingerprint headers here (the same seam that already reads `anthropic-beta`)
    // and thread them to the relay. Auth/cookie are never captured (the whitelist
    // excludes them). GATED on the flag (`captureCallerIdentity`) — skipped entirely
    // when replay is disabled (no wasted extraction on the default/BYO path); the
    // relay's own claude-scoped gate is unchanged, so behavior when enabled is
    // identical.
    const callerIdentity = captureCallerIdentity(getSharedIdentityStore(), req.headers);
    await handleAnthropicMessagesByo(res, rawBody, route, deps, { callerAnthropicBeta, callerIdentity });
    return;
  }

  // ── factory PRESENT → delegate, BYTE-IDENTICAL. ───────────────────────────
  const hints = route.anthropicSdkHints;
  if (!hints) {
    writeError(res, 502, 'Anthropic route is missing anthropicSdkHints');
    return;
  }
  // Pass-through (claude-code OAuth) needs neither a providerId nor a DB row —
  // the handler forwards verbatim. Every other Anthropic route requires the
  // providerId so the handler can resolve the provider row + auth.
  if (!hints.passThrough && !route.providerId) {
    writeError(res, 502, 'Anthropic route is missing a providerId');
    return;
  }

  const handler = handlerFactory({
    llmConfig: deps.llmConfig,
    providerId: route.providerId ?? '',
    model: route.model,
    apiKey: hints.apiKey,
    backgroundTaskModel: route.backgroundTaskModel,
    isOfficialProvider: hints.isOfficialProvider,
    thinkingLevel: hints.thinkingLevel,
    extendedContext: hints.extendedContext ?? null,
    passThrough: hints.passThrough,
    passThroughAuthToken: hints.passThroughAuthToken ?? null,
    resolvePassThroughAuthToken: hints.resolvePassThroughAuthToken ?? null,
    subscriptionProfile: hints.subscriptionProfile ?? null,
    maxConcurrency: hints.maxConcurrency,
    webSearchService: hints.webSearchService ?? null,
    onRetry: hints.onRetry,
    onStreamEvent: hints.onStreamEvent,
    usageRecorder: hints.usageRecorder ?? null,
    attribution: hints.attribution ?? null,
  });

  await handler.handle(req, res);
}
