/**
 * FallbackChain — pick the next OpenCodeGo model entry after an unrecoverable
 * upstream error.
 *
 * Caller tracks the list of `attemptedModels` (including the primary that
 * just failed). Returns `null` when the per-scenario fallback list is
 * exhausted; the proxy caps total attempts at 3 (primary + 2 fallbacks) per
 * design D4.
 */

import type { OpenCodeGoModelEntry, OpenCodeGoScenario, OpenCodeGoTokenConfig } from '@omnicross/contracts/subscription-types';

import { DEFAULT_OPENCODEGO_FALLBACKS } from './defaults';

/** Maximum number of attempts (primary + fallbacks) per inbound request. */
export const MAX_FALLBACK_ATTEMPTS = 3;

/** Next entry, or `null` when exhausted (caller MUST also enforce
 *  `attemptedModels.length < MAX_FALLBACK_ATTEMPTS`). */
export function nextFallbackEntry(
  scenario: OpenCodeGoScenario,
  attemptedModels: readonly string[],
  config: OpenCodeGoTokenConfig | undefined,
): OpenCodeGoModelEntry | null {
  if (attemptedModels.length >= MAX_FALLBACK_ATTEMPTS) return null;
  const list =
    config?.fallbacks?.[scenario] ??
    DEFAULT_OPENCODEGO_FALLBACKS[scenario] ??
    [];
  const remaining = list.filter((e) => !attemptedModels.includes(e.modelId));
  return remaining[0] ?? null;
}
