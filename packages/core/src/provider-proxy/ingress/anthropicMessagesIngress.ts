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
 * conversion stack here. All four
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

import { extractClaudeClientHeaders } from '../identity/claudeCodeHeaders';
import { captureCallerIdentity } from '../identity/fingerprintHeaders';
import { getSharedIdentityStore } from '../identity/SubscriptionIdentityStore';
import { DEFAULT_SEARCH_FRONTEND_MODES } from '../../search/frontends';
import type { ProviderProxyDeps, RouteContext } from '../types';

import {
  handleAnthropicManagedSearch,
  replayAnthropicRequest,
  requestAbortSignal,
  resolveAnthropicSearchHintBackend,
} from './anthropicManagedSearch';
import { handleAnthropicMessagesByo } from './anthropicMessagesByo';
import { handleAnthropicCountTokens } from './anthropicCountTokens';
import { classifyAnthropicMessagesPath } from './anthropicPathMatch';
import { readBody, resolvePoolBoundKey, writeError } from './providerProxyShared';

/**
 * Match `POST` + any path in the Anthropic Messages family. Derived from the
 * SHARED classifier (`classifyAnthropicMessagesPath`) — the same function the
 * outbound server's `selectEndpoint` derives from — so the two serving faces
 * agree BY CONSTRUCTION. Subpaths (`/v1/messages/*`) intentionally match here
 * so they enter this ingress and receive an Anthropic-shaped 404; lookalikes
 * (`/v1/messagesfoo`) do not.
 */
export function isAnthropicMessagesRequest(
  method: string | undefined,
  url: string | undefined,
): boolean {
  return method === 'POST' && classifyAnthropicMessagesPath(url) !== null;
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
  // Every body/header read below goes through `request`. It IS `req` unless
  // the managed-search branch consumed the stream and handed back a replay.
  let request: http.IncomingMessage = req;
  // Sub-resource dispatch (claude-api-routing-errors). The outbound face
  // rejects unsupported subpaths pre-dispatch; the resident face has no
  // pre-dispatch stage, so the check lives HERE. `writeError` consults the
  // entry mark (set in `routeRequest`) → the 404 is Anthropic-shaped
  // `not_found_error`, with zero upstream calls.
  const pathClass = classifyAnthropicMessagesPath(req.url);
  if (pathClass === 'unsupported-subpath') {
    writeError(res, 404, `Unsupported Anthropic subpath: ${req.method} ${req.url}`);
    return;
  }
  if (pathClass === 'count_tokens') {
    // Same request-side header extraction as the BYO branch below (the
    // subscription relay consumes callerAnthropicBeta / identity / client
    // headers; the BYO count_tokens fetch consumes callerAnthropicBeta and
    // callerAnthropicVersion).
    const rawBody = await readBody(request);
    const callerBetaRaw = request.headers['anthropic-beta'];
    const callerAnthropicBeta = Array.isArray(callerBetaRaw) ? callerBetaRaw.join(',') : callerBetaRaw;
    const callerVersionRaw = request.headers['anthropic-version'];
    const callerAnthropicVersion = Array.isArray(callerVersionRaw)
      ? callerVersionRaw.join(',')
      : callerVersionRaw;
    const callerIdentity = captureCallerIdentity(getSharedIdentityStore(), request.headers);
    const callerClientHeaders = extractClaudeClientHeaders(request.headers);
    await handleAnthropicCountTokens(res, rawBody, route, deps, {
      callerAnthropicBeta,
      callerAnthropicVersion,
      callerIdentity,
      callerClientHeaders,
    });
    return;
  }

  // ── SEARCH MODE, resolved ONCE, before any wire bytes. ────────────────────
  // `native` (the default) is a pure short-circuit: no body read, no extra
  // allocation, and the two branches below stay byte-identical to their
  // pre-change behavior. Only a non-native mode enters the managed lane, and
  // the two lanes share no emission code (hard constraint 6).
  //
  // A route that supplies its OWN `webSearchService` is a host declaring that
  // it owns search for this request; the lane stands down so the delegated
  // handler — the thing that hint has always fed — keeps doing the work.
  const searchMode = deps.searchFrontendModes?.anthropic ?? DEFAULT_SEARCH_FRONTEND_MODES.anthropic;
  const routeSuppliedSearchBackend = route.anthropicSdkHints?.webSearchService ?? null;
  if (searchMode !== 'native' && !routeSuppliedSearchBackend) {
    const preReadBody = await readBody(req);
    let parsedForSearch: unknown;
    try {
      parsedForSearch = preReadBody ? JSON.parse(preReadBody) : {};
    } catch {
      parsedForSearch = undefined;
    }
    const handled = await handleAnthropicManagedSearch(res, parsedForSearch, {
      mode: searchMode,
      runtime: deps.searchRuntime ?? null,
      signal: requestAbortSignal(req, res),
    });
    if (handled) return;
    // Not ours: hand the branches below a request that can be read again.
    request = replayAnthropicRequest(req, preReadBody);
  }

  const handlerFactory = deps.anthropicIngressHandlerFactory;

  // ── factory ABSENT → built-in factory-less BYO path (was 502). ─────────────
  // The delegation guards below (anthropicSdkHints / providerId) are quirk-stack
  // preconditions for the DELEGATED handler only; the built-in BYO path runs its
  // own guards inside `handleAnthropicMessagesByo` (providerId, JSON, key), so it
  // is reached BEFORE those delegation-only guards.
  if (!handlerFactory) {
    // Read the body HERE (the delegation path keeps passing the un-pre-read
    // `req`; only this fallthrough consumes the stream). Forward the caller's
    // request-side `anthropic-beta` for the same-format fast path (LEAD OQ1)
    // and `anthropic-version` verbatim (claude-api-protocol-fidelity, R5).
    const rawBody = await readBody(request);
    const callerBetaRaw = request.headers['anthropic-beta'];
    const callerAnthropicBeta = Array.isArray(callerBetaRaw) ? callerBetaRaw.join(',') : callerBetaRaw;
    const callerVersionRaw = request.headers['anthropic-version'];
    const callerAnthropicVersion = Array.isArray(callerVersionRaw)
      ? callerVersionRaw.join(',')
      : callerVersionRaw;
    // subscription-client-fingerprint #7: capture the caller's WHITELISTED
    // fingerprint headers here (the same seam that already reads `anthropic-beta`)
    // and thread them to the relay. Auth/cookie are never captured (the whitelist
    // excludes them). GATED on the flag (`captureCallerIdentity`) — skipped entirely
    // when replay is disabled (no wasted extraction on the default/BYO path); the
    // relay's own claude-scoped gate is unchanged, so behavior when enabled is
    // identical.
    const callerIdentity = captureCallerIdentity(getSharedIdentityStore(), request.headers);
    // UNGATED, unlike `captureCallerIdentity`: forwarding the client's OWN
    // Claude Code headers (UA / x-app / x-stainless-* / accept*) is not
    // fingerprint synthesis, and the subscription relay needs them regardless of
    // whether the opt-in freeze/replay feature is on.
    const callerClientHeaders = extractClaudeClientHeaders(request.headers);
    await handleAnthropicMessagesByo(res, rawBody, route, deps, {
      callerAnthropicBeta,
      callerAnthropicVersion,
      callerIdentity,
      callerClientHeaders,
    });
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

  let delegatedApiKey = hints.apiKey;
  if (route.authMode === 'byo' && route.providerId) {
    const provider = await deps.llmConfig.getProvider(route.providerId);
    if (!provider) {
      writeError(res, 502, `Provider not found: ${route.providerId}`);
      return;
    }
    delegatedApiKey = await resolvePoolBoundKey(
      deps,
      route.providerId,
      provider,
      route.sessionId,
      route.preferredKeyId,
      route.boundKeyFallbackPolicy,
    );
    if (!delegatedApiKey) {
      writeError(res, 502, 'API key not configured');
      return;
    }
  }

  const handler = handlerFactory({
    llmConfig: deps.llmConfig,
    providerId: route.providerId ?? '',
    model: route.model,
    apiKey: delegatedApiKey,
    backgroundTaskModel: route.backgroundTaskModel,
    isOfficialProvider: hints.isOfficialProvider,
    thinkingLevel: hints.thinkingLevel,
    extendedContext: hints.extendedContext ?? null,
    passThrough: hints.passThrough,
    passThroughAuthToken: hints.passThroughAuthToken ?? null,
    resolvePassThroughAuthToken: hints.resolvePassThroughAuthToken ?? null,
    subscriptionProfile: hints.subscriptionProfile ?? null,
    preferredAccountId: hints.preferredAccountId,
    preferredAccountGroup: hints.preferredAccountGroup,
    boundAccountFallbackPolicy: hints.boundAccountFallbackPolicy,
    preferredKeyId: route.preferredKeyId,
    boundKeyFallbackPolicy: route.boundKeyFallbackPolicy,
    maxConcurrency: hints.maxConcurrency,
    // plan 阶段5: the slot is no longer dead. A route-supplied backend still
    // wins; otherwise the shared runtime arrives here wrapped in the 阶段3
    // compat adapter, which this is the first production consumer of.
    webSearchService: resolveAnthropicSearchHintBackend(
      hints.webSearchService,
      deps.searchRuntime,
    ),
    onRetry: hints.onRetry,
    onStreamEvent: hints.onStreamEvent,
    usageRecorder: hints.usageRecorder ?? null,
    attribution: hints.attribution ?? null,
  });

  await handler.handle(request, res);
}
