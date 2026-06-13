/**
 * AnthropicStreaming - SSE stream conversion entry point for
 * AnthropicTransformer.
 *
 * Re-exports both stream-direction helpers from sibling files:
 * - convertOpenAIStreamToAnthropic - OpenAI SSE -> Anthropic event SSE
 * - convertAnthropicStreamToOpenAI - Anthropic event SSE -> OpenAI SSE
 *
 * Each helper lives in its own sibling file to keep individual files within
 * the per-file size budget (≤ 400 lines).
 *
 * Internal module of AnthropicTransformer; do not import the facade here.
 *
 * @module transformer/transformers/AnthropicStreaming
 */

export { convertAnthropicStreamToOpenAI } from './AnthropicAnthropicToOpenAIStream';
export { convertOpenAIStreamToAnthropic } from './AnthropicOpenAIToAnthropicStream';
