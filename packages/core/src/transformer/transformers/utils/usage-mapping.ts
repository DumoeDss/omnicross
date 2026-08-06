/**
 * usage-mapping — shared helpers that carry Anthropic prompt-cache token counts
 * across the Anthropic ↔ OpenAI / Responses usage-shape conversions.
 *
 * Why this exists: the Anthropic usage block separates cache pools
 * (`input_tokens` EXCLUDES cache; `cache_read_input_tokens` and
 * `cache_creation_input_tokens` are reported alongside). The OpenAI Chat and
 * Responses usage shapes have only `cached_tokens` (cache READ, modeled as a
 * SUBSET of `prompt_tokens`/`input_tokens`) and NO cache-creation field. The
 * ingress usage readers (recordChatCompletionsUsage / recordResponsesUsage)
 * compute `billable = prompt_tokens - cached_tokens`.
 *
 * Earlier conversions rebuilt usage with only prompt/completion/total and
 * silently dropped the cache fields, so an Anthropic-format upstream that
 * returned `cache_read_input_tokens` (e.g. z.ai's Anthropic endpoint) showed
 * 0 cache read on the dashboard. These helpers preserve cache accounting:
 *
 *   - cache-read is surfaced via `*_details.cached_tokens` (billed at the
 *     cache-read rate by the downstream reader).
 *   - cache-creation has no OpenAI representation, so it is folded into
 *     `prompt_tokens` (billed at the full input rate — a slight underestimate
 *     vs Anthropic's 1.25× cache-write rate, but far better than dropping the
 *     tokens entirely).
 *
 * @module transformer/transformers/utils/usage-mapping
 */

/** Read a numeric field off a loosely-typed usage object, defaulting to 0. */
function num(obj: Record<string, unknown> | undefined, key: string): number {
  const v = obj?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Detail sub-object (`prompt_tokens_details` / `input_tokens_details`). */
function detailCachedTokens(
  obj: Record<string, unknown> | undefined,
  detailKey: string,
): number {
  const detail = obj?.[detailKey] as Record<string, unknown> | undefined;
  return num(detail, 'cached_tokens');
}

/**
 * Convert an Anthropic usage block into an OpenAI Chat usage object, preserving
 * prompt-cache counts. Returns `undefined` for a falsy input so callers can keep
 * the `usage: conv(...) : undefined` shape. The result is `prompt_tokens`-based
 * (Chat shape); use {@link chatUsageToResponsesUsage} to re-express as Responses.
 */
export function anthropicUsageToChatUsage(
  usage: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!usage) return undefined;
  const input = num(usage, 'input_tokens');
  const output = num(usage, 'output_tokens');
  const cacheRead = num(usage, 'cache_read_input_tokens');
  const cacheCreation = num(usage, 'cache_creation_input_tokens');
  // OpenAI semantics: cached tokens are a SUBSET of prompt_tokens. Anthropic's
  // input_tokens excludes cache, so fold both pools in to keep the total honest.
  const promptTokens = input + cacheRead + cacheCreation;
  const out: Record<string, unknown> = {
    prompt_tokens: promptTokens,
    completion_tokens: output,
    total_tokens: promptTokens + output,
  };
  if (cacheRead > 0) {
    out.prompt_tokens_details = { cached_tokens: cacheRead };
  }
  return out;
}

/**
 * Convert an OpenAI Chat usage object into a Responses-API usage object,
 * carrying `prompt_tokens_details.cached_tokens` → `input_tokens_details.cached_tokens`
 * so the Responses ingress tap still sees cache-read. Returns `undefined` for a
 * falsy input.
 */
export function chatUsageToResponsesUsage(
  usage: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!usage) return undefined;
  const prompt = num(usage, 'prompt_tokens');
  const completion = num(usage, 'completion_tokens');
  const out: Record<string, unknown> = {
    input_tokens: prompt,
    output_tokens: completion,
    total_tokens: num(usage, 'total_tokens') || prompt + completion,
  };
  const cacheRead = detailCachedTokens(usage, 'prompt_tokens_details');
  if (cacheRead > 0) {
    out.input_tokens_details = { cached_tokens: cacheRead };
  }
  return out;
}

/**
 * Convert a Responses-API usage object into an OpenAI Chat usage object,
 * carrying `input_tokens_details.cached_tokens` → `prompt_tokens_details.cached_tokens`.
 * Returns `undefined` for a falsy input.
 */
export function responsesUsageToChatUsage(
  usage: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!usage) return undefined;
  const input = num(usage, 'input_tokens');
  const output = num(usage, 'output_tokens');
  const out: Record<string, unknown> = {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: num(usage, 'total_tokens') || input + output,
  };
  const cacheRead = detailCachedTokens(usage, 'input_tokens_details');
  if (cacheRead > 0) {
    out.prompt_tokens_details = { cached_tokens: cacheRead };
  }
  return out;
}
