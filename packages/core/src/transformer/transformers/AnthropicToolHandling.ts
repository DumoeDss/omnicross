/**
 * AnthropicToolHandling - Tool conversion helpers for AnthropicTransformer.
 *
 * Handles:
 * - Server-side tool detection (web_search, code_execution, etc.)
 * - Anthropic tool schema -> OpenAI/unified UnifiedTool[] conversion
 *
 * Internal module of AnthropicTransformer; do not import the facade here.
 *
 * @module transformer/transformers/AnthropicToolHandling
 */

import type { UnifiedTool } from '../types';

/** Provider-defined tools have native schemas, whether executed by server or client. */
export function isNativeAnthropicTool(tool: Record<string, unknown>): boolean {
  return typeof tool.type === 'string' && tool.type !== 'custom';
}

/**
 * Convert Anthropic tools to unified format.
 * Native tools are preserved separately via _serverSideTools for Anthropic replay.
 */
export function convertAnthropicToolsToOpenAI(
  tools: Array<Record<string, unknown>>
): UnifiedTool[] {
  return tools
    .filter(tool => !isNativeAnthropicTool(tool))
    .map((tool) => {
      if (typeof tool.name !== 'string' || !tool.input_schema || typeof tool.input_schema !== 'object') {
        throw new Error('Anthropic function tools require a name and input_schema');
      }
      return {
        type: 'function' as const,
        function: {
          name: tool.name,
          description: String(tool.description || ''),
          parameters: tool.input_schema as UnifiedTool['function']['parameters'],
        },
      };
    });
}
