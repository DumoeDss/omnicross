/**
 * Core-owned tool-shape types.
 *
 * The structural tool definitions (`OpenAITool`, `AnthropicTool`,
 * `GeminiTools`) are pure data shapes with no host dependency — hoisted here
 * (verbatim from the host `tools/mcp-users/ToolsLoader.ts`) so the serving core
 * names no host module. The host `ToolsLoader.ts` re-exports these from
 * `@omnicross/core`, keeping every existing host consumer unchanged.
 *
 * `McpToolProvider` is the narrow structural port for the single `callTool`
 * method the completion tool-loop consumes from the host's concrete
 * `McpService`. The concrete `McpService` instance is injected at the existing
 * seam and satisfies this port structurally (type-only — no runtime coupling).
 */

import type { MCPCallToolResponse } from '@omnicross/contracts/mcp-types'

/**
 * OpenAI-compatible tool definition
 */
export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

/**
 * Anthropic tool definition
 */
export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, any>;
}

/**
 * Google Gemini tool definition
 * Gemini REST API expects tools wrapped in functionDeclarations
 */
export type GeminiTools = Array<{
  functionDeclarations: Array<{
    name: string;
    description: string;
    parameters: Record<string, any>;
  }>;
}>;

/**
 * Narrow structural port for the host MCP tool provider — only the `callTool`
 * method the serving-core tool-loop dispatches to. The host's concrete
 * `McpService` satisfies this structurally.
 */
export interface McpToolProvider {
  callTool(
    serverId: string,
    toolName: string,
    args: unknown,
    callId: string,
  ): Promise<MCPCallToolResponse>;
}
