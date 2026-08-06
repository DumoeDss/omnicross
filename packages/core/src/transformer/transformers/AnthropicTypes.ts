/**
 * AnthropicTypes - Shared types & helpers used by AnthropicTransformer split modules.
 *
 * Internal to the AnthropicTransformer facade — siblings
 * (`AnthropicConversion`, `AnthropicStreaming`, `AnthropicToolHandling`) import
 * from here. Do not import the facade from this file.
 *
 * @module transformer/transformers/AnthropicTypes
 */

import type { ThinkLevel } from '../types';

/**
 * Anthropic content types
 */
export interface AnthropicTextContent {
  type: 'text';
  text: string;
  cache_control?: { type?: string };
}

export interface AnthropicImageContent {
  type: 'image';
  source: {
    type: 'base64' | 'url';
    media_type?: string;
    data?: string;
    url?: string;
  };
}

export interface AnthropicToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string | unknown[];
  cache_control?: { type?: string };
}

export interface AnthropicThinkingContent {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export type AnthropicContent =
  | AnthropicTextContent
  | AnthropicImageContent
  | AnthropicToolUseContent
  | AnthropicToolResultContent
  | AnthropicThinkingContent;

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContent[];
}

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  system?: string | Array<{ type: 'text'; text: string; cache_control?: unknown }>;
  temperature?: number;
  stream?: boolean;
  tools?: Array<{
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
  }>;
  tool_choice?: { type: 'auto' | 'any' | 'tool'; name?: string };
  thinking?: {
    type: 'enabled' | 'disabled';
    budget_tokens?: number;
  };
}

/**
 * Get thinking level from budget tokens
 */
export function getThinkLevel(budgetTokens?: number): ThinkLevel {
  if (!budgetTokens || budgetTokens <= 0) return 'none';
  if (budgetTokens < 4096) return 'low';
  if (budgetTokens < 16384) return 'medium';
  return 'high';
}

/**
 * Format base64 image URL
 */
export function formatBase64(data: string, mediaType?: string): string {
  if (data.startsWith('data:')) return data;
  return `data:${mediaType || 'image/png'};base64,${data}`;
}

/**
 * Flatten an Anthropic `tool_result.content` into the plain string an
 * OpenAI-chat `tool` message carries.
 *
 * Claude Code sends tool results as a BLOCK ARRAY (`[{type:'text',text:…}]`)
 * far more often than as a bare string, so `JSON.stringify` made the upstream
 * model read the literal envelope `[{"type":"text","text":"…"}]` on EVERY tool
 * result — and a screenshot tool dumped its whole base64 payload into the
 * prompt. Text blocks are concatenated; an image block becomes a short
 * placeholder because a chat `tool` message cannot carry image parts at all.
 * A non-array object still falls back to JSON, which is a fair textual
 * rendering of structured data.
 */
export function flattenToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (!Array.isArray(content)) return JSON.stringify(content);

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (!block || typeof block !== 'object') continue;
    const typed = block as Record<string, unknown>;
    if (typed.type === 'image' || typed.type === 'image_url') {
      parts.push('[image omitted]');
    } else if (typeof typed.text === 'string') {
      parts.push(typed.text);
    }
  }
  return parts.filter((text) => text !== '').join('\n');
}
