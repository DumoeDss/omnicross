/**
 * DirectApiHandler - Handles non-streaming (direct) completion API calls
 *
 * Extracted from CompletionService to handle direct (non-streaming)
 * API calls for OpenAI, Anthropic, and Gemini providers.
 */

import type {
  AnthropicChatResponse,
  ConversionConfig,
  OpenAIChatRequest,
  OpenAIChatResponse
} from '@omnicross/contracts/completion-types';
import type { LLMProvider } from '@omnicross/contracts/llm-config';
import { getOpenAIReasoningEffort } from '@omnicross/contracts/thinking-config';

import { convertAnthropicToOpenAI, convertOpenAIToAnthropic } from '..';
import type { Logger } from '../ports/logger';

import {
  buildProviderApiUrl,
  type CompletionOptions,
  type CompletionResult,
  convertMessageToAnthropic,
  convertMessageToGemini,
  convertMessageToOpenAI,
  getProviderHeaders
} from './';

/**
 * Call OpenAI-compatible completion API
 */
export async function callOpenAICompletion(
  provider: LLMProvider,
  apiKey: string,
  options: CompletionOptions,
  logger: Logger
): Promise<CompletionResult> {
  const request: OpenAIChatRequest = {
    model: options.model,
    messages: options.messages.map(m => convertMessageToOpenAI(m)),
    // Only set max_tokens if explicitly provided, otherwise let API use its default
    ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
    temperature: options.temperature,
    stream: false, // For now, non-streaming only
  };

  // Add reasoning_effort for OpenAI reasoning models (Chat Completions API format)
  if (options.thinkLevel && options.thinkLevel !== 'none') {
    const effort = getOpenAIReasoningEffort(options.thinkLevel);
    if (effort) {
      (request as unknown as Record<string, unknown>).reasoning_effort = effort;
    }
  }

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
  const choice = data.choices[0];

  return {
    success: true,
    message: {
      id: `msg_${Date.now()}`,
      role: 'assistant',
      content: choice.message.content || '',
      timestamp: Date.now(),
      thinking: data.reasoning_content ? { content: data.reasoning_content } : undefined,
    },
    usage: {
      promptTokens: data.usage.prompt_tokens,
      completionTokens: data.usage.completion_tokens,
      totalTokens: data.usage.total_tokens,
    },
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
  // Check if any messages have images
  const hasImages = options.messages.some(m => m.images && m.images.length > 0);

  if (hasImages) {
    // Build Anthropic request directly with image support
    const systemMessages = options.messages.filter(m => m.role === 'system');
    const nonSystemMessages = options.messages.filter(m => m.role !== 'system');

    const anthropicRequest = {
      model: options.model,
      max_tokens: options.maxTokens || 16384,
      temperature: options.temperature,
      ...(systemMessages.length > 0 ? { system: systemMessages.map(m => m.content).join('\n\n') } : {}),
      messages: nonSystemMessages.map(m => convertMessageToAnthropic(m)),
      stream: false,
    };

    const apiUrl = buildProviderApiUrl(provider, { model: options.model, stream: false });
    const headers = getProviderHeaders(provider, apiKey);

    logger.info('Calling Anthropic completion API with images', { url: apiUrl, model: options.model });

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(anthropicRequest),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        error: `API error (${response.status}): ${errorText}`,
      };
    }

    const anthropicResponse = await response.json() as AnthropicChatResponse;
    const openaiResponse = convertAnthropicToOpenAI(anthropicResponse);
    const choice = openaiResponse.choices[0];

    return {
      success: true,
      message: {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: choice.message?.content || '',
        timestamp: Date.now(),
      },
      usage: openaiResponse.usage ? {
        promptTokens: openaiResponse.usage.prompt_tokens,
        completionTokens: openaiResponse.usage.completion_tokens,
        totalTokens: openaiResponse.usage.total_tokens,
      } : undefined,
    };
  }

  // Original flow for text-only messages
  // Convert simple messages to OpenAI format first
  const openaiRequest: OpenAIChatRequest = {
    model: options.model,
    messages: options.messages.map(m => ({
      role: m.role,
      content: m.content,
    })),
    // Anthropic requires max_tokens; use 16384 default if not explicitly set
    max_tokens: options.maxTokens || 16384,
    temperature: options.temperature,
    stream: false,
  };

  // Convert to Anthropic format
  const config: ConversionConfig = {
    defaultModel: options.model,
  };
  const anthropicRequest = convertOpenAIToAnthropic(openaiRequest, config);

  // Build the correct endpoint URL for Anthropic Messages API
  const apiUrl = buildProviderApiUrl(provider, { model: options.model, stream: false });
  const headers = getProviderHeaders(provider, apiKey);

  logger.info('Calling Anthropic completion API', { url: apiUrl, model: options.model });

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(anthropicRequest),
  });

  if (!response.ok) {
    const errorText = await response.text();
    return {
      success: false,
      error: `API error (${response.status}): ${errorText}`,
    };
  }

  const anthropicResponse = await response.json() as AnthropicChatResponse;

  // Convert back to OpenAI format
  const openaiResponse = convertAnthropicToOpenAI(anthropicResponse);
  const choice = openaiResponse.choices[0];

  return {
    success: true,
    message: {
      id: `msg_${Date.now()}`,
      role: 'assistant',
      content: choice.message.content || '',
      timestamp: Date.now(),
      thinking: openaiResponse.reasoning_content ? { content: openaiResponse.reasoning_content } : undefined,
    },
    usage: {
      promptTokens: openaiResponse.usage.prompt_tokens,
      completionTokens: openaiResponse.usage.completion_tokens,
      totalTokens: openaiResponse.usage.total_tokens,
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

  // Build non-streaming URL
  const apiUrl = buildProviderApiUrl(provider, { model: options.model, stream: false });
  const headers = getProviderHeaders(provider, apiKey);

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
  const content = candidate.content;
  let textContent = '';

  if (content?.parts) {
    for (const part of content.parts) {
      if (part.text) {
        textContent += part.text;
      }
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
    },
    usage: usage ? {
      promptTokens: usage.promptTokenCount || 0,
      completionTokens: usage.candidatesTokenCount || 0,
      totalTokens: usage.totalTokenCount || 0,
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
  // Convert messages to Response API input format
  const input: Array<Record<string, unknown>> = [];
  for (const msg of options.messages) {
    if (msg.role === 'system') {
      input.push({ role: 'developer', content: msg.content });
    } else {
      input.push({ role: msg.role, content: msg.content });
    }
  }

  const request: Record<string, unknown> = {
    model: options.model,
    input,
    stream: false,
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

  const apiUrl = buildProviderApiUrl(provider, { model: options.model, stream: false });
  const headers = getProviderHeaders(provider, apiKey);

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

  // Extract text from response output
  let textContent = '';
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
    },
    usage: usage ? {
      promptTokens: usage.input_tokens || 0,
      completionTokens: usage.output_tokens || 0,
      totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
    } : undefined,
  };
}
