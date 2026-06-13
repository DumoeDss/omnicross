/**
 * @module shared/completion-types/anthropic
 *
 * Anthropic Messages API wire types — content-part union + message +
 * tool + request / response. Also owns ConversionConfig (cross-provider
 * mapping config).
 */

export interface AnthropicSystemContent {
  type: 'text';
  text: string;
  cache_control?: { type: string };
}

export interface AnthropicTextContent {
  type: 'text';
  text: string;
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
  content: string | AnthropicContentPart[];
  is_error?: boolean;
}

export interface AnthropicThinkingContent {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface AnthropicAudioContent {
  type: 'audio';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export interface AnthropicVideoContent {
  type: 'video';
  source: {
    type: 'base64' | 'url';
    media_type: string;
    data?: string;
    url?: string;
  };
}

export type AnthropicContentPart =
  | AnthropicTextContent
  | AnthropicImageContent
  | AnthropicToolUseContent
  | AnthropicToolResultContent
  | AnthropicThinkingContent
  | AnthropicAudioContent
  | AnthropicVideoContent;

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentPart[];
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicChatRequest {
  model: string;
  max_tokens: number;
  system?: string | AnthropicSystemContent[];
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  tool_choice?: { type: 'auto' } | { type: 'any' } | { type: 'tool'; name: string };
  stream?: boolean;
  temperature?: number;
  thinking?: {
    type: 'enabled' | 'disabled';
    budget_tokens?: number;
  };
}

export interface AnthropicChatResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AnthropicContentPart[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  stop_sequence?: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

// ============================================================================
// Conversion Config
// ============================================================================

export interface ConversionConfig {
  defaultModel: string;
  modelMapping?: Record<string, string>;
  enableThinking?: boolean;
}
