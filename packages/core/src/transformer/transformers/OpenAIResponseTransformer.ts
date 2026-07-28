/**
 * OpenAIResponseTransformer - Transformer for OpenAI Responses API
 *
 * Handles bidirectional conversion between unified (OpenAI Chat Completions)
 * format and OpenAI Responses API format (/v1/responses).
 *
 * @module transformer/transformers/OpenAIResponseTransformer
 */

import type {
  LLMProvider,
  Transformer,
  TransformerContext,
  TransformerLogger,
  UnifiedChatRequest,
  UnifiedMessage,
  UnifiedTool,
} from '../types';

// ============================================================================
// Response API Types
// ============================================================================

interface ResponseApiInput {
  role: 'user' | 'assistant' | 'developer';
  content: string | Array<Record<string, unknown>>;
  tool_call_id?: string;
}

interface ResponseApiRequest {
  model: string;
  input: Array<ResponseApiInput | Record<string, unknown>>;
  stream?: boolean;
  max_output_tokens?: number;
  temperature?: number;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: string | Record<string, unknown>;
  reasoning?: { effort: string; summary?: string };
}

// ============================================================================
// Transformer Implementation
// ============================================================================

/**
 * OpenAIResponseTransformer handles OpenAI Responses API format conversion
 *
 * Features:
 * - Converts unified (OpenAI CC) requests to Response API format
 * - Converts Response API responses back to unified format
 * - Supports both streaming SSE and non-streaming JSON responses
 * - Bearer token authentication
 */
export class OpenAIResponseTransformer implements Transformer {
  static TransformerName = 'openai-response';
  name = 'openai-response';
  endPoint = '/v1/responses';
  logger?: TransformerLogger;

  /**
   * Handle authentication - Bearer token
   */
  async auth(
    request: unknown,
    provider: LLMProvider,
    _context: TransformerContext
  ): Promise<{ body: unknown; config: { headers: Record<string, string> } }> {
    return {
      body: request,
      config: {
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          'Content-Type': 'application/json',
        },
      },
    };
  }

  /**
   * Transform unified request → Response API format
   */
  async transformRequestIn(
    request: UnifiedChatRequest,
    provider: LLMProvider,
    _context: TransformerContext
  ): Promise<Record<string, unknown>> {
    // ChatGPT's codex backend (official chatgpt.com OR any third-party relay)
    // is a PRIVATE Responses variant: it REQUIRES `store:false`, REQUIRES typed
    // `input_text` parts (rejects bare-string content), REJECTS
    // `max_output_tokens`, and omits Content-Type on its SSE stream. Relays do
    // NOT carry a discoverable url token, so codex can't be reliably told from
    // public-OpenAI by url. Default to the codex-private shape because the
    // public OpenAI Responses API ACCEPTS it too (`input_text` is the standard
    // part type, `store:false` is legal, omitting `max_output_tokens` falls
    // back to the upstream default) — works for all providers without a url
    // guess. If a future public provider must honor max_output_tokens, add an
    // opt-out flag then.
    const input: Array<Record<string, unknown>> = [];

    for (const msg of request.messages) {
      if (msg.role === 'system') {
        const sysText = typeof msg.content === 'string' ? msg.content : flattenContent(msg.content);
        input.push({
          role: 'developer',
          content: [{ type: 'input_text', text: sysText }],
        });
      } else if (msg.role === 'tool') {
        input.push({
          type: 'function_call_output',
          call_id: msg.tool_call_id,
          output: typeof msg.content === 'string' ? msg.content : '',
        });
      } else {
        const text = typeof msg.content === 'string' ? msg.content : flattenContent(msg.content);
        const entry: Record<string, unknown> = {
          role: msg.role,
          content: [{ type: msg.role === 'assistant' ? 'output_text' : 'input_text', text }],
        };
        // Include tool_calls as function_call items
        if (msg.role === 'assistant' && msg.tool_calls?.length) {
          // For Response API, tool calls are separate output items
          // Push the assistant text first, then each function_call
          input.push(entry);
          for (const tc of msg.tool_calls) {
            // codex's function_call ITEM carries TWO ids: `id` (the item id,
            // MUST begin with 'fc_') and `call_id` (the call handle a later
            // function_call_output references). The unified tool_call only has
            // the call_id, so synthesize an fc_ item id from it — codex
            // correlates call↔output by `call_id`, never by the item id.
            const callId = tc.id;
            const itemId = callId.startsWith('fc_')
              ? callId
              : `fc_${callId.replace(/^(call_|fc_)/, '')}`;
            input.push({
              type: 'function_call',
              id: itemId,
              call_id: callId,
              name: tc.function.name,
              arguments: tc.function.arguments,
            });
          }
          continue;
        }
        input.push(entry);
      }
    }

    const body: Record<string, unknown> = {
      model: request.model,
      input,
      // codex's backend REQUIRES `stream:true` (it 400s with "Stream must be
      // set to true" otherwise). Always force it; a non-streaming CLIENT is
      // served by aggregating the SSE upstream of the wire (the ingress buffers
      // it into a single message), not by asking codex for a non-streaming reply.
      stream: true,
      // `store:false` is required by the codex backend and accepted by the
      // public Responses API (which defaults to store:true). Always set it so
      // codex relays (no discoverable url token) work without configuration.
      store: false,
      // `max_output_tokens` is intentionally omitted: the codex backend rejects
      // it, and the public API falls back to its default when absent. If a
      // public provider ever needs it honored, gate that on an opt-out flag.
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    };

    // Map reasoning config
    if (request.reasoning?.effort && request.reasoning.effort !== 'none') {
      body.reasoning = { effort: request.reasoning.effort, summary: 'auto' };
    }

    // Map tools
    if (request.tools?.length) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      }));
    }

    // Map tool_choice
    if (request.tool_choice) {
      if (typeof request.tool_choice === 'string') {
        body.tool_choice = request.tool_choice;
      } else if (typeof request.tool_choice === 'object' && 'function' in request.tool_choice) {
        body.tool_choice = { type: 'function', name: request.tool_choice.function.name };
      }
    }

    // HOST-ROOT-ABSOLUTE BY DESIGN: `new URL('/v1/responses', baseUrl)` keeps only
    // the base's ORIGIN and replaces the WHOLE path with `/v1/responses`. This is
    // correct for the public OpenAI / ChatGPT Responses endpoints (their path IS
    // `/v1/responses` at the host root). Consumers whose provider base carries a
    // PATH PREFIX (e.g. opencode-zen `…/zen/v1/responses`, codex
    // `…/backend-api/codex/responses`) MUST NOT use this `config.url` — it would
    // drop the prefix. Such consumers prefer their own complete `upstreamUrl`
    // instead (see `usesResponsesChain` in `anthropicSubscriptionPlan.ts` /
    // `SubscriptionDispatcher.ts`, which gate the Responses chain onto `upstreamUrl`).
    const url = new URL('/v1/responses', provider.baseUrl);

    return { body, config: { url } };
  }

  /**
   * Transform Response API request → unified format
   */
  async transformRequestOut(
    request: unknown,
    _context: TransformerContext
  ): Promise<UnifiedChatRequest> {
    const req = request as ResponseApiRequest;
    const messages: UnifiedMessage[] = [];

    if (req.input) {
      for (const item of req.input) {
        const entry = item as Record<string, unknown>;

        // Handle function_call_output (tool results)
        if (entry.type === 'function_call_output') {
          messages.push({
            role: 'tool',
            content: (entry.output as string) || '',
            tool_call_id: (entry.call_id as string) || undefined,
          });
          continue;
        }

        // Handle function_call (assistant tool CALL items — they carry no `role`).
        // This is the inverse of `transformRequestIn`'s encode: an assistant turn
        // with tool_calls is emitted as a `{role:'assistant'}` text item followed
        // by one `{type:'function_call'}` item per tool call. Attach the call to the
        // most-recent assistant message if it is the last pushed message (mirrors the
        // encode grouping); otherwise start a fresh assistant message.
        if (entry.type === 'function_call') {
          const toolCall = {
            id: ((entry.call_id ?? entry.id) as string) || '',
            type: 'function' as const,
            function: {
              name: (entry.name as string) || '',
              arguments: typeof entry.arguments === 'string' ? entry.arguments : '',
            },
          };
          const last = messages[messages.length - 1];
          if (last && last.role === 'assistant') {
            (last.tool_calls ??= []).push(toolCall);
          } else {
            messages.push({ role: 'assistant', content: null, tool_calls: [toolCall] });
          }
          continue;
        }

        const role = entry.role as string;
        if (role === 'developer') {
          messages.push({
            role: 'system',
            content:
              typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content),
          });
        } else if (role === 'user' || role === 'assistant') {
          messages.push({
            role,
            content:
              typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content),
          });
        }
      }
    }

    const result: UnifiedChatRequest = {
      messages,
      model: req.model,
      max_tokens: req.max_output_tokens,
      temperature: req.temperature,
      stream: req.stream,
    };

    if (req.reasoning?.effort) {
      result.reasoning = {
        effort: req.reasoning.effort as 'low' | 'medium' | 'high',
        enabled: true,
      };
    }

    if (req.tools?.length) {
      result.tools = req.tools
        .filter((t) => t.type === 'function')
        .map((t) => ({
          type: 'function' as const,
          function: {
            name: (t.name as string) || '',
            description: (t.description as string) || '',
            parameters: (t.parameters || {}) as UnifiedTool['function']['parameters'],
          },
        }));
    }

    return result;
  }

  /**
   * Transform Response API response → unified (OpenAI CC) format
   */
  async transformResponseOut(
    response: Response,
    _context: TransformerContext
  ): Promise<Response> {
    const contentType = response.headers.get('Content-Type') ?? '';

    // ChatGPT's codex backend OMITS Content-Type on SSE streams, so a header
    // check alone misroutes them into the JSON branch (which throws
    // "Unexpected token 'e'" on the leading `event:` line). Peek the first
    // chunk to detect an SSE frame when the header is absent.
    let isSse = contentType.includes('text/event-stream');
    if (!isSse && response.body) {
      const peek = response.clone();
      try {
        const reader = peek.body!.getReader();
        const { value } = await reader.read();
        reader.releaseLock();
        const head = value ? new TextDecoder().decode(value).trimStart() : '';
        isSse = head.startsWith('event:') || head.startsWith('data:');
      } catch {
        /* treat as non-SSE on peek failure */
      }
    }

    if (isSse) {
      if (!response.body) {
        throw new Error('Stream response body is null');
      }
      return new Response(convertResponseApiStreamToOpenAI(response.body), {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    }

    const data = await response.json();
    return new Response(JSON.stringify(convertResponseApiJsonToOpenAI(data)), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Transform OpenAI CC response → Response API format
   */
  async transformResponseIn(
    response: Response,
    _context?: TransformerContext
  ): Promise<Response> {
    const contentType = response.headers.get('Content-Type') ?? '';

    if (contentType.includes('text/event-stream')) {
      if (!response.body) {
        throw new Error('Stream response body is null');
      }
      return new Response(convertOpenAIStreamToResponseApi(response.body), {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    }

    const data = await response.json();
    return new Response(JSON.stringify(convertOpenAIJsonToResponseApi(data)), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!content) return '';
  if (Array.isArray(content)) {
    return content
      .filter((c: Record<string, unknown>) => c.type === 'text')
      .map((c: Record<string, unknown>) => (c.text as string) || '')
      .join('\n');
  }
  return '';
}

// ============================================================================
// Non-streaming JSON Conversion
// ============================================================================

function convertResponseApiJsonToOpenAI(data: Record<string, unknown>): Record<string, unknown> {
  let textContent = '';
  const toolCalls: Array<Record<string, unknown>> = [];

  const output = data.output as Array<Record<string, unknown>> | undefined;
  if (output) {
    for (const item of output) {
      if (item.type === 'message') {
        const content = item.content as Array<Record<string, unknown>> | undefined;
        if (content) {
          for (const part of content) {
            if (part.type === 'output_text' && typeof part.text === 'string') {
              textContent += part.text;
            }
          }
        }
      } else if (item.type === 'function_call') {
        toolCalls.push({
          id: item.call_id || item.id || `call_${Date.now()}`,
          type: 'function',
          function: {
            name: item.name,
            arguments:
              typeof item.arguments === 'string'
                ? item.arguments
                : JSON.stringify(item.arguments || {}),
          },
        });
      }
    }
  }

  const usage = data.usage as Record<string, number> | undefined;
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: textContent || null,
  };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  return {
    id: data.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: data.model || 'unknown',
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      },
    ],
    usage: usage
      ? {
          prompt_tokens: usage.input_tokens || 0,
          completion_tokens: usage.output_tokens || 0,
          total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
        }
      : undefined,
  };
}

function convertOpenAIJsonToResponseApi(data: Record<string, unknown>): Record<string, unknown> {
  const choices = data.choices as Array<Record<string, unknown>> | undefined;
  const message = choices?.[0]?.message as Record<string, unknown> | undefined;
  const output: Array<Record<string, unknown>> = [];

  if (message) {
    const contentParts: Array<Record<string, unknown>> = [];
    if (message.content) {
      contentParts.push({ type: 'output_text', text: message.content });
    }
    if (contentParts.length > 0) {
      output.push({ type: 'message', role: 'assistant', content: contentParts });
    }

    const toolCalls = message.tool_calls as Array<Record<string, unknown>> | undefined;
    if (toolCalls?.length) {
      for (const tc of toolCalls) {
        const func = tc.function as Record<string, unknown>;
        output.push({
          type: 'function_call',
          id: tc.id,
          call_id: tc.id,
          name: func?.name,
          arguments: func?.arguments,
        });
      }
    }
  }

  const usage = data.usage as Record<string, number> | undefined;

  return {
    id: data.id || `resp_${Date.now()}`,
    object: 'response',
    status: 'completed',
    model: data.model || 'unknown',
    output,
    usage: usage
      ? {
          input_tokens: usage.prompt_tokens || 0,
          output_tokens: usage.completion_tokens || 0,
          total_tokens:
            usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
        }
      : undefined,
  };
}

// ============================================================================
// Streaming SSE Conversion
// ============================================================================

/**
 * Convert Response API SSE stream → OpenAI CC SSE stream
 */
function convertResponseApiStreamToOpenAI(
  responseApiStream: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  return new ReadableStream({
    start: async (controller) => {
      const reader = responseApiStream.getReader();
      let buffer = '';
      let isClosed = false;
      const messageId = `chatcmpl-${Date.now()}`;
      let model = 'unknown';
      let hasEmittedRole = false;
      // True once a codex function_call event is seen in this stream, so the
      // terminal `response.completed` chunk carries `finish_reason:"tool_calls"`
      // (matching the OpenAI-chat protocol — a tool-call turn is NOT a `stop`).
      let hasToolCalls = false;

      const safeEnqueue = (str: string) => {
        if (!isClosed) {
          try {
            controller.enqueue(encoder.encode(str));
          } catch {
            isClosed = true;
          }
        }
      };

      const emitChunk = (choices: unknown[], usage?: unknown) => {
        const chunk: Record<string, unknown> = {
          id: messageId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices,
        };
        if (usage) chunk.usage = usage;
        safeEnqueue(`data: ${JSON.stringify(chunk)}\n\n`);
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (isClosed) break;
            if (!line.startsWith('data:')) continue;

            const data = line.slice(5).trim();
            if (data === '[DONE]') continue;

            try {
              const event = JSON.parse(data);
              model = event.model || event.response?.model || model;

              switch (event.type) {
                case 'response.output_text.delta':
                  if (event.delta) {
                    if (!hasEmittedRole) {
                      emitChunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]);
                      hasEmittedRole = true;
                    }
                    emitChunk([{ index: 0, delta: { content: event.delta }, finish_reason: null }]);
                  }
                  break;

                case 'response.reasoning_summary_text.delta':
                  if (event.delta) {
                    emitChunk([{
                      index: 0,
                      delta: { thinking: { content: event.delta } },
                      finish_reason: null,
                    }]);
                  }
                  break;

                case 'response.output_item.added': {
                  // codex emits a `function_call` output item when the model
                  // decides to call a tool. Translate it into an OpenAI-chat
                  // `tool_calls` delta so step 2 (AnthropicOpenAIToAnthropicStream)
                  // can map it to an Anthropic `tool_use` block. Without this,
                  // the tool call is silently dropped and the client gets an
                  // empty assistant turn.
                  const item = event.item;
                  if (item?.type !== 'function_call') break;
                  if (!hasEmittedRole) {
                    emitChunk([{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }]);
                    hasEmittedRole = true;
                  }
                  hasToolCalls = true;
                  emitChunk([{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: event.output_index ?? 0,
                        id: item.call_id,
                        type: 'function',
                        function: { name: item.name, arguments: '' },
                      }],
                    },
                    finish_reason: null,
                  }]);
                  break;
                }

                case 'response.function_call_arguments.delta': {
                  // codex streams the function-call arguments token-by-token;
                  // concatenate into the matching tool_call's `arguments`.
                  hasToolCalls = true;
                  emitChunk([{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: event.output_index ?? 0,
                        function: { arguments: event.delta ?? '' },
                      }],
                    },
                    finish_reason: null,
                  }]);
                  break;
                }

                case 'response.completed': {
                  const resp = event.response;
                  const respUsage = resp?.usage;
                  const usage = respUsage
                    ? {
                        prompt_tokens: respUsage.input_tokens || 0,
                        completion_tokens: respUsage.output_tokens || 0,
                        total_tokens:
                          (respUsage.input_tokens || 0) + (respUsage.output_tokens || 0),
                      }
                    : undefined;
                  // A tool-call turn finishes with `tool_calls` (matching the
                  // OpenAI-chat protocol); a plain-text turn finishes `stop`.
                  emitChunk([{ index: 0, delta: {}, finish_reason: hasToolCalls ? 'tool_calls' : 'stop' }], usage);
                  safeEnqueue('data: [DONE]\n\n');
                  break;
                }

                case 'error':
                  emitChunk([{
                    index: 0,
                    delta: { content: `[Error: ${event.error?.message || 'Unknown error'}]` },
                    finish_reason: 'stop',
                  }]);
                  break;

                default:
                  break;
              }
            } catch {
              // Ignore parse errors
            }
          }
        }
      } catch (e) {
        if (!isClosed) controller.error(e);
      } finally {
        if (!isClosed) {
          try {
            controller.close();
          } catch {
            // Already closed
          }
        }
        reader.releaseLock();
      }
    },
  });
}

/**
 * Convert OpenAI CC SSE stream → Response API SSE stream
 */
function convertOpenAIStreamToResponseApi(
  openaiStream: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  return new ReadableStream({
    start: async (controller) => {
      const reader = openaiStream.getReader();
      let buffer = '';
      let isClosed = false;
      let accumulatedContent = '';
      let model = 'unknown';
      const responseId = `resp_${Date.now()}`;

      const safeEnqueue = (str: string) => {
        if (!isClosed) {
          try {
            controller.enqueue(encoder.encode(str));
          } catch {
            isClosed = true;
          }
        }
      };

      const emitEvent = (event: Record<string, unknown>) => {
        safeEnqueue(`data: ${JSON.stringify(event)}\n\n`);
      };

      emitEvent({
        type: 'response.created',
        response: { id: responseId, status: 'in_progress' },
      });

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (isClosed) break;
            if (!line.startsWith('data:')) continue;

            const data = line.slice(5).trim();
            if (data === '[DONE]') continue;

            try {
              const chunk = JSON.parse(data);
              const choice = chunk.choices?.[0];
              model = chunk.model || model;

              if (!choice) continue;

              if (choice.delta?.content) {
                accumulatedContent += choice.delta.content;
                emitEvent({ type: 'response.output_text.delta', delta: choice.delta.content });
              }

              if (choice.delta?.thinking?.content) {
                emitEvent({
                  type: 'response.reasoning_summary_text.delta',
                  delta: choice.delta.thinking.content,
                });
              }

              if (choice.finish_reason) {
                emitEvent({ type: 'response.output_text.done', text: accumulatedContent });
                emitEvent({
                  type: 'response.completed',
                  response: {
                    id: responseId,
                    status: 'completed',
                    model,
                    output: [
                      {
                        type: 'message',
                        role: 'assistant',
                        content: [{ type: 'output_text', text: accumulatedContent }],
                      },
                    ],
                    usage: chunk.usage
                      ? {
                          input_tokens: chunk.usage.prompt_tokens || 0,
                          output_tokens: chunk.usage.completion_tokens || 0,
                          total_tokens: chunk.usage.total_tokens || 0,
                        }
                      : undefined,
                  },
                });
              }
            } catch {
              // Ignore parse errors
            }
          }
        }
      } catch (e) {
        if (!isClosed) controller.error(e);
      } finally {
        if (!isClosed) {
          try {
            controller.close();
          } catch {
            // Already closed
          }
        }
        reader.releaseLock();
      }
    },
  });
}
