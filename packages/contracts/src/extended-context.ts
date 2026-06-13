/**
 * 1M-context (extended-context) capability gate for Anthropic models.
 *
 * @module extended-context
 */

/**
 * Bare model ids that have a 1M-context (extended) tier registered in
 * `canonical-models.ts`. The beta header `context-1m-2025-08-07` is only
 * injected on outbound requests when the active model is in this set AND
 * the caller opted in.
 */
export const EXTENDED_CONTEXT_CAPABLE_MODELS: ReadonlySet<string> = new Set([
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
]);

/**
 * Returns true when the bare model id has a 1M-context variant. Used as a
 * defensive gate before injecting `context-1m-2025-08-07` into the
 * `anthropic_beta` array — guards against stale opt-in state whose model has
 * been edited to a non-capable id.
 */
export function isExtendedContextCapable(model: string): boolean {
  return EXTENDED_CONTEXT_CAPABLE_MODELS.has(model);
}
