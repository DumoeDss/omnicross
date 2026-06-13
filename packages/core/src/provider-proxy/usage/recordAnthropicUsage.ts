/**
 * recordAnthropicUsage — the non-stream usage tap for the built-in factory-less
 * Anthropic `/v1/messages` BYO ingress (`omnicross-anthropic-byo-ingress`).
 *
 * The relayed non-stream body the proxy sees has ALREADY been re-encoded to the
 * Anthropic wire by `AnthropicTransformer.transformResponseIn` (the endpoint
 * encoder) — OR, on the same-format fast path, was relayed verbatim from an
 * Anthropic-format upstream. Either way usage lives in Anthropic's `usage` block
 * (`input_tokens` / `output_tokens` / `cache_read_input_tokens` /
 * `cache_creation_input_tokens`), NOT the OpenAI `usage` (`prompt_tokens`),
 * Responses (`input_tokens`+details) or Gemini `usageMetadata` shapes. It
 * therefore gets its own reader; everything else mirrors
 * `recordResponsesNonStreamUsage` / `recordGeminiNonStreamUsage`. Never throws.
 *
 * NOTE: `engineOrigin` reuses `'codex-ingress'` — the only non-Anthropic ingress
 * origin the `UsageRecordImportInput` union exposes today (same placeholder
 * `recordGeminiUsage` / `recordResponsesUsage` use). Widening that enum (e.g. a
 * dedicated `'anthropic-ingress'`) is a usage-recorder concern out of this
 * change's scope; the attribution is non-load-bearing for routing. FLAGGED.
 *
 * @module provider-proxy/usage/recordAnthropicUsage
 */

import type { UsageRecorderImport } from '../types';

interface AnthropicUsageAttribution {
  readonly sessionId: string | null;
  readonly providerId: string;
  readonly model: string;
}

/** Read token counts from an Anthropic `usage` object (cache-aware). */
function readAnthropicUsage(usage: Record<string, unknown> | undefined): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
} | null {
  if (!usage) return null;
  // Anthropic already EXCLUDES cached + cache-creation tokens from `input_tokens`
  // (unlike the OpenAI/Responses/Gemini shapes where the cached count is nested
  // inside the input total), so `input_tokens` IS the billable input — no
  // subtraction needed.
  const inputTokens = Number(usage.input_tokens) || 0;
  const outputTokens = Number(usage.output_tokens) || 0;
  const cacheReadTokens = Number(usage.cache_read_input_tokens) || 0;
  const cacheCreationTokens = Number(usage.cache_creation_input_tokens) || 0;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    // The Anthropic wire carries no separate reasoning-token field; thinking
    // tokens are folded into `output_tokens`.
    reasoningTokens: 0,
  };
}

/**
 * Parse a non-stream Anthropic Messages JSON body and, when a `usage` block is
 * present, record one usage event with origin `'codex-ingress'`. Never
 * throws.
 */
export function recordAnthropicNonStreamUsage(
  recorder: UsageRecorderImport,
  bodyText: string,
  attribution: AnthropicUsageAttribution,
): void {
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    const tapped = readAnthropicUsage(parsed.usage as Record<string, unknown> | undefined);
    if (!tapped) return;
    recorder.record({
      messageId: null,
      parentMessageId: null,
      sessionId: attribution.sessionId,
      providerId: attribution.providerId,
      model: attribution.model,
      apiKeyId: null,
      engineOrigin: 'codex-ingress',
      usage: tapped,
      rawUsage: parsed.usage,
    });
  } catch {
    // Unparseable body / no usage — skip silently.
  }
}
