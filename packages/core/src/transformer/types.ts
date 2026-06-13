/**
 * TransformerService Types
 *
 * Type definitions for the Transformer system, providing unified
 * request/response formats and transformer chain configuration.
 *
 * @module transformer/types
 */

// ============================================================================
// Thinking / Reasoning Types
// ============================================================================

/**
 * Thinking effort level for reasoning models
 */
export type ThinkLevel = 'none' | 'low' | 'medium' | 'high';

/**
 * Thinking content with optional signature for extended context
 */
export interface ThinkingContent {
  content: string;
  signature?: string;
}

/**
 * Reasoning configuration for request
 */
export interface ReasoningConfig {
  /** OpenAI-style effort level */
  effort?: ThinkLevel;
  /** Anthropic-style max tokens for thinking */
  max_tokens?: number;
  /** Whether reasoning is enabled */
  enabled?: boolean;
}

// ============================================================================
// Content Types
// ============================================================================

/**
 * Text content block
 */
export interface TextContent {
  type: 'text';
  text: string;
  cache_control?: {
    type?: string;
  };
}

/**
 * Image content block
 */
export interface ImageContent {
  type: 'image_url';
  image_url: {
    url: string;
  };
  media_type?: string;
}

/**
 * Union of all content types
 */
export type MessageContent = TextContent | ImageContent;

// ============================================================================
// Unified Message Types
// ============================================================================

/**
 * Tool call definition
 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * Unified message format that works across all providers
 */
export interface UnifiedMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | null | MessageContent[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  cache_control?: {
    type?: string;
  };
  thinking?: ThinkingContent;
}

// ============================================================================
// Unified Tool Types
// ============================================================================

/**
 * Tool parameter schema
 */
export interface ToolParameterSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  $schema?: string;
}

/**
 * Unified tool definition
 */
export interface UnifiedTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: ToolParameterSchema;
  };
}

/**
 * Tool choice configuration
 */
export type ToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | string
  | { type: 'function'; function: { name: string } };

// ============================================================================
// Unified Request/Response Types
// ============================================================================

/**
 * Unified chat request format
 */
export interface UnifiedChatRequest {
  messages: UnifiedMessage[];
  model: string;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  tools?: UnifiedTool[];
  tool_choice?: ToolChoice;
  reasoning?: ReasoningConfig;
  /**
   * Internal-only routing metadata. Populated by callers (CompletionService /
   * the host's engine adapters and proxy servers) so the usage-capture hook can attribute
   * the recorded event to a chat message, session, engine origin, and api key.
   *
   * **Must not be serialised into the outbound HTTP body.** The transformer chain
   * passes this object alongside the request internally; transformers that build
   * provider request payloads must drop `meta` from their output.
   */
  meta?: UnifiedChatRequestMeta;
}

/**
 * Routing metadata threaded through the transformer chain so the usage-capture
 * hook can identify which chat message / session / api key produced the call.
 * See `UnifiedChatRequest.meta`.
 */
export interface UnifiedChatRequestMeta {
  /** Host message id of the assistant message being produced, when known. */
  messageId?: string | null;
  /** Parent assistant message id (for subagent dispatches that have a parent). */
  parentMessageId?: string | null;
  /** Host session id, when applicable. */
  sessionId?: string | null;
  /** Which engine path is making the call. See `UsageEngineOrigin`. */
  engineOrigin?:
    | 'completion'
    | 'claude-sdk'
    | 'claude-sdk-direct'
    | 'codex-ingress'
    | (string & {});
  /** The api-key-pool entry id selected for this request. */
  apiKeyId?: string | null;
}

/**
 * URL citation annotation
 */
export interface UrlCitation {
  url: string;
  title: string;
  content: string;
  start_index: number;
  end_index: number;
}

/**
 * Response annotation
 */
export interface Annotation {
  type: 'url_citation';
  url_citation?: UrlCitation;
}

/**
 * Unified chat response format
 */
export interface UnifiedChatResponse {
  id: string;
  model: string;
  content: string | null;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    /**
     * Anthropic prompt-cache hit count. Optional — providers without prompt
     * caching omit it. Counted from the response's raw usage block by the
     * provider's transformer.
     */
    cache_read_input_tokens?: number;
    /** Anthropic prompt-cache write count. Optional, see `cache_read_input_tokens`. */
    cache_creation_input_tokens?: number;
    /** OpenAI o1 / Anthropic extended-thinking — already part of completion_tokens by some providers. */
    reasoning_tokens?: number;
  };
  tool_calls?: ToolCall[];
  annotations?: Annotation[];
}

/**
 * Stream chunk format
 */
export interface StreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices?: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      thinking?: {
        content?: string;
        signature?: string;
      };
      tool_calls?: Array<{
        id?: string;
        type?: 'function';
        function?: {
          name?: string;
          arguments?: string;
        };
        index?: number;
      }>;
      annotations?: Annotation[];
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    completion_tokens?: number;
    prompt_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
    output_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
}

// ============================================================================
// LLM Provider Types
// ============================================================================

/**
 * LLM Provider configuration (runtime format)
 */
export interface LLMProvider {
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  transformer?: TransformerChainConfig;
  /**
   * Resolved Google **Code Assist** project id, threaded onto the transformer
   * provider object by the subscription dispatch seam (SubscriptionDispatcher /
   * openaiResponsesIngress) so `GeminiCodeAssistTransformer.transformRequestIn`
   * can embed it in the top-level envelope. `undefined` is the valid fresh
   * free-tier value (sending a project on free/legacy-tier → Precondition
   * Failed). Only ever set for the gemini subscription profile; inert otherwise.
   */
  geminiProject?: string;
}

/**
 * Model route information
 */
export interface ModelRoute {
  provider: string;
  model: string;
  fullModel: string;
}

/**
 * Request routing information
 */
export interface RequestRouteInfo {
  provider: LLMProvider;
  originalModel: string;
  targetModel: string;
}

// ============================================================================
// Transformer Types
// ============================================================================

/**
 * Transformer options passed during instantiation
 */
export interface TransformerOptions {
  [key: string]: unknown;
}

/**
 * Context passed through transformer chain
 */
export interface TransformerContext {
  /** Original request object */
  req?: unknown;
  /** Logger instance */
  logger?: TransformerLogger;
  /** Provider name */
  providerName?: string;
  /** Additional context data */
  [key: string]: unknown;
}

/**
 * Logger interface for transformers
 */
export interface TransformerLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * Transformer interface - defines the contract for all transformers
 */
export interface Transformer {
  /** Unique name for the transformer */
  name?: string;

  /** API endpoint path (e.g., '/v1/chat/completions') */
  endPoint?: string;

  /** Logger instance */
  logger?: TransformerLogger;

  /**
   * Transform incoming request (provider-specific → unified format)
   * Called when request enters the transformer chain
   */
  transformRequestIn?: (
    request: UnifiedChatRequest,
    provider: LLMProvider,
    context: TransformerContext
  ) => Promise<Record<string, unknown>>;

  /**
   * Transform outgoing request (unified → provider-specific format)
   * Called before sending to LLM provider
   */
  transformRequestOut?: (
    request: unknown,
    context: TransformerContext
  ) => Promise<UnifiedChatRequest>;

  /**
   * Transform incoming response (provider-specific → unified format)
   * Called after receiving response from provider
   */
  transformResponseIn?: (
    response: Response,
    context?: TransformerContext
  ) => Promise<Response>;

  /**
   * Transform outgoing response (unified → client format)
   * Called before returning response to client
   */
  transformResponseOut?: (
    response: Response,
    context: TransformerContext
  ) => Promise<Response>;

  /**
   * Handle authentication for the request
   */
  auth?: (
    request: unknown,
    provider: LLMProvider,
    context: TransformerContext
  ) => Promise<unknown>;
}

/**
 * Transformer constructor interface
 */
export interface TransformerConstructor {
  new (options?: TransformerOptions): Transformer;
  TransformerName?: string;
}

// ============================================================================
// Transformer Chain Configuration
// ============================================================================

/**
 * Individual transformer reference in chain
 * Can be a string name or [name, options] tuple
 */
export type TransformerReference = string | [string, TransformerOptions];

/**
 * Model-specific transformer configuration
 */
export interface ModelTransformerConfig {
  use?: TransformerReference[];
}

/**
 * Transformer chain configuration for a provider
 */
export interface TransformerChainConfig {
  /** Provider-level transformers applied to all models */
  use?: TransformerReference[];
  /** Model-specific transformer overrides */
  [modelName: string]: ModelTransformerConfig | TransformerReference[] | undefined;
}

/**
 * Resolved transformer chain (instances ready to execute)
 */
export interface ResolvedTransformerChain {
  /** Provider-level transformer instances */
  providerTransformers: Transformer[];
  /** Model-specific transformer instances */
  modelTransformers: Transformer[];
}

// ============================================================================
// Chain Execution Types
// ============================================================================

/**
 * Result of request transformation
 */
export interface TransformRequestResult {
  /** Transformed request body */
  requestBody: unknown;
  /** Additional request configuration */
  config: RequestConfig;
  /** Whether to bypass further transformations */
  bypass: boolean;
}

/**
 * Request configuration for HTTP call
 */
export interface RequestConfig {
  /** Request URL */
  url?: URL | string;
  /** Request headers */
  headers?: Record<string, string>;
  /** Additional fetch options */
  [key: string]: unknown;
}

// ============================================================================
// Service Types
// ============================================================================

/**
 * Transformer registration from configuration
 */
export interface TransformerConfigEntry {
  name: string;
  type?: 'class' | 'module';
  path?: string;
  options?: TransformerOptions;
}

/**
 * Service configuration
 */
export interface TransformerServiceConfig {
  transformers?: TransformerConfigEntry[];
}
