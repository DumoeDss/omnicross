/** Gemini provider responses → unified Chat responses. */
import type { TransformerLogger } from '../../types';
import { readAnthropicSSE } from '../AnthropicSSE';

type Data = Record<string, unknown>;
interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
  inlineData?: { mimeType?: string; mime_type?: string; data?: string };
  inline_data?: { mimeType?: string; mime_type?: string; data?: string };
}
interface GeminiCandidate {
  index?: number;
  content?: { parts?: GeminiPart[] };
  finishReason?: string;
  groundingMetadata?: {
    groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
    groundingSupports?: Array<{ groundingChunkIndices?: number[]; segment?: { text?: string; startIndex?: number; endIndex?: number } }>;
  };
}
interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
}
interface GeminiResponse {
  error?: unknown;
  responseId?: string;
  modelVersion?: string;
  candidates?: GeminiCandidate[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: GeminiUsage;
}

function finishReason(reason: string | undefined, hasTools: boolean): string | null {
  if (!reason) return null;
  if (reason === 'STOP') return hasTools ? 'tool_calls' : 'stop';
  if (reason === 'MAX_TOKENS') return 'length';
  if (['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT'].includes(reason)) return 'content_filter';
  return hasTools ? 'tool_calls' : 'stop';
}

function usage(metadata: GeminiUsage): Data {
  const reasoning = metadata.thoughtsTokenCount ?? 0;
  return {
    prompt_tokens: metadata.promptTokenCount ?? 0,
    completion_tokens: (metadata.candidatesTokenCount ?? 0) + reasoning,
    total_tokens: metadata.totalTokenCount ?? ((metadata.promptTokenCount ?? 0) + (metadata.candidatesTokenCount ?? 0) + reasoning),
    prompt_tokens_details: { cached_tokens: metadata.cachedContentTokenCount ?? 0 },
    completion_tokens_details: { reasoning_tokens: reasoning },
    output_tokens_details: { reasoning_tokens: reasoning },
  };
}

function convertParts(parts: GeminiPart[], streaming: boolean, nextToolIndex: () => number): Data {
  const message: Data = { role: 'assistant' };
  let text = '';
  let thinking = '';
  const calls: Data[] = [];
  const images: string[] = [];
  for (const part of parts) {
    if (typeof part.text === 'string') {
      if (part.thought) thinking += part.text;
      else text += part.text;
    }
    if (part.functionCall) {
      const call = part.functionCall;
      calls.push({
        ...(streaming ? { index: nextToolIndex() } : {}),
        id: call.id || `call_${crypto.randomUUID()}`,
        type: 'function',
        function: { name: call.name ?? '', arguments: JSON.stringify(call.args ?? {}) },
        ...(part.thoughtSignature ? { extra_content: { google: { thought_signature: part.thoughtSignature } } } : {}),
      });
    }
    const inline = part.inlineData ?? part.inline_data;
    if (inline?.data) images.push(`data:${inline.mimeType ?? inline.mime_type ?? 'image/png'};base64,${inline.data}`);
  }
  if (thinking) message.thinking = { content: thinking };
  if (calls.length) message.tool_calls = calls;
  if (images.length) message.images = images;
  if (!streaming || text) message.content = text;
  // Retain exact part ordering/signature attachment for Gemini endpoint replay.
  if (parts.length) message.extra_content = { google: { parts } };
  return message;
}

function annotations(candidate: GeminiCandidate): Data[] | undefined {
  const metadata = candidate.groundingMetadata;
  return metadata?.groundingChunks?.map((chunk, index) => {
    const support = metadata.groundingSupports?.find((item) => item.groundingChunkIndices?.includes(index));
    return { type: 'url_citation', url_citation: {
      url: chunk.web?.uri ?? '', title: chunk.web?.title ?? '',
      content: support?.segment?.text ?? '', start_index: support?.segment?.startIndex ?? 0,
      end_index: support?.segment?.endIndex ?? 0,
    } };
  });
}

function convertResponse(data: GeminiResponse, streaming: boolean, toolIndices: Map<number, number>, toolChoices: Set<number>): Data {
  if (data.error) return { error: data.error };
  const candidates = data.candidates ?? (data.promptFeedback?.blockReason
    ? [{ index: 0, finishReason: data.promptFeedback.blockReason, content: { parts: [] } }]
    : []);
  const failure = candidates.find((candidate) =>
    candidate.finishReason === 'MALFORMED_FUNCTION_CALL' || candidate.finishReason === 'UNEXPECTED_TOOL_CALL');
  if (failure) return { error: { type: 'upstream_generation_error', message: `Gemini generation failed: ${failure.finishReason}` } };
  const choices = candidates.map((candidate, position) => {
    const index = candidate.index ?? position;
    const message = convertParts(candidate.content?.parts ?? [], streaming, () => {
      const next = toolIndices.get(index) ?? 0;
      toolIndices.set(index, next + 1);
      return next;
    });
    if (candidate.finishReason) {
      message.extra_content = { google: { parts: candidate.content?.parts ?? [], finishReason: candidate.finishReason } };
    }
    if (message.tool_calls) toolChoices.add(index);
    const citations = annotations(candidate);
    if (citations?.length) message.annotations = citations;
    return {
      index,
      [streaming ? 'delta' : 'message']: message,
      finish_reason: finishReason(candidate.finishReason, toolChoices.has(index)),
    };
  });
  return {
    id: data.responseId ?? '', model: data.modelVersion ?? '',
    object: streaming ? 'chat.completion.chunk' : 'chat.completion',
    created: Math.floor(Date.now() / 1000), choices,
    ...(data.usageMetadata ? { usage: usage(data.usageMetadata) } : {}),
    ...(data.promptFeedback ? { extra_content: { google: { promptFeedback: data.promptFeedback } } } : {}),
  };
}

export async function transformResponseOut(response: Response, providerName: string, logger?: TransformerLogger): Promise<Response> {
  if (!response.ok) return response;
  const contentType = response.headers.get('Content-Type') ?? '';
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  if (contentType.includes('application/json')) {
    const data = await response.json();
    const converted = convertResponse(data, false, new Map(), new Set());
    return new Response(JSON.stringify(converted), { status: response.status, statusText: response.statusText, headers });
  }
  if (!contentType.includes('stream') || !response.body) return response;
  const reader = response.body.getReader();
  const encoder = new TextEncoder();
  const toolIndices = new Map<number, number>();
  const toolChoices = new Set<number>();
  let responseId = '';
  let modelVersion = '';
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        let failed = false;
        await readAnthropicSSE(reader, (data: GeminiResponse) => {
          responseId = data.responseId || responseId;
          modelVersion = data.modelVersion || modelVersion;
          data.responseId = responseId;
          data.modelVersion = modelVersion;
          const converted = convertResponse(data, true, toolIndices, toolChoices);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(converted)}\n\n`));
          if (converted.error) { failed = true; return false; }
        }, logger);
        if (!failed) controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (error) {
        logger?.error(`Error decoding ${providerName} stream`, error);
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return new Response(stream, { status: response.status, statusText: response.statusText, headers });
}
