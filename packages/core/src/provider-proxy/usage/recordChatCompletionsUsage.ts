/**
 * recordChatCompletionsUsage — the non-stream usage tap for the ProviderProxy
 * OpenAI Chat Completions ingress (`provider-proxy-transformer-matrix`).
 *
 * Parses the Chat-Completions `usage` block (`prompt_tokens` /
 * `completion_tokens` + the `prompt_tokens_details` / `completion_tokens_details`
 * cache + reasoning sub-objects) from a relayed non-stream JSON body and records
 * ONE usage event. The shape differs from the Responses-API tap
 * (`input_tokens` / `output_tokens`) so it gets its own reader; everything else
 * mirrors `recordResponsesNonStreamUsage`. Never throws.
 *
 * NOTE: `engineOrigin` reuses `'codex-ingress'` — the only OpenAI-family origin
 * the `UsageRecordImportInput` union exposes today. Widening that enum (e.g. a
 * dedicated `'openai-chat-ingress'`) is a usage-recorder concern out of this
 * slice's scope; the attribution is non-load-bearing for routing.
 *
 * @module provider-proxy/usage/recordChatCompletionsUsage
 */

import type { UsageRecorderImport } from '../types';

interface ChatCompletionsUsageAttribution {
  readonly sessionId: string | null;
  readonly providerId: string;
  readonly model: string;
  readonly apiKeyId: string | null;
}

/** Read token counts from a Chat-Completions `usage` object (cache-aware). */
function readChatCompletionsUsage(usage: Record<string, unknown> | undefined): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
} | null {
  if (!usage) return null;
  const promptTokens = Number(usage.prompt_tokens) || 0;
  const completionTokens = Number(usage.completion_tokens) || 0;
  const promptDetails = (usage.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const cacheReadTokens = Number(promptDetails.cached_tokens) || 0;
  const completionDetails = (usage.completion_tokens_details ?? {}) as Record<string, unknown>;
  const reasoningTokens = Number(completionDetails.reasoning_tokens) || 0;
  // Avoid double-counting cached tokens within the billable input total.
  const billableInput = Math.max(0, promptTokens - cacheReadTokens);
  return {
    inputTokens: billableInput,
    outputTokens: completionTokens,
    cacheReadTokens,
    cacheCreationTokens: 0,
    reasoningTokens,
  };
}

/**
 * Parse a non-stream Chat-Completions JSON body and, when a usage block is
 * present, record one usage event. Never throws.
 */
export function recordChatCompletionsNonStreamUsage(
  recorder: UsageRecorderImport,
  bodyText: string,
  attribution: ChatCompletionsUsageAttribution,
): void {
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    const tapped = readChatCompletionsUsage(parsed.usage as Record<string, unknown> | undefined);
    if (!tapped) return;
    recorder.record({
      messageId: null,
      parentMessageId: null,
      sessionId: attribution.sessionId,
      providerId: attribution.providerId,
      model: attribution.model,
      apiKeyId: attribution.apiKeyId,
      engineOrigin: 'codex-ingress',
      usage: tapped,
      rawUsage: parsed.usage,
    });
  } catch {
    // Unparseable body / no usage — skip silently.
  }
}
