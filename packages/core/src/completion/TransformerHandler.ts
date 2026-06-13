/**
 * TransformerHandler - Handles completion requests using transformer chains
 *
 * Extracted from CompletionService to isolate transformer chain-based
 * request/response transformation logic.
 *
 * Input is always unified (OpenAI) format. The mainTransformer is added to
 * providerTransformers (not used as endpointTransformer) because no endpoint
 * decoding is needed — the same pattern as the host engine adapters.
 */

import type { LLMProvider } from '@omnicross/contracts/llm-config';

import { isOpenRouterProvider, OPENROUTER_APP_HEADERS } from '../openrouter';
import { executeProviderCall } from '../pipeline/executeProviderCall';
import { resolveProviderChain } from '../pipeline/resolveProviderChain';
import type { UsageSink } from '../ports/index';
import type { Logger } from '../ports/logger';
import type { ProviderConfigSource } from '../ports/provider-config-source';
import {
  type LLMProvider as TransformerLLMProvider,
  TransformerChainExecutor,
  type UnifiedChatRequest
} from '../transformer';

import {
  addOpenRouterProviderToRequest,
  buildProviderApiUrl,
  type CompletionOptions,
  type CompletionResult,
  type StreamCallbacks
} from './';
import { getProviderHeaders } from './header-builder';
import { resolveProviderEndpoint } from './url-builder';

/** Extra context passed to the transformer-handler functions for usage recording. */
export interface TransformerHandlerRecordingContext {
  recorder: UsageSink;
  /** The api-key-pool entry id selected for this request, if any. */
  apiKeyId?: string;
}

/** Extract usage tokens from an OpenAI-compat `data.usage` object (handles cache fields). */
function readUsageFromOpenAIResponse(usage: Record<string, unknown> | undefined): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
} | null {
  if (!usage) return null;
  const promptTokens = Number(usage.prompt_tokens) || 0;
  const completionTokens = Number(usage.completion_tokens) || 0;
  // OpenAI standard: cached input tokens nested under prompt_tokens_details.
  const promptDetails = (usage.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const cachedTokens =
    Number(promptDetails.cached_tokens) ||
    Number(usage.cache_read_input_tokens) ||
    0;
  const cacheCreation = Number(usage.cache_creation_input_tokens) || 0;
  // Anthropic puts cache fields at top-level; subtract from prompt to avoid double-counting.
  const inputTokens = Math.max(0, promptTokens - cachedTokens - cacheCreation);
  const reasoningDetails = (usage.completion_tokens_details ??
    usage.output_tokens_details ??
    {}) as Record<string, unknown>;
  const reasoningTokens = Number(reasoningDetails.reasoning_tokens) || 0;
  return {
    inputTokens,
    outputTokens: completionTokens,
    cacheReadTokens: cachedTokens,
    cacheCreationTokens: cacheCreation,
    reasoningTokens,
  };
}

// Singleton TransformerChainExecutor (stateless, can be reused)
let sharedExecutor: TransformerChainExecutor | null = null;

function getSharedExecutor(): TransformerChainExecutor {
  if (!sharedExecutor) {
    sharedExecutor = new TransformerChainExecutor();
  }
  return sharedExecutor;
}

/**
 * Resolve the transformer chain with mainTransformer merged into providerTransformers.
 * Delegates to the shared `resolveProviderChain` helper (pipeline module, Phase 0).
 */
async function resolveChainWithMain(
  llmConfig: ProviderConfigSource,
  providerId: string,
  model: string
): Promise<{
  chain: { providerTransformers: Awaited<ReturnType<ProviderConfigSource['resolveTransformerChain']>>['providerTransformers']; modelTransformers: Awaited<ReturnType<ProviderConfigSource['resolveTransformerChain']>>['modelTransformers'] };
  hasTransformers: boolean;
}> {
  return resolveProviderChain(llmConfig, providerId, model);
}

/**
 * Send a completion request using transformer chain.
 * This method uses the provider's configured transformers for request/response transformation.
 */
export async function completeWithTransformers(
  options: CompletionOptions,
  llmConfig: ProviderConfigSource,
  getProvider: (providerId: string) => Promise<LLMProvider | null>,
  resolveApiKey: (apiKey: string) => string,
  completeFallback: (options: CompletionOptions) => Promise<CompletionResult>,
  logger: Logger,
  recording?: TransformerHandlerRecordingContext,
): Promise<CompletionResult> {
  try {
    // Check if this is a routed model (Code->Chat router)
    const routedInfo = await llmConfig.resolveRoutedModel(
      options.providerId,
      options.model
    );

    // Resolve the actual provider and model
    const actualProviderId = routedInfo?.actualProviderId || options.providerId;
    const actualModel = routedInfo?.actualModelId || options.model;

    const provider = await getProvider(actualProviderId);
    if (!provider) {
      return { success: false, error: `Provider not found: ${actualProviderId}` };
    }

    if (!provider.enabled) {
      return { success: false, error: `Provider is disabled: ${provider.name}` };
    }

    const { apiKey: effectiveKey } = resolveProviderEndpoint(provider);
    const apiKey = resolveApiKey(effectiveKey);
    if (!apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    // Resolve chain with mainTransformer merged into providerTransformers
    const { chain, hasTransformers } = await resolveChainWithMain(
      llmConfig, actualProviderId, actualModel
    );

    // If no transformers configured, use legacy path
    if (!hasTransformers) {
      return completeFallback(options);
    }

    // Build unified request (using actual model ID)
    const unifiedRequest: UnifiedChatRequest = {
      model: actualModel,
      messages: options.messages.map(m => ({
        role: m.role as 'user' | 'assistant' | 'system' | 'tool',
        content: m.content
      })),
      max_tokens: options.maxTokens || 4096,
      temperature: options.temperature,
      stream: options.stream ?? false
    };

    // Convert provider to transformer LLMProvider format
    const transformerProvider: TransformerLLMProvider = {
      name: provider.name,
      baseUrl: provider.api_base_url,
      apiKey,
      models: provider.models || []
    };

    // Execute transformer chain (using shared executor)
    const executor = getSharedExecutor();

    // Route through the shared provider-call core (Phase 1). Handler injects
    // its CURRENT per-site logic:
    //   - endpointTransformer: none (input already unified).
    //   - resolveUrl: config.url (when a URL) else buildProviderApiUrl(...).
    //   - buildHeaders: getProviderHeaders + config.headers + OpenRouter app headers.
    //   - prepareBody: addOpenRouterProviderToRequest (post-transform / pre-fetch).
    //   - fetchFn: plain fetch (logs the url immediately before the call).
    //   - runResponseChain: FALSE — Handler gates on `response.ok` on the RAW
    //     response BEFORE the response chain, so it runs executeResponseChain
    //     at the call site below with `unifiedRequest` (pre-transform), as before.
    const { response } = await executeProviderCall({
      executor,
      request: unifiedRequest,
      provider: transformerProvider,
      chain,
      endpointTransformer: undefined,
      extendedContext: options.useExtendedContext
        ? { enabled: true, model: actualModel }
        : undefined,
      resolveUrl: (config) =>
        config.url instanceof URL
          ? config.url.toString()
          : buildProviderApiUrl(provider, { model: actualModel, stream: false }),
      buildHeaders: (config) => ({
        ...getProviderHeaders(provider, apiKey),
        ...(config.headers as Record<string, string>),
        ...(isOpenRouterProvider(provider) ? OPENROUTER_APP_HEADERS : {})
      }),
      // Add OpenRouter provider routing config if applicable
      prepareBody: (requestBody) =>
        addOpenRouterProviderToRequest(
          requestBody as Record<string, unknown>,
          provider,
          actualModel
        ),
      fetchFn: (url, headers, body) => {
        logger.info('Calling completion with transformers', { url });
        return fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body)
        });
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        error: `API error (${response.status}): ${errorText}`
      };
    }

    // Transform response — providerTransformers handle provider鈫抲nified
    const transformedResponse = await executor.executeResponseChain(
      unifiedRequest,
      response,
      transformerProvider,
      chain,
      { endpointTransformer: undefined }
    );

    // Parse the transformed response
    const data = await transformedResponse.json();

    // Extract message from OpenAI-compatible format
    const choice = data.choices?.[0];
    if (!choice) {
      return { success: false, error: 'No choices in response' };
    }

    // Extract tool calls if present
    const rawToolCalls = choice.message?.tool_calls as Array<{
      id: string;
      type?: string;
      function: { name: string; arguments: string };
    }> | undefined;

    const toolCalls = rawToolCalls?.map(tc => ({
      id: tc.id,
      name: tc.function.name,
      args: typeof tc.function.arguments === 'string'
        ? JSON.parse(tc.function.arguments)
        : tc.function.arguments,
    }));

    // Tap A: record usage (transformer-path, non-streaming).
    const tapped = readUsageFromOpenAIResponse(data.usage as Record<string, unknown> | undefined);
    if (recording?.recorder && tapped) {
      recording.recorder.record({
        messageId: options.messageId ?? null,
        parentMessageId: options.parentMessageId ?? null,
        sessionId: options.sessionId ?? null,
        providerId: actualProviderId,
        model: actualModel,
        apiKeyId: recording.apiKeyId ?? null,
        engineOrigin: 'completion',
        usage: tapped,
        rawUsage: data.usage,
      });
    }

    return {
      success: true,
      message: {
        id: `msg_${Date.now()}`,
        role: 'assistant',
        content: choice.message?.content || '',
        timestamp: Date.now(),
        thinking: (data.reasoning_content || choice.message?.thinking?.content)
          ? { content: data.reasoning_content || choice.message?.thinking?.content || '', signature: choice.message?.thinking?.signature }
          : undefined,
        toolCalls,
      },
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens || 0,
        completionTokens: data.usage.completion_tokens || 0,
        totalTokens: data.usage.total_tokens || 0
      } : undefined,
      finishReason: choice.finish_reason,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

/**
 * Send a streaming completion request using transformer chain
 */
export async function completeStreamWithTransformers(
  options: CompletionOptions,
  callbacks: StreamCallbacks,
  llmConfig: ProviderConfigSource,
  getProvider: (providerId: string) => Promise<LLMProvider | null>,
  resolveApiKey: (apiKey: string) => string,
  completeStreamFallback: (options: CompletionOptions, callbacks: StreamCallbacks) => Promise<void>,
  logger: Logger,
  recording?: TransformerHandlerRecordingContext,
): Promise<void> {
  try {
    // Check if this is a routed model (Code->Chat router)
    const routedInfo = await llmConfig.resolveRoutedModel(
      options.providerId,
      options.model
    );

    // Resolve the actual provider and model
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

    // Resolve chain with mainTransformer merged into providerTransformers
    const { chain, hasTransformers } = await resolveChainWithMain(
      llmConfig, actualProviderId, actualModel
    );

    // If no transformers, use legacy path
    if (!hasTransformers) {
      return completeStreamFallback(options, callbacks);
    }

    const messageId = `msg_${Date.now()}`;
    callbacks.onStart?.(messageId);

    // Build unified request (using actual model ID)
    const unifiedRequest: UnifiedChatRequest = {
      model: actualModel,
      messages: options.messages.map(m => ({
        role: m.role as 'user' | 'assistant' | 'system' | 'tool',
        content: m.content
      })),
      max_tokens: options.maxTokens || 4096,
      temperature: options.temperature,
      stream: true
    };

    // Convert provider to transformer LLMProvider format
    const transformerProvider: TransformerLLMProvider = {
      name: provider.name,
      baseUrl: provider.api_base_url,
      apiKey,
      models: provider.models || []
    };

    // Execute transformer chain (using shared executor)
    const executor = getSharedExecutor();

    // Route through the shared provider-call core (Phase 1) — same per-site
    // injection as the non-stream variant, but the URL is built for stream
    // mode and the logger message differs. `runResponseChain: false` keeps the
    // `response.ok` gate (→ callbacks.onError) BEFORE the response chain, which
    // is then run at the call site with `unifiedRequest` (pre-transform).
    const { response } = await executeProviderCall({
      executor,
      request: unifiedRequest,
      provider: transformerProvider,
      chain,
      endpointTransformer: undefined,
      extendedContext: options.useExtendedContext
        ? { enabled: true, model: actualModel }
        : undefined,
      resolveUrl: (config) =>
        config.url instanceof URL
          ? config.url.toString()
          : buildProviderApiUrl(provider, { model: actualModel, stream: true }),
      buildHeaders: (config) => ({
        ...getProviderHeaders(provider, apiKey),
        ...(config.headers as Record<string, string>),
        ...(isOpenRouterProvider(provider) ? OPENROUTER_APP_HEADERS : {})
      }),
      // Add OpenRouter provider routing config if applicable
      prepareBody: (requestBody) =>
        addOpenRouterProviderToRequest(
          requestBody as Record<string, unknown>,
          provider,
          actualModel
        ),
      fetchFn: (url, headers, body) => {
        logger.info('Streaming completion with transformers', { url });
        return fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body)
        });
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      callbacks.onError?.(`API error (${response.status}): ${errorText}`);
      return;
    }

    // Transform the response stream — providerTransformers handle provider鈫抲nified
    const transformedResponse = await executor.executeResponseChain(
      unifiedRequest,
      response,
      transformerProvider,
      chain,
      { endpointTransformer: undefined }
    );

    // Process the stream
    const reader = transformedResponse.body?.getReader();
    if (!reader) {
      callbacks.onError?.('No response body');
      return;
    }

    const decoder = new TextDecoder();
    let content = '';
    let reasoning = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(line => line.trim() !== '');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;

            try {
              const json = JSON.parse(data);
              const delta = json.choices?.[0]?.delta;

              if (delta?.content) {
                content += delta.content;
                callbacks.onDelta?.(delta.content);
              }

              if (delta?.thinking?.content) {
                reasoning += delta.thinking.content;
                callbacks.onReasoning?.(delta.thinking.content);
              }

              if (delta?.reasoning_content) {
                reasoning += delta.reasoning_content;
                callbacks.onReasoning?.(delta.reasoning_content);
              }

              if (json.usage) {
                // Tap A (streaming): record usage.
                const tapped = readUsageFromOpenAIResponse(json.usage);
                if (recording?.recorder && tapped) {
                  recording.recorder.record({
                    messageId: options.messageId ?? null,
                    parentMessageId: options.parentMessageId ?? null,
                    sessionId: options.sessionId ?? null,
                    providerId: actualProviderId,
                    model: actualModel,
                    apiKeyId: recording.apiKeyId ?? null,
                    engineOrigin: 'completion',
                    usage: tapped,
                    rawUsage: json.usage,
                  });
                }

                callbacks.onDone?.(
                  {
                    id: messageId,
                    role: 'assistant',
                    content,
                    timestamp: Date.now(),
                    thinking: reasoning ? { content: reasoning } : undefined
                  },
                  {
                    promptTokens: json.usage.prompt_tokens || 0,
                    completionTokens: json.usage.completion_tokens || 0,
                    totalTokens: json.usage.total_tokens || 0
                  }
                );
                return;
              }
            } catch (_e) {
              // Ignore parse errors
            }
          }
        }
      }

      // Final callback
      callbacks.onDone?.({
        id: messageId,
        role: 'assistant',
        content,
        timestamp: Date.now(),
        thinking: reasoning ? { content: reasoning } : undefined
      });
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    callbacks.onError?.(message);
  }
}
