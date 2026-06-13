/**
 * TransformerChainExecutor - Executes transformer chains for requests and responses
 *
 * Implements the transformer pipeline:
 * Request: transformRequestOut 鈫?Provider transformers 鈫?Model transformers 鈫?HTTP
 * Response: Model transformers (reverse) 鈫?Provider transformers (reverse) 鈫?transformResponseIn
 *
 * @module transformer/TransformerChainExecutor
 */

import { injectExtendedContextBeta } from './anthropicBetaInject';
import type {
  LLMProvider,
  RequestConfig,
  ResolvedTransformerChain,
  Transformer,
  TransformerContext,
  TransformerLogger,
  TransformRequestResult,
  UnifiedChatRequest,
} from './types';

/**
 * Default console logger
 */
const defaultLogger: TransformerLogger = {
  debug: (msg, ...args) => console.debug(`[ChainExecutor] ${msg}`, ...args),
  info: (msg, ...args) => console.info(`[ChainExecutor] ${msg}`, ...args),
  warn: (msg, ...args) => console.warn(`[ChainExecutor] ${msg}`, ...args),
  error: (msg, ...args) => console.error(`[ChainExecutor] ${msg}`, ...args),
};

/**
 * Options for chain execution
 */
export interface ChainExecutionOptions {
  /** The primary/endpoint transformer */
  endpointTransformer?: Transformer;
  /** Request headers */
  headers?: Record<string, string> | Headers;
  /** Logger instance */
  logger?: TransformerLogger;
  /**
   * 1M-context opt-in. When `enabled` is true and the post-chain request body
   * looks Anthropic-shaped (has a `messages` array), the executor injects
   * `'context-1m-2025-08-07'` into `body.anthropic_beta`. Capability gating
   * (model id allowlist) lives inside `injectExtendedContextBeta` itself.
   */
  extendedContext?: { enabled: boolean; model: string };
}

/**
 * TransformerChainExecutor handles the execution of transformer chains.
 *
 * The execution flow follows the llms project pattern:
 *
 * Request Phase:
 * 1. transformRequestOut (endpoint transformer) - Convert to unified format
 * 2. Provider transformers [].transformRequestIn (forward order)
 * 3. Model transformers [].transformRequestIn (forward order)
 *
 * Response Phase:
 * 4. Model transformers [].transformResponseOut (reverse order)
 * 5. Provider transformers [].transformResponseOut (reverse order)
 * 6. transformResponseIn (endpoint transformer) - Convert to client format
 */
export class TransformerChainExecutor {
  private logger: TransformerLogger;

  constructor(logger?: TransformerLogger) {
    this.logger = logger ?? defaultLogger;
  }

  /**
   * Execute the request transformation chain
   *
   * @param request - Original request body
   * @param provider - LLM provider configuration
   * @param chain - Resolved transformer chain
   * @param options - Execution options
   * @returns Transformed request result
   */
  async executeRequestChain(
    request: unknown,
    provider: LLMProvider,
    chain: ResolvedTransformerChain,
    options: ChainExecutionOptions = {}
  ): Promise<TransformRequestResult> {
    const { endpointTransformer, headers, extendedContext } = options;
    const context: TransformerContext = {
      logger: this.logger,
      providerName: provider.name,
    };

    let requestBody = request;
    let config: RequestConfig = {};
    let bypass = false;

    // Check if we should bypass transformers (optimization)
    bypass = this.shouldBypassTransformers(
      chain,
      endpointTransformer,
      requestBody as UnifiedChatRequest
    );

    if (bypass) {
      // In bypass mode, pass through headers directly
      if (headers) {
        const cleanHeaders = this.cleanHeaders(headers);
        config.headers = cleanHeaders;
      }
      this.logger.debug('Bypass mode enabled - skipping transformations');
    }

    // Step 1: Execute endpoint transformer's transformRequestOut
    if (!bypass && endpointTransformer?.transformRequestOut) {
      this.logger.debug('Executing transformRequestOut');
      try {
        const transformOut = await endpointTransformer.transformRequestOut(requestBody, context);
        if (transformOut && typeof transformOut === 'object') {
          if ('body' in transformOut) {
            requestBody = (transformOut as { body: unknown }).body;
            config = (transformOut as { config?: RequestConfig }).config ?? {};
          } else {
            requestBody = transformOut;
          }
        }
      } catch (error) {
        this.logger.error(`transformRequestOut error: ${this.getErrorMessage(error)}`);
        throw error;
      }
    }

    // Step 2: Execute provider-level transformers (transformRequestIn)
    if (!bypass && chain.providerTransformers.length > 0) {
      this.logger.debug(`Executing ${chain.providerTransformers.length} provider transformers`);
      for (const transformer of chain.providerTransformers) {
        if (transformer.transformRequestIn) {
          try {
            const transformIn = await transformer.transformRequestIn(
              requestBody as UnifiedChatRequest,
              provider,
              context
            );
            if (transformIn && typeof transformIn === 'object') {
              if ('body' in transformIn) {
                requestBody = (transformIn as { body: unknown }).body;
                config = { ...config, ...(transformIn as { config?: RequestConfig }).config };
              } else {
                requestBody = transformIn;
              }
            }
          } catch (error) {
            this.logger.error(
              `Provider transformer ${transformer.name} error: ${this.getErrorMessage(error)}`
            );
            throw error;
          }
        }
      }
    }

    // Step 3: Execute model-specific transformers (transformRequestIn)
    if (!bypass && chain.modelTransformers.length > 0) {
      this.logger.debug(`Executing ${chain.modelTransformers.length} model transformers`);
      for (const transformer of chain.modelTransformers) {
        if (transformer.transformRequestIn) {
          try {
            const result = await transformer.transformRequestIn(
              requestBody as UnifiedChatRequest,
              provider,
              context
            );
            requestBody = result;
          } catch (error) {
            this.logger.error(
              `Model transformer ${transformer.name} error: ${this.getErrorMessage(error)}`
            );
            throw error;
          }
        }
      }
    }

    // Final exit hook: merge the 1M-context flag into the request's
    // `anthropic-beta` HTTP header (transmitted via `config.headers`).
    // `/v1/messages` rejects an `anthropic_beta` body field; the canonical
    // mechanism is the header. The helper itself gates on the capability
    // allowlist so a stale flag on a non-1M model is a no-op.
    if (extendedContext?.enabled) {
      if (!config.headers || typeof config.headers !== 'object') {
        config.headers = {};
      }
      injectExtendedContextBeta(
        config.headers as Record<string, string>,
        extendedContext.model,
        true,
      );
    }

    return { requestBody, config, bypass };
  }

  /**
   * Execute the response transformation chain
   *
   * @param request - Original request (for context)
   * @param response - Response from provider
   * @param provider - LLM provider configuration
   * @param chain - Resolved transformer chain
   * @param options - Execution options
   * @returns Transformed response
   */
  async executeResponseChain(
    request: UnifiedChatRequest,
    response: Response,
    provider: LLMProvider,
    chain: ResolvedTransformerChain,
    options: ChainExecutionOptions = {}
  ): Promise<Response> {
    const { endpointTransformer } = options;
    const context: TransformerContext = {
      logger: this.logger,
      providerName: provider.name,
    };

    let finalResponse = response;

    // Check if we should bypass transformers
    const bypass = this.shouldBypassTransformers(chain, endpointTransformer, request);

    if (bypass) {
      this.logger.debug('Bypass mode - skipping response transformations');
      return finalResponse;
    }

    // Step 4: Execute model-specific transformers (transformResponseOut) in reverse order
    if (chain.modelTransformers.length > 0) {
      const reversedModelTransformers = [...chain.modelTransformers].reverse();
      this.logger.debug(
        `Executing ${reversedModelTransformers.length} model response transformers (reversed)`
      );

      for (const transformer of reversedModelTransformers) {
        if (transformer.transformResponseOut) {
          try {
            finalResponse = await transformer.transformResponseOut(finalResponse, context);
          } catch (error) {
            this.logger.error(
              `Model transformer ${transformer.name} response error: ${this.getErrorMessage(error)}`
            );
            throw error;
          }
        }
      }
    }

    // Step 5: Execute provider-level transformers (transformResponseOut) in reverse order
    if (chain.providerTransformers.length > 0) {
      const reversedProviderTransformers = [...chain.providerTransformers].reverse();
      this.logger.debug(
        `Executing ${reversedProviderTransformers.length} provider response transformers (reversed)`
      );

      for (const transformer of reversedProviderTransformers) {
        if (transformer.transformResponseOut) {
          try {
            finalResponse = await transformer.transformResponseOut(finalResponse, context);
          } catch (error) {
            this.logger.error(
              `Provider transformer ${transformer.name} response error: ${this.getErrorMessage(error)}`
            );
            throw error;
          }
        }
      }
    }

    // Step 6: Execute endpoint transformer's transformResponseIn
    if (endpointTransformer?.transformResponseIn) {
      this.logger.debug('Executing transformResponseIn');
      try {
        finalResponse = await endpointTransformer.transformResponseIn(finalResponse, context);
      } catch (error) {
        this.logger.error(`transformResponseIn error: ${this.getErrorMessage(error)}`);
        throw error;
      }
    }

    return finalResponse;
  }

  /**
   * Execute authentication handler if available
   *
   * @param request - Request body
   * @param provider - LLM provider
   * @param endpointTransformer - Endpoint transformer with auth handler
   * @param context - Transformer context
   * @returns Auth result with potentially modified request and config
   */
  async executeAuth(
    request: unknown,
    provider: LLMProvider,
    endpointTransformer: Transformer | undefined,
    context: TransformerContext
  ): Promise<{ requestBody: unknown; config: RequestConfig }> {
    let requestBody = request;
    let config: RequestConfig = {};

    if (endpointTransformer?.auth) {
      this.logger.debug('Executing auth handler');
      try {
        const auth = await endpointTransformer.auth(requestBody, provider, context);
        if (auth && typeof auth === 'object') {
          if ('body' in auth) {
            requestBody = (auth as { body: unknown }).body;
            const authConfig = (auth as { config?: RequestConfig }).config;
            if (authConfig) {
              const headers = { ...(config.headers ?? {}), ...(authConfig.headers ?? {}) };
              // Remove host header if present
              delete headers['host'];
              config = { ...config, ...authConfig, headers };
            }
          } else {
            requestBody = auth;
          }
        }
      } catch (error) {
        this.logger.error(`Auth handler error: ${this.getErrorMessage(error)}`);
        throw error;
      }
    }

    return { requestBody, config };
  }

  /**
   * Check if transformers should be bypassed (optimization)
   *
   * Bypass is enabled when:
   * - Provider has only one transformer that matches the endpoint transformer
   * - Model has no specific transformers or only the same endpoint transformer
   */
  private shouldBypassTransformers(
    chain: ResolvedTransformerChain,
    endpointTransformer: Transformer | undefined,
    _request: UnifiedChatRequest
  ): boolean {
    if (!endpointTransformer?.name) {
      return false;
    }

    const providerHasOnlyEndpoint =
      chain.providerTransformers.length === 1 &&
      chain.providerTransformers[0]?.name === endpointTransformer.name;

    const modelHasNoTransformers = chain.modelTransformers.length === 0;
    const modelHasOnlyEndpoint =
      chain.modelTransformers.length === 1 &&
      chain.modelTransformers[0]?.name === endpointTransformer.name;

    return providerHasOnlyEndpoint && (modelHasNoTransformers || modelHasOnlyEndpoint);
  }

  /**
   * Clean headers for pass-through
   */
  private cleanHeaders(headers: Record<string, string> | Headers): Record<string, string> {
    const result: Record<string, string> = {};

    if (headers instanceof Headers) {
      headers.forEach((value, key) => {
        if (key.toLowerCase() !== 'content-length') {
          result[key] = value;
        }
      });
    } else {
      for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() !== 'content-length') {
          result[key] = value;
        }
      }
    }

    return result;
  }

  /**
   * Get error message from unknown error
   */
  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}
