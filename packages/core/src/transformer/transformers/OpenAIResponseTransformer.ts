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
    const input: Array<Record<string, unknown>> = [];

    for (const msg of request.messages) {
      if (msg.role === 'system') {
        input.push({
          role: 'developer',
          content: typeof msg.content === 'string' ? msg.content : flattenContent(msg.content),
        });
      } else if (msg.role === 'tool') {
        input.push({
          type: 'function_call_output',
          call_id: msg.tool_call_id,
          output: typeof msg.content === 'string' ? msg.content : '',
        });
      } else {
        const entry: Record<string, unknown> = {
          role: msg.role,
          content: typeof msg.content === 'string' ? msg.content : flattenContent(msg.content),
        };
        // Include tool_calls as function_call items
        if (msg.role === 'assistant' && msg.tool_calls?.length) {
          // For Response API, tool calls are separate output items
          // Push the assistant text first, then each function_call
          input.push(entry);
          for (const tc of msg.tool_calls) {
            input.push({
              type: 'function_call',
              id: tc.id,
              call_id: tc.id,
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
      stream: request.stream ?? false,
      ...(request.max_tokens ? { max_output_tokens: request.max_tokens } : {}),
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

    if (contentType.includes('text/event-stream')) {
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
                  emitChunk([{ index: 0, delta: {}, finish_reason: 'stop' }], usage);
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
