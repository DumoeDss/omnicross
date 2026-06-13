/**
 * Completion Module
 *
 * Provides CompletionService, LLM utilities (URL/header/message building),
 * and search completion support.
 */

// Types
export type { ApiFormat, CompletionOptions, CompletionResult, StreamCallbacks } from './types';

// CompletionService
export { CompletionService } from './CompletionService';
export type { VisionFallbackProvider } from './VisionFallbackProvider';

// Stream event buffering for the `completion:stream:${streamId}` IPC channel
export type { StreamEvent, StreamEventType, StreamSender } from './StreamEventBuffer';
export {
  attach as attachStreamEventBuffer,
  emit as emitStreamEvent,
  register as registerStreamEventBuffer,
  release as releaseStreamEventBuffer,
} from './StreamEventBuffer';

// URL Building
export {
  buildAnthropicApiUrl,
  buildAzureOpenAIApiUrl,
  buildGeminiApiUrl,
  buildOpenAIApiUrl,
  buildOpenAIResponseApiUrl,
  buildProviderApiUrl,
  normalizeAzureEndpoint,
  resolveApiFormat,
  resolveProviderEndpoint,
} from './url-builder';

// Header Building
export { getProviderHeaders } from './header-builder';

// Message Conversion
export type { SimpleChatGeminiMessage, SimpleChatGeminiPart } from './message-converter';
export {
  convertMessageToAnthropic,
  convertMessageToGemini,
  convertMessageToOpenAI,
} from './message-converter';

// OpenRouter Utilities
export {
  addOpenRouterProviderToRequest,
  getOpenRouterProviderConfig,
} from './openrouter-utils';

// Built-in tool executor (web_search, web_fetch)
export { BuiltinToolExecutor, getBuiltinSearchTools } from './BuiltinToolExecutor';

// Native Search
export type {
  NativeSearchAugmentation,
  NativeSearchDetectionResult,
  NativeSearchProvider,
  NativeSearchUserConfig,
} from './native-search-types';
export { NATIVE_SEARCH_TOOL_NAMES } from './native-search-types';
export {
  applyAugmentation,
  buildNativeSearchAugmentation,
  detectNativeSearch,
} from './NativeSearchInjector';
