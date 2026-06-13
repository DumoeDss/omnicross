/**
 * Shared helpers for API direction converters.
 *
 * Pure functions used by both OpenAI→Anthropic and Anthropic→OpenAI
 * conversion paths: tool schema mapping, stop-reason mapping, and
 * lightweight image detection.
 */

import type {
  AnthropicChatRequest,
  AnthropicTool,
  OpenAIChatRequest,
  OpenAITool,
} from '@omnicross/contracts/completion-types';

/**
 * Convert an OpenAI tool definition into Anthropic format.
 */
export function convertOpenAITool(tool: OpenAITool): AnthropicTool {
  return {
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  };
}

/**
 * Map an Anthropic stop_reason to an OpenAI finish_reason.
 */
export function mapAnthropicStopReason(
  stopReason: string
): 'stop' | 'length' | 'tool_calls' | 'content_filter' {
  switch (stopReason) {
    case 'end_turn':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'stop_sequence':
      return 'stop';
    default:
      return 'stop';
  }
}

/**
 * Map an OpenAI finish_reason to an Anthropic stop_reason.
 */
export function mapOpenAIFinishReason(
  finishReason: string
): 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' {
  switch (finishReason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    case 'content_filter':
      return 'end_turn';
    default:
      return 'end_turn';
  }
}

/**
 * Check if a request contains image content (either format).
 */
export function hasImageContent(request: OpenAIChatRequest | AnthropicChatRequest): boolean {
  const messages = request.messages;

  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        // OpenAI format
        if ('type' in part && part.type === 'image_url') {
          return true;
        }
        // Anthropic format
        if ('type' in part && part.type === 'image') {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Check if a request has thinking/reasoning enabled.
 */
export function hasThinkingEnabled(request: OpenAIChatRequest | AnthropicChatRequest): boolean {
  // Anthropic format
  if ('thinking' in request && request.thinking?.type === 'enabled') {
    return true;
  }
  // OpenAI format (through special parameter)
  if ('reasoning' in request) {
    return true;
  }
  return false;
}
