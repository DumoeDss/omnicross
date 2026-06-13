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

/**
 * Check if a tool is an Anthropic server-side tool (executed by the API server, not the client).
 * These tools have a specific `type` field (e.g. "web_search_20250305") instead of "tool".
 */
export function isServerSideTool(tool: Record<string, unknown>): boolean {
  const type = String(tool.type || '');
  return type.startsWith('web_search_') ||
    type.startsWith('code_execution_') ||
    type.startsWith('text_editor_') ||
    type.startsWith('memory_') ||
    type.startsWith('web_fetch_') ||
    type.startsWith('search_tool_');
}

/**
 * Convert Anthropic tools to unified format.
 * Server-side tools (web_search, code_execution, etc.) are filtered out
 * and preserved separately via _serverSideTools in the unified request.
 */
export function convertAnthropicToolsToOpenAI(
  tools: Array<Record<string, unknown>>
): UnifiedTool[] {
  return tools
    .filter(tool => !isServerSideTool(tool))
    .map((tool) => ({
      type: 'function' as const,
      function: {
        name: String(tool.name),
        description: String(tool.description || ''),
        parameters: tool.input_schema as unknown as UnifiedTool['function']['parameters'],
      },
    }));
}
