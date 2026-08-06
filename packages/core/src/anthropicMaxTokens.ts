/**
 * `max_tokens` resolution for native Anthropic Messages requests.
 *
 * The Anthropic Messages API **requires** `max_tokens`, so unlike the
 * OpenAI-compatible wire format we cannot simply omit the field and let the
 * provider apply its own default. Every code path that builds an Anthropic
 * body therefore has to supply *something* — and what it supplies is a real
 * output ceiling, not a formality.
 *
 * This module exists because the previous `?? 4096` fallback made "caller did
 * not specify a cap" mean "cap the model at 4096 output tokens". That is far
 * below every current model's ceiling (Claude Opus 4.8 is 128K), and the
 * failure mode is silent: the response is cut off mid-generation, and when the
 * truncated span happens to be a tool call's JSON arguments the host sees a
 * malformed tool call rather than a token-limit error.
 *
 * Resolution order:
 *   1. An explicit caller-supplied cap wins, always.
 *   2. Otherwise the model's real ceiling from the canonical registry
 *      (`KNOWN_MODELS[...].maxTokens`), which already tracks per-model output
 *      limits and normalizes ids / aliases for us.
 *   3. Otherwise {@link ANTHROPIC_FALLBACK_MAX_TOKENS} — the current frontier
 *      ceiling. An unknown id is usually a relay/aggregator alias for a recent
 *      model, so erring high keeps output intact; a provider whose real cap is
 *      lower answers with an explicit HTTP 400 naming its limit, which is a
 *      loud, one-look diagnosis instead of silent truncation.
 *
 * @module anthropicMaxTokens
 */

import { lookupCanonicalCapabilities } from '@omnicross/contracts/canonical-models';

/**
 * Last-resort output cap for models absent from the canonical registry.
 *
 * 128K is the max output of the current frontier models (Claude Opus 5 /
 * Opus 4.8 / Sonnet 5 / Fable 5). Note this is a *ceiling*, not a target:
 * raising it does not make responses longer, it only stops them being cut
 * short. Callers that need a hard spend limit should pass an explicit cap.
 */
export const ANTHROPIC_FALLBACK_MAX_TOKENS = 128_000;

/**
 * Resolve the `max_tokens` to send on a native Anthropic Messages request.
 *
 * @param model     Model id as it will be sent on the wire. Normalization and
 *                  alias resolution are handled by the canonical registry.
 * @param requested Caller-supplied cap, if any. Honored verbatim when it is a
 *                  positive finite number; any other value (undefined, null,
 *                  0, NaN, negative) falls through to resolution.
 */
export function resolveAnthropicMaxTokens(model: string | undefined, requested?: unknown): number {
  if (typeof requested === 'number' && Number.isFinite(requested) && requested > 0) {
    return requested;
  }

  const canonical = model ? lookupCanonicalCapabilities(model)?.maxTokens : undefined;
  if (typeof canonical === 'number' && Number.isFinite(canonical) && canonical > 0) {
    return canonical;
  }

  return ANTHROPIC_FALLBACK_MAX_TOKENS;
}
