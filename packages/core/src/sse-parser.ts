/**
 * SSE Parser Utility
 *
 * Reusable Server-Sent Events parser for streaming API responses.
 * Supports OpenAI and Anthropic SSE formats with proper buffer handling.
 *
 * @module sse-parser
 */

import type { MessageBlock, ThinkingBlock, ToolResultBlock, ToolUseBlock } from '@omnicross/contracts/message-blocks';
import type { SimpleChatAudio, SimpleChatImage, SimpleChatMessage, SimpleChatVideo } from '@omnicross/contracts/completion-types';

// Debug logging for SSE parsing
const DEBUG_SSE = true;
function debugSSE(prefix: string, ...args: unknown[]) {
  if (DEBUG_SSE) {
    console.log(`[SSE-Parser] ${prefix}`, ...args);
  }
}

/**
 * SSE event data after parsing
 */
export interface SSEEvent {
  /** Raw event type (e.g., 'message', 'content_block_delta') */
  type?: string;
  /** Parsed JSON data */
  data: unknown;
  /** Raw data string */
  raw: string;
}

/**
 * Callbacks for SSE stream processing
 */
export interface SSEParserCallbacks {
  /** Called when text content delta is received */
  onDelta?: (content: string) => void;
  /** Called when reasoning/thinking content is received */
  onReasoning?: (reasoning: string) => void;
  /** Called when usage statistics are received */
  onUsage?: (usage: { promptTokens: number; completionTokens: number; totalTokens: number }) => void;
  /** Called when stream ends normally */
  onDone?: () => void;
  /** Called when an error occurs */
  onError?: (error: string) => void;
  /** Called for each raw SSE event (for debugging) */
  onRawEvent?: (event: SSEEvent) => void;
  /** Called when a structured content block is detected (e.g., Anthropic server_tool_use) */
  onBlock?: (block: MessageBlock) => void;
  /** Called when audio content is received (e.g., OpenAI TTS) */
  onAudio?: (audio: SimpleChatAudio) => void;
  /** Called when video content is received */
  onVideo?: (video: SimpleChatVideo) => void;
}

/**
 * SSE parser format
 */
export type SSEFormat = 'openai' | 'anthropic' | 'gemini' | 'openai-response';

/**
 * SSE Parser state
 */
interface SSEParserState {
  buffer: string;
  content: string;
  reasoning: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  isDone: boolean;
  error?: string;
  /** Timestamp when stream started (first chunk received) */
  streamStartTime?: number;
  /** Timestamp when first content token received */
  firstTokenTime?: number;
  /** Timestamp when stream completed */
  streamEndTime?: number;
  /** Accumulated structured content blocks (e.g., tool_use, tool_result) */
  blocks: MessageBlock[];
  /** Accumulated audio content */
  audios: SimpleChatAudio[];
  /** Accumulated video content */
  videos: SimpleChatVideo[];
}

/**
 * Create a reusable SSE parser for streaming API responses.
 *
 * Usage:
 * ```typescript
 * const parser = createSSEParser('openai', {
 *   onDelta: (content) => console.log('Content:', content),
 *   onDone: () => console.log('Stream complete')
 * });
 *
 * // Feed chunks as they arrive
 * for await (const chunk of reader) {
 *   parser.push(chunk);
 * }
 *
 * // Get accumulated results
 * const { content, reasoning, usage } = parser.getResult();
 * ```
 *
 * @param format - SSE format ('openai' or 'anthropic')
 * @param callbacks - Event callbacks
 * @returns Parser instance with push(), flush(), and getResult() methods
 */
export function createSSEParser(format: SSEFormat, callbacks: SSEParserCallbacks) {
  const state: SSEParserState = {
    buffer: '',
    content: '',
    reasoning: '',
    usage: undefined,
    isDone: false,
    streamStartTime: undefined,
    firstTokenTime: undefined,
    streamEndTime: undefined,
    blocks: [],
    audios: [],
    videos: [],
  };
  let anthropicUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const pendingTools = new Map<number, { id: string; name: string; arguments: string }>();
  const toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
  let thinkingSignature = '';
  let nativeContent: Record<string, unknown>[] = [];
  const nativeInputs = new Map<number, string>();
  let sawFinishReason = false;
  const images: SimpleChatImage[] = [];
  let nativeFormat: NonNullable<SimpleChatMessage['providerMetadata']>['apiFormat'] | undefined =
    format === 'openai' ? undefined : format === 'gemini' ? 'google' : format;
  const nativeThinking = new Map<number, Record<string, unknown>>();

  function fail(message: string): void {
    if (state.error) return;
    state.error = message;
    state.isDone = true;
    callbacks.onError?.(message);
  }

  function finishTools(): void {
    for (const pending of pendingTools.values()) {
      if (!pending.id || !pending.name) throw new Error('Incomplete streaming tool identity');
      const args: unknown = JSON.parse(pending.arguments || '{}');
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be a JSON object');
      toolCalls.push({ id: pending.id, name: pending.name, args: args as Record<string, unknown> });
    }
    pendingTools.clear();
  }

  /**
   * Parse OpenAI format SSE event
   */
  function parseOpenAIEvent(data: string): void {
    if (data === '[DONE]') {
      debugSSE('OpenAI [DONE] received, content length:', state.content.length);
      if (!sawFinishReason) { fail('OpenAI stream ended without a finish reason'); return; }
      try { finishTools(); } catch (error) { fail(String(error)); return; }
      state.isDone = true;
      callbacks.onDone?.();
      return;
    }

    try {
      const json = JSON.parse(data);
      callbacks.onRawEvent?.({ data: json, raw: data });
      if (json.error) { fail(json.error.message || JSON.stringify(json.error)); return; }
      for (const tc of json.choices?.[0]?.delta?.tool_calls ?? []) {
        const index = tc.index ?? 0;
        const pending = pendingTools.get(index) ?? { id: '', name: '', arguments: '' };
        if (tc.id) pending.id += tc.id;
        if (tc.function?.name) pending.name += tc.function.name;
        if (tc.function?.arguments) pending.arguments += tc.function.arguments;
        pendingTools.set(index, pending);
      }

      const delta = json.choices?.[0]?.delta;
      const finishReason = json.choices?.[0]?.finish_reason;
      if (finishReason) sawFinishReason = true;
      if (Array.isArray(delta?.extra_content?.google?.parts)) {
        nativeFormat = 'google';
        nativeContent.push(...delta.extra_content.google.parts);
      }
      if (Array.isArray(delta?.extra_content?.responses?.reasoning)) {
        nativeFormat = 'openai-response';
        nativeContent.push(...delta.extra_content.responses.reasoning);
      }
      if (Array.isArray(delta?.extra_content?.omnicross?.thinking?.blocks)) {
        for (const [index, block] of delta.extra_content.omnicross.thinking.blocks.entries()) nativeThinking.set(index, block);
      }
      for (const image of delta?.images ?? []) {
        const url = typeof image === 'string' ? image : image?.image_url?.url;
        if (typeof url === 'string') images.push({ url });
      }

      // Log significant events
      if (finishReason) {
        debugSSE('OpenAI finish_reason:', finishReason, 'content length so far:', state.content.length);
      }

      if (delta?.content) {
        // Record first token time
        if (!state.firstTokenTime) {
          state.firstTokenTime = Date.now();
        }
        state.content += delta.content;
        callbacks.onDelta?.(delta.content);
      }

      const reasoning = delta?.reasoning_content ?? delta?.thinking?.content;
      if (reasoning) {
        state.reasoning += reasoning;
        callbacks.onReasoning?.(reasoning);
      }
      if (delta?.thinking?.signature && delta.thinking.index === undefined) thinkingSignature += delta.thinking.signature;
      if (delta?.thinking?.index !== undefined) {
        const thinking = delta.thinking;
        const index = thinking.index;
        if (thinking.type === 'redacted_thinking') {
          nativeThinking.set(index, { type: 'redacted_thinking', data: thinking.data });
        } else {
          const block = nativeThinking.get(index) ?? { type: 'thinking', thinking: '' };
          if (thinking.content) block.thinking = String(block.thinking ?? '') + thinking.content;
          if (thinking.signature) block.signature = String(block.signature ?? '') + thinking.signature;
          nativeThinking.set(index, block);
        }
      }

      // Handle audio content (OpenAI TTS responses)
      if (delta?.audio) {
        const audioData = delta.audio;
        if (audioData.data) {
          const mimeType = audioData.format ? `audio/${audioData.format}` : 'audio/wav';
          const audio: SimpleChatAudio = {
            url: audioData.data.startsWith('data:') ? audioData.data : `data:${mimeType};base64,${audioData.data}`,
            mimeType,
          };
          state.audios.push(audio);
          callbacks.onAudio?.(audio);
        }
      }

      // Handle usage in final chunk
      // Note: Some providers send usage with finish_reason, we should check both
      if (json.usage) {
        debugSSE('OpenAI usage received:', JSON.stringify(json.usage));
        debugSSE('OpenAI final chunk full data:', JSON.stringify(json));
        state.usage = {
          promptTokens: json.usage.prompt_tokens || 0,
          completionTokens: json.usage.completion_tokens || 0,
          totalTokens: json.usage.total_tokens ?? ((json.usage.prompt_tokens ?? 0) + (json.usage.completion_tokens ?? 0)),
        };
        callbacks.onUsage?.(state.usage);
        // Don't set isDone here - wait for [DONE] marker or finish_reason
        // Some providers send usage before the final [DONE]
      }

      // Check finish_reason to determine if we should mark as done
      if (finishReason === 'stop' || finishReason === 'end_turn' || finishReason === 'length') {
        debugSSE('OpenAI stream marked done due to finish_reason:', finishReason);
        // Note: We don't set isDone here because [DONE] should come after
        // But log it for debugging
      }
    } catch (error) {
      fail(`Invalid OpenAI stream event: ${String(error)}`);
    }
  }

  /**
   * Parse Anthropic format SSE event
   */
  function parseAnthropicEvent(data: string): void {
    try {
      const json = JSON.parse(data);
      callbacks.onRawEvent?.({ type: json.type, data: json, raw: data });
      if (json.type === 'message_start') {
        anthropicUsage = { ...anthropicUsage, ...json.message?.usage };
      }

      // Handle content_block_start
      if (json.type === 'content_block_start') {
        const contentBlock = json.content_block;
        nativeContent[json.index] = { ...contentBlock };
        if (contentBlock?.type === 'text' && contentBlock.text) {
          state.content += contentBlock.text;
          callbacks.onDelta?.(contentBlock.text);
        } else if (contentBlock?.type === 'thinking' && contentBlock.thinking) {
          state.reasoning += contentBlock.thinking;
          callbacks.onReasoning?.(contentBlock.thinking);
        }

        if (contentBlock?.type === 'thinking') {
          debugSSE('THINKING BLOCK STARTED!');
        }

        // Track server_tool_use blocks (e.g., web_search)
        if (contentBlock?.type === 'server_tool_use') {
          const toolUseBlock: ToolUseBlock = {
            id: contentBlock.id || `block_${Date.now()}`,
            type: 'tool_use',
            toolId: contentBlock.id || '',
            toolName: contentBlock.name || 'web_search',
            input: contentBlock.input || {},
            status: 'running',
          };
          state.blocks.push(toolUseBlock);
          callbacks.onBlock?.(toolUseBlock);
        }

        // Track web_search_tool_result blocks
        if (contentBlock?.type === 'web_search_tool_result') {
          // Format search results from content array
          const searchResults = contentBlock.content;
          let output = '';
          if (Array.isArray(searchResults)) {
            output = searchResults
              .filter((r: Record<string, unknown>) => r.type === 'web_search_result')
              .map((r: Record<string, unknown>) =>
                `**${r.title || 'Untitled'}**\n${r.url || ''}\n${r.encrypted_content ? '(encrypted)' : (r.page_content || r.snippet || '')}`,
              )
              .join('\n\n');
          }

          // Find the matching tool_use block to link via toolId
          const lastToolUse = state.blocks.find(
            (b): b is ToolUseBlock => b.type === 'tool_use' && b.toolId === contentBlock.tool_use_id,
          );

          const toolResultBlock: ToolResultBlock = {
            id: `result_${Date.now()}`,
            type: 'tool_result',
            toolId: contentBlock.tool_use_id || '',
            toolName: lastToolUse?.toolName || 'web_search',
            output: output || '(no results)',
          };
          state.blocks.push(toolResultBlock);
          callbacks.onBlock?.(toolResultBlock);

          // Mark the matching tool_use as completed
          if (lastToolUse) {
            lastToolUse.status = 'completed';
            callbacks.onBlock?.(lastToolUse);
          }
        }
      }

      // Handle content_block_delta
      if (json.type === 'content_block_delta') {
        const delta = json.delta;
        const native = nativeContent[json.index];
        if (native) {
          if (delta?.type === 'text_delta') native.text = String(native.text ?? '') + (delta.text ?? '');
          if (delta?.type === 'thinking_delta') native.thinking = String(native.thinking ?? '') + (delta.thinking ?? '');
          if (delta?.type === 'signature_delta') native.signature = String(native.signature ?? '') + (delta.signature ?? '');
          if (delta?.type === 'input_json_delta') nativeInputs.set(json.index, (nativeInputs.get(json.index) ?? '') + (delta.partial_json ?? ''));
        }

        if (delta?.type === 'text_delta' && delta?.text) {
          if (!state.firstTokenTime) {
            state.firstTokenTime = Date.now();
          }
          state.content += delta.text;
          callbacks.onDelta?.(delta.text);
        }
        if (delta?.type === 'thinking_delta' && delta?.thinking) {
          state.reasoning += delta.thinking;
          callbacks.onReasoning?.(delta.thinking);
        }
      }

      // Handle content_block_stop — finalize tool input
      if (json.type === 'content_block_stop') {
        const native = nativeContent[json.index];
        if (native && (native.type === 'tool_use' || native.type === 'server_tool_use')) {
          const input = nativeInputs.get(json.index);
          if (input) native.input = JSON.parse(input);
          nativeInputs.delete(json.index);
          if (native.type === 'tool_use') {
            if (!native.id || !native.name) throw new Error('Incomplete Anthropic tool identity');
            toolCalls.push({ id: String(native.id), name: String(native.name), args: (native.input ?? {}) as Record<string, unknown> });
          } else {
            const block = state.blocks.find((b): b is ToolUseBlock => b.type === 'tool_use' && b.toolId === native.id);
            if (block) {
              block.input = (native.input ?? {}) as Record<string, unknown>;
              callbacks.onBlock?.(block);
            }
          }
        }
        if (native?.type === 'thinking' && typeof native.signature === 'string') {
          thinkingSignature = nativeContent.filter(block => block?.type === 'thinking').length === 1
            ? native.signature : '';
        }
      }

      // Handle message_delta with usage
      if (json.type === 'message_delta' && json.usage) {
        anthropicUsage = { ...anthropicUsage, ...json.usage };
        const promptTokens = anthropicUsage.input_tokens + anthropicUsage.cache_read_input_tokens + anthropicUsage.cache_creation_input_tokens;
        state.usage = {
          promptTokens,
          completionTokens: anthropicUsage.output_tokens,
          totalTokens: promptTokens + anthropicUsage.output_tokens,
        };
        callbacks.onUsage?.(state.usage);
      }

      // Handle message_stop
      if (json.type === 'message_stop') {
        state.isDone = true;
        callbacks.onDone?.();
      }

      // Handle error events
      if (json.type === 'error') {
        fail(json.error?.message || 'Unknown error');
      }
    } catch (error) {
      fail(`Invalid Anthropic stream event: ${String(error)}`);
    }
  }

  /**
   * Parse Google Gemini format SSE event
   * Gemini streaming response format:
   * {
   *   "candidates": [{
   *     "content": {
   *       "parts": [{"text": "..."}],
   *       "role": "model"
   *     },
   *     "finishReason": "STOP"
   *   }],
   *   "usageMetadata": {
   *     "promptTokenCount": ...,
   *     "candidatesTokenCount": ...,
   *     "totalTokenCount": ...
   *   }
   * }
   */
  function parseGeminiEvent(data: string): void {
    try {
      const json = JSON.parse(data);
      callbacks.onRawEvent?.({ data: json, raw: data });

      // Extract text from candidates
      const candidates = json.candidates;
      if (candidates && candidates.length > 0) {
        const candidate = candidates[0];
        const content = candidate.content;

        if (content?.parts) {
          nativeContent.push(...content.parts);
          for (const part of content.parts) {
            if (part.inlineData?.mimeType?.startsWith('image/') && part.inlineData.data) {
              images.push({ url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`, mimeType: part.inlineData.mimeType });
            }
            if (part.functionCall) {
              toolCalls.push({
                id: part.functionCall.id || `call_${toolCalls.length}_${Date.now()}`,
                name: part.functionCall.name, args: part.functionCall.args ?? {},
              });
            }
            // Gemini thinking models return thought parts with `thought: true` flag
            // The actual thinking text is in `part.text`, not in `part.thought`
            if (part.thought === true && part.text) {
              // This is a thinking/reasoning part
              state.reasoning += part.text;
              callbacks.onReasoning?.(part.text);
            } else if (part.text) {
              // Record first token time
              if (!state.firstTokenTime) {
                state.firstTokenTime = Date.now();
              }
              // Regular text content
              state.content += part.text;
              callbacks.onDelta?.(part.text);
            }
          }
        }

        // Check finish reason
        const finishReason = candidate.finishReason;
        if (finishReason) sawFinishReason = true;
        if (finishReason && finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS') {
          fail(`Gemini generation stopped: ${finishReason}`);
        }
        if (finishReason === 'STOP' || finishReason === 'MAX_TOKENS' || finishReason === 'SAFETY') {
          debugSSE('Gemini finish reason:', finishReason);
        }
      }

      // Handle usage metadata
      const usage = json.usageMetadata;
      if (usage) {
        state.usage = {
          promptTokens: usage.promptTokenCount || 0,
          completionTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
          totalTokens: usage.totalTokenCount ?? ((usage.promptTokenCount ?? 0) + (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0)),
        };
        callbacks.onUsage?.(state.usage);
        debugSSE('Gemini usage:', state.usage);
      }

      if (json.promptFeedback?.blockReason) fail(`Gemini prompt blocked: ${json.promptFeedback.blockReason}`);
      // Handle error
      if (json.error) {
        fail(json.error.message || 'Gemini API error');
      }
    } catch (error) {
      fail(`Invalid Gemini stream event: ${String(error)}`);
    }
  }

  /**
   * Parse OpenAI Responses API format SSE event
   * Events have a `type` field in the JSON data payload:
   * - response.output_text.delta → text content
   * - response.reasoning_summary_text.delta → reasoning content
   * - response.completed → stream done with usage
   * - error → error
   */
  function parseOpenAIResponseEvent(data: string): void {
    try {
      const json = JSON.parse(data);
      callbacks.onRawEvent?.({ type: json.type, data: json, raw: data });

      switch (json.type) {
        case 'response.output_item.done':
          nativeContent[json.output_index] = json.item;
          break;
        case 'response.output_text.delta':
          if (json.delta) {
            if (!state.firstTokenTime) {
              state.firstTokenTime = Date.now();
            }
            state.content += json.delta;
            callbacks.onDelta?.(json.delta);
          }
          break;

        case 'response.reasoning_summary_text.delta':
          if (json.delta) {
            state.reasoning += json.delta;
            callbacks.onReasoning?.(json.delta);
          }
          break;

        case 'response.incomplete':
        case 'response.completed': {
          const response = json.response;
          if (response?.output) nativeContent = response.output;
          for (const item of nativeContent) {
            if (item?.type === 'function_call') toolCalls.push({
              id: String(item.call_id), name: String(item.name), args: JSON.parse(String(item.arguments || '{}')),
            });
          }
          if (response?.usage) {
            state.usage = {
              promptTokens: response.usage.input_tokens || 0,
              completionTokens: response.usage.output_tokens || 0,
              totalTokens: (response.usage.input_tokens || 0) + (response.usage.output_tokens || 0),
            };
            callbacks.onUsage?.(state.usage);
          }
          state.isDone = true;
          callbacks.onDone?.();
          break;
        }

        case 'response.failed':
          fail(json.response?.error?.message || 'Response failed');
          break;
        case 'error':
          fail(json.error?.message || json.message || 'Unknown error');
          break;

        // Informational events — no-op
        // response.created, response.in_progress, response.output_item.added,
        // response.content_part.added, response.output_text.done,
        // response.content_part.done, response.output_item.done, etc.
        default:
          break;
      }
    } catch (error) {
      fail(`Invalid Responses stream event: ${String(error)}`);
    }
  }

  /**
   * Process a single SSE event block
   */
  function processEventBlock(eventBlock: string): void {
    const lines = eventBlock.split(/\r\n|\r|\n/);
    const dataLines: string[] = [];

    // Collect all consecutive data: lines and merge them
    for (const line of lines) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      } else if (line.trim() !== '' && !line.startsWith(':')) {
        // Non-data, non-comment, non-empty line (e.g., event:, id:, retry:)
        // This typically shouldn't happen in a well-formed event block
        // but we handle it gracefully
      }
    }

    // If we have accumulated data lines, merge and parse them
    if (dataLines.length > 0) {
      const data = dataLines.join('\n');

      if (format === 'openai') {
        parseOpenAIEvent(data);
      } else if (format === 'gemini') {
        parseGeminiEvent(data);
      } else if (format === 'openai-response') {
        parseOpenAIResponseEvent(data);
      } else {
        parseAnthropicEvent(data);
      }
    }
  }

  return {
    /**
     * Push a chunk of data to the parser
     * @param chunk - Raw SSE chunk from response stream
     */
    push(chunk: string): void {
      if (state.isDone) return;

      // Record stream start time on first chunk
      if (!state.streamStartTime) {
        state.streamStartTime = Date.now();
      }

      // Add chunk to buffer
      state.buffer += chunk;

      // Split by double newline (SSE event separator)
      const events = state.buffer.split(/\r?\n\r?\n|\r\r/);

      // Keep the last potentially incomplete event in buffer
      state.buffer = events.pop() || '';

      // Process complete events
      for (const eventBlock of events) {
        processEventBlock(eventBlock);
        if (state.isDone) break;
      }
    },

    /**
     * Flush any remaining data in the buffer
     */
    flush(): void {
      debugSSE('flush() called, buffer length:', state.buffer.length, 'isDone:', state.isDone);
      if (!state.isDone && state.buffer.trim()) {
        debugSSE('flush() processing remaining buffer:', state.buffer.substring(0, 200));
        processEventBlock(state.buffer);
        state.buffer = '';
      }

      // Record stream end time
      state.streamEndTime = Date.now();

      // If not done yet, trigger onDone
      if (!state.error && pendingTools.size) {
        try { finishTools(); } catch (error) { fail(String(error)); }
      }
      if (!state.isDone && !sawFinishReason) {
        fail('Upstream stream ended before completion');
      }
      if (!state.isDone) {
        debugSSE('flush() marking stream as done, final content length:', state.content.length);
        state.isDone = true;
        callbacks.onDone?.();
      }
    },

    /**
     * Get accumulated results
     */
    getResult(): {
      content: string;
      reasoning: string;
      usage?: typeof state.usage;
      error?: string;
      thinkingSignature?: string;
      thinkingBlocks?: NonNullable<SimpleChatMessage['thinking']>['blocks'];
      toolCalls: typeof toolCalls;
      providerMetadata?: SimpleChatMessage['providerMetadata'];
      metrics?: {
        completionTokens: number;
        timeCompletionMs: number;
        timeFirstTokenMs?: number;
      };
      blocks: MessageBlock[];
      audios: SimpleChatAudio[];
      videos: SimpleChatVideo[];
      images: SimpleChatImage[];
    } {
      // Calculate metrics if we have timing data
      let metrics: { completionTokens: number; timeCompletionMs: number; timeFirstTokenMs?: number } | undefined;

      if (state.usage && state.firstTokenTime && state.streamEndTime) {
        const timeCompletionMs = state.streamEndTime - state.firstTokenTime;
        const timeFirstTokenMs = state.streamStartTime
          ? state.firstTokenTime - state.streamStartTime
          : undefined;

        metrics = {
          completionTokens: state.usage.completionTokens,
          timeCompletionMs: timeCompletionMs > 0 ? timeCompletionMs : 1, // Ensure at least 1ms
          timeFirstTokenMs,
        };
      }

      // Emit ThinkingBlock into blocks if reasoning was accumulated
      if (state.reasoning && !state.blocks.some(block => block.type === 'thinking')) {
        const thinkingBlock: ThinkingBlock = {
          id: `thinking_${Date.now()}`,
          type: 'thinking',
          content: state.reasoning,
        };
        // Prepend so thinking comes before tool blocks
        state.blocks.unshift(thinkingBlock);
      }

      return {
        content: state.content,
        reasoning: state.reasoning,
        usage: state.usage,
        error: state.error,
        thinkingSignature: thinkingSignature || undefined,
        thinkingBlocks: (nativeThinking.size ? Array.from(nativeThinking.values()) : nativeContent.filter(block => block?.type === 'thinking' || block?.type === 'redacted_thinking')) as NonNullable<SimpleChatMessage['thinking']>['blocks'],
        toolCalls,
        providerMetadata: nativeFormat ? {
          apiFormat: nativeFormat,
          content: nativeContent.filter(Boolean),
        } : undefined,
        metrics,
        blocks: state.blocks,
        audios: state.audios,
        videos: state.videos,
        images,
      };
    },

    /**
     * Check if stream is complete
     */
    isDone(): boolean {
      return state.isDone;
    },

    /**
     * Reset parser state for reuse
     */
    reset(): void {
      state.buffer = '';
      state.content = '';
      state.reasoning = '';
      state.usage = undefined;
      state.isDone = false;
      state.error = undefined;
      anthropicUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      pendingTools.clear();
      toolCalls.length = 0;
      thinkingSignature = '';
      nativeContent = [];
      nativeInputs.clear();
      sawFinishReason = false;
      images.length = 0;
      nativeFormat = format === 'openai' ? undefined : format === 'gemini' ? 'google' : format;
      nativeThinking.clear();
      state.streamStartTime = undefined;
      state.firstTokenTime = undefined;
      state.streamEndTime = undefined;
      state.blocks = [];
      state.audios = [];
      state.videos = [];
    },
  };
}

/**
 * Helper function to stream and parse SSE response
 *
 * @param response - Fetch response with SSE body
 * @param format - SSE format
 * @param callbacks - Event callbacks
 * @returns Promise that resolves when stream is complete
 */
export async function streamSSEResponse(
  response: Response,
  format: SSEFormat,
  callbacks: SSEParserCallbacks
): Promise<{
  content: string;
  reasoning: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  error?: string;
  thinkingSignature?: string;
  thinkingBlocks?: NonNullable<SimpleChatMessage['thinking']>['blocks'];
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  providerMetadata?: SimpleChatMessage['providerMetadata'];
  metrics?: { completionTokens: number; timeCompletionMs: number; timeFirstTokenMs?: number };
  blocks: MessageBlock[];
  audios: SimpleChatAudio[];
  videos: SimpleChatVideo[];
  images: SimpleChatImage[];
}> {
  debugSSE('streamSSEResponse started, format:', format);
  const reader = response.body?.getReader();
  if (!reader) {
    callbacks.onError?.('No response body');
    return { content: '', reasoning: '', error: 'No response body', toolCalls: [], blocks: [], audios: [], videos: [], images: [] };
  }

  const decoder = new TextDecoder();
  const parser = createSSEParser(format, callbacks);
  let chunkCount = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        debugSSE('Reader done signal received after', chunkCount, 'chunks');
        break;
      }

      const chunk = decoder.decode(value, { stream: true });
      chunkCount++;
      parser.push(chunk);

      if (parser.isDone()) {
        debugSSE('Parser isDone after', chunkCount, 'chunks');
        break;
      }
    }

    parser.push(decoder.decode());
    parser.flush();
    const result = parser.getResult();
    debugSSE('streamSSEResponse complete, content length:', result.content.length, 'completionTokens:', result.usage?.completionTokens, 'usage:', result.usage);
    return result;
  } finally {
    reader.releaseLock();
  }
}
