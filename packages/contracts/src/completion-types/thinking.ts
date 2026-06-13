/**
 * @module shared/completion-types/thinking
 *
 * Thinking / reasoning effort level + reasoning-config types. Provider-
 * neutral surface used by both OpenAI- and Anthropic-style requests.
 */

/**
 * Thinking/reasoning effort levels
 * Used to configure the amount of reasoning in model responses
 */
export type ThinkLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Thinking content with optional signature for verification
 */
export interface ThinkingContent {
  /** The thinking/reasoning content */
  content: string;
  /** Optional cryptographic signature for thinking verification */
  signature?: string;
}

/**
 * Reasoning configuration for model requests
 */
export interface ReasoningConfig {
  /** Reasoning effort level */
  effort?: ThinkLevel;
  /** Maximum tokens for reasoning */
  max_tokens?: number;
  /** Whether reasoning is enabled */
  enabled?: boolean;
}
