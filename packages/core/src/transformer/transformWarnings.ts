/**
 * transformWarnings — the `_transformWarnings` audit side-channel
 * (`claude-api-transform-fidelity`, R7 / design D2).
 *
 * When a decoded ingress field (top_k, metadata_user_id, stop on Responses,
 * redacted_thinking, …) has NO representation on the target wire, the encoder
 * records it here instead of silently dropping it: the entry carries the FIELD
 * NAME and target only — NEVER the value (values may carry user content), so
 * the channel is safe to log.
 *
 * The channel rides the Unified request (the `_serverSideTools` precedent) and
 * is stripped at every encoder boundary — the OpenAI-chat blacklist lists it
 * and the Responses/Gemini/Anthropic builders construct their bodies
 * field-by-field — so it can never serialize into an upstream request.
 *
 * §9's `dropped_field{field}` metric is a module-level counter (no metrics
 * registry in this repo — the same minimal-observability precedent as B's
 * stop_reason counter) plus a once-per-field console.warn so a hot loop of
 * dropping requests doesn't spam the log.
 *
 * @module transformer/transformWarnings
 */

import type { UnifiedChatRequest } from './types';

/** One dropped-field audit entry. `field`/`target` names only — never values. */
export interface DroppedFieldEntry {
  field: string;
  target: string;
}

/** Bounded per-field counters (tests reset via the helper below). */
export const droppedFieldCounts: Record<string, number> = {};

const warnedOnce = new Set<string>();

/** Record that `field` was dropped while encoding to `target`. Field-name only. */
export function recordDroppedField(
  request: UnifiedChatRequest,
  field: string,
  target: string,
): void {
  attachTransformWarnings(request).push({ field, target });
  const key = `${field}\0${target}`;
  droppedFieldCounts[key] = (droppedFieldCounts[key] ?? 0) + 1;
  if (!warnedOnce.has(key)) {
    warnedOnce.add(key);
    console.warn(
      `[transform] dropped_field: '${field}' has no representation on the '${target}' wire (counting; values never logged)`,
    );
  }
}

/** Seed the side channel on a Unified request (decoder side). */
export function attachTransformWarnings(request: UnifiedChatRequest): DroppedFieldEntry[] {
  const holder = request as unknown as { _transformWarnings?: DroppedFieldEntry[] };
  holder._transformWarnings ??= [];
  return holder._transformWarnings;
}

/** Test-only: reset counters + the once-per-field warn dedupe. */
export function __resetDroppedFieldCountsForTests(): void {
  for (const key of Object.keys(droppedFieldCounts)) delete droppedFieldCounts[key];
  warnedOnce.clear();
}
