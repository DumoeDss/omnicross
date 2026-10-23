/**
 * DirectApiHandler - Handles non-streaming (direct) completion API calls
 *
 * Extracted from CompletionService to handle direct (non-streaming)
 * API calls for OpenAI, Anthropic, and Gemini providers.
 */

import type {
  AnthropicChatResponse,
  OpenAIChatRequest,
  OpenAIChatResponse
} from '@omnicross/contracts/completion-types';
import type { LLMProvider } from '@omnicross/contracts/llm-config';

import type { Logger } from '../ports/logger';
import { applyOpenAIChatReasoning } from '../reasoning/openai-chat-wire';

import {
  buildProviderApiUrl,
  convertMessageToAnthropic,
  convertMessageToOpenAI,
  getProviderHeaders
} from './';
import type { CompletionOptions, CompletionResult } from './';
import {
  buildAnthropicReasoningWire,
  buildGeminiThinkingConfig,
  resolveCompletionModel,
  resolveCompletionReasoningPlan,
  resolveOpenAIResponsesEffort,
} from './ReasoningRequestBuilder';
import { convertMessagesToGemini, convertMessagesToResponses } from './message-converter';
import { applyAugmentation } from './NativeSearchInjector';

/**
 * Call OpenAI-compatible completion API
 */
export async function callOpenAICompletion(
  provider: LLMProvider,
  apiKey: string,
  options: CompletionOptions,
  logger: Logger
): Promise<CompletionResult> {
  const redirected = resolveCompletionModel(provider, options);
  if (redirected) ({ provider, options } = redirected);
  const request: OpenAIChatRequest = {
    model: options.model,
    messages: options.messages.map(m => convertMessageToOpenAI(m)),
    // Only set max_tokens if explicitly provided, otherwise let API use its default
    ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
    temperature: options.temperature,
    stream: false, // For now, non-streaming only
  };

  applyOpenAIChatReasoning(
    request as unknown as Record<string, unknown>,
    resolveCompletionReasoningPlan(provider, options, 'openai-chat'),
    provider,
    options.model,
  );

  if (options.nativeSearchAugmentation) applyAugmentation(request as unknown as Record<string, unknown>, options.nativeSearchAugmentation);
  const apiUrl = buildProviderApiUrl(provider, { model: options.model, stream: false });
  const headers = getProviderHeaders(provider, apiKey);

  logger.info('Calling OpenAI completion API', { url: apiUrl, model: options.model });

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const errorText = await response.text();
    return {
      success: false,
      error: `API error (${response.status}): ${errorText}`,
    };
  }

  const data = await response.json() as OpenAIChatResponse;
  const choice = data.choices?.[0];
  if (!choice) return { success: false, error: 'No choices in response' };

  return {
    success: true,
    message: {
      id: `msg_${Date.now()}`,
      role: 'assistant',
      content: choice.message.content || '',
      timestamp: Date.now(),
      thinking: (choice.message.reasoning_content || choice.message.thinking || data.reasoning_content)
        ? { ...choice.message.thinking, content: choice.message.reasoning_content ?? choice.message.thinking?.content ?? data.reasoning_content ?? '' } : undefined,
      toolCalls: choice.message.tool_calls?.map(tc => ({
        id: tc.id, name: tc.function.name, args: JSON.parse(tc.function.arguments),
      })),
    },
    finishReason: choice.finish_reason,
    usage: data.usage ? {
      promptTokens: data.usage.prompt_tokens,
      completionTokens: data.usage.completion_tokens,
      totalTokens: data.usage.total_tokens,
    } : undefined,
  };
}

/**
 * Call Anthropic Messages API (Claude Code format)
 */
export async function callAnthropicCompletion(
  provider: LLMProvider,
  apiKey: string,
  options: CompletionOptions,
  logger: Logger
): Promise<CompletionResult> {
  const redirected = resolveCompletionModel(provider, options);
  if (redirected) ({ provider, options } = redirected);
  const reasoningWire = buildAnthropicReasoningWire(provider, options);
  const system = options.messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const request = {
    model: options.model,
    max_tokens: reasoningWire.effectiveMaxTokens,
    ...(reasoningWire.legacyBudgetEnabled ? {} : { temperature: options.temperature }),
    ...(system ? { system } : {}),
    messages: options.messages.filter(m => m.role !== 'system').map(convertMessageToAnthropic),
    stream: false,
    ...(reasoningWire.thinking ? { thinking: reasoningWire.thinking } : {}),
    ...(reasoningWire.outputConfig ? { output_config: reasoningWire.outputConfig } : {}),
  };
  if (options.nativeSearchAugmentation) applyAugmentation(request, options.nativeSearchAugmentation);
  const url = buildProviderApiUrl(provider, { model: options.model, stream: false });
  logger.info('Calling Anthropic completion API', { url, model: options.model });
  const response = await fetch(url, {
    method: 'POST', headers: getProviderHeaders(provider, apiKey), body: JSON.stringify(request),
  });
  if (!response.ok) return { success: false, error: `API error (${response.status}): ${await response.text()}` };
  const native = await response.json() as AnthropicChatResponse;
  let content = '';
  let reasoning = '';
  const toolCalls: NonNullable<NonNullable<CompletionResult['message']>['toolCalls']> = [];
  for (const block of native.content) {
    if (block.type === 'text') content += block.text;
    else if (block.type === 'thinking') reasoning += block.thinking;
    else if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, args: block.input });
  }
  const promptTokens = native.usage.input_tokens + (native.usage.cache_read_input_tokens ?? 0) + (native.usage.cache_creation_input_tokens ?? 0);
  return {
    success: true,
    message: {
      id: native.id, role: 'assistant', content, timestamp: Date.now(),
      thinking: reasoning ? { content: reasoning } : undefined,
      providerMetadata: { apiFormat: 'anthropic', content: native.content as unknown as Record<string, unknown>[] },
      toolCalls: toolCalls.length ? toolCalls : undefined,
    },
    finishReason: native.stop_reason,
    usage: {
      promptTokens,
      completionTokens: native.usage.output_tokens,
      totalTokens: promptTokens + native.usage.output_tokens,
    },
  };
}

/**
 * Call Google Gemini API
 * Uses Gemini's generateContent API (non-streaming)
 */
export async function callGeminiCompletion(
  provider: LLMProvider,
  apiKey: string,
  options: CompletionOptions,
  logger: Logger
): Promise<CompletionResult> {
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

  // Build non-streaming URL
  const apiUrl = buildProviderApiUrl(provider, { model: options.model, stream: false });
  const headers = getProviderHeaders(provider, apiKey);
  if (options.nativeSearchAugmentation) applyAugmentation(request, options.nativeSearchAugmentation);

  logger.info('Calling Gemini completion API', { url: apiUrl, model: options.model });

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const errorText = await response.text();
    return {
      success: false,
      error: `API error (${response.status}): ${errorText}`,
    };
  }

  const data = await response.json();

  // Extract content from Gemini response
  const candidates = data.candidates;
  if (!candidates || candidates.length === 0) {
    return {
      success: false,
      error: 'No candidates in response',
    };
  }

  const candidate = candidates[0];
  if (candidate.finishReason && candidate.finishReason !== 'STOP' && candidate.finishReason !== 'MAX_TOKENS') {
    return { success: false, error: `Gemini generation stopped: ${candidate.finishReason}` };
  }
  const content = candidate.content;
  let textContent = '';
  let reasoning = '';

  if (content?.parts) {
    for (const part of content.parts) {
      if (part.thought === true && part.text) reasoning += part.text;
      else if (part.text) textContent += part.text;
    }
  }

  // Extract usage
  const usage = data.usageMetadata;

  return {
    success: true,
    message: {
      id: `msg_${Date.now()}`,
      role: 'assistant',
      content: textContent,
      timestamp: Date.now(),
      thinking: reasoning ? { content: reasoning } : undefined,
      providerMetadata: { apiFormat: 'google', content: content?.parts ?? [] },
      images: content?.parts?.filter((part: { inlineData?: { mimeType?: string; data?: string } }) => part.inlineData?.mimeType?.startsWith('image/') && part.inlineData.data)
        .map((part: { inlineData: { mimeType: string; data: string } }) => ({ mimeType: part.inlineData.mimeType, url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}` })),
    },
    usage: usage ? {
      promptTokens: usage.promptTokenCount || 0,
      completionTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
      totalTokens: usage.totalTokenCount ?? ((usage.promptTokenCount ?? 0) + (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0)),
    } : undefined,
  };
}

/**
 * Call OpenAI Responses API (non-streaming)
 * Uses the /v1/responses endpoint
 */
export async function callOpenAIResponseCompletion(
  provider: LLMProvider,
  apiKey: string,
  options: CompletionOptions,
  logger: Logger
): Promise<CompletionResult> {
  const redirected = resolveCompletionModel(provider, options);
  if (redirected) ({ provider, options } = redirected);
  // Convert messages to Response API input format
  const input = convertMessagesToResponses(options.messages);

  const request: Record<string, unknown> = {
    model: options.model,
    input,
    stream: false,
    ...(options.maxTokens !== undefined ? { max_output_tokens: options.maxTokens } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  };

  // Add reasoning effort for reasoning models (Response API format)
  const responseEffort = resolveOpenAIResponsesEffort(provider, options);
  if (responseEffort) {
    request.reasoning = responseEffort === 'none'
      ? { effort: responseEffort }
      : { effort: responseEffort, summary: 'auto' };
  }

  const apiUrl = buildProviderApiUrl(provider, { model: options.model, stream: false });
  const headers = getProviderHeaders(provider, apiKey);
  if (options.nativeSearchAugmentation) applyAugmentation(request, options.nativeSearchAugmentation);

  logger.info('Calling OpenAI Response API', { url: apiUrl, model: options.model });

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const errorText = await response.text();
    return {
      success: false,
      error: `API error (${response.status}): ${errorText}`,
    };
  }

  const data = await response.json() as Record<string, unknown>;
  if (data.error || data.status === 'failed') {
    return { success: false, error: JSON.stringify(data.error ?? 'Response failed') };
  }

  // Extract text from response output
  let textContent = '';
  let reasoning = '';
  const toolCalls: NonNullable<NonNullable<CompletionResult['message']>['toolCalls']> = [];
  const output = data.output as Array<Record<string, unknown>> | undefined;
  if (output) {
    for (const item of output) {
      if (item.type === 'message') {
        const content = item.content as Array<Record<string, unknown>> | undefined;
        if (content) {
          for (const part of content) {
            if (part.type === 'output_text' && typeof part.text === 'string') {
              textContent += part.text;
            }
          }
        }
      }
      if (item.type === 'reasoning') {
        for (const part of (item.summary ?? []) as Array<{ text?: string }>) reasoning += part.text ?? '';
      }
      if (item.type === 'function_call') {
        toolCalls.push({ id: String(item.call_id), name: String(item.name), args: JSON.parse(String(item.arguments || '{}')) });
      }
    }
  }

  // Extract usage
  const usage = data.usage as Record<string, number> | undefined;

  return {
    success: true,
    message: {
      id: `msg_${Date.now()}`,
      role: 'assistant',
      content: textContent,
      timestamp: Date.now(),
      thinking: reasoning ? { content: reasoning } : undefined,
      providerMetadata: { apiFormat: 'openai-response', content: output ?? [] },
      toolCalls: toolCalls.length ? toolCalls : undefined,
    },
    usage: usage ? {
      promptTokens: usage.input_tokens || 0,
      completionTokens: usage.output_tokens || 0,
      totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
    } : undefined,
  };
}
