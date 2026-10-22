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
import { streamSSEResponse } from '../sse-parser';
import type { AnthropicTool, GeminiTools, McpToolProvider, OpenAITool } from '../tool-types';

import {
  type CompletionOptions,
  getProviderHeaders,
  resolveApiFormat,
  type StreamCallbacks
} from './';
import type { BuiltinToolExecutor } from './BuiltinToolExecutor';
import { applyAugmentation } from './NativeSearchInjector';
import {
  buildIterationBlocks,
  buildToolRequest,
  executeToolCalls,
  logToolFormat,
} from './ToolExecutor';
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
    let finalMetadata: SimpleChatMessage['providerMetadata'];
    let finalImages: SimpleChatMessage['images'];
    let finalAudios: SimpleChatMessage['audios'];
    let finalVideos: SimpleChatMessage['videos'];
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

      const format = apiFormat === 'google' ? 'gemini'
        : apiFormat === 'anthropic' ? 'anthropic'
        : apiFormat === 'openai-response' ? 'openai-response' : 'openai';
      const result = await streamSSEResponse(response, format, {
        onDelta: callbacks.onDelta, onReasoning: callbacks.onReasoning,
        onError: callbacks.onError, onBlock: callbacks.onBlock,
        onAudio: callbacks.onAudio, onVideo: callbacks.onVideo,
      });
      if (result.error) return;
      const { content, reasoning, toolCalls } = result;
      for (const call of toolCalls) callbacks.onToolCall?.(call);
      if (result.usage) {
        finalUsageTokens = {
          promptTokens: (finalUsageTokens?.promptTokens ?? 0) + result.usage.promptTokens,
          completionTokens: (finalUsageTokens?.completionTokens ?? 0) + result.usage.completionTokens,
          totalTokens: (finalUsageTokens?.totalTokens ?? 0) + result.usage.totalTokens,
        };
      }

      try {

        // Store content and reasoning for this iteration
        finalContent = content;
        finalReasoning = reasoning;
        finalMetadata = result.providerMetadata;
        finalImages = result.images.length ? result.images : undefined;
        finalAudios = result.audios.length ? result.audios : undefined;
        finalVideos = result.videos.length ? result.videos : undefined;

        // Build blocks for this iteration
        buildIterationBlocks(iteration, content, reasoning, blocks, callbacks);

        const executableToolCalls = toolCalls;

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
            content,
            thinking: reasoning ? { content: reasoning } : undefined,
            toolCalls: executableToolCalls,
            providerMetadata: result.providerMetadata,
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

          for (const { toolCall, result: toolResult } of toolResults) {
            const structuredResult = toolResult as { isError?: boolean; content?: Array<Record<string, unknown>> };
            const isError = structuredResult?.isError === true;
            const resultParts = structuredResult?.content;
            const hasMedia = resultParts?.some(part => part.type !== 'text');
            if (hasMedia && apiFormat !== 'anthropic') {
              throw new Error(`Cannot encode multimodal tool results for ${apiFormat}`);
            }
            const resultText = resultParts?.every(part => part.type === 'text')
              ? resultParts.map(part => String(part.text ?? '')).join('\n')
              : typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
            const nativeCall = result.providerMetadata?.apiFormat === 'google'
              ? result.providerMetadata.content.filter(part => part.functionCall)[toolCalls.indexOf(toolCall)]?.functionCall as { id?: string } | undefined
              : undefined;
            conversationMessages.push({
              id: `tool_result_${toolCall.id}`, role: 'tool', content: resultText,
              name: toolCall.name, toolCallId: toolCall.id, timestamp: Date.now(),
              isError,
              ...(apiFormat === 'anthropic' && resultParts ? { providerMetadata: {
                apiFormat: 'anthropic' as const,
                content: [{ type: 'tool_result', tool_use_id: toolCall.id, is_error: isError,
                  content: resultParts.map(part => {
                    if (part.type === 'text') return { type: 'text', text: part.text };
                    if (part.type === 'image') return {
                      type: 'image', source: { type: 'base64', media_type: part.mimeType, data: part.data },
                    };
                    throw new Error(`Unsupported tool result content: ${String(part.type)}`);
                  }),
                }],
              } } : {}),
              ...(apiFormat === 'google' ? { providerMetadata: {
                apiFormat: 'google' as const, content: [{ functionResponse: {
                  ...(nativeCall?.id ? { id: nativeCall.id } : {}),
                  name: toolCall.name, response: isError ? { error: toolResult } : { result: toolResult },
                } }],
              } } : {}),
            });
          }
          if (iteration === MAX_ITERATIONS) {
            callbacks.onError?.(`Tool iteration limit reached (${MAX_ITERATIONS})`);
            return;
          }

          logger.info('Continuing to next iteration with tool results');
          // Continue to next iteration
          continue;
        } else {
          if (executableToolCalls.length) {
            callbacks.onError?.('Tool calls received but no tool executor is available');
            return;
          }
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
      providerMetadata: finalMetadata,
      images: finalImages, audios: finalAudios, videos: finalVideos,
      blocks: blocks.length > 0 ? blocks : undefined
    }, finalUsageTokens);

  } catch (error) {
    logger.error('Error in streamWithTools', error instanceof Error ? error : undefined);
    const message = error instanceof Error ? error.message : 'Unknown error';
    callbacks.onError?.(message);
  }
}
