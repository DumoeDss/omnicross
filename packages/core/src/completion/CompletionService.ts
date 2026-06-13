/**
 * CompletionService - Handles completion API calls
 *
 * This service provides a unified interface for making completion API calls
 * to different providers, handling format conversion as needed.
 * Supports transformer chains for advanced request/response transformation.
 *
 * This is a thin facade that delegates to domain-specific handlers:
 * - DirectApiHandler: Non-streaming API calls (OpenAI, Anthropic, Gemini)
 * - StreamHandler: SSE-based streaming (OpenAI, Anthropic, Gemini)
 * - TransformerHandler: Transformer chain-based completion
 * - ToolHandler: Agentic tool-calling loop
 * - ThinkingResolver: Thinking budget and max tokens resolution
 */

import type {
  SimpleChatMessage,
  ThinkLevel
} from '@omnicross/contracts/completion-types';
import type { LLMProvider } from '@omnicross/contracts/llm-config';

import type { CorePaths } from '../ports/core-paths';
import type { UsageSink } from '../ports/index';
import type { Logger } from '../ports/logger';
import type { ProviderConfigSource } from '../ports/provider-config-source';
import type { UsageEventSink } from '../ports/usage-event-sink';
import type { McpToolProvider } from '../tool-types';

import {
  type ApiFormat,
  type CompletionOptions,
  type CompletionResult,
  resolveApiFormat,
  type StreamCallbacks
} from './';
import type { ApiKeyPoolService } from './ApiKeyPoolService';
import type { BuiltinToolExecutor } from './BuiltinToolExecutor';
import {
  callAnthropicCompletion,
  callGeminiCompletion,
  callOpenAICompletion,
  callOpenAIResponseCompletion
} from './DirectApiHandler';
import {
  streamAnthropicCompletion,
  streamGeminiCompletion,
  streamOpenAICompletion,
  streamOpenAIResponseCompletion
} from './StreamHandler';
import {
  getRequiredMaxTokens,
  resolveEffectiveMaxTokens,
  resolveThinkingBudget
} from './ThinkingResolver';
import {
  streamWithTools,
  type StreamWithToolsCallbacks,
  type StreamWithToolsOptions
} from './ToolHandler';
import {
  completeStreamWithTransformers,
  completeWithTransformers
} from './TransformerHandler';
import { resolveProviderEndpoint } from './url-builder';
import type { VisionFallbackProvider } from './VisionFallbackProvider';

// Re-export types for backward compatibility
export type { CompletionOptions, CompletionResult, StreamCallbacks } from './';

// Provider lookup is delegated to the injected `ProviderConfigSource` (the host
// config service) which maintains its own in-memory cache. No additional
// caching needed here.

export class CompletionService {
  private apiKeyPool: ApiKeyPoolService | null = null;
  private usageRecorder: UsageSink | null = null;
  private usageEventSink: UsageEventSink | null = null;
  private visionFallbackProvider: VisionFallbackProvider | null = null;

  constructor(
    private paths: CorePaths,
    private llmConfig: ProviderConfigSource,
    private logger: Logger
  ) {}

  /**
   * Set the API key pool service for multi-key load balancing.
   * When set, keys are resolved via the pool instead of directly from the provider.
   */
  setApiKeyPool(pool: ApiKeyPoolService): void {
    this.apiKeyPool = pool;
  }

  /**
   * Set the usage recorder so completion paths can persist token/cost stats.
   * Optional — when unset, all calls succeed but nothing is recorded.
   */
  setUsageRecorder(recorder: UsageSink): void {
    this.usageRecorder = recorder;
  }

  /**
   * Set the usage-event sink so completion paths can push live usage events
   * (context-meter, aggregate recorder) into the in-process hub. Injected DOWN
   * at bootstrap with `getUsageEventHub()` immediately after construction, so
   * emission is unconditional in production. Optional — when unset (unit-test
   * constructors), the emit calls no-op, identical to `usageRecorder`.
   */
  setUsageEventSink(sink: UsageEventSink): void {
    this.usageEventSink = sink;
  }

  /**
   * Set the vision-fallback provider used by `applyVisionFallback` to describe
   * images for non-vision models. Injected DOWN by the host at bootstrap
   * (the host's impl is built on top of CompletionService).
   * Optional — when unset, `applyVisionFallback` strips images instead.
   */
  setVisionFallbackProvider(provider: VisionFallbackProvider): void {
    this.visionFallbackProvider = provider;
  }

  /**
   * Get provider by ID
   * Delegates to the `ProviderConfigSource` which maintains its own in-memory cache.
   */
  async getProvider(providerId: string): Promise<LLMProvider | null> {
    return this.llmConfig.getProvider(providerId);
  }

  /**
   * Send a completion request
   */
  async complete(options: CompletionOptions): Promise<CompletionResult> {
    try {
      // Check if this is a routed model (Code->Chat router)
      const routedInfo = await this.llmConfig.resolveRoutedModel(
        options.providerId,
        options.model
      );

      // Resolve the actual provider and model
      const actualProviderId = routedInfo?.actualProviderId || options.providerId;
      const actualModel = routedInfo?.actualModelId || options.model;

      // Get provider configuration (with caching)
      const provider = await this.getProvider(actualProviderId);
      if (!provider) {
        return { success: false, error: `Provider not found: ${actualProviderId}` };
      }

      if (!provider.enabled) {
        return { success: false, error: `Provider is disabled: ${provider.name}` };
      }

      // Resolve API key: codingPlan > key pool > legacy single key
      const apiKey = await this.resolveApiKeyForRequest(provider, actualProviderId, options.sessionId);
      if (!apiKey) {
        return { success: false, error: 'API key not configured' };
      }

      // Determine API format based on provider configuration
      const apiFormat = resolveApiFormat(provider);
      this.logger.info('Using API format for completion', { apiFormat, providerId: actualProviderId });

      // Use the actual model ID for the API call
      const resolvedOptions = { ...options, model: actualModel };

      let result = await this.callDirectHandler(apiFormat, provider, apiKey, resolvedOptions);

      // Retry once on rate-limit (429) or overloaded (529) with a different key
      if (!result.success && result.error && this.apiKeyPool && options.sessionId) {
        const status = this.extractHttpStatus(result.error);
        if (status && (status === 429 || status === 529 || status === 401 || status === 403)) {
          const newKey = await this.apiKeyPool.reportError(actualProviderId, options.sessionId, status);
          if (newKey) {
            this.logger.info('Retrying completion with new API key', {
              providerId: actualProviderId,
              statusCode: status,
            });
            result = await this.callDirectHandler(apiFormat, provider, newKey, resolvedOptions);
          }
        }
      }

      // Report success to pool for cooldown reset
      if (result.success && this.apiKeyPool && options.sessionId) {
        this.apiKeyPool.reportSuccess(options.sessionId);
      }

      // Emit usage to the in-process hub so live indicators (context-meter,
      // future aggregate recorder) can react. Non-streaming path.
      if (result.success && result.usage && options.sessionId) {
        this.usageEventSink?.emit({
          sessionId: options.sessionId,
          modelId: actualModel,
          usage: result.usage,
          engineOrigin: 'completion',
        });
      }

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: message };
    }
  }

  /**
   * Send a streaming completion request
   */
  async completeStream(options: CompletionOptions, callbacks: StreamCallbacks): Promise<void> {
    try {
      // Vision fallback: if messages contain images but model lacks vision,
      // use the auxiliary vision model to describe images as text
      await this.applyVisionFallback(options);

      this.logger.info('Starting stream completion', {
        providerId: options.providerId,
        model: options.model,
        messagesCount: options.messages.length
      });

      // Check if this is a routed model (Code->Chat router)
      const routedInfo = await this.llmConfig.resolveRoutedModel(
        options.providerId,
        options.model
      );
      this.logger.debug('Resolved routed model', { routedInfo });

      // Resolve the actual provider and model
      const actualProviderId = routedInfo?.actualProviderId || options.providerId;
      const actualModel = routedInfo?.actualModelId || options.model;
      this.logger.debug('Resolved provider and model', { actualProviderId, actualModel });

      const provider = await this.getProvider(actualProviderId);
      this.logger.debug('Retrieved provider', provider ? {
        id: provider.id,
        name: provider.name,
        apiType: provider.apiType,
        apiFormat: provider.apiFormat,
        api_base_url: provider.api_base_url,
        enabled: provider.enabled
      } : { error: 'Provider not found' });

      if (!provider) {
        callbacks.onError?.(`Provider not found: ${actualProviderId}`);
        return;
      }

      if (!provider.enabled) {
        callbacks.onError?.(`Provider is disabled: ${provider.name}`);
        return;
      }

      // Resolve API key: codingPlan > key pool > legacy single key
      const apiKey = await this.resolveApiKeyForRequest(provider, actualProviderId, options.sessionId);
      if (!apiKey) {
        callbacks.onError?.('API key not configured');
        return;
      }

      // Determine API format based on provider configuration
      const apiFormat = resolveApiFormat(provider);
      this.logger.info('Using API format for stream', { apiFormat });

      const messageId = `msg_${Date.now()}`;
      callbacks.onStart?.(messageId);

      // Use the actual model ID for the API call
      const resolvedOptions = { ...options, model: actualModel };

      // Wrap callbacks once so EVERY downstream branch (pool retry, plain
      // path, transformer-handler retry) emits usage on the hub when
      // onDone fires. Live indicators (context-meter) consume this.
      if (options.sessionId) {
        const sid = options.sessionId;
        const userOnDone = callbacks.onDone;
        callbacks = {
          ...callbacks,
          onDone: (message, usage, metrics) => {
            if (usage) {
              this.usageEventSink?.emit({
                sessionId: sid,
                modelId: actualModel,
                usage,
                engineOrigin: 'completion',
              });
            }
            userOnDone?.(message, usage, metrics);
          },
        };
      }

      // If pool is available, intercept 429/529 errors for auto-retry
      if (this.apiKeyPool && options.sessionId) {
        // Use object ref so TypeScript tracks mutations from closures
        const retryState: { error: { status: number; message: string } | null } = { error: null };

        const interceptCallbacks: StreamCallbacks = {
          ...callbacks,
          onStart: undefined, // already called above
          onError: (error: string) => {
            const status = this.extractHttpStatus(error);
            if (status && (status === 429 || status === 529 || status === 401 || status === 403)) {
              retryState.error = { status, message: error };
              return; // swallow — will retry below
            }
            callbacks.onError?.(error);
          },
          onDone: (message, usage, metrics) => {
            this.apiKeyPool!.reportSuccess(options.sessionId!);
            callbacks.onDone?.(message, usage, metrics);
          },
        };

        await this.callStreamHandler(apiFormat, provider, apiKey, resolvedOptions, messageId, interceptCallbacks);

        // Retry once with a different key if rate-limited
        if (retryState.error) {
          const newKey = await this.apiKeyPool.reportError(
            actualProviderId, options.sessionId, retryState.error.status,
          );
          if (newKey) {
            this.logger.info('Retrying stream with new API key', {
              providerId: actualProviderId,
              statusCode: retryState.error.status,
            });
            await this.callStreamHandler(apiFormat, provider, newKey, resolvedOptions, messageId, {
              ...callbacks,
              onStart: undefined, // don't fire onStart again
            });
          } else {
            callbacks.onError?.(retryState.error.message);
          }
        }
      } else {
        // No pool — direct call without retry
        await this.callStreamHandler(apiFormat, provider, apiKey, resolvedOptions, messageId, {
          ...callbacks,
          onStart: undefined, // already called above
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Stream completion error', error instanceof Error ? error : undefined, { message });
      callbacks.onError?.(message);
    }
  }

  /**
   * Get available models for a provider
   */
  async getAvailableModels(providerId: string): Promise<string[]> {
    const provider = await this.getProvider(providerId);
    if (!provider) return [];
    return provider.models || [];
  }

  /**
   * Test provider connection with a specific model.
   * Sends "Hello" and returns the AI response, duration, etc.
   */
  async testModel(
    providerId: string,
    modelId: string
  ): Promise<{
    success: boolean;
    message: string;
    response?: string;
    model: string;
    durationMs?: number;
  }> {
    try {
      const provider = await this.getProvider(providerId);
      if (!provider) {
        return { success: false, message: 'Provider not found', model: modelId };
      }

      const apiKey = this.resolveApiKey(provider.api_key);
      if (!apiKey) {
        return { success: false, message: 'API key not configured', model: modelId };
      }

      const testMessages: SimpleChatMessage[] = [
        { id: 'test', role: 'user', content: 'Hello', timestamp: Date.now() }
      ];

      const startTime = Date.now();

      const result = await this.complete({
        providerId,
        model: modelId,
        messages: testMessages,
        maxTokens: 100,
      });

      const durationMs = Date.now() - startTime;

      if (result.success) {
        return {
          success: true,
          message: 'Connection successful',
          response: result.message?.content || '',
          model: modelId,
          durationMs,
        };
      } else {
        return {
          success: false,
          message: result.error || 'Unknown error',
          model: modelId,
          durationMs,
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, message, model: modelId };
    }
  }

  /**
   * Check if any messages contain images and the model lacks vision capability.
   * If so, use the auxiliary vision model to describe images as text and remove
   * the image attachments from the messages.
   *
   * Mutates options.messages in-place.
   */
  private async applyVisionFallback(options: CompletionOptions): Promise<void> {
    const hasImages = options.messages.some(m => m.images && m.images.length > 0);
    if (!hasImages) return;

    const hasVision = await this.llmConfig.hasVisionCapability(options.providerId, options.model);
    if (hasVision) return;

    // Check for vision auxiliary model (respects follow-provider setting)
    const { vision: effectiveVisionModel } = await this.llmConfig.resolveEffectiveModels();
    if (!effectiveVisionModel || !this.visionFallbackProvider) {
      this.logger.info('Messages contain images but no vision auxiliary model configured; stripping images');
      // Strip images from messages since the model can't process them
      for (const msg of options.messages) {
        if (msg.images && msg.images.length > 0) {
          msg.images = undefined;
        }
      }
      return;
    }

    this.logger.info('Model lacks vision capability, using auxiliary vision model for image descriptions', {
      providerId: options.providerId,
      model: options.model,
    });

    const visionService = this.visionFallbackProvider;

    for (const msg of options.messages) {
      if (msg.images && msg.images.length > 0) {
        const imageDataUrls = msg.images.map(img => ({ data: img.url }));
        const description = await visionService.describeImages(imageDataUrls, msg.content, effectiveVisionModel);
        if (description && description !== '[Image description unavailable]') {
          msg.content = `${msg.content}\n\n[Image Description]\n${description}`;
        }
        // Remove images from the message since model can't process them
        msg.images = undefined;
      }
    }
  }

  /**
   * Resolve API key for a request with priority:
   * 1. Coding Plan override (if enabled)
   * 2. API key pool (session-affinity weighted round-robin)
   * 3. Legacy single key from provider config
   */
  private async resolveApiKeyForRequest(
    provider: LLMProvider,
    providerId: string,
    sessionId?: string,
  ): Promise<string> {
    // Priority 1: Coding Plan override
    if (provider.codingPlan?.enabled && provider.codingPlan.apiKey) {
      return this.resolveApiKey(provider.codingPlan.apiKey);
    }

    // Priority 2: API key pool (if available)
    if (this.apiKeyPool) {
      const poolKey = sessionId
        ? await this.apiKeyPool.getKeyForSession(providerId, sessionId)
        : await this.apiKeyPool.getKey(providerId);
      if (poolKey) return poolKey;
      // Pool returned empty — fall through to legacy key
    }

    // Priority 3: Legacy single key
    const { apiKey: effectiveKey } = resolveProviderEndpoint(provider);
    return this.resolveApiKey(effectiveKey);
  }

  // ==========================================================================
  // Handler dispatch helpers
  // ==========================================================================

  /**
   * Extract HTTP status code from error messages like "API error (429): ..."
   */
  private extractHttpStatus(error: string): number | null {
    const match = error.match(/\((\d{3})\):/);
    return match ? parseInt(match[1], 10) : null;
  }

  /**
   * Dispatch a non-streaming completion to the appropriate handler.
   */
  private async callDirectHandler(
    apiFormat: ApiFormat,
    provider: LLMProvider,
    apiKey: string,
    options: CompletionOptions,
  ): Promise<CompletionResult> {
    switch (apiFormat) {
      case 'anthropic':
        return callAnthropicCompletion(provider, apiKey, options, this.logger);
      case 'google':
        return callGeminiCompletion(provider, apiKey, options, this.logger);
      case 'openai-response':
        return callOpenAIResponseCompletion(provider, apiKey, options, this.logger);
      case 'azure-openai':
      case 'openai':
      default:
        return callOpenAICompletion(provider, apiKey, options, this.logger);
    }
  }

  /**
   * Dispatch a streaming completion to the appropriate handler.
   */
  private async callStreamHandler(
    apiFormat: ApiFormat,
    provider: LLMProvider,
    apiKey: string,
    options: CompletionOptions,
    messageId: string,
    callbacks: StreamCallbacks,
  ): Promise<void> {
    switch (apiFormat) {
      case 'openai-response':
        await streamOpenAIResponseCompletion(provider, apiKey, options, messageId, callbacks, this.logger);
        return;
      case 'anthropic':
        await streamAnthropicCompletion(provider, apiKey, options, messageId, callbacks, this.logger);
        return;
      case 'google':
        await streamGeminiCompletion(provider, apiKey, options, messageId, callbacks, this.logger);
        return;
      case 'azure-openai':
      case 'openai':
      default:
        await streamOpenAICompletion(provider, apiKey, options, messageId, callbacks, this.logger);
        return;
    }
  }

  /**
   * Resolve API key (handle environment variable references)
   */
  resolveApiKey(apiKey: string): string {
    if (!apiKey) return '';

    // Check if it's an environment variable reference
    if (apiKey.startsWith('$')) {
      const envVar = apiKey.slice(1);
      return process.env[envVar] || '';
    }

    return apiKey;
  }

  /**
   * Resolve effective max_tokens value with priority:
   * 1. Session settings (if provided)
   * 2. Global model parameters (if enabled)
   * 3. Model's maxTokens from provider config
   * 4. Discovered models cache (from API)
   * 5. undefined - let API use its default
   */
  async resolveEffectiveMaxTokens(
    providerId: string,
    modelId: string,
    sessionMaxTokens?: number
  ): Promise<number | undefined> {
    return resolveEffectiveMaxTokens(
      this.llmConfig,
      this.getProvider.bind(this),
      this.logger,
      providerId,
      modelId,
      sessionMaxTokens
    );
  }

  /**
   * Get required max_tokens for providers that need it (e.g., Anthropic)
   * Falls back to DEFAULT_MAX_TOKENS if no value is configured
   */
  async getRequiredMaxTokens(
    providerId: string,
    modelId: string,
    sessionMaxTokens?: number
  ): Promise<number> {
    return getRequiredMaxTokens(
      this.llmConfig,
      this.getProvider.bind(this),
      this.logger,
      providerId,
      modelId,
      sessionMaxTokens
    );
  }

  /**
   * Calculate thinking budget and adjust max_tokens for the provider
   */
  async resolveThinkingBudget(
    providerId: string,
    modelId: string,
    maxTokens: number,
    thinkLevel: ThinkLevel
  ): Promise<{
    adjustedMaxTokens: number;
    thinkingBudget: number | undefined;
    thinkingConfig: {
      type?: 'enabled' | 'disabled';
      budget_tokens?: number;
    } | undefined;
  }> {
    return resolveThinkingBudget(
      this.getProvider.bind(this),
      this.logger,
      providerId,
      modelId,
      maxTokens,
      thinkLevel
    );
  }

  // --------------------------------------------------------------------------
  // Transformer Chain Completion
  // --------------------------------------------------------------------------

  /**
   * Send a completion request using transformer chain
   */
  async completeWithTransformers(options: CompletionOptions): Promise<CompletionResult> {
    return completeWithTransformers(
      options,
      this.llmConfig,
      this.getProvider.bind(this),
      this.resolveApiKey.bind(this),
      this.complete.bind(this),
      this.logger,
      this.usageRecorder ? { recorder: this.usageRecorder } : undefined,
    );
  }

  /**
   * Send a streaming completion request using transformer chain
   */
  async completeStreamWithTransformers(
    options: CompletionOptions,
    callbacks: StreamCallbacks
  ): Promise<void> {
    return completeStreamWithTransformers(
      options,
      callbacks,
      this.llmConfig,
      this.getProvider.bind(this),
      this.resolveApiKey.bind(this),
      this.completeStream.bind(this),
      this.logger,
      this.usageRecorder ? { recorder: this.usageRecorder } : undefined,
    );
  }

  // --------------------------------------------------------------------------
  // Tool-based Completion
  // --------------------------------------------------------------------------

  /**
   * Stream completion with MCP tools support (direct API call)
   * Implements agentic loop: calls LLM -> executes tools -> calls LLM again until done
   */
  async streamWithTools(
    options: StreamWithToolsOptions,
    callbacks: StreamWithToolsCallbacks,
    mcpService?: McpToolProvider,
    builtinExecutor?: BuiltinToolExecutor
  ): Promise<void> {
    return streamWithTools(
      options,
      callbacks,
      mcpService,
      this.llmConfig,
      this.getProvider.bind(this),
      this.resolveApiKey.bind(this),
      this.logger,
      builtinExecutor
    );
  }
}
