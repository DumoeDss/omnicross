/**
 * modelPrefixDispatch — pure model-name PREFIX classification for the `chat`
 * endpoint's opt-in `dispatchMode: 'prefix'` (openai-chat-bridge #11, design D2).
 *
 * In prefix mode the requested model's leading vendor token selects a configured
 * target from {@link ModelPrefixTargets} (`claude-*` → `claude`, `gpt-*` → `gpt`,
 * `gemini-*` → `gemini`), so an operator can serve many upstreams from a single
 * `/v1/chat/completions` without an explicit per-model list entry. The match is
 * case-insensitive and anchored at the START of the id (a token prefix, not a
 * substring — `my-gpt-thing` does NOT classify as `gpt`). This is a ROUTING
 * convenience layered on top of the existing conversion machinery; it changes
 * only which upstream a model resolves to, never how the body is translated.
 *
 * @module outbound-api/modelPrefixDispatch
 */

import type { ModelPrefixTargets, ModelRef } from './types';

/** The three core prefixes this dispatch vocabulary recognizes. */
export type ModelPrefixKind = 'claude' | 'gpt' | 'gemini';

/**
 * Classify a requested model id by its leading vendor token. Case-insensitive;
 * anchored at the start (matches `<prefix>` exactly or `<prefix>-…`). Returns the
 * matched {@link ModelPrefixKind}, or `null` when no known prefix applies (an
 * empty/blank id also yields `null`).
 *
 * `gpt` also matches the OpenAI `o`-series reasoning ids (`o1`, `o3-mini`, …),
 * which carry no `gpt` token but are the same OpenAI Chat-Completions family the
 * `gpt` target serves.
 */
export function classifyModelPrefix(model: string | undefined): ModelPrefixKind | null {
  if (!model) return null;
  const id = model.trim().toLowerCase();
  if (!id) return null;
  if (matchesPrefix(id, 'claude')) return 'claude';
  if (matchesPrefix(id, 'gemini')) return 'gemini';
  if (matchesPrefix(id, 'gpt') || matchesOSeries(id)) return 'gpt';
  return null;
}

/** True when `id` equals `prefix` or begins with `prefix-` (token-anchored). */
function matchesPrefix(id: string, prefix: string): boolean {
  return id === prefix || id.startsWith(`${prefix}-`);
}

/** True for an OpenAI `o`-series reasoning id (`o1`, `o3`, `o4-mini`, …). */
function matchesOSeries(id: string): boolean {
  return /^o\d/.test(id);
}

/**
 * Resolve the configured target ref for a requested model under prefix dispatch.
 * Returns the `ModelRef` for the matched prefix, or `null` when the model has no
 * known prefix OR the matched prefix has no configured target (both are
 * "unroutable" — the caller surfaces a clear per-request error).
 */
export function resolvePrefixTarget(
  targets: ModelPrefixTargets | undefined,
  model: string | undefined,
): { kind: ModelPrefixKind; ref: ModelRef } | null {
  const kind = classifyModelPrefix(model);
  if (!kind) return null;
  const ref = targets?.[kind];
  if (!ref || !ref.trim()) return null;
  return { kind, ref };
}
