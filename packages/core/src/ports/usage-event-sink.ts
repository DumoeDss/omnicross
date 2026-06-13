/**
 * `UsageEventSink` — core-owned port for the in-process usage-event hub the
 * completion path emits to (live context-meter + aggregate recorder consumers).
 *
 * The serving core MUST depend on THIS interface, never on the host
 * `getUsageEventHub` global getter. Bootstrap injects `getUsageEventHub()` as
 * the sink (eagerly, right after `new CompletionService(...)`), so emission
 * stays unconditional in production.
 *
 * The emitted payload is declared STRUCTURALLY here (design Q3) so the core does
 * not import the host's own usage-event type. The shape is the subset the core
 * actually emits (`sessionId`/`modelId`/`usage`/`engineOrigin`) and is kept
 * assignable to the host's type (tsc enforces this at the bootstrap injection
 * site):
 *
 * - `usage` carries the three required token counts the completion path
 *   produces plus the two OPTIONAL Anthropic cache fields, so it stays
 *   assignable to the host's `UsageTokenCounts`.
 * - `engineOrigin` is narrowed to the only origin the core emits
 *   (`'completion'`), a subset of the host union.
 *
 * @module ports/usage-event-sink
 */

/** Token counts emitted by the core — structural subset of the host `UsageTokenCounts`. */
export interface CoreUsageTokenCounts {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

/** Usage event the core emits — structurally assignable to the host `UsageEvent`. */
export interface CoreUsageEvent {
  sessionId: string;
  modelId: string;
  usage: CoreUsageTokenCounts;
  engineOrigin?: 'completion';
}

export interface UsageEventSink {
  emit(event: CoreUsageEvent): void;
}
