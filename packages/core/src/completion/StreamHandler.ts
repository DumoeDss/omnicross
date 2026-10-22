/**
 * StreamHandler - Handles SSE-based streaming completion for different API formats
 *
 * Extracted from CompletionService to handle stream-specific logic
 * for OpenAI, Anthropic, and Gemini providers.
 */

import type {
  AnthropicChatRequest,
  OpenAIChatRequest
} from '@omnicross/contracts/completion-types';
import type { LLMProvider } from '@omnicross/contracts/llm-config';
import { streamSSEResponse } from '@omnicross/core/sse-parser';

import type { Logger } from '../ports/logger';

import {
  buildProviderApiUrl,
  type CompletionOptions,
  convertMessageToAnthropic,
  convertMessageToOpenAI,
  getProviderHeaders,
  type StreamCallbacks
} from './';
import { applyAugmentation } from './NativeSearchInjector';
import {
  buildAnthropicReasoningWire,
  buildGeminiThinkingConfig,
  resolveOpenAIEffort,
  resolveCompletionModel,
} from './ReasoningRequestBuilder';
import { convertMessagesToGemini, convertMessagesToResponses } from './message-converter';

/**
 * Stream OpenAI-compatible completion
 * Uses streamSSEResponse utility for cleaner SSE parsing
 */
export async function streamOpenAICompletion(
  provider: LLMProvider,
  apiKey: string,
  options: CompletionOptions,
  messageId: string,
  callbacks: StreamCallbacks,
  logger: Logger
): Promise<void> {
  const redirected = resolveCompletionModel(provider, options);
  if (redirected) ({ provider, options } = redirected);
  const request: OpenAIChatRequest = {
    model: options.model,
    messages: options.messages.map(m => convertMessageToOpenAI(m)),
    // Only set max_tokens if explicitly provided, otherwise let API use its default
    ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
    temperature: options.temperature,
    stream: true,
    stream_options: { include_usage: true },
  };

  // Add reasoning_effort for OpenAI reasoning models (Chat Completions API format)
  const effort = resolveOpenAIEffort(provider, options, 'openai-chat');
  if (effort) {
    (request as unknown as Record<string, unknown>).reasoning_effort = effort;
  }

  const apiUrl = buildProviderApiUrl(provider, { model: options.model, stream: true });
  const headers = getProviderHeaders(provider, apiKey);

  // Apply native search augmentation if present
  if (options.nativeSearchAugmentation) {
    applyAugmentation(request as unknown as Record<string, unknown>, options.nativeSearchAugmentation);
  }

  // Log full request parameters for debugging
  logger.info('Streaming OpenAI completion request', {
    url: apiUrl,
    providerId: options.providerId,
    model: options.model,
    maxTokens: options.maxTokens,
    max_tokens_in_request: request.max_tokens,
    temperature: options.temperature,
    messagesCount: options.messages.length,
    hasNativeSearchAugmentation: !!options.nativeSearchAugmentation,
  });

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const errorText = await response.text();
    callbacks.onError?.(`API error (${response.status}): ${errorText}`);
    return;
  }

  // Use streamSSEResponse utility
  const result = await streamSSEResponse(response, 'openai', {
    onDelta: callbacks.onDelta,
    onReasoning: callbacks.onReasoning,
    onAudio: callbacks.onAudio,
    onVideo: callbacks.onVideo,
    onError: callbacks.onError,
  });
  if (result.error) return;

  // Call onDone with accumulated results
  callbacks.onDone?.(
    {
      id: messageId,
      role: 'assistant',
      content: result.content,
      timestamp: Date.now(),
      thinking: result.reasoning || result.thinkingBlocks?.length
        ? { content: result.reasoning, signature: result.thinkingSignature, blocks: result.thinkingBlocks } : undefined,
      toolCalls: result.toolCalls.length ? result.toolCalls : undefined,
      images: result.images.length ? result.images : undefined,
      audios: result.audios.length > 0 ? result.audios : undefined,
      videos: result.videos.length > 0 ? result.videos : undefined,
    },
    result.usage,
    result.metrics
  );
}

/**
 * Stream Anthropic (Claude Code) completion
 * Uses streamSSEResponse utility for cleaner SSE parsing
 */
export async function streamAnthropicCompletion(
  provider: LLMProvider,
  apiKey: string,
  options: CompletionOptions,
  messageId: string,
  callbacks: StreamCallbacks,
  logger: Logger
): Promise<void> {
  const redirected = resolveCompletionModel(provider, options);
  if (redirected) ({ provider, options } = redirected);
  const reasoningWire = buildAnthropicReasoningWire(provider, options);
  const system = options.messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const anthropicRequest: AnthropicChatRequest = {
    model: options.model,
    max_tokens: reasoningWire.effectiveMaxTokens,
    ...(reasoningWire.legacyBudgetEnabled ? {} : { temperature: options.temperature }),
    ...(system ? { system } : {}),
    messages: options.messages.filter(m => m.role !== 'system').map(convertMessageToAnthropic),
    stream: true,
    ...(reasoningWire.thinking ? { thinking: reasoningWire.thinking as AnthropicChatRequest['thinking'] } : {}),
  };
  if (reasoningWire.outputConfig) {
    (anthropicRequest as unknown as Record<string, unknown>).output_config = reasoningWire.outputConfig;
  }

  // Build the correct endpoint URL for Anthropic Messages API
  const apiUrl = buildProviderApiUrl(provider, { model: options.model, stream: true });
  const headers = getProviderHeaders(provider, apiKey);

  // Apply native search augmentation if present
  if (options.nativeSearchAugmentation) {
    applyAugmentation(anthropicRequest as unknown as Record<string, unknown>, options.nativeSearchAugmentation);
  }

  logger.info('Streaming Anthropic completion request', {
    url: apiUrl,
    model: anthropicRequest.model,
    messagesCount: (anthropicRequest.messages as unknown[])?.length,
    max_tokens: anthropicRequest.max_tokens,
    temperature: anthropicRequest.temperature,
    stream: anthropicRequest.stream,
    hasThinking: !!anthropicRequest.thinking,
    hasNativeSearchAugmentation: !!options.nativeSearchAugmentation,
  });

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(anthropicRequest),
  });

  logger.debug('Anthropic response status', { status: response.status });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error('Anthropic API error', undefined, { status: response.status, errorText });
    callbacks.onError?.(`API error (${response.status}): ${errorText}`);
    return;
  }

  // Use streamSSEResponse utility
  const result = await streamSSEResponse(response, 'anthropic', {
    onDelta: callbacks.onDelta,
    onReasoning: callbacks.onReasoning,
    onError: callbacks.onError,
    onBlock: callbacks.onBlock,
  });
  if (result.error) return;

  logger.info('Anthropic stream complete', {
    contentLength: result.content.length,
    reasoningLength: result.reasoning?.length || 0,
    blocksCount: result.blocks.length,
  });

  // Call onDone with accumulated results
  callbacks.onDone?.(
    {
      id: messageId,
      role: 'assistant',
      content: result.content,
      timestamp: Date.now(),
      thinking: result.reasoning ? { content: result.reasoning } : undefined,
      providerMetadata: result.providerMetadata,
      toolCalls: result.toolCalls.length ? result.toolCalls : undefined,
      blocks: result.blocks.length > 0 ? result.blocks : undefined,
    },
    result.usage,
    result.metrics
  );
}

/**
 * Stream Google Gemini completion
 * Uses Gemini's generateContent API with streaming (alt=sse)
 */
export async function streamGeminiCompletion(
  provider: LLMProvider,
  apiKey: string,
  options: CompletionOptions,
  messageId: string,
  callbacks: StreamCallbacks,
  logger: Logger
): Promise<void> {
  const redirected = resolveCompletionModel(provider, options);
  if (redirected) ({ provider, options } = redirected);
  const { contents, systemInstruction } = convertMessagesToGemini(options.messages);

  const thinkingConfig = buildGeminiThinkingConfig(provider, options);
  const request: Record<string, unknown> = {
    contents,
    generationConfig: {
      ...(options.maxTokens !== undefined ? { maxOutputTokens: options.maxTokens } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(thinkingConfig ? { thinkingConfig } : {}),
    },
  };

  if (systemInstruction) {
    request.systemInstruction = systemInstruction;
  }

  // Build streaming URL
  const apiUrl = buildProviderApiUrl(provider, { model: options.model, stream: true });
  const headers = getProviderHeaders(provider, apiKey);

  // Apply native search augmentation if present
  if (options.nativeSearchAugmentation) {
    applyAugmentation(request, options.nativeSearchAugmentation);
  }

  logger.info('Streaming Gemini completion request', {
    url: apiUrl,
    model: options.model,
    contentsCount: contents.length,
    hasSystemInstruction: !!systemInstruction,
    maxOutputTokens: options.maxTokens,
    temperature: options.temperature,
    hasNativeSearchAugmentation: !!options.nativeSearchAugmentation,
  });

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
  });

  logger.debug('Gemini response status', { status: response.status });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error('Gemini API error', undefined, { status: response.status, errorText });
    callbacks.onError?.(`API error (${response.status}): ${errorText}`);
    return;
  }

  // Use streamSSEResponse utility with 'gemini' format
  const result = await streamSSEResponse(response, 'gemini', {
    onDelta: callbacks.onDelta,
    onReasoning: callbacks.onReasoning,
    onError: callbacks.onError,
  });
  if (result.error) return;

  logger.info('Gemini stream complete', { contentLength: result.content.length });

  // Call onDone with accumulated results
  callbacks.onDone?.(
    {
      id: messageId,
      role: 'assistant',
      content: result.content,
      timestamp: Date.now(),
      thinking: result.reasoning ? { content: result.reasoning } : undefined,
      providerMetadata: result.providerMetadata,
      toolCalls: result.toolCalls.length ? result.toolCalls : undefined,
      images: result.images.length ? result.images : undefined,
    },
    result.usage,
    result.metrics
  );
}

/**
 * Stream OpenAI Responses API completion
 * Uses the /v1/responses endpoint with event-driven SSE format
 */
export async function streamOpenAIResponseCompletion(
  provider: LLMProvider,
  apiKey: string,
  options: CompletionOptions,
  messageId: string,
  callbacks: StreamCallbacks,
  logger: Logger
): Promise<void> {
  const redirected = resolveCompletionModel(provider, options);
  if (redirected) ({ provider, options } = redirected);
  // Convert messages to Response API input format
  const input = convertMessagesToResponses(options.messages);

  const request: Record<string, unknown> = {
    model: options.model,
    input,
    stream: true,
    ...(options.maxTokens !== undefined ? { max_output_tokens: options.maxTokens } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  };

  // Add reasoning effort for reasoning models (Response API format)
  const responseEffort = resolveOpenAIEffort(provider, options, 'openai-responses');
  if (responseEffort) {
    request.reasoning = { effort: responseEffort, summary: 'auto' };
  }

  const apiUrl = buildProviderApiUrl(provider, { model: options.model, stream: true });
  const headers = getProviderHeaders(provider, apiKey);
  if (options.nativeSearchAugmentation) applyAugmentation(request, options.nativeSearchAugmentation);

  logger.info('Streaming OpenAI Response API request', {
    url: apiUrl,
    providerId: options.providerId,
    model: options.model,
    maxOutputTokens: options.maxTokens,
    temperature: options.temperature,
    inputCount: input.length,
    reasoning: request.reasoning,
  });

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const errorText = await response.text();
    callbacks.onError?.(`API error (${response.status}): ${errorText}`);
    return;
  }

  // Use streamSSEResponse with 'openai-response' format
  const result = await streamSSEResponse(response, 'openai-response', {
    onDelta: callbacks.onDelta,
    onReasoning: callbacks.onReasoning,
    onError: callbacks.onError,
  });
  if (result.error) return;

  logger.info('OpenAI Response API stream complete', { contentLength: result.content.length });

  callbacks.onDone?.(
    {
      id: messageId,
      role: 'assistant',
      content: result.content,
      timestamp: Date.now(),
      thinking: result.reasoning ? { content: result.reasoning } : undefined,
      providerMetadata: result.providerMetadata,
      toolCalls: result.toolCalls.length ? result.toolCalls : undefined,
    },
    result.usage,
    result.metrics
  );
}
