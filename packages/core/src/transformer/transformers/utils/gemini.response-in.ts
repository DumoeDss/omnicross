/**
 * Gemini Response-In Conversion (OpenAI → Gemini)
 *
 * Converts OpenAI-compatible responses back to Gemini API format.
 * Used when GeminiTransformer acts as endpointTransformer
 * (i.e., the client expects Gemini-format responses).
 *
 * @module transformer/transformers/utils/gemini.response-in
 */

import type { TransformerLogger } from '../../types';

// ============================================================================
// Gemini response types (output format)
// ============================================================================

interface GeminiResponsePart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: {
    id?: string;
    name: string;
    args: Record<string, unknown>;
  };
}

interface GeminiResponse {
  responseId: string;
  modelVersion: string;
  candidates: Array<{
    content: { parts: GeminiResponsePart[] };
    finishReason: string | null;
  }>;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
  };
}

// ============================================================================
// Finish reason mapping (OpenAI → Gemini)
// ============================================================================

const FINISH_REASON_TO_GEMINI: Record<string, string> = {
  stop: 'STOP',
  length: 'MAX_TOKENS',
  tool_calls: 'STOP',
  content_filter: 'SAFETY',
  // Already-lowercased Gemini reasons (pass-through from another transformer)
  max_tokens: 'MAX_TOKENS',
  safety: 'SAFETY',
};

function toGeminiFinishReason(openaiReason: string | null): string | null {
  if (!openaiReason) return null;
  return FINISH_REASON_TO_GEMINI[openaiReason] || openaiReason.toUpperCase();
}

// ============================================================================
// Non-streaming: OpenAI JSON → Gemini JSON
// ============================================================================

export function convertOpenAIResponseToGemini(
  openaiData: Record<string, unknown>
): GeminiResponse {
  const choice = (openaiData.choices as Array<Record<string, unknown>>)?.[0];
  const message = (choice?.message ?? {}) as Record<string, unknown>;
  const usage = openaiData.usage as Record<string, unknown> | undefined;
  const usagePromptDetails = usage?.prompt_tokens_details as Record<string, unknown> | undefined;
  const usageOutputDetails = usage?.output_tokens_details as Record<string, unknown> | undefined;

  const parts: GeminiResponsePart[] = [];

  // Thinking → thought parts (before text/tool)
  const thinking = message.thinking as Record<string, unknown> | undefined;
  if (thinking?.content) {
    parts.push({ text: thinking.content as string, thought: true });
  }
  if (thinking?.signature) {
    parts.push({ thoughtSignature: thinking.signature as string });
  }

  // Text content
  if (message.content) {
    parts.push({ text: message.content as string });
  }

  // Tool calls → functionCall parts
  const toolCalls = message.tool_calls as Array<Record<string, unknown>> | undefined;
  if (toolCalls?.length) {
    for (const tc of toolCalls) {
      const func = tc.function as Record<string, unknown>;
      let args: Record<string, unknown> = {};
      try {
        const raw = func.arguments as string;
        args = typeof raw === 'string' ? JSON.parse(raw) : (raw as unknown as Record<string, unknown>);
      } catch {
        args = {};
      }
      parts.push({
        functionCall: {
          id: tc.id as string,
          name: func.name as string,
          args,
        },
      });
    }
  }

  // Ensure at least one part
  if (parts.length === 0) {
    parts.push({ text: '' });
  }

  return {
    responseId: (openaiData.id as string) || '',
    modelVersion: (openaiData.model as string) || '',
    candidates: [{
      content: { parts },
      finishReason: toGeminiFinishReason(choice?.finish_reason as string | null),
    }],
    usageMetadata: usage ? {
      promptTokenCount: (usage.prompt_tokens as number) || 0,
      candidatesTokenCount: (usage.completion_tokens as number) || 0,
      totalTokenCount: (usage.total_tokens as number) || 0,
      cachedContentTokenCount: (usagePromptDetails?.cached_tokens as number) || 0,
      thoughtsTokenCount: (usageOutputDetails?.reasoning_tokens as number) || 0,
    } : undefined,
  };
}

// ============================================================================
// Streaming: OpenAI SSE → Gemini SSE
// ============================================================================

/**
 * Convert an OpenAI SSE stream to Gemini SSE format.
 *
 * Gemini streaming emits complete `functionCall` parts rather than
 * incremental argument deltas, so we accumulate partial tool-call
 * data from OpenAI and flush complete functionCall parts on:
 *   - the next tool-call starting, or
 *   - stream end / finish_reason received.
 */
export function convertOpenAIStreamToGemini(
  openaiStream: ReadableStream<Uint8Array>,
  logger?: TransformerLogger
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  // Accumulator for in-progress tool calls (keyed by OpenAI tool_call index)
  const pendingToolCalls = new Map<number, {
    id: string;
    name: string;
    args: string;
  }>();

  let model = '';
  let responseId = '';

  return new ReadableStream({
    start: async (controller) => {
      const reader = openaiStream.getReader();
      let buffer = '';
      let isClosed = false;

      const emit = (data: GeminiResponse) => {
        if (isClosed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          isClosed = true;
        }
      };

      /** Flush all pending tool calls as a single Gemini chunk */
      const flushToolCalls = () => {
        if (pendingToolCalls.size === 0) return;
        const parts: GeminiResponsePart[] = [];
        for (const tc of pendingToolCalls.values()) {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(tc.args || '{}'); } catch { /* keep empty */ }
          parts.push({
            functionCall: { id: tc.id, name: tc.name, args },
          });
        }
        pendingToolCalls.clear();
        emit({
          responseId,
          modelVersion: model,
          candidates: [{ content: { parts }, finishReason: null }],
        });
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
            if (!data || data === '[DONE]') continue;

            try {
              const chunk = JSON.parse(data);
              if (!responseId && chunk.id) responseId = chunk.id;
              if (!model && chunk.model) model = chunk.model;

              const choice = chunk.choices?.[0];
              if (!choice) continue;
              const delta = choice.delta ?? {};

              // --- Thinking ---
              if (delta.thinking) {
                const parts: GeminiResponsePart[] = [];
                if (delta.thinking.content) {
                  parts.push({ text: delta.thinking.content, thought: true });
                }
                if (delta.thinking.signature) {
                  parts.push({ thoughtSignature: delta.thinking.signature });
                }
                if (parts.length > 0) {
                  emit({
                    responseId,
                    modelVersion: model,
                    candidates: [{ content: { parts }, finishReason: null }],
                  });
                }
              }

              // --- Text content ---
              if (delta.content) {
                emit({
                  responseId,
                  modelVersion: model,
                  candidates: [{
                    content: { parts: [{ text: delta.content }] },
                    finishReason: null,
                  }],
                });
              }

              // --- Tool calls (accumulate) ---
              if (delta.tool_calls) {
                for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
                  const idx = (tc.index ?? 0) as number;
                  const existing = pendingToolCalls.get(idx);
                  const func = tc.function as Record<string, unknown> | undefined;

                  if (existing) {
                    // Append arguments
                    if (func?.arguments) {
                      existing.args += func.arguments as string;
                    }
                  } else {
                    // New tool call
                    pendingToolCalls.set(idx, {
                      id: (tc.id as string) || `tool_${Date.now()}_${idx}`,
                      name: (func?.name as string) || '',
                      args: (func?.arguments as string) || '',
                    });
                  }
                }
              }

              // --- Finish reason / usage ---
              if (choice.finish_reason) {
                flushToolCalls();

                const geminiUsage = chunk.usage ? {
                  promptTokenCount: chunk.usage.prompt_tokens || 0,
                  candidatesTokenCount: chunk.usage.completion_tokens || 0,
                  totalTokenCount: chunk.usage.total_tokens || 0,
                  cachedContentTokenCount: chunk.usage.prompt_tokens_details?.cached_tokens || 0,
                  thoughtsTokenCount: chunk.usage.output_tokens_details?.reasoning_tokens || 0,
                } : undefined;

                emit({
                  responseId,
                  modelVersion: model,
                  candidates: [{
                    content: { parts: [{ text: '' }] },
                    finishReason: toGeminiFinishReason(choice.finish_reason) || 'STOP',
                  }],
                  usageMetadata: geminiUsage,
                });
              }
            } catch (e) {
              logger?.error(`Error parsing OpenAI stream chunk for Gemini conversion: ${e}`);
            }
          }
        }

        // Flush any remaining tool calls
        flushToolCalls();
      } catch (e) {
        if (!isClosed) controller.error(e);
      } finally {
        if (!isClosed) {
          try { controller.close(); } catch { /* already closed */ }
        }
        reader.releaseLock();
      }
    },
  });
}

/**
 * Convert an OpenAI-compatible Response to Gemini format.
 * Handles both JSON and streaming responses.
 */
export async function transformResponseIn(
  response: Response,
  logger?: TransformerLogger
): Promise<Response> {
  const contentType = response.headers.get('Content-Type') ?? '';

  if (contentType.includes('text/event-stream')) {
    if (!response.body) {
      throw new Error('Stream response body is null');
    }
    const geminiStream = convertOpenAIStreamToGemini(response.body, logger);
    return new Response(geminiStream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  }

  // Non-streaming JSON
  const data = await response.json();
  const geminiResponse = convertOpenAIResponseToGemini(data);
  return new Response(JSON.stringify(geminiResponse), {
    status: response.status,
    statusText: response.statusText,
    headers: { 'Content-Type': 'application/json' },
  });
}
