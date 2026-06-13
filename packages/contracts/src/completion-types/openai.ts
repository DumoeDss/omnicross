/**
 * @module shared/completion-types/openai
 *
 * OpenAI chat-completions wire types — message / content parts / tool
 * calls / requests / responses / stream chunks.
 */

import type { ReasoningConfig, ThinkingContent } from './thinking';

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | OpenAIContentPart[] | null;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAIContentPart {
  type: 'text' | 'image_url' | 'audio_url' | 'video_url' | 'input_audio';
  text?: string;
  image_url?: {
    url: string;
    detail?: 'auto' | 'low' | 'high';
  };
  audio_url?: {
    url: string;
    format?: string;
  };
  video_url?: {
    url: string;
  };
  /** OpenAI / OpenRouter chat audio input: base64 + format (wav/mp3/flac/m4a/ogg/aac/aiff/pcm16/pcm24). */
  input_audio?: {
    data: string;
    format: string;
  };
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  tools?: OpenAITool[];
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  stream_options?: {
    include_usage?: boolean;
  };
  /** Reasoning configuration for thinking models */
  reasoning?: ReasoningConfig;
}

export interface OpenAIChatResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: OpenAIToolCall[];
      /** Thinking content for reasoning models */
      thinking?: ThinkingContent;
    };
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter';
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    /** Detailed prompt token breakdown */
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
    /** Detailed completion token breakdown */
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
  /** Extension for reasoning/thinking content (DeepSeek style) */
  reasoning_content?: string;
}

export interface OpenAIStreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: {
    index: number;
    delta: {
      role?: 'assistant';
      content?: string;
      tool_calls?: Partial<OpenAIToolCall>[];
      /** Thinking content delta for reasoning models */
      thinking?: Partial<ThinkingContent>;
      /** DeepSeek style reasoning content */
      reasoning_content?: string;
    };
    finish_reason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
}
