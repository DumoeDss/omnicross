/**
 * ToolExecutor - Helper functions for tool execution and stream parsing
 *
 * Extracted from ToolHandler to keep file sizes under 600 lines.
 * Contains tool execution, argument mapping, stream chunk parsing,
 * and iteration block building helpers.
 */

import type { MessageBlock } from '@omnicross/contracts/message-blocks';
import type { SimpleChatMessage } from '@omnicross/contracts/completion-types';
import type { LLMProvider } from '@omnicross/contracts/llm-config';
import type { MCPTool } from '@omnicross/contracts/mcp-types';

import type { Logger } from '../ports/logger';
import type { AnthropicTool, GeminiTools, McpToolProvider, OpenAITool } from '../tool-types';

import { buildProviderApiUrl } from './';
import type { BuiltinToolExecutor } from './BuiltinToolExecutor';
import type { StreamWithToolsCallbacks, StreamWithToolsOptions } from './ToolHandler';

/**
 * Log tool format information for debugging
 */
export function logToolFormat(tools: OpenAITool[] | AnthropicTool[] | GeminiTools, logger: Logger): void {
  if (!Array.isArray(tools) || tools.length === 0) {
    logger.warn('No tools provided');
    return;
  }

  const firstTool = tools[0];

  if ('function' in firstTool) {
    // OpenAI format
    const openaiTools = tools as OpenAITool[];
    logger.info('Tools configured (OpenAI format)', {
      count: openaiTools.length,
      tools: openaiTools.map(t => t.function.name),
      firstTool: {
        name: firstTool.function.name,
        description: firstTool.function.description?.slice(0, 100),
        parameters: firstTool.function.parameters
      }
    });
  } else if ('input_schema' in firstTool) {
    // Anthropic format
    const anthropicTools = tools as AnthropicTool[];
    logger.info('Tools configured (Anthropic format)', {
      count: anthropicTools.length,
      tools: anthropicTools.map(t => t.name),
      firstTool: {
        name: firstTool.name,
        description: (firstTool as { description?: string }).description?.slice(0, 100),
        input_schema: (firstTool as { input_schema?: unknown }).input_schema
      }
    });
  } else if ('functionDeclarations' in firstTool) {
    // Gemini format (wrapped in functionDeclarations)
    const geminiTools = tools as GeminiTools;
    const allDeclarations = geminiTools.flatMap(t => t.functionDeclarations);
    logger.info('Tools configured (Gemini format)', {
      count: allDeclarations.length,
      tools: allDeclarations.map(t => t.name),
      firstTool: {
        name: allDeclarations[0]?.name,
        description: allDeclarations[0]?.description?.slice(0, 100),
        parameters: allDeclarations[0]?.parameters
      }
    });
  }
}

/**
 * Build the request body and URL for a tool-based API call
 */
export function buildToolRequest(
  apiFormat: string,
  conversationMessages: SimpleChatMessage[],
  actualModel: string,
  options: StreamWithToolsOptions,
  provider: LLMProvider
): { requestBody: Record<string, unknown>; url: string } {
  let requestBody: Record<string, unknown>;
  let url: string;

  if (apiFormat === 'google') {
    // Gemini format
    const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
    for (const msg of conversationMessages) {
      if (msg.role !== 'system') {
        contents.push({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.content }]
        });
      }
    }

    requestBody = {
      contents,
      tools: options.tools
    };

    // TEMPORARY: Use non-streaming endpoint for debugging
    url = buildProviderApiUrl(provider, { model: actualModel, stream: true });
  } else if (apiFormat === 'anthropic') {
    // Anthropic format
    requestBody = {
      model: actualModel,
      messages: conversationMessages.filter(m => m.role !== 'system').map(m => ({
        role: m.role,
        content: m.content
      })),
      max_tokens: options.maxTokens || 4096,
      temperature: options.temperature ?? 0.7,
      stream: true,
      tools: options.tools
    };

    const systemMsg = conversationMessages.find(m => m.role === 'system');
    if (systemMsg) {
      requestBody.system = systemMsg.content;
    }

    url = buildProviderApiUrl(provider, { model: actualModel, stream: true });
  } else {
    // OpenAI format
    requestBody = {
      model: actualModel,
      messages: conversationMessages.map(m => ({
        role: m.role,
        content: m.content
      })),
      max_tokens: options.maxTokens || 4096,
      temperature: options.temperature ?? 0.7,
      stream: true,
      tools: options.tools
    };

    url = buildProviderApiUrl(provider, { model: actualModel, stream: true });
  }

  return { requestBody, url };
}

/**
 * Extract text content delta from a stream chunk based on API format
 */
// Loose chunk shape for stream JSON. Each backend uses a different layout —
// we duck-type the fields we need and tolerate undefined.
interface StreamChunk {
  candidates?: Array<{ content?: { parts?: Array<{ thought?: boolean; text?: string }> } }>;
  delta?: { text?: string };
  choices?: Array<{ delta?: { content?: string; thinking?: { content?: string }; reasoning_content?: string } }>;
}

export function extractDeltaContent(rawJson: unknown, apiFormat: string): string {
  const json = rawJson as StreamChunk;
  if (apiFormat === 'google') {
    const parts = json.candidates?.[0]?.content?.parts || [];
    let text = '';
    for (const part of parts) {
      if (part.thought === true) continue; // skip thinking
      if (part.text) text += part.text;
    }
    return text;
  } else if (apiFormat === 'anthropic') {
    return json.delta?.text || '';
  } else {
    return json.choices?.[0]?.delta?.content || '';
  }
}

/**
 * Extract reasoning content delta from a stream chunk based on API format
 */
export function extractDeltaReasoning(rawJson: unknown, apiFormat: string): string {
  const json = rawJson as StreamChunk;
  if (apiFormat === 'google') {
    const parts = json.candidates?.[0]?.content?.parts || [];
    let reasoning = '';
    for (const part of parts) {
      if (part.thought === true && part.text) reasoning += part.text;
    }
    return reasoning;
  } else if (apiFormat === 'anthropic') {
    return '';
  } else {
    const delta = json.choices?.[0]?.delta;
    return (delta?.thinking?.content || '') + (delta?.reasoning_content || '');
  }
}

/**
 * Pending OpenAI tool call accumulator.
 * OpenAI streams tool calls incrementally: id, name, and arguments
 * arrive in separate delta chunks and must be accumulated.
 */
export type PendingOpenAIToolCalls = Map<number, { id: string; name: string; arguments: string }>;

/**
 * Extract and process tool calls from a stream chunk.
 *
 * For Gemini: tool calls arrive complete in a single chunk → push immediately.
 * For OpenAI: tool calls arrive incrementally → accumulate in pendingOpenAIToolCalls,
 *             then call finalizeOpenAIToolCalls() after the stream ends.
 */
// Wider chunk shape that also covers tool-call deltas across all backends.
interface ToolCallChunk {
  candidates?: Array<{ content?: { parts?: Array<{ functionCall?: { name: string; args?: Record<string, unknown> } }> } }>;
  choices?: Array<{ delta?: { tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }>;
}

export function extractToolCalls(
  rawJson: unknown,
  apiFormat: string,
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
  callbacks: StreamWithToolsCallbacks,
  logger: Logger,
  pendingOpenAIToolCalls?: PendingOpenAIToolCalls
): void {
  const json = rawJson as ToolCallChunk;
  if (apiFormat === 'google') {
    const parts = json.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      if (part.functionCall) {
        logger.info('Function call detected', { functionCall: part.functionCall });
        const toolCall = {
          id: `call_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          name: part.functionCall.name,
          args: part.functionCall.args || {}
        };
        toolCalls.push(toolCall);
        callbacks.onToolCall?.(toolCall);
        logger.info('Tool called', { toolName: toolCall.name });
      }
    }
  } else if (apiFormat !== 'anthropic') {
    // OpenAI format: accumulate tool call deltas
    const delta = json.choices?.[0]?.delta;
    if (delta?.tool_calls && pendingOpenAIToolCalls) {
      for (const tc of delta.tool_calls) {
        const index = tc.index ?? 0;
        let pending = pendingOpenAIToolCalls.get(index);
        if (!pending) {
          pending = { id: '', name: '', arguments: '' };
          pendingOpenAIToolCalls.set(index, pending);
        }
        if (tc.id) pending.id = tc.id;
        if (tc.function?.name) pending.name += tc.function.name;
        if (tc.function?.arguments) pending.arguments += tc.function.arguments;
      }
    }
  }
  // TODO: Handle Anthropic tool calls
}

/**
 * Finalize accumulated OpenAI streaming tool calls into the toolCalls array.
 * Must be called after the stream has ended.
 */
export function finalizeOpenAIToolCalls(
  pendingOpenAIToolCalls: PendingOpenAIToolCalls,
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
  callbacks: StreamWithToolsCallbacks,
  logger: Logger
): void {
  for (const [, pending] of pendingOpenAIToolCalls) {
    if (pending.name) {
      try {
        const toolCall = {
          id: pending.id || `tool_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          name: pending.name,
          args: JSON.parse(pending.arguments || '{}')
        };
        toolCalls.push(toolCall);
        callbacks.onToolCall?.(toolCall);
        logger.info('Tool called (OpenAI)', { toolName: toolCall.name, args: toolCall.args });
      } catch (e) {
        logger.error('Failed to parse OpenAI tool call arguments', e instanceof Error ? e : undefined, {
          name: pending.name,
          arguments: pending.arguments
        });
      }
    }
  }
}

/**
 * Parse a stream chunk and dispatch callbacks based on API format
 */
export function parseStreamChunk(
  rawJson: unknown,
  apiFormat: string,
  callbacks: StreamWithToolsCallbacks,
  logger: Logger
): void {
  // Cast once — chunk fields are duck-typed below per backend.
  const json = rawJson as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean; thoughtSignature?: string; functionCall?: { name: string; args?: Record<string, unknown> } }> } }>;
    delta?: { type?: string; text?: string };
    choices?: Array<{ delta?: { content?: string; thinking?: { content?: string }; reasoning_content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string }; index?: number }> } }>;
  };
  if (apiFormat === 'google') {
    const candidate = json.candidates?.[0];
    if (!candidate) {
      logger.warn('No candidate found in Gemini response');
      return;
    }

    const parts = candidate.content?.parts || [];
    for (const part of parts) {
      // Handle thinking/reasoning (Gemini extended thinking) FIRST
      if (part.thought === true && part.text) {
        callbacks.onReasoning?.(part.text);
        continue;
      } else if (part.thoughtSignature && !part.thought) {
        logger.debug('Gemini returned thoughtSignature without thought content');
      }

      // Handle regular text content (non-thinking)
      if (part.text) {
        callbacks.onDelta?.(part.text);
      }
    }
  } else if (apiFormat === 'anthropic') {
    const delta = json.delta;
    if (delta?.text) {
      callbacks.onDelta?.(delta.text);
    }
  } else {
    // OpenAI format
    const delta = json.choices?.[0]?.delta;

    if (delta?.content) {
      callbacks.onDelta?.(delta.content);
    }

    if (delta?.thinking?.content) {
      callbacks.onReasoning?.(delta.thinking.content);
    }

    if (delta?.reasoning_content) {
      callbacks.onReasoning?.(delta.reasoning_content);
    }
  }
}

/**
 * Build content blocks for an iteration (thinking + text blocks)
 */
export function buildIterationBlocks(
  iteration: number,
  content: string,
  reasoning: string,
  blocks: MessageBlock[],
  callbacks: StreamWithToolsCallbacks
): void {
  const blockIdPrefix = `block_${iteration}_${Date.now()}`;

  // Add thinking block if there's reasoning
  if (reasoning && reasoning.trim()) {
    const thinkingBlock = {
      id: `${blockIdPrefix}_thinking`,
      type: 'thinking' as const,
      content: reasoning
    };
    blocks.push(thinkingBlock);
    callbacks.onBlock?.(thinkingBlock);
  }

  // Add text block if there's content
  if (content && content.trim()) {
    const textBlock = {
      id: `${blockIdPrefix}_text`,
      type: 'text' as const,
      content: content
    };
    blocks.push(textBlock);
    callbacks.onBlock?.(textBlock);
  }
}

/**
 * Execute tool calls and collect results
 */
export async function executeToolCalls(
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
  mcpTools: MCPTool[],
  mcpService: McpToolProvider | undefined,
  blocks: MessageBlock[],
  callbacks: StreamWithToolsCallbacks,
  logger: Logger,
  builtinExecutor?: BuiltinToolExecutor
): Promise<Array<{ toolCall: typeof toolCalls[0]; result: unknown }>> {
  const toolResults: Array<{ toolCall: typeof toolCalls[0]; result: unknown }> = [];

  for (const toolCall of toolCalls) {
    // Add tool_use block
    const toolUseBlock = {
      id: `${toolCall.id}_use`,
      type: 'tool_use' as const,
      toolId: toolCall.id,
      toolName: toolCall.name,
      input: toolCall.args,
      status: 'running' as const
    };
    blocks.push(toolUseBlock);
    callbacks.onBlock?.(toolUseBlock);

    try {
      logger.info('Executing tool', { toolName: toolCall.name });

      // Find the tool info from mcpTools
      const mcpTool = mcpTools.find(t => t.id === toolCall.name);
      if (!mcpTool) {
        logger.error('Tool not found', undefined, { toolName: toolCall.name });
        continue;
      }

      logger.debug('Tool info', {
        serverId: mcpTool.serverId,
        toolName: mcpTool.name,
        args: toolCall.args
      });

      // Map parameter names from LLM response to what the tool expects
      const mappedArgs = mapToolArguments(toolCall.args, mcpTool, logger);

      // Execute the tool — dispatch to builtin executor or MCP service
      let result;
      if (mcpTool.serverId === 'builtin' && builtinExecutor) {
        result = await builtinExecutor.execute(mcpTool.name, mappedArgs);
      } else if (mcpService) {
        result = await mcpService.callTool(mcpTool.serverId, mcpTool.name, mappedArgs, toolCall.id);
      } else {
        result = { isError: true, content: [{ type: 'text' as const, text: 'MCP service not available' }] };
      }

      logger.info('Tool result received', { result });

      // Notify callback
      callbacks.onToolResult?.(toolCall.id, result);

      // Add tool_result block
      const resultText = result.content?.[0]?.text || JSON.stringify(result);
      const toolResultBlock = {
        id: `${toolCall.id}_result`,
        type: 'tool_result' as const,
        toolId: toolCall.id,
        toolName: toolCall.name,
        output: resultText,
        isError: result.isError
      };
      blocks.push(toolResultBlock);
      callbacks.onBlock?.(toolResultBlock);

      // Update tool_use block status
      const toolUseBlockRef = blocks.find(b => b.id === `${toolCall.id}_use`);
      if (toolUseBlockRef && toolUseBlockRef.type === 'tool_use') {
        toolUseBlockRef.status = result.isError ? 'error' : 'completed';
        // Send updated tool_use block with new status
        callbacks.onBlock?.({ ...toolUseBlockRef });
      }

      // Store result for adding to conversation
      toolResults.push({ toolCall, result });

    } catch (error) {
      logger.error('Tool execution error', error instanceof Error ? error : undefined);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorResult = {
        isError: true,
        content: [{ type: 'text', text: `Error: ${errorMessage}` }]
      };
      callbacks.onToolResult?.(toolCall.id, errorResult);

      // Add error tool_result block
      const errorToolResultBlock = {
        id: `${toolCall.id}_result`,
        type: 'tool_result' as const,
        toolId: toolCall.id,
        toolName: toolCall.name,
        error: errorMessage,
        isError: true
      };
      blocks.push(errorToolResultBlock);
      callbacks.onBlock?.(errorToolResultBlock);

      // Update tool_use block status
      const errorToolUseBlockRef = blocks.find(b => b.id === `${toolCall.id}_use`);
      if (errorToolUseBlockRef && errorToolUseBlockRef.type === 'tool_use') {
        errorToolUseBlockRef.status = 'error';
        // Send updated tool_use block with error status
        callbacks.onBlock?.({ ...errorToolUseBlockRef });
      }

      toolResults.push({ toolCall, result: errorResult });
    }
  }

  return toolResults;
}

/**
 * Map parameter names from LLM response to what the tool expects.
 * Gemini sometimes uses simplified parameter names (e.g., 'query' instead of 'search_query')
 */
export function mapToolArguments(
  args: Record<string, unknown>,
  mcpTool: MCPTool,
  logger: Logger
): Record<string, unknown> {
  const mappedArgs: Record<string, unknown> = { ...args };
  const toolSchema = mcpTool.inputSchema as { properties?: Record<string, unknown>; required?: string[] } | undefined;
  if (toolSchema?.properties) {
    const expectedParams = Object.keys(toolSchema.properties);

    // Common parameter name mappings (LLM simplified name -> tool expected name)
    const paramMappings: Record<string, string[]> = {
      'search_query': ['query', 'q', 'searchQuery', 'search'],
      'content': ['text', 'body', 'message'],
      'file_path': ['path', 'filePath', 'file'],
      'url': ['link', 'uri'],
    };

    // For each expected parameter that's missing, check if a mapped parameter exists
    for (const expectedParam of expectedParams) {
      if (!(expectedParam in mappedArgs)) {
        const aliases = paramMappings[expectedParam];
        if (aliases) {
          for (const alias of aliases) {
            if (alias in mappedArgs) {
              logger.info('Mapping parameter', { from: alias, to: expectedParam });
              mappedArgs[expectedParam] = mappedArgs[alias];
              delete mappedArgs[alias];
              break;
            }
          }
        }
      }
    }
  }

  return mappedArgs;
}
