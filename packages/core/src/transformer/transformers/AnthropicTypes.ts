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

/** Optional gateway extension; standard Anthropic clients may discard it. */
export interface AnthropicReplayContent {
  extra_content?: {
    google?: { parts?: unknown[]; thought_signature?: string };
  };
}

export function readGoogleReplayContent(extra: unknown): AnthropicReplayContent['extra_content'] {
  if (!extra || typeof extra !== 'object' || !('google' in extra)) return undefined;
  const google = extra.google;
  if (!google || typeof google !== 'object') return undefined;
  const parts = 'parts' in google && Array.isArray(google.parts) ? google.parts : undefined;
  const signature = 'thought_signature' in google && typeof google.thought_signature === 'string'
    ? google.thought_signature : undefined;
  if (!parts && signature === undefined) return undefined;
  return { google: { ...(parts ? { parts } : {}), ...(signature !== undefined ? { thought_signature: signature } : {}) } };
}

/**
 * Anthropic content types
 */
export interface AnthropicTextContent extends AnthropicReplayContent {
  type: 'text';
  text: string;
  cache_control?: { type?: string };
}

export interface AnthropicImageContent extends AnthropicReplayContent {
  type: 'image';
  source: {
    type: 'base64' | 'url';
    media_type?: string;
    data?: string;
    url?: string;
  };
}

export interface AnthropicToolUseContent extends AnthropicReplayContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicToolResultContent extends AnthropicReplayContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string | unknown[];
  cache_control?: { type?: string };
  is_error?: boolean;
}

export interface AnthropicThinkingContent extends AnthropicReplayContent {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface AnthropicRedactedThinkingContent extends AnthropicReplayContent {
  type: 'redacted_thinking';
  data: string;
}

export type AnthropicContent =
  | AnthropicTextContent
  | AnthropicImageContent
  | AnthropicToolUseContent
  | AnthropicToolResultContent
  | AnthropicThinkingContent
  | AnthropicRedactedThinkingContent;

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
  tool_choice?: { type: 'auto' | 'any' | 'tool' | 'none'; name?: string; disable_parallel_tool_use?: boolean };
  thinking?: {
    type: 'enabled' | 'disabled' | 'adaptive';
    budget_tokens?: number;
  };
  output_config?: {
    effort?: string;
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

/** Public web-source metadata can cross protocols; encrypted search payloads cannot. */
export function formatAnthropicWebSources(sources: unknown): string {
  if (!Array.isArray(sources)) throw new Error('Unsupported Anthropic web search result');
  return sources.map((source: unknown) => {
    if (!source || typeof source !== 'object' || !('url' in source) || typeof source.url !== 'string') {
      throw new Error('Unsupported Anthropic citation or web search result');
    }
    const title = 'title' in source && typeof source.title === 'string' ? source.title : source.url;
    const snippet = 'page_content' in source && typeof source.page_content === 'string' ? source.page_content
      : 'snippet' in source && typeof source.snippet === 'string' ? source.snippet : '';
    return `[${title}](${source.url})${snippet ? `: ${snippet}` : ''}`;
  }).join('\n');
}
