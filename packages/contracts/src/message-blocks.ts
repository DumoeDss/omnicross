/**
 * Message content blocks — the provider-neutral content-block shapes one
 * assistant turn is composed of (thinking / text / tool_use / tool_result).
 *
 * These mirror the LLM wire-level content blocks and are consumed by the
 * completion pipeline's stream parsing and tool loop. They carry NO host
 * application semantics (no chat persistence, no UI state).
 *
 * @module message-blocks
 */

export type MessageBlockType = 'thinking' | 'text' | 'tool_use' | 'tool_result';

export interface MessageBlockBase {
  id: string;
  type: MessageBlockType;
}

export interface ThinkingBlock extends MessageBlockBase {
  type: 'thinking';
  content: string;
  durationMs?: number;
  /** Cryptographic signature for Anthropic extended thinking (required for multi-turn) */
  signature?: string;
}

export interface TextBlock extends MessageBlockBase {
  type: 'text';
  content: string;
}

export interface ToolUseBlock extends MessageBlockBase {
  type: 'tool_use';
  toolId: string;
  toolName: string;
  input: Record<string, unknown>;
  status: 'pending' | 'running' | 'completed' | 'error';
}

export interface ToolResultBlock extends MessageBlockBase {
  type: 'tool_result';
  toolId: string;
  toolName: string;
  output?: string;
  error?: string;
  isError?: boolean;
}

export type MessageBlock =
  | ThinkingBlock
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock;
