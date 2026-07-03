/**
 * recordGeminiUsage — the non-stream usage tap for the ProviderProxy Gemini
 * `generateContent` ingress (`provider-proxy-transformer-matrix` slice 2).
 *
 * The relayed non-stream body the proxy sees has ALREADY been re-encoded to the
 * Gemini wire by `GeminiTransformer.transformResponseIn` (the endpoint encoder),
 * so the usage lives in Gemini's `usageMetadata` block (`promptTokenCount` /
 * `candidatesTokenCount` / `cachedContentTokenCount` / `thoughtsTokenCount`),
 * NOT the OpenAI `usage` (`prompt_tokens`) or Responses (`input_tokens`) shapes.
 * It therefore gets its own reader; everything else mirrors
 * `recordResponsesNonStreamUsage` / `recordChatCompletionsNonStreamUsage`.
 * Never throws.
 *
 * NOTE: `engineOrigin` reuses `'codex-ingress'` — the only non-Anthropic ingress
 * origin the `UsageRecordImportInput` union exposes today (same call the chat tap
 * makes). Widening that enum (e.g. a dedicated `'gemini-ingress'`) is a
 * usage-recorder concern out of this slice's scope; the attribution is
 * non-load-bearing for routing. FLAGGED in the change notes.
 *
 * @module provider-proxy/usage/recordGeminiUsage
 */

import type { UsageRecorderImport } from '../types';

interface GeminiUsageAttribution {
  readonly sessionId: string | null;
  readonly providerId: string;
  readonly model: string;
  readonly apiKeyId: string | null;
}

/** Read token counts from a Gemini `usageMetadata` object (cache + thoughts aware). */
function readGeminiUsage(usage: Record<string, unknown> | undefined): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
} | null {
  if (!usage) return null;
  const promptTokens = Number(usage.promptTokenCount) || 0;
  const candidatesTokens = Number(usage.candidatesTokenCount) || 0;
  const cacheReadTokens = Number(usage.cachedContentTokenCount) || 0;
  const reasoningTokens = Number(usage.thoughtsTokenCount) || 0;
  // Avoid double-counting cached tokens within the billable input total
  // (mirrors the Responses / Chat taps).
  const billableInput = Math.max(0, promptTokens - cacheReadTokens);
  return {
    inputTokens: billableInput,
    outputTokens: candidatesTokens,
    cacheReadTokens,
    cacheCreationTokens: 0,
    reasoningTokens,
  };
}

/**
 * Parse a non-stream Gemini `generateContent` JSON body and, when a
 * `usageMetadata` block is present, record one usage event. Never throws.
 */
export function recordGeminiNonStreamUsage(
  recorder: UsageRecorderImport,
  bodyText: string,
  attribution: GeminiUsageAttribution,
): void {
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    const tapped = readGeminiUsage(parsed.usageMetadata as Record<string, unknown> | undefined);
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
      rawUsage: parsed.usageMetadata,
    });
  } catch {
    // Unparseable body / no usage — skip silently.
  }
}
