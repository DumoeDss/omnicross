/** Unified Chat responses → Gemini endpoint responses. */
import type { TransformerLogger } from '../../types';
import { readAnthropicSSE } from '../AnthropicSSE';

type Data = Record<string, unknown>;
interface GeminiResponse {
  responseId: string;
  modelVersion: string;
  candidates: Array<{ index: number; content: { role: string; parts: Data[] }; finishReason: string | null }>;
  usageMetadata?: Record<string, number>;
  promptFeedback?: unknown;
}
interface GoogleMetadata {
  google?: { parts?: Data[]; thought_signature?: string; promptFeedback?: unknown; finishReason?: string };
}
interface ChatToolCall {
  id?: string;
  index?: number;
  function: { name?: string; arguments?: string };
  extra_content?: GoogleMetadata;
}
interface ChatMessage {
  content?: string | null | Array<{ type: string; text?: string }>;
  role?: string;
  reasoning_content?: string;
  thinking?: { content?: string; signature?: string };
  images?: Array<string | { image_url?: { url?: string } }>;
  tool_calls?: ChatToolCall[];
  extra_content?: GoogleMetadata;
}
interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}
interface ChatResponse {
  id?: string;
  model?: string;
  error?: unknown;
  choices?: Array<{ index?: number; message?: ChatMessage; delta?: ChatMessage; finish_reason?: string | null }>;
  usage?: ChatUsage;
  extra_content?: GoogleMetadata;
}

const FINISH_REASONS: Record<string, string> = {
  stop: 'STOP', tool_calls: 'STOP', length: 'MAX_TOKENS', max_tokens: 'MAX_TOKENS',
  content_filter: 'SAFETY', safety: 'SAFETY',
};

function responseParts(message: ChatMessage): Data[] {
  const native = message.extra_content?.google?.parts;
  if (Array.isArray(native)) return native;
  const parts: Data[] = [];
  const reasoning = message.reasoning_content ?? message.thinking?.content;
  if (reasoning) parts.push({ text: reasoning, thought: true });
  if (typeof message.content === 'string' && message.content) parts.push({ text: message.content });
  else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === 'text') parts.push({ text: part.text });
    }
  }
  for (const image of message.images ?? []) {
    const url = typeof image === 'string' ? image : image.image_url?.url;
    const match = typeof url === 'string' ? /^data:([^;,]+);base64,([\s\S]*)$/.exec(url) : null;
    if (!match) throw new Error('Gemini generated images require a base64 data URL');
    parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
  }
  for (const call of message.tool_calls ?? []) {
    const raw = call.function?.arguments;
    const args = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw ?? {});
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Gemini function arguments must be an object');
    const signature = call.extra_content?.google?.thought_signature;
    parts.push({ functionCall: { id: call.id, name: call.function.name, args }, ...(signature ? { thoughtSignature: signature } : {}) });
  }
  return parts;
}

function convertUsage(usage: ChatUsage): Record<string, number> {
  const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens ?? 0;
  return {
    promptTokenCount: usage.prompt_tokens ?? 0,
    candidatesTokenCount: Math.max(0, (usage.completion_tokens ?? 0) - reasoning),
    totalTokenCount: usage.total_tokens ?? ((usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0)),
    cachedContentTokenCount: usage.prompt_tokens_details?.cached_tokens ?? 0,
    thoughtsTokenCount: reasoning,
  };
}

export function convertOpenAIResponseToGemini(data: ChatResponse): GeminiResponse {
  if (data.error) throw new Error(`Cannot convert an upstream error into Gemini candidates: ${JSON.stringify(data.error)}`);
  return {
    responseId: data.id ?? '', modelVersion: data.model ?? '',
    candidates: (data.choices ?? []).map((choice, index) => ({
      index: choice.index ?? index,
      content: { role: 'model', parts: responseParts(choice.message ?? {}) },
      finishReason: choice.message?.extra_content?.google?.finishReason ??
        (choice.finish_reason ? (FINISH_REASONS[choice.finish_reason] ?? choice.finish_reason.toUpperCase()) : null),
    })),
    ...(data.usage ? { usageMetadata: convertUsage(data.usage) } : {}),
    ...(data.extra_content?.google?.promptFeedback ? { promptFeedback: data.extra_content.google.promptFeedback } : {}),
  };
}

export function convertOpenAIStreamToGemini(openaiStream: ReadableStream<Uint8Array>, logger?: TransformerLogger): ReadableStream<Uint8Array> {
  const reader = openaiStream.getReader();
  const encoder = new TextEncoder();
  const pending = new Map<number, Map<number, ChatToolCall & { function: { name: string; arguments: string } }>>();
  let model = '';
  let responseId = '';
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (value: Data) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
      const flushCalls = (choiceIndex: number): Data[] => {
        const calls = pending.get(choiceIndex);
        if (!calls) return [];
        pending.delete(choiceIndex);
        return responseParts({ tool_calls: [...calls.values()] });
      };
      try {
        let failed = false;
        await readAnthropicSSE(reader, (chunk: ChatResponse) => {
          if (chunk.error) { failed = true; emit({ error: chunk.error }); return false; }
          responseId = chunk.id || responseId;
          model = chunk.model || model;
          const candidates: Data[] = [];
          for (const choice of chunk.choices ?? []) {
            const index = choice.index ?? 0;
            const delta = choice.delta ?? {};
            const native = Array.isArray(delta.extra_content?.google?.parts);
            const parts = responseParts(native ? delta : { ...delta, tool_calls: undefined });
            if (!native) {
              for (const call of delta.tool_calls ?? []) {
                let calls = pending.get(index);
                if (!calls) { calls = new Map(); pending.set(index, calls); }
                const callIndex = call.index ?? 0;
                let accumulated = calls.get(callIndex);
                if (!accumulated) {
                  accumulated = { id: call.id, function: { name: '', arguments: '' } };
                  calls.set(callIndex, accumulated);
                }
                if (call.id) accumulated.id = call.id;
                if (call.function?.name) accumulated.function.name += call.function.name;
                if (call.function?.arguments) accumulated.function.arguments += call.function.arguments;
                if (call.extra_content) accumulated.extra_content = call.extra_content;
              }
            }
            if (choice.finish_reason) parts.push(...flushCalls(index));
            if (parts.length || choice.finish_reason) candidates.push({
              index, content: { role: 'model', parts },
              finishReason: delta.extra_content?.google?.finishReason ??
                (choice.finish_reason ? (FINISH_REASONS[choice.finish_reason] ?? choice.finish_reason.toUpperCase()) : null),
            });
          }
          if (candidates.length || chunk.usage || chunk.extra_content?.google?.promptFeedback) emit({
            responseId, modelVersion: model, candidates,
            ...(chunk.usage ? { usageMetadata: convertUsage(chunk.usage) } : {}),
            ...(chunk.extra_content?.google?.promptFeedback ? { promptFeedback: chunk.extra_content.google.promptFeedback } : {}),
          });
        }, logger);
        if (!failed) {
          for (const index of pending.keys()) {
            emit({ responseId, modelVersion: model, candidates: [{ index, content: { role: 'model', parts: flushCalls(index) }, finishReason: null }] });
          }
        }
        controller.close();
      } catch (error) {
        logger?.error('Error converting OpenAI stream to Gemini', error);
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}

export async function transformResponseIn(response: Response, logger?: TransformerLogger): Promise<Response> {
  if (!response.ok) return response;
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  if (headers.get('Content-Type')?.includes('text/event-stream')) {
    if (!response.body) throw new Error('Stream response body is null');
    return new Response(convertOpenAIStreamToGemini(response.body, logger), { status: response.status, statusText: response.statusText, headers });
  }
  const data = await response.json();
  if (data.error) return new Response(JSON.stringify(data), { status: response.status, statusText: response.statusText, headers });
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(convertOpenAIResponseToGemini(data)), { status: response.status, statusText: response.statusText, headers });
}
