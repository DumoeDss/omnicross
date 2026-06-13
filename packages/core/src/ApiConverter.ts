/**
 * API Converter - Bidirectional OpenAI ↔ Anthropic conversion.
 *
 * This module is a barrel re-export. The implementation lives in
 * `./api-converter/` split by direction:
 *
 * - `openai-to-anthropic.ts` — claude-code-router direction
 * - `anthropic-to-openai.ts` — claude-code-rerouter direction
 * - `shared.ts` — cross-direction helpers (tool schema, stop-reason mapping)
 */

export {
  convertAnthropicRequestToOpenAI,
  convertAnthropicStreamToOpenAI,
  convertAnthropicToOpenAI,
  convertAnthropicToOpenAIWithThinking,
} from './api-converter/anthropic-to-openai';
export {
  convertOpenAIResponseToAnthropic,
  convertOpenAIStreamToAnthropic,
  convertOpenAIToAnthropic,
  convertOpenAIToAnthropicWithThinking,
} from './api-converter/openai-to-anthropic';
export { hasImageContent, hasThinkingEnabled } from './api-converter/shared';
