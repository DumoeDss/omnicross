/**
 * Transformer Registry
 *
 * Exports all built-in transformers for registration with TransformerService.
 *
 * @module transformer/transformers/index
 */

import type { TransformerService } from '../TransformerService';

import { AnthropicTransformer } from './AnthropicTransformer';
import { GeminiCodeAssistTransformer } from './GeminiCodeAssistTransformer';
import { GeminiTransformer } from './GeminiTransformer';
import { OpenAIResponseTransformer } from './OpenAIResponseTransformer';
import { OpenAITransformer } from './OpenAITransformer';

// Export individual transformers
export { AnthropicTransformer } from './AnthropicTransformer';
export { GeminiCodeAssistTransformer } from './GeminiCodeAssistTransformer';
export { GeminiTransformer } from './GeminiTransformer';
export { OpenAIResponseTransformer } from './OpenAIResponseTransformer';
export { OpenAITransformer } from './OpenAITransformer';

/**
 * Map of all built-in transformers
 * Used for automatic registration with TransformerService
 *
 * This is the FORMAT axis — one encoder per upstream wire, selected by a
 * provider row's `apiFormat` (plus `gemini-code-assist`, the Code-Assist
 * subscription's variant of the Gemini wire). The MODIFIER axis (`maxtoken`,
 * `sampling`, `reasoning`, …) is a separate, currently-unimplemented surface:
 * those names are declared in the UI, round-trip through config, and are warned
 * + skipped at resolve time until something implements them.
 */
export const BuiltinTransformers = {
  OpenAITransformer,
  GeminiTransformer,
  GeminiCodeAssistTransformer,
  AnthropicTransformer,
  OpenAIResponseTransformer,
} as const;

/**
 * Get all built-in transformer constructors
 */
export function getBuiltinTransformers(): typeof BuiltinTransformers {
  return BuiltinTransformers;
}

/**
 * List of built-in transformer names
 */
export const BUILTIN_TRANSFORMER_NAMES = [
  'openai',
  'gemini',
  'gemini-code-assist',
  'anthropic',
  'openai-response',
] as const;

export type BuiltinTransformerName = (typeof BUILTIN_TRANSFORMER_NAMES)[number];

/**
 * Single self-registration entry point for the built-in transformer set.
 *
 * This is the **one** place the built-in set is seeded onto a
 * {@link TransformerService}. Production seeders (bootstrap deferred-init and
 * the host proxy's local instance) call this instead of
 * re-deriving the set from {@link getBuiltinTransformers} at the call site, so
 * adding/removing a built-in is a single-file edit (append to
 * {@link BuiltinTransformers} + {@link BUILTIN_TRANSFORMER_NAMES} + its module)
 * that every seeder inherits.
 *
 * Registration is delegated verbatim to {@link TransformerService.initialize}
 * so the registered map contents and all side effects (constructor-vs-instance
 * handling, static `TransformerName` honoring, the summary log line) are
 * byte-identical to the prior `initialize(getBuiltinTransformers())` call.
 *
 * @param service - The TransformerService instance to seed.
 */
export async function registerBuiltinTransformers(service: TransformerService): Promise<void> {
  await service.initialize(getBuiltinTransformers());
}
