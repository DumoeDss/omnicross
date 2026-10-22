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
    case 'refusal':
      return 'content_filter';
    default:
      return 'stop';
  }
}

/**
 * Map an OpenAI finish_reason to an Anthropic stop_reason.
 */
export function mapOpenAIFinishReason(
  finishReason: string
): 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'refusal' {
  switch (finishReason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    case 'content_filter':
      return 'refusal';
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
  if ('thinking' in request && (request.thinking?.type === 'enabled' || request.thinking?.type === 'adaptive')) {
    return true;
  }
  // OpenAI format (through special parameter)
  if ('reasoning' in request && request.reasoning) {
    return request.reasoning.enabled !== false && request.reasoning.effort !== 'none';
  }
  return false;
}

/**
 * Convert text-only tool results without silently dropping unsupported media.
 * OpenAI Chat tool messages cannot represent Anthropic image/document results.
 */
export function flattenToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (!Array.isArray(content)) return JSON.stringify(content);

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (!block || typeof block !== 'object') continue;
    const typed = block as Record<string, unknown>;
    if (typeof typed.text === 'string' && typed.type === 'text') {
      parts.push(typed.text);
    } else {
      throw new Error(`Cannot convert tool result content type: ${String(typed.type)}`);
    }
  }
  return parts.filter((text) => text !== '').join('\n');
}

/** Read SSE data from either complete lines or arbitrarily split wire chunks. */
export async function* readSSEData(stream: AsyncIterable<string>): AsyncGenerator<string> {
  let buffer = '';
  let data: string[] = [];
  for await (const chunk of stream) {
    if (!buffer && !chunk.includes('\n') && /^(event:|id:|retry:|:)/.test(chunk)) continue;
    // The public converters historically also accepted individual lines.
    if (!buffer && !chunk.includes('\n') && !chunk.includes('\r') && chunk.startsWith('data:')) {
      const value = chunk.slice(5).replace(/^ /, '');
      let complete = value === '[DONE]';
      if (!complete) {
        try { JSON.parse(value); complete = true; } catch { /* Partial wire chunk. */ }
      }
      if (complete) {
        if (data.length) { yield data.join('\n'); data = []; }
        yield value;
        continue;
      }
    }
    buffer += chunk;
    let match: RegExpExecArray | null;
    while ((match = /\r\n|\r(?!$)|\n/.exec(buffer))) {
      const line = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      if (!line) {
        if (data.length) { yield data.join('\n'); data = []; }
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''));
      }
    }
  }
  if (buffer.startsWith('data:')) data.push(buffer.slice(5).replace(/^ /, '').replace(/\r$/, ''));
  if (data.length) yield data.join('\n');
}
