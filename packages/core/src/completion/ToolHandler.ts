/**
 * ToolHandler - Handles streaming completion with MCP tool support
 *
 * Extracted from CompletionService to isolate the agentic loop logic
 * that handles tool calls: LLM -> execute tools -> LLM again until done.
 */

import type { MessageBlock } from '@omnicross/contracts/message-blocks';
import type { SimpleChatMessage } from '@omnicross/contracts/completion-types';
import type { LLMProvider } from '@omnicross/contracts/llm-config';
import type { MCPTool } from '@omnicross/contracts/mcp-types';

import type { Logger } from '../ports/logger';
import type { ProviderConfigSource } from '../ports/provider-config-source';
import type { AnthropicTool, GeminiTools, McpToolProvider, OpenAITool } from '../tool-types';

import {
  type CompletionOptions,
  getProviderHeaders,
  resolveApiFormat,
  type StreamCallbacks
} from './';
import type { BuiltinToolExecutor } from './BuiltinToolExecutor';
import { NATIVE_SEARCH_TOOL_NAMES } from './native-search-types';
import { applyAugmentation } from './NativeSearchInjector';
import {
  buildIterationBlocks,
  buildToolRequest,
  executeToolCalls,
  extractDeltaContent,
  extractDeltaReasoning,
  extractToolCalls,
  finalizeOpenAIToolCalls,
  logToolFormat,
  parseStreamChunk,
  type PendingOpenAIToolCalls} from './ToolExecutor';
import { resolveProviderEndpoint } from './url-builder';

/** Extended options for tool-based completion */
export interface StreamWithToolsOptions extends CompletionOptions {
  tools: OpenAITool[] | AnthropicTool[] | GeminiTools;
  mcpTools?: MCPTool[];
}

/** Extended callbacks for tool-based completion */
export interface StreamWithToolsCallbacks extends StreamCallbacks {
  onToolCall?: (toolCall: { id: string; name: string; args: unknown }) => void;
  onToolResult?: (toolId: string, result: unknown) => void;
}

/**
 * Stream completion with MCP tools support (direct API call)
 * Implements agentic loop: calls LLM -> executes tools -> calls LLM again until done
 */
export async function streamWithTools(
  options: StreamWithToolsOptions,
  callbacks: StreamWithToolsCallbacks,
  mcpService: McpToolProvider | undefined,
  llmConfig: ProviderConfigSource,
  getProvider: (providerId: string) => Promise<LLMProvider | null>,
  resolveApiKey: (apiKey: string) => string,
  logger: Logger,
  builtinExecutor?: BuiltinToolExecutor
): Promise<void> {
  try {
    // Resolve routing and provider
    const routedInfo = await llmConfig.resolveRoutedModel(
      options.providerId,
      options.model
    );
    const actualProviderId = routedInfo?.actualProviderId || options.providerId;
    const actualModel = routedInfo?.actualModelId || options.model;

    const provider = await getProvider(actualProviderId);
    if (!provider) {
      callbacks.onError?.(`Provider not found: ${actualProviderId}`);
      return;
    }

    if (!provider.enabled) {
      callbacks.onError?.(`Provider is disabled: ${provider.name}`);
      return;
    }

    const { apiKey: effectiveKey } = resolveProviderEndpoint(provider);
    const apiKey = resolveApiKey(effectiveKey);
    if (!apiKey) {
      callbacks.onError?.('API key not configured');
      return;
    }

    // Generate message ID
    const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    callbacks.onStart?.(messageId);

    // Agentic loop variables
    const globalParams = await llmConfig.getGlobalModelParameters();
    const MAX_ITERATIONS = globalParams.toolMaxTurns ?? 100;
    let iteration = 0;
    const conversationMessages: SimpleChatMessage[] = [...options.messages]; // Copy messages for iteration
    let finalContent = '';
    let finalReasoning = '';
    let finalUsageTokens: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;
    const blocks: MessageBlock[] = []; // Structured content blocks for multi-turn display

    // Log the complete request
    logger.info('Sending request to LLM with tools', {
      model: actualModel,
      providerId: actualProviderId,
      messagesCount: options.messages.length
    });

    // Determine tool format and log accordingly
    logToolFormat(options.tools, logger);

    // Determine API format
    const apiFormat = resolveApiFormat(provider);
    logger.info('API format determined', { apiFormat });

    // Start agentic loop
    while (iteration < MAX_ITERATIONS) {
      iteration++;
      logger.info('Agentic loop iteration', {
        iteration,
        maxIterations: MAX_ITERATIONS,
        messagesCount: conversationMessages.length
      });

      // Build request based on API format (no transformer needed)
      const { requestBody, url } = buildToolRequest(
        apiFormat,
        conversationMessages,
        actualModel,
        options,
        provider
      );

      // Apply native search augmentation if present
      if (options.nativeSearchAugmentation) {
        applyAugmentation(requestBody, options.nativeSearchAugmentation);
      }

      const headers = getProviderHeaders(provider, apiKey);

      logger.info('Sending tool call request', {
        url,
        headers,
        requestBody
      });

      // Make the request
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorText = await response.text();
        callbacks.onError?.(`API error (${response.status}): ${errorText}`);
        return;
      }

      // Process the stream (no transformer needed)
      const reader = response.body?.getReader();
      if (!reader) {
        callbacks.onError?.('No response body');
        return;
      }

      const decoder = new TextDecoder();
      let content = '';
      let reasoning = '';
      const toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
      const pendingOpenAIToolCalls: PendingOpenAIToolCalls = new Map();
      let buffer = ''; // Buffer for incomplete lines

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          logger.debug('Received raw chunk', { chunkLength: chunk.length });

          // Add to buffer and split by newlines
          buffer += chunk;
          const lines = buffer.split('\n');

          // Keep the last incomplete line in buffer
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine) continue;

            logger.debug('Processing line', { linePreview: trimmedLine.substring(0, 200) });

            if (trimmedLine.startsWith('data: ')) {
              const data = trimmedLine.slice(6);
              if (data === '[DONE]') {
                logger.debug('Stream done');
                continue;
              }

              try {
                const json = JSON.parse(data);
                logger.debug('Parsed JSON', { json });

                // Check for error response
                if (json.error) {
                  logger.error('API Error', undefined, { error: json.error });
                  callbacks.onError?.(`API Error: ${json.error.message || JSON.stringify(json.error)}`);
                  return;
                }

                // Parse based on API format and dispatch callbacks
                parseStreamChunk(json, apiFormat, callbacks, logger);

                // Update local variables from mutable state
                content = (content + extractDeltaContent(json, apiFormat));
                reasoning = (reasoning + extractDeltaReasoning(json, apiFormat));
                extractToolCalls(json, apiFormat, toolCalls, callbacks, logger, pendingOpenAIToolCalls);

                // Capture usage tokens (OpenAI format) — do NOT call onDone here,
                // it will be called once after the stream ends to avoid duplicate messages
                if (apiFormat !== 'google' && apiFormat !== 'anthropic' && json.usage) {
                  finalUsageTokens = {
                    promptTokens: json.usage.prompt_tokens || 0,
                    completionTokens: json.usage.completion_tokens || 0,
                    totalTokens: json.usage.total_tokens || 0
                  };
                }
              } catch (_e) {
                // Ignore parse errors
              }
            }
          }
        }

        // Finalize accumulated OpenAI streaming tool calls
        if (apiFormat !== 'google' && apiFormat !== 'anthropic') {
          finalizeOpenAIToolCalls(pendingOpenAIToolCalls, toolCalls, callbacks, logger);
          pendingOpenAIToolCalls.clear();
        }

        // Store content and reasoning for this iteration
        finalContent = content;
        finalReasoning = reasoning;

        // Build blocks for this iteration
        buildIterationBlocks(iteration, content, reasoning, blocks, callbacks);

        // Check if there are tool calls to execute
        // Filter out native search tool calls (executed server-side by the provider)
        const executableToolCalls = toolCalls.filter(
          tc => !NATIVE_SEARCH_TOOL_NAMES.includes(tc.name)
        );

        logger.info('Tool execution check', {
          toolCallsLength: toolCalls.length,
          executableToolCallsLength: executableToolCalls.length,
          hasMcpTools: !!options.mcpTools,
          mcpToolsLength: options.mcpTools?.length,
          hasMcpService: !!mcpService
        });

        if (executableToolCalls.length > 0 && options.mcpTools && (mcpService || builtinExecutor)) {
          logger.info('Executing tool calls', { count: executableToolCalls.length });

          // Add assistant message with tool calls to conversation
          conversationMessages.push({
            id: `assistant_${iteration}`,
            role: 'assistant',
            content: content || 'Calling tools...',
            timestamp: Date.now()
          });

          // Execute tools and collect results
          const toolResults = await executeToolCalls(
            executableToolCalls,
            options.mcpTools,
            mcpService,
            blocks,
            callbacks,
            logger,
            builtinExecutor
          );

          // Add tool results to conversation as user message
          const toolResultsText = toolResults.map(({ toolCall, result }) => {
            const resultText = typeof result === 'string'
              ? result
              : (result as { content?: Array<{ text?: string }> }).content?.[0]?.text || JSON.stringify(result);
            return `Tool ${toolCall.name} result:\n${resultText}`;
          }).join('\n\n');

          conversationMessages.push({
            id: `tool_results_${iteration}`,
            role: 'user',
            content: toolResultsText,
            timestamp: Date.now()
          });

          logger.info('Continuing to next iteration with tool results');
          // Continue to next iteration
          continue;
        } else {
          // No tool calls, we're done
          logger.info('No tool calls, finishing');
          break;
        }
      } catch (streamError) {
        logger.error('Stream processing error', streamError instanceof Error ? streamError : undefined);
        callbacks.onError?.(`Stream error: ${streamError instanceof Error ? streamError.message : 'Unknown error'}`);
        return;
      }
    } // End of while loop

    // Send final callback with accumulated content and blocks
    logger.info('Sending final callback', { blocksCount: blocks.length });
    callbacks.onDone?.({
      id: messageId,
      role: 'assistant',
      content: finalContent,
      timestamp: Date.now(),
      thinking: finalReasoning ? { content: finalReasoning } : undefined,
      blocks: blocks.length > 0 ? blocks : undefined
    }, finalUsageTokens);

  } catch (error) {
    logger.error('Error in streamWithTools', error instanceof Error ? error : undefined);
    const message = error instanceof Error ? error.message : 'Unknown error';
    callbacks.onError?.(message);
  }
}
