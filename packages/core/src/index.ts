/**
 * @omnicross/core — the LLM serving core.
 *
 * Public barrel for the serving core (pipeline, transformer, provider-proxy,
 * completion, outbound-api, ports, ApiConverter + leaf utils + the hoisted tool
 * types). Consumed via the `@omnicross/core` package entry.
 *
 * Deep symbols that are not on this barrel are reachable via the
 * `@omnicross/core/<subpath>` exports (e.g. `@omnicross/core/pipeline/...`).
 */

// ── Leaf utils ──────────────────────────────────────────────────────────────
export { serializeError } from './serializeError'
export type { SSEEvent, SSEFormat, SSEParserCallbacks } from './sse-parser'
export { createSSEParser, streamSSEResponse } from './sse-parser'

// ── Hoisted tool-shape types + MCP tool provider port ────────────────────────
export type {
  AnthropicTool,
  GeminiTools,
  McpToolProvider,
  OpenAITool,
} from './tool-types'

// ── OpenRouter helpers (relocated from the host config-service) ──────────────
export {
  getOpenRouterAppIdentity,
  isOpenRouterProvider,
  OPENROUTER_APP_HEADERS,
  setOpenRouterAppIdentity,
} from './openrouter'
export type { OpenRouterAppIdentity } from './openrouter'

// ── Host ports (core-owned interfaces the host implements) ───────────────────
export type {
  CorePaths,
  CoreUsageEvent,
  CoreUsageTokenCounts,
  Logger,
  OutboundCredentialStore,
  PricingStore,
  ProviderConfigSource,
  UsageEventSink,
  UsageEventStore,
  UsageSink,
  WebSearchBackend,
} from './ports/index'
export type { UsageRecorderImport } from './provider-proxy/types'

// ── Usage (pricing engine + usage-stats recorder over injected stores) ───────
export type { CostCalculation, PricingEngineOptions, UsageRecorderOptions, UsageRecordInput } from './usage/index'
export { PricingEngine, UsageRecorder } from './usage/index'

// ── Completion (CompletionService + LLM utilities) ───────────────────────────
export * from './completion'

// ── Provider proxy (resident loopback ingress) ───────────────────────────────
export * from './provider-proxy'

// ── Outbound API server (external-facing wire-format ingress) ────────────────
export * from './outbound-api'

// ── API converter (Anthropic ↔ OpenAI request/response conversion) ───────────
export * from './ApiConverter'

// ── Transformer (explicit re-exports to avoid the `LLMProvider` name clash
//    with completion/config, mirroring the pre-extraction barrel) ─
export type { ChainExecutionOptions } from './transformer'
export type {
  Annotation,
  ImageContent,
  MessageContent,
  ModelRoute,
  ModelTransformerConfig,
  ReasoningConfig,
  RequestConfig,
  RequestRouteInfo,
  ResolvedTransformerChain,
  StreamChunk,
  TextContent,
  ThinkingContent,
  ThinkLevel,
  ToolCall,
  ToolChoice,
  ToolParameterSchema,
  Transformer,
  TransformerChainConfig,
  TransformerConfigEntry,
  TransformerConstructor,
  TransformerContext,
  TransformerLogger,
  TransformerOptions,
  TransformerReference,
  TransformerServiceConfig,
  TransformRequestResult,
  UnifiedChatRequest,
  UnifiedChatResponse,
  UnifiedMessage,
  UnifiedTool,
  UrlCitation,
} from './transformer'
export { registerBuiltinTransformers, TransformerChainExecutor, TransformerService } from './transformer'
