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
import { convertMessageToAnthropic, convertMessagesToGemini, convertMessageToOpenAI, convertMessagesToResponses } from './message-converter';
import { buildAnthropicReasoningWire, buildGeminiThinkingConfig, resolveCompletionModel, resolveOpenAIEffort } from './ReasoningRequestBuilder';

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
  if (options.model !== actualModel) options = { ...options, model: actualModel };
  const redirected = resolveCompletionModel(provider, options);
  if (redirected) ({ provider, options } = redirected);
  actualModel = options.model;
  let requestBody: Record<string, unknown>;
  let url: string;

  if (apiFormat === 'google') {
    // Gemini format
    const thinkingConfig = buildGeminiThinkingConfig(provider, options);
    requestBody = {
      ...convertMessagesToGemini(conversationMessages),
      tools: options.tools,
      generationConfig: {
        ...(options.maxTokens !== undefined ? { maxOutputTokens: options.maxTokens } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(thinkingConfig ? { thinkingConfig } : {}),
      },
    };

    url = buildProviderApiUrl(provider, { model: actualModel, stream: true });
  } else if (apiFormat === 'anthropic') {
    const reasoningWire = buildAnthropicReasoningWire(provider, options);
    // Anthropic format
    requestBody = {
      model: actualModel,
      messages: conversationMessages.filter(m => m.role !== 'system').map(convertMessageToAnthropic),
      max_tokens: reasoningWire.effectiveMaxTokens,
      ...(reasoningWire.legacyBudgetEnabled ? {} : { temperature: options.temperature }),
      ...(reasoningWire.thinking ? { thinking: reasoningWire.thinking } : {}),
      ...(reasoningWire.outputConfig ? { output_config: reasoningWire.outputConfig } : {}),
      stream: true,
      tools: options.tools
    };

    const system = conversationMessages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    if (system) requestBody.system = system;

    url = buildProviderApiUrl(provider, { model: actualModel, stream: true });
  } else if (apiFormat === 'openai-response') {
    const effort = resolveOpenAIEffort(provider, { ...options, model: actualModel }, 'openai-responses');
    requestBody = {
      model: actualModel, input: convertMessagesToResponses(conversationMessages), stream: true,
      tools: (options.tools as OpenAITool[]).map(tool => ({ type: 'function', ...tool.function })),
      ...(options.maxTokens !== undefined ? { max_output_tokens: options.maxTokens } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(effort ? { reasoning: { effort, summary: 'auto' } } : {}),
    };
    url = buildProviderApiUrl(provider, { model: actualModel, stream: true });
  } else {
    // OpenAI format
    requestBody = {
      model: actualModel,
      messages: conversationMessages.map(convertMessageToOpenAI),
      ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      stream: true,
      tools: options.tools,
      stream_options: { include_usage: true },
    };
    const effort = resolveOpenAIEffort(provider, { ...options, model: actualModel }, 'openai-chat');
    if (effort) requestBody.reasoning_effort = effort;

    url = buildProviderApiUrl(provider, { model: actualModel, stream: true });
  }

  return { requestBody, url };
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
        throw new Error(`Tool not found: ${toolCall.name}`);
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
      const resultText = result.content?.every(part => part.type === 'text')
        ? result.content.map(part => part.text).join('\n') : JSON.stringify(result);
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
