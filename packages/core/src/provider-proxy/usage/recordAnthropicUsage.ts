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
 * NOTE: `engineOrigin` is `'anthropic-messages-ingress'`
 * (claude-api-transform-fidelity, R11) — it formerly reused `'codex-ingress'`
 * as a placeholder before the union gained a dedicated value. Historical
 * events keep the old value (no backfill); release note covers the migration.
 *
 * @module provider-proxy/usage/recordAnthropicUsage
 */

import type { RouteLeaseUsageAttribution, UsageRecorderImport } from '../types';

interface AnthropicUsageAttribution {
  readonly sessionId: string | null;
  readonly providerId: string;
  readonly model: string;
  readonly apiKeyId: string | null;
  readonly routeLease?: RouteLeaseUsageAttribution;
  /** request-audit-log: per-request audit correlation key (the response object). */
  readonly auditResponse?: object;
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
 * present, record one usage event with origin `'anthropic-messages-ingress'`. Never
 * throws.
 */
function emitAnthropicUsageRecord(
  recorder: UsageRecorderImport,
  rawUsage: Record<string, unknown> | undefined,
  attribution: AnthropicUsageAttribution,
): void {
  const tapped = readAnthropicUsage(rawUsage);
  if (!tapped) return;
  recorder.record({
    messageId: null,
    parentMessageId: null,
    sessionId: attribution.sessionId,
    providerId: attribution.providerId,
    model: attribution.model,
    apiKeyId: attribution.apiKeyId,
    runId: attribution.routeLease?.runId ?? null,
    routeLeaseId: attribution.routeLease?.leaseId ?? null,
    routeLeaseConsumer: attribution.routeLease?.consumer ?? null,
    routeLeaseStageId: attribution.routeLease?.stageId ?? null,
    auditResponse: attribution.auditResponse,
    engineOrigin: 'anthropic-messages-ingress',
    usage: tapped,
    rawUsage,
  });
}

export function recordAnthropicNonStreamUsage(
  recorder: UsageRecorderImport,
  bodyText: string,
  attribution: AnthropicUsageAttribution,
): void {
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    emitAnthropicUsageRecord(
      recorder,
      parsed.usage as Record<string, unknown> | undefined,
      attribution,
    );
  } catch {
    // Unparseable body / no usage — skip silently.
  }
}

/**
 * Record one Anthropic usage event from a raw combined `usage` object tapped out
 * of a STREAMING `message_start`+`message_delta` pair (the ingress merges the
 * piecewise input/output usage before calling this). Never throws.
 */
export function recordAnthropicStreamUsage(
  recorder: UsageRecorderImport,
  rawUsage: Record<string, unknown> | undefined,
  attribution: AnthropicUsageAttribution,
): void {
  try {
    emitAnthropicUsageRecord(recorder, rawUsage, attribution);
  } catch {
    // never throw on usage accounting
  }
}
