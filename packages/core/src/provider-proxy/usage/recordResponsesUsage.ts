/**
 * recordResponsesUsage — the single non-stream usage tap for the ProviderProxy
 * OpenAI-Responses ingress (task 2.8, design R6).
 *
 * Parses the Responses-API `usage` block (`input_tokens` / `output_tokens` /
 * cache fields) from a relayed non-stream JSON body and records ONE
 * usage event with `engineOrigin: 'codex-ingress'`. Identical token math
 * to the host's pre-existing codex usage tap — re-expressed here so the
 * resident proxy owns the single tap. Never throws.
 *
 * @module provider-proxy/usage/recordResponsesUsage
 */

import type { UsageRecorderImport } from '../types';

interface ResponsesUsageAttribution {
  readonly sessionId: string | null;
  readonly providerId: string;
  readonly model: string;
  readonly apiKeyId: string | null;
}

/** Read token counts from a Responses-API `usage` object (cache-aware). */
function readResponsesUsage(usage: Record<string, unknown> | undefined): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
} | null {
  if (!usage) return null;
  const inputTokens = Number(usage.input_tokens) || 0;
  const outputTokens = Number(usage.output_tokens) || 0;
  const inputDetails = (usage.input_tokens_details ?? {}) as Record<string, unknown>;
  const cacheReadTokens = Number(inputDetails.cached_tokens) || 0;
  const outputDetails = (usage.output_tokens_details ?? {}) as Record<string, unknown>;
  const reasoningTokens = Number(outputDetails.reasoning_tokens) || 0;
  // Avoid double-counting cached tokens within the billable input total.
  const billableInput = Math.max(0, inputTokens - cacheReadTokens);
  return {
    inputTokens: billableInput,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens: 0,
    reasoningTokens,
  };
}

/**
 * Parse a non-stream Responses-API JSON body and, when a usage block is present,
 * record one usage event with origin `'codex-ingress'`. Never throws.
 */
export function recordResponsesNonStreamUsage(
  recorder: UsageRecorderImport,
  bodyText: string,
  attribution: ResponsesUsageAttribution,
): void {
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    const tapped = readResponsesUsage(parsed.usage as Record<string, unknown> | undefined);
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
