type WireRecord = Record<string, unknown>;

const CHAT_STRING_FIELDS = ['id', 'model', 'type'] as const;
const CHAT_USAGE_FIELDS = ['prompt_tokens', 'completion_tokens'] as const;
const THINKING_STRING_FIELDS = ['content', 'signature', 'type', 'data'] as const;
const DELTA_TEXT_FIELDS: Record<string, string> = {
  text_delta: 'text', thinking_delta: 'thinking', signature_delta: 'signature', input_json_delta: 'partial_json',
};

function record(value: unknown, field: string): asserts value is WireRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid stream ${field}: expected object`);
}

function optionalString(value: unknown, field: string): asserts value is string | undefined {
  if (value !== undefined && typeof value !== 'string') throw new Error(`Invalid stream ${field}: expected string`);
}

function requiredString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string') throw new Error(`Invalid stream ${field}: expected string`);
}

interface ThinkingDelta {
  content?: string;
  signature?: string;
  index?: number;
  done?: boolean;
  type?: string;
  data?: string;
}

interface ChatToolDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
  extra_content?: unknown;
}

interface ChatDelta {
  content?: string | null;
  reasoning_content?: string | null;
  thinking?: ThinkingDelta | string;
  images?: unknown[];
  tool_calls?: ChatToolDelta[];
  extra_content?: unknown;
}

export interface AnthropicChatStreamChunk {
  id?: string;
  model?: string;
  type?: string;
  error?: unknown;
  response?: { error?: unknown } | null;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number } | null;
  } | null;
  choices?: Array<{ index?: number; delta?: ChatDelta | null; finish_reason?: string | null }> | null;
}

export function assertAnthropicChatStreamChunk(value: unknown): asserts value is AnthropicChatStreamChunk {
  record(value, 'chunk');
  for (const key of CHAT_STRING_FIELDS) optionalString(value[key], key);
  if (value.response !== undefined && value.response !== null) record(value.response, 'response');
  if (value.usage !== undefined && value.usage !== null) {
    record(value.usage, 'usage');
    for (const key of CHAT_USAGE_FIELDS) {
      if (value.usage[key] !== undefined && typeof value.usage[key] !== 'number') throw new Error(`Invalid stream usage.${key}`);
    }
    if (value.usage.prompt_tokens_details !== undefined && value.usage.prompt_tokens_details !== null) {
      record(value.usage.prompt_tokens_details, 'prompt_tokens_details');
      const cached = value.usage.prompt_tokens_details.cached_tokens;
      if (cached !== undefined && typeof cached !== 'number') throw new Error('Invalid stream cached_tokens');
    }
  }
  if (value.choices === undefined || value.choices === null) return;
  if (!Array.isArray(value.choices)) throw new Error('Invalid stream choices');
  for (const choice of value.choices) {
    record(choice, 'choice');
    if (choice.index !== undefined && typeof choice.index !== 'number') throw new Error('Invalid stream choice.index');
    if (choice.finish_reason !== null) optionalString(choice.finish_reason, 'finish_reason');
    if (choice.delta === undefined || choice.delta === null) continue;
    record(choice.delta, 'delta');
    const delta = choice.delta;
    if (delta.content !== null) optionalString(delta.content, 'content');
    if (delta.reasoning_content !== null) optionalString(delta.reasoning_content, 'reasoning_content');
    if (delta.images !== undefined && !Array.isArray(delta.images)) throw new Error('Invalid stream images');
    if (delta.thinking !== undefined && typeof delta.thinking !== 'string') {
      record(delta.thinking, 'thinking');
      for (const key of THINKING_STRING_FIELDS) optionalString(delta.thinking[key], `thinking.${key}`);
      if (delta.thinking.index !== undefined && typeof delta.thinking.index !== 'number') throw new Error('Invalid stream thinking.index');
      if (delta.thinking.done !== undefined && typeof delta.thinking.done !== 'boolean') throw new Error('Invalid stream thinking.done');
    }
    if (delta.tool_calls === undefined) continue;
    if (!Array.isArray(delta.tool_calls)) throw new Error('Invalid stream tool_calls');
    for (const tool of delta.tool_calls) {
      record(tool, 'tool_call');
      optionalString(tool.id, 'tool_call.id');
      if (tool.index !== undefined && typeof tool.index !== 'number') throw new Error('Invalid stream tool_call.index');
      if (tool.function === undefined) continue;
      record(tool.function, 'tool_call.function');
      optionalString(tool.function.name, 'tool_call.function.name');
      optionalString(tool.function.arguments, 'tool_call.function.arguments');
    }
  }
}

type ReplayExtension = { extra_content?: unknown };
type ContentBlock = ReplayExtension & (
  | { type: 'tool_use' | 'server_tool_use'; id: string; name: string; input?: WireRecord }
  | { type: 'text'; text?: string; citations?: unknown[] }
  | { type: 'thinking'; thinking?: string; signature?: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'web_search_tool_result'; tool_use_id: string; content: unknown }
);
type ContentDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'signature_delta'; signature: string }
  | { type: 'input_json_delta'; partial_json: string }
  | { type: 'citations_delta'; citation: unknown };

export type AnthropicWireStreamEvent = ReplayExtension & (
  | { type: 'message_start'; message: { id?: string; model?: string; usage?: WireRecord } }
  | { type: 'content_block_start'; index: number; content_block: ContentBlock }
  | { type: 'content_block_delta'; index: number; delta: ContentDelta }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason?: string | null }; usage?: WireRecord }
  | { type: 'message_stop' | 'ping' }
  | { type: 'error'; error: unknown }
);

export function assertAnthropicWireStreamEvent(value: unknown): asserts value is AnthropicWireStreamEvent {
  record(value, 'event');
  requiredString(value.type, 'event.type');
  if (value.type.startsWith('content_block_') && typeof value.index !== 'number') throw new Error('Invalid stream block index');
  if (value.type === 'message_start') {
    record(value.message, 'message');
    optionalString(value.message.id, 'message.id');
    optionalString(value.message.model, 'message.model');
    if (value.message.usage !== undefined) record(value.message.usage, 'message.usage');
  } else if (value.type === 'content_block_start') {
    record(value.content_block, 'content_block');
    const block = value.content_block;
    if (block.type === 'tool_use' || block.type === 'server_tool_use') {
      requiredString(block.id, 'tool.id');
      requiredString(block.name, 'tool.name');
      if (block.input !== undefined) record(block.input, 'tool.input');
    } else if (block.type === 'text') {
      optionalString(block.text, 'block.text');
      if (block.citations !== undefined && !Array.isArray(block.citations)) throw new Error('Invalid stream citations');
    } else if (block.type === 'thinking') {
      optionalString(block.thinking, 'block.thinking');
      optionalString(block.signature, 'block.signature');
    } else if (block.type === 'redacted_thinking') {
      requiredString(block.data, 'block.data');
    } else if (block.type === 'web_search_tool_result') {
      requiredString(block.tool_use_id, 'block.tool_use_id');
    } else throw new Error(`Unsupported Anthropic response block: ${String(block.type)}`);
  } else if (value.type === 'content_block_delta') {
    record(value.delta, 'delta');
    const field = typeof value.delta.type === 'string' ? DELTA_TEXT_FIELDS[value.delta.type] : undefined;
    if (field) requiredString(value.delta[field], `delta.${field}`);
    else if (value.delta.type !== 'citations_delta') throw new Error(`Unsupported Anthropic response delta: ${String(value.delta.type)}`);
  } else if (value.type === 'message_delta') {
    record(value.delta, 'delta');
    if (value.delta.stop_reason !== null) optionalString(value.delta.stop_reason, 'stop_reason');
    if (value.usage !== undefined) record(value.usage, 'usage');
  } else if (value.type !== 'content_block_stop' && value.type !== 'message_stop' && value.type !== 'ping' && value.type !== 'error') {
    throw new Error(`Unsupported Anthropic stream event: ${value.type}`);
  }
}
