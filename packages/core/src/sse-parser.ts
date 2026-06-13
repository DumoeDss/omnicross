/**
 * SSE Parser Utility
 *
 * Reusable Server-Sent Events parser for streaming API responses.
 * Supports OpenAI and Anthropic SSE formats with proper buffer handling.
 *
 * @module sse-parser
 */

import type { MessageBlock, ThinkingBlock, ToolResultBlock, ToolUseBlock } from '@omnicross/contracts/message-blocks';
import type { SimpleChatAudio, SimpleChatVideo } from '@omnicross/contracts/completion-types';

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
  /** Timestamp when stream started (first chunk received) */
  streamStartTime?: number;
  /** Timestamp when first content token received */
  firstTokenTime?: number;
  /** Timestamp when stream completed */
  streamEndTime?: number;
  /** Accumulated structured content blocks (e.g., tool_use, tool_result) */
  blocks: MessageBlock[];
  /** Index of the currently active content block (Anthropic streaming) */
  currentBlockIndex: number;
  /** Type of the currently active content block */
  currentBlockType: string;
  /** Buffer for accumulating input_json_delta partials */
  inputJsonBuffer: string;
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
    currentBlockIndex: -1,
    currentBlockType: '',
    inputJsonBuffer: '',
    audios: [],
    videos: [],
  };

  /**
   * Parse OpenAI format SSE event
   */
  function parseOpenAIEvent(data: string): void {
    if (data === '[DONE]') {
      debugSSE('OpenAI [DONE] received, content length:', state.content.length);
      state.isDone = true;
      callbacks.onDone?.();
      return;
    }

    try {
      const json = JSON.parse(data);
      callbacks.onRawEvent?.({ data: json, raw: data });

      const delta = json.choices?.[0]?.delta;
      const finishReason = json.choices?.[0]?.finish_reason;

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

      if (delta?.reasoning_content) {
        state.reasoning += delta.reasoning_content;
        callbacks.onReasoning?.(delta.reasoning_content);
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
          totalTokens: json.usage.total_tokens || 0,
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
    } catch {
      // Ignore parse errors for incomplete chunks
    }
  }

  /**
   * Parse Anthropic format SSE event
   */
  function parseAnthropicEvent(data: string): void {
    try {
      const json = JSON.parse(data);
      callbacks.onRawEvent?.({ type: json.type, data: json, raw: data });

      // Handle content_block_start
      if (json.type === 'content_block_start') {
        const contentBlock = json.content_block;
        const blockIndex = json.index ?? -1;

        if (contentBlock?.type === 'thinking') {
          debugSSE('THINKING BLOCK STARTED!');
        }

        // Track server_tool_use blocks (e.g., web_search)
        if (contentBlock?.type === 'server_tool_use') {
          state.currentBlockIndex = blockIndex;
          state.currentBlockType = 'server_tool_use';
          state.inputJsonBuffer = '';

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
          state.currentBlockIndex = blockIndex;
          state.currentBlockType = 'web_search_tool_result';

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
          const lastToolUse = [...state.blocks].reverse().find(
            (b): b is ToolUseBlock => b.type === 'tool_use',
          );

          const toolResultBlock: ToolResultBlock = {
            id: `result_${Date.now()}`,
            type: 'tool_result',
            toolId: lastToolUse?.toolId || '',
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
        // Accumulate input_json_delta for server_tool_use blocks
        if (delta?.type === 'input_json_delta' && delta?.partial_json) {
          state.inputJsonBuffer += delta.partial_json;
        }
      }

      // Handle content_block_stop — finalize tool input
      if (json.type === 'content_block_stop') {
        if (state.currentBlockType === 'server_tool_use' && state.inputJsonBuffer) {
          const lastToolUse = [...state.blocks].reverse().find(
            (b): b is ToolUseBlock => b.type === 'tool_use',
          );
          if (lastToolUse) {
            try {
              lastToolUse.input = JSON.parse(state.inputJsonBuffer);
            } catch {
              lastToolUse.input = { raw: state.inputJsonBuffer };
            }
            callbacks.onBlock?.(lastToolUse);
          }
        }
        state.currentBlockIndex = -1;
        state.currentBlockType = '';
        state.inputJsonBuffer = '';
      }

      // Handle message_delta with usage
      if (json.type === 'message_delta' && json.usage) {
        state.usage = {
          promptTokens: json.usage.input_tokens || 0,
          completionTokens: json.usage.output_tokens || 0,
          totalTokens: (json.usage.input_tokens || 0) + (json.usage.output_tokens || 0),
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
        callbacks.onError?.(json.error?.message || 'Unknown error');
      }
    } catch {
      // Ignore parse errors for incomplete chunks
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
          for (const part of content.parts) {
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
        if (finishReason === 'STOP' || finishReason === 'MAX_TOKENS' || finishReason === 'SAFETY') {
          debugSSE('Gemini finish reason:', finishReason);
        }
      }

      // Handle usage metadata
      const usage = json.usageMetadata;
      if (usage) {
        state.usage = {
          promptTokens: usage.promptTokenCount || 0,
          completionTokens: usage.candidatesTokenCount || 0,
          totalTokens: usage.totalTokenCount || 0,
        };
        callbacks.onUsage?.(state.usage);
        debugSSE('Gemini usage:', state.usage);
      }

      // Handle error
      if (json.error) {
        callbacks.onError?.(json.error.message || 'Gemini API error');
      }
    } catch {
      // Ignore parse errors for incomplete chunks
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

        case 'response.completed': {
          const response = json.response;
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

        case 'error':
          callbacks.onError?.(json.error?.message || json.message || 'Unknown error');
          break;

        // Informational events — no-op
        // response.created, response.in_progress, response.output_item.added,
        // response.content_part.added, response.output_text.done,
        // response.content_part.done, response.output_item.done, etc.
        default:
          break;
      }
    } catch {
      // Ignore parse errors for incomplete chunks
    }
  }

  /**
   * Process a single SSE event block
   */
  function processEventBlock(eventBlock: string): void {
    const lines = eventBlock.split('\n');
    const dataLines: string[] = [];

    // Collect all consecutive data: lines and merge them
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        dataLines.push(line.slice(6));
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
      const events = state.buffer.split('\n\n');

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
      if (state.buffer.trim()) {
        debugSSE('flush() processing remaining buffer:', state.buffer.substring(0, 200));
        processEventBlock(state.buffer);
        state.buffer = '';
      }

      // Record stream end time
      state.streamEndTime = Date.now();

      // If not done yet, trigger onDone
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
      metrics?: {
        completionTokens: number;
        timeCompletionMs: number;
        timeFirstTokenMs?: number;
      };
      blocks: MessageBlock[];
      audios: SimpleChatAudio[];
      videos: SimpleChatVideo[];
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
      if (state.reasoning) {
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
        metrics,
        blocks: state.blocks,
        audios: state.audios,
        videos: state.videos,
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
      state.streamStartTime = undefined;
      state.firstTokenTime = undefined;
      state.streamEndTime = undefined;
      state.blocks = [];
      state.currentBlockIndex = -1;
      state.currentBlockType = '';
      state.inputJsonBuffer = '';
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
  metrics?: { completionTokens: number; timeCompletionMs: number; timeFirstTokenMs?: number };
  blocks: MessageBlock[];
  audios: SimpleChatAudio[];
  videos: SimpleChatVideo[];
}> {
  debugSSE('streamSSEResponse started, format:', format);
  const reader = response.body?.getReader();
  if (!reader) {
    callbacks.onError?.('No response body');
    return { content: '', reasoning: '', blocks: [], audios: [], videos: [] };
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

    parser.flush();
    const result = parser.getResult();
    debugSSE('streamSSEResponse complete, content length:', result.content.length, 'completionTokens:', result.usage?.completionTokens, 'usage:', result.usage);
    return result;
  } finally {
    reader.releaseLock();
  }
}
