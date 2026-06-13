/**
 * Completion Service Types
 *
 * Type definitions for completion options, results, and callbacks.
 */

import type { MessageBlock } from '@omnicross/contracts/message-blocks';
import type {
  SimpleChatAudio,
  SimpleChatMessage,
  SimpleChatVideo,
  ThinkLevel
} from '@omnicross/contracts/completion-types';

import type { NativeSearchAugmentation } from './native-search-types';

export interface CompletionOptions {
  providerId: string;
  model: string;
  messages: SimpleChatMessage[];
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
  /** Thinking effort level for reasoning models */
  thinkLevel?: ThinkLevel;
  /** Native search augmentation to apply to the request body */
  nativeSearchAugmentation?: NativeSearchAugmentation;
  /** Session ID for API key pool affinity (preserves prompt cache) and usage attribution. */
  sessionId?: string;
  /**
   * Assistant-message id this request is producing — used to attribute
   * recorded usage rows back to host messages. Optional; if absent the row is
   * still recorded but won't be linked.
   */
  messageId?: string;
  /**
   * Parent message id (for subagent-style nested calls). Best-effort: callers
   * that know the parent should fill this; otherwise leave unset.
   */
  parentMessageId?: string;
  /**
   * Opt into the Anthropic 1M-context tier for this request. The transformer
   * pipeline (and any direct Anthropic-format paths) inject the
   * `'context-1m-2025-08-07'` beta into the outbound request body when this
   * is true AND the resolved model is in the 1M-capable allowlist.
   */
  useExtendedContext?: boolean;
}

export interface CompletionResult {
  success: boolean;
  message?: SimpleChatMessage;
  error?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** Provider finish reason (e.g. 'stop', 'tool_use', 'max_tokens') */
  finishReason?: string;
}

export interface StreamCallbacks {
  onStart?: (messageId: string) => void;
  onDelta?: (content: string) => void;
  onReasoning?: (reasoning: string) => void;
  onAudio?: (audio: SimpleChatAudio) => void;
  onVideo?: (video: SimpleChatVideo) => void;
  /** Called when a new content block is created (thinking, text, tool_use, tool_result) */
  onBlock?: (block: MessageBlock) => void;
  onDone?: (message: SimpleChatMessage, usage?: CompletionResult['usage'], metrics?: {
    completionTokens: number;
    timeCompletionMs: number;
    timeFirstTokenMs?: number;
  }) => void;
  onError?: (error: string) => void;
}

/**
 * API format type for determining endpoint structure
 */
export type ApiFormat = 'openai' | 'anthropic' | 'google' | 'azure-openai' | 'openai-response';

// Re-export native search types for convenience
export type {
  NativeSearchAugmentation,
  NativeSearchUserConfig,
} from './native-search-types';
