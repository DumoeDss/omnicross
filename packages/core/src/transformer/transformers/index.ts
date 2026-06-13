/**
 * Transformer Registry
 *
 * Exports all built-in transformers for registration with TransformerService.
 *
 * @module transformer/transformers/index
 */

import type { TransformerService } from '../TransformerService';

import { AnthropicTransformer } from './AnthropicTransformer';
import { DeepseekTransformer } from './DeepseekTransformer';
import { GeminiCodeAssistTransformer } from './GeminiCodeAssistTransformer';
import { GeminiTransformer } from './GeminiTransformer';
import { OpenAIResponseTransformer } from './OpenAIResponseTransformer';
import { OpenCodeGoTransformer } from './OpenCodeGoTransformer';
import { ReasoningTransformer } from './ReasoningTransformer';

// Export individual transformers
export { AnthropicTransformer } from './AnthropicTransformer';
export { DeepseekTransformer } from './DeepseekTransformer';
export { GeminiCodeAssistTransformer } from './GeminiCodeAssistTransformer';
export { GeminiTransformer } from './GeminiTransformer';
export { OpenAIResponseTransformer } from './OpenAIResponseTransformer';
export { OpenCodeGoTransformer } from './OpenCodeGoTransformer';
export { ReasoningTransformer } from './ReasoningTransformer';

/**
 * Map of all built-in transformers
 * Used for automatic registration with TransformerService
 */
export const BuiltinTransformers = {
  DeepseekTransformer,
  ReasoningTransformer,
  GeminiTransformer,
  GeminiCodeAssistTransformer,
  AnthropicTransformer,
  OpenAIResponseTransformer,
  OpenCodeGoTransformer,
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
  'deepseek',
  'reasoning',
  'gemini',
  'gemini-code-assist',
  'anthropic',
  'openai-response',
  'opencodego',
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
