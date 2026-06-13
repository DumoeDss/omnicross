/**
 * TransformerService Module
 *
 * Provides transformer management and chain execution for LLM request/response handling.
 *
 * @module transformer/index
 */

// Core service exports
export type { ChainExecutionOptions } from './TransformerChainExecutor';
export { TransformerChainExecutor } from './TransformerChainExecutor';
export { TransformerService } from './TransformerService';

// Built-in transformer self-registration entry point. Additive, behavior-neutral
// re-export (omnicross Phase 3, design D7 option 1) so embedders can construct a
// seeded `TransformerService` via the stable `@omnicross/core/transformer` alias
// (the daemon's `ConfigFileProviderConfigSource` calls this in its ctor) instead
// of reaching into the deep `transformer/transformers` subpath.
export { registerBuiltinTransformers } from './transformers';

// Type exports
export type {
  Annotation,
  ImageContent,
  // Provider types
  LLMProvider,
  MessageContent,
  ModelRoute,
  ModelTransformerConfig,
  ReasoningConfig,
  RequestConfig,
  RequestRouteInfo,
  ResolvedTransformerChain,
  StreamChunk,
  // Content types
  TextContent,
  ThinkingContent,
  // Thinking/Reasoning
  ThinkLevel,
  // Message types
  ToolCall,
  ToolChoice,
  ToolParameterSchema,
  // Transformer types
  Transformer,
  TransformerChainConfig,
  // Service configuration
  TransformerConfigEntry,
  TransformerConstructor,
  TransformerContext,
  TransformerLogger,
  TransformerOptions,
  // Chain configuration
  TransformerReference,
  TransformerServiceConfig,
  // Execution types
  TransformRequestResult,
  // Request/Response types
  UnifiedChatRequest,
  UnifiedChatResponse,
  UnifiedMessage,
  UnifiedTool,
  UrlCitation,
} from './types';
