/**
 * anthropicCountTokens — the `POST /v1/messages/count_tokens` handler
 * (`claude-api-routing-errors`, R2 passthrough+reject subset).
 *
 * Before this module, the substring `/v1/messages` match routed count_tokens
 * into the FULL generation pipeline — every context-stats call burned a real
 * upstream inference (BYO money, subscription 5h-window quota) and returned a
 * Message JSON instead of `{"input_tokens":N}` (audit F-1, P0).
 *
 * Strategies (portfolio-locked default: `'auto'`):
 *  - **passthrough** (Anthropic-wire upstream — `plan.sameFormat`): strip the
 *    generation-only fields the count_tokens endpoint rejects (`stream`,
 *    `max_tokens`), rewrite `model` to the resolved upstream model, and POST to
 *    `<upstream>/v1/messages/count_tokens` via the SAME same-format fetches the
 *    generation path uses (credential injection, beta merge, claude header
 *    baseline all inherited). The response — success OR failure — relays
 *    verbatim with its real status (an Anthropic-wire error body already IS
 *    the official shape; wrapping it would violate the verbatim moat).
 *  - **estimate** (Change B; explicit config, or `auto` on a translation
 *    upstream): a PURE-LOCAL heuristic estimate (`anthropicCountEstimate.ts`)
 *    answered as `{"input_tokens":N}` with the `x-omnicross-count-estimate:
 *    true` marker header — zero upstream calls, never recorded as usage.
 *  - **reject** (explicit config, or `passthrough` degraded on a translation
 *    upstream): a clean Anthropic 404 `not_found_error` with ZERO upstream
 *    calls — Claude Code treats it as "endpoint absent" and falls back to its
 *    local usage estimation.
 *
 * A free endpoint: no usage recording, no concurrency gate (the outbound face
 * bypasses its gate before dispatch), single attempt — no 401 refresh retry,
 * no subscription health marking (a failed count_tokens must not cool an
 * account that serves inference; the inference path drives those itself).
 *
 * @module provider-proxy/ingress/anthropicCountTokens
 */

import type http from 'node:http';

import { serializeError } from '@omnicross/core/serializeError';

import { isAccountAllowanceExhaustedError } from '../../pipeline/AccountAllowanceScheduling';
import { isBoundAccountSelectionError } from '../../pipeline/BoundAccountSelectionError';

import type { ProviderProxyDeps, RouteContext } from '../types';

import { buildByoPlan, runSameFormatFetch } from './anthropicMessagesByo';
import {
  DEFAULT_COUNT_ESTIMATE_BUDGET_MS,
  estimateAnthropicInputTokens,
} from './anthropicCountEstimate';
import {
  type AnthropicByoOptions,
  type AnthropicCallPlan,
  buildSubscriptionPlan,
  runSubscriptionSameFormatFetch,
} from './anthropicSubscriptionPlan';
import { relayResponse, writeBoundAccountError, writeError } from './providerProxyShared';

/** The operator-facing strategy config (§10 `anthropic.countTokens.mode`). */
export type CountTokensMode = 'auto' | 'passthrough' | 'estimate' | 'reject';

/** The resolved strategy for one request. */
export type CountTokensResolvedStrategy = 'passthrough' | 'estimate' | 'reject';

/**
 * Resolve the count_tokens strategy from the configured mode and the SAME wire
 * signal the generation path uses (`plan.sameFormat` — BYO: provider format /
 * route hint `anthropic`; subscription: pass-through mode or a `/v1/messages`
 * upstream URL). Branch order (design D2):
 *  - `reject` → reject (absolute);
 *  - `estimate` → estimate (explicit config wins over wire — local estimation
 *    needs no upstream);
 *  - wire → passthrough;
 *  - `passthrough` on non-wire → degrade to reject with a warning (no upstream
 *    count_tokens endpoint exists to relay to);
 *  - `auto` on non-wire → estimate (Change B behavior: Claude Code gets a
 *    usable local estimate instead of A's 404).
 */
export function resolveCountTokensStrategy(
  mode: CountTokensMode | undefined,
  upstreamIsAnthropicWire: boolean,
): CountTokensResolvedStrategy {
  const effectiveMode: CountTokensMode = mode ?? 'auto';
  if (effectiveMode === 'reject') return 'reject';
  if (effectiveMode === 'estimate') return 'estimate';
  if (upstreamIsAnthropicWire) return 'passthrough';
  if (effectiveMode === 'passthrough') {
    console.warn(
      '[ProviderProxy:anthropic] count_tokens passthrough requested but the resolved upstream is not Anthropic wire — degrading to reject',
    );
    return 'reject';
  }
  return 'estimate';
}

/**
 * Handle one `/v1/messages/count_tokens` request. `res` carries the
 * Anthropic-protocol mark (set at the serving-face entry), so every local
 * error below is Anthropic-shaped automatically; the upstream response relays
 * verbatim and never passes through a writer.
 */
export async function handleAnthropicCountTokens(
  res: http.ServerResponse,
  rawBody: string,
  route: RouteContext,
  deps: ProviderProxyDeps,
  options: AnthropicByoOptions = {},
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    writeError(res, 400, 'Invalid JSON in request body');
    return;
  }

  // EXPLICIT estimate short-circuits before any plan building: local
  // estimation needs no provider row, auth strategy, or upstream — a route
  // that could not even build a plan still answers with an estimate.
  if (route.anthropicCountTokensMode === 'estimate') {
    writeCountTokensEstimate(res, body, route.anthropicCountTokensEstimateBudgetMs);
    return;
  }

  try {
    // Reuse the generation path's plan builders verbatim (model resolution,
    // pool-bound key / auth strategy, sameFormat signal). Their internal
    // writeErrors are mark-aware → Anthropic-shaped 502 `api_error`.
    const plan =
      route.authMode === 'subscription'
        ? await buildSubscriptionPlan(res, route, deps, body, route.model, false)
        : await buildByoPlan(res, route, deps, route.model, false);
    if (!plan) return;

    const strategy = resolveCountTokensStrategy(route.anthropicCountTokensMode, plan.sameFormat);
    if (strategy === 'reject') {
      writeError(
        res,
        404,
        'count_tokens is not available on this route (strategy: reject); clients fall back to inference-based usage estimation',
      );
      return;
    }
    if (strategy === 'estimate') {
      // auto on a translation upstream → local estimate (Change B default).
      writeCountTokensEstimate(res, body, route.anthropicCountTokensEstimateBudgetMs);
      return;
    }

    // passthrough: the count_tokens endpoint rejects generation-only fields.
    // This is a NEW endpoint (not a generation relay), so re-serialization is
    // in-bounds: only the two spec-named fields are removed, unknown fields
    // survive the JSON round-trip losslessly, and the generation paths are
    // untouched. Model is rewritten to the resolved upstream model.
    delete body.stream;
    delete body.max_tokens;
    body.model = plan.resolvedModel;
    const bodyToSend = JSON.stringify(body);
    const countTokensUrl = `${plan.upstreamUrl}/count_tokens`;

    const providerResponse = plan.isSubscription
      ? await runSubscriptionCountTokensFetch(bodyToSend, plan, options, countTokensUrl)
      : await runByoCountTokensFetch(bodyToSend, plan, options, countTokensUrl);

    // Verbatim relay: no model rewrite, no usage tap. An upstream failure keeps
    // its real status and body bytes (the moat — never wrapped).
    await relayResponse(res, providerResponse.response, false);
  } catch (err) {
    if (isBoundAccountSelectionError(err)) {
      writeBoundAccountError(res, err);
      return;
    }
    const errMsg = serializeError(err);
    console.error('[ProviderProxy:anthropic] count_tokens error:', errMsg);
    writeError(res, isAccountAllowanceExhaustedError(err) ? 429 : 502, errMsg);
  }
}

/**
 * Answer one count_tokens request with the LOCAL heuristic estimate: 200,
 * `{"input_tokens":N}`, and the `x-omnicross-count-estimate: true` marker so a
 * client can tell an estimate from an upstream count. Bypasses the relay
 * machinery entirely and is never recorded as usage (not a real consumption).
 */
function writeCountTokensEstimate(
  res: http.ServerResponse,
  body: Record<string, unknown>,
  budgetMs: number | undefined,
): void {
  const inputTokens = estimateAnthropicInputTokens(body, budgetMs ?? DEFAULT_COUNT_ESTIMATE_BUDGET_MS);
  if (res.headersSent) return;
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'x-omnicross-count-estimate': 'true',
  });
  res.end(JSON.stringify({ input_tokens: inputTokens }));
}

/**
 * BYO count_tokens fetch — mirrors `runPipelineWithPoolReporting`'s
 * onResult-rebound-retry-once semantics (the shared wrapper hardcodes the
 * generation-path body resolution, so this special case keeps its own ~15-line
 * mirror instead of overloading it). NO 401-refresh wrapper: a failed
 * count_tokens must not burn a refresh; the inference path drives those.
 */
async function runByoCountTokensFetch(
  bodyToSend: string,
  plan: AnthropicCallPlan,
  options: AnthropicByoOptions,
  url: string,
): Promise<{ response: Response; rawStatus: number | null }> {
  const runOnce = (keyOverride?: string): Promise<{ response: Response; rawStatus: number | null }> =>
    runSameFormatFetch(bodyToSend, plan, options, keyOverride, url);
  const first = await runOnce();
  const outcome = await plan.auth.onResult?.(first.rawStatus);
  if (outcome?.rebound) {
    console.info(
      '[ProviderProxy:anthropic] pool re-bound key after status',
      first.rawStatus,
      '→ retrying count_tokens once',
    );
    return runOnce(outcome.newKey);
  }
  return first;
}

/**
 * Subscription count_tokens fetch — ONE attempt through the shared
 * subscription same-format relay (auth strategy header injection, claude
 * header baseline, per-account model remap all inherited). Deliberately NO
 * 401-refresh retry and NO health marking (design R5): count_tokens failure is
 * not an account-health signal, and Claude Code safely falls back on a 401.
 */
async function runSubscriptionCountTokensFetch(
  bodyToSend: string,
  plan: AnthropicCallPlan,
  options: AnthropicByoOptions,
  url: string,
): Promise<{ response: Response; rawStatus: number | null; actualModel?: string }> {
  return runSubscriptionSameFormatFetch(bodyToSend, plan, undefined, options, url);
}
