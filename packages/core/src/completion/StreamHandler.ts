/**
 * StreamHandler - Handles SSE-based streaming completion for different API formats
 *
 * Extracted from CompletionService to handle stream-specific logic
 * for OpenAI, Anthropic, and Gemini providers.
 */

import type {
  AnthropicChatRequest,
  ConversionConfig,
  OpenAIChatRequest
} from '@omnicross/contracts/completion-types';
import type { LLMProvider } from '@omnicross/contracts/llm-config';
import { buildAnthropicThinking, getOpenAIReasoningEffort } from '@omnicross/contracts/thinking-config';
import { streamSSEResponse } from '@omnicross/core/sse-parser';

import { convertOpenAIToAnthropic } from '..';
import type { Logger } from '../ports/logger';

import {
  buildProviderApiUrl,
  type CompletionOptions,
  convertMessageToAnthropic,
  convertMessageToGemini,
  convertMessageToOpenAI,
  getProviderHeaders,
  type StreamCallbacks
} from './';
import { applyAugmentation } from './NativeSearchInjector';

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
  const request: OpenAIChatRequest = {
    model: options.model,
    messages: options.messages.map(m => convertMessageToOpenAI(m)),
    // Only set max_tokens if explicitly provided, otherwise let API use its default
    ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
    temperature: options.temperature,
    stream: true,
  };

  // Add reasoning_effort for OpenAI reasoning models (Chat Completions API format)
  if (options.thinkLevel && options.thinkLevel !== 'none') {
    const effort = getOpenAIReasoningEffort(options.thinkLevel);
    if (effort) {
      (request as unknown as Record<string, unknown>).reasoning_effort = effort;
    }
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

  // Call onDone with accumulated results
  callbacks.onDone?.(
    {
      id: messageId,
      role: 'assistant',
      content: result.content,
      timestamp: Date.now(),
      thinking: result.reasoning ? { content: result.reasoning } : undefined,
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
  // Check if any messages have images
  const hasImages = options.messages.some(m => m.images && m.images.length > 0);

  // For extended thinking, Anthropic has specific constraints:
  // - max_tokens sets the combined limit for thinking + output
  // - budget_tokens must be less than max_tokens
  // - Some proxies have lower limits than official Anthropic API
  // Cap max_tokens first, then calculate thinking budget based on that
  const MAX_TOKENS_FOR_THINKING = 16384; // Safe limit for most proxies
  let effectiveMaxTokens = options.maxTokens || 16384;

  // Build thinking configuration if thinkLevel is set
  // Use the capped max_tokens for budget calculation
  const thinkingMaxTokens = options.thinkLevel && options.thinkLevel !== 'none'
    ? Math.min(effectiveMaxTokens, MAX_TOKENS_FOR_THINKING)
    : effectiveMaxTokens;

  const thinkingConfig = options.thinkLevel && options.thinkLevel !== 'none'
    ? buildAnthropicThinking(options.model, options.thinkLevel, thinkingMaxTokens)
    : undefined;

  // When thinking is enabled, use the capped max_tokens
  if (thinkingConfig) {
    effectiveMaxTokens = thinkingMaxTokens;
  }

  logger.debug('Anthropic thinking configuration', {
    thinkLevel: options.thinkLevel,
    thinkingConfig,
    effectiveMaxTokens
  });

  let anthropicRequest: AnthropicChatRequest;

  if (hasImages) {
    // Build Anthropic request directly with image support
    const systemMessages = options.messages.filter(m => m.role === 'system');
    const nonSystemMessages = options.messages.filter(m => m.role !== 'system');

    anthropicRequest = {
      model: options.model,
      max_tokens: effectiveMaxTokens,
      // Omit temperature when thinking is enabled (Anthropic will use default temperature=1)
      ...(thinkingConfig ? {} : { temperature: options.temperature }),
      ...(systemMessages.length > 0 ? { system: systemMessages.map(m => m.content).join('\n\n') } : {}),
      messages: nonSystemMessages.map(m => convertMessageToAnthropic(m)),
      stream: true,
      ...(thinkingConfig ? { thinking: thinkingConfig } : {}),
    };
  } else {
    // Original flow for text-only messages
    // Convert to Anthropic format
    const config: ConversionConfig = {
      defaultModel: options.model,
    };

    const openaiRequest: OpenAIChatRequest = {
      model: options.model,
      messages: options.messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
      // Anthropic requires max_tokens; use adjusted value
      max_tokens: effectiveMaxTokens,
      // Omit temperature when thinking is enabled (Anthropic will use default temperature=1)
      temperature: thinkingConfig ? undefined : options.temperature,
      stream: true,
    };

    anthropicRequest = convertOpenAIToAnthropic(openaiRequest, config);
    // Add thinking config after conversion
    if (thinkingConfig) {
      anthropicRequest.thinking = thinkingConfig;
      // Remove temperature if it was set during conversion
      delete anthropicRequest.temperature;
    }
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
    hasImages,
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
  // Build Gemini request format
  // Convert messages to Gemini contents format
  const contents: Array<{ role: string; parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> }> = [];
  let systemInstruction: { parts: Array<{ text: string }> } | undefined;

  for (const msg of options.messages) {
    if (msg.role === 'system') {
      // Gemini uses systemInstruction for system messages
      systemInstruction = { parts: [{ text: msg.content }] };
    } else {
      // Use convertMessageToGemini for proper image handling
      contents.push(convertMessageToGemini(msg));
    }
  }

  const request: Record<string, unknown> = {
    contents,
    generationConfig: {
      ...(options.maxTokens ? { maxOutputTokens: options.maxTokens } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
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

  logger.info('Gemini stream complete', { contentLength: result.content.length });

  // Call onDone with accumulated results
  callbacks.onDone?.(
    {
      id: messageId,
      role: 'assistant',
      content: result.content,
      timestamp: Date.now(),
      thinking: result.reasoning ? { content: result.reasoning } : undefined,
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
  // Convert messages to Response API input format
  const input: Array<Record<string, unknown>> = [];
  for (const msg of options.messages) {
    if (msg.role === 'system') {
      // system → developer role in Response API
      input.push({ role: 'developer', content: msg.content });
    } else {
      input.push({ role: msg.role, content: msg.content });
    }
  }

  const request: Record<string, unknown> = {
    model: options.model,
    input,
    stream: true,
    ...(options.maxTokens ? { max_output_tokens: options.maxTokens } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  };

  // Add reasoning effort for reasoning models (Response API format)
  if (options.thinkLevel && options.thinkLevel !== 'none') {
    const effort = getOpenAIReasoningEffort(options.thinkLevel);
    if (effort) {
      request.reasoning = { effort, summary: 'auto' };
    }
  }

  const apiUrl = buildProviderApiUrl(provider, { model: options.model, stream: true });
  const headers = getProviderHeaders(provider, apiKey);

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

  logger.info('OpenAI Response API stream complete', { contentLength: result.content.length });

  callbacks.onDone?.(
    {
      id: messageId,
      role: 'assistant',
      content: result.content,
      timestamp: Date.now(),
      thinking: result.reasoning ? { content: result.reasoning } : undefined,
    },
    result.usage,
    result.metrics
  );
}
