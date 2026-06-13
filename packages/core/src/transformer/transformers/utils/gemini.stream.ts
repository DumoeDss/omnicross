/**
 * Gemini Stream Processing
 *
 * Handles Gemini response transformation, including streaming responses.
 * Converts Gemini response format to OpenAI-compatible format.
 *
 * @module transformer/transformers/utils/gemini.stream
 */

import type { TransformerLogger } from '../../types';

/**
 * Gemini response candidate
 */
interface GeminiCandidate {
  content?: {
    parts?: GeminiResponsePart[];
  };
  finishReason?: string;
  groundingMetadata?: {
    groundingChunks?: Array<{
      web?: {
        uri?: string;
        title?: string;
      };
    }>;
    groundingSupports?: Array<{
      groundingChunkIndices?: number[];
      segment?: {
        text?: string;
        startIndex?: number;
        endIndex?: number;
      };
    }>;
  };
}

interface GeminiResponsePart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: {
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
  };
}

interface GeminiUsageMetadata {
  candidatesTokenCount?: number;
  promptTokenCount?: number;
  cachedContentTokenCount?: number;
  totalTokenCount?: number;
  thoughtsTokenCount?: number;
}

interface GeminiJsonResponse {
  responseId?: string;
  modelVersion?: string;
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
}

/**
 * OpenAI-compatible response format
 */
interface OpenAIResponse {
  id: string;
  choices: Array<{
    finish_reason: string | null;
    index: number;
    message: {
      content: string;
      role: string;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: {
          name: string;
          arguments: string;
        };
      }>;
      thinking?: {
        content: string;
        signature?: string;
      };
    };
  }>;
  created: number;
  model: string;
  object: string;
  usage: {
    completion_tokens: number;
    prompt_tokens: number;
    prompt_tokens_details?: {
      cached_tokens: number;
    };
    total_tokens: number;
    output_tokens_details?: {
      reasoning_tokens: number;
    };
  };
}

/**
 * Transform Gemini response to OpenAI-compatible format
 *
 * @param response - Gemini API response
 * @param providerName - Provider name for logging
 * @param logger - Optional logger
 * @returns Transformed response
 */
export async function transformResponseOut(
  response: Response,
  providerName: string,
  logger?: TransformerLogger
): Promise<Response> {
  const contentType = response.headers.get('Content-Type') ?? '';

  if (contentType.includes('application/json')) {
    return handleJsonResponse(response, providerName, logger);
  } else if (contentType.includes('stream') || contentType.includes('text/event-stream')) {
    return handleStreamResponse(response, providerName, logger);
  }

  return response;
}

/**
 * Handle JSON (non-streaming) response
 */
async function handleJsonResponse(
  response: Response,
  providerName: string,
  logger?: TransformerLogger
): Promise<Response> {
  const jsonResponse: GeminiJsonResponse = await response.json();
  logger?.debug(`${providerName} JSON response received`);

  const parts = jsonResponse.candidates?.[0]?.content?.parts || [];

  // Extract thinking content
  let thinkingContent = '';
  let thinkingSignature = '';
  const nonThinkingParts: GeminiResponsePart[] = [];

  for (const part of parts) {
    if (part.text && part.thought === true) {
      thinkingContent += part.text;
    } else {
      nonThinkingParts.push(part);
    }
  }

  // Get signature
  thinkingSignature =
    parts.find((part) => part.thoughtSignature)?.thoughtSignature ?? '';

  // Extract tool calls
  const toolCalls = nonThinkingParts
    .filter((part) => part.functionCall)
    .map((part) => ({
      id: part.functionCall?.id || `tool_${Math.random().toString(36).substring(2, 15)}`,
      type: 'function',
      function: {
        name: part.functionCall?.name ?? '',
        arguments: JSON.stringify(part.functionCall?.args || {}),
      },
    }));

  // Extract text content
  const textContent = nonThinkingParts
    .filter((part) => part.text)
    .map((part) => part.text)
    .join('\n');

  const openAIResponse: OpenAIResponse = {
    id: jsonResponse.responseId ?? '',
    choices: [
      {
        finish_reason:
          (jsonResponse.candidates?.[0]?.finishReason ?? '').toLowerCase() || null,
        index: 0,
        message: {
          content: textContent,
          role: 'assistant',
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          ...(thinkingSignature && {
            thinking: {
              content: thinkingContent || '(no content)',
              signature: thinkingSignature,
            },
          }),
        },
      },
    ],
    created: Math.floor(Date.now() / 1000),
    model: jsonResponse.modelVersion ?? '',
    object: 'chat.completion',
    usage: {
      completion_tokens: jsonResponse.usageMetadata?.candidatesTokenCount || 0,
      prompt_tokens: jsonResponse.usageMetadata?.promptTokenCount || 0,
      prompt_tokens_details: {
        cached_tokens: jsonResponse.usageMetadata?.cachedContentTokenCount || 0,
      },
      total_tokens: jsonResponse.usageMetadata?.totalTokenCount || 0,
      output_tokens_details: {
        reasoning_tokens: jsonResponse.usageMetadata?.thoughtsTokenCount || 0,
      },
    },
  };

  return new Response(JSON.stringify(openAIResponse), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Handle streaming response
 */
function handleStreamResponse(
  response: Response,
  providerName: string,
  logger?: TransformerLogger
): Response {
  if (!response.body) {
    return response;
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let signatureSent = false;
  let contentSent = false;
  let hasThinkingContent = false;
  let pendingContent = '';
  let contentIndex = 0;
  let toolCallIndex = -1;

  const stream = new ReadableStream({
    async start(controller) {
      const reader = response.body!.getReader();
      let buffer = '';

      const processLine = async (line: string) => {
        if (!line.startsWith('data: ')) return;

        const chunkStr = line.slice(6).trim();
        if (!chunkStr) return;

        logger?.debug(`${providerName} chunk: ${chunkStr.substring(0, 100)}...`);

        try {
          const chunk: GeminiJsonResponse = JSON.parse(chunkStr);

          if (!chunk.candidates?.[0]) {
            logger?.debug('Invalid chunk structure');
            return;
          }

          const candidate = chunk.candidates[0];
          const parts = candidate.content?.parts || [];

          // Process thinking content
          parts
            .filter((part) => part.text && part.thought === true)
            .forEach((part) => {
              hasThinkingContent = true;
              const thinkingChunk = createChunk({
                responseId: chunk.responseId,
                modelVersion: chunk.modelVersion,
                contentIndex,
                delta: {
                  role: 'assistant',
                  content: null,
                  thinking: { content: part.text },
                },
              });
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(thinkingChunk)}\n\n`));
            });

          // Handle signature
          const signature = parts.find((part) => part.thoughtSignature)?.thoughtSignature;
          if (signature && !signatureSent) {
            if (!hasThinkingContent) {
              // Send empty thinking content so the signature block has a valid start
              const thinkingChunk = createChunk({
                responseId: chunk.responseId,
                modelVersion: chunk.modelVersion,
                contentIndex,
                delta: {
                  role: 'assistant',
                  content: null,
                  thinking: { content: '' },
                },
              });
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(thinkingChunk)}\n\n`));
            }

            const signatureChunk = createChunk({
              responseId: chunk.responseId,
              modelVersion: chunk.modelVersion,
              contentIndex,
              delta: {
                role: 'assistant',
                content: null,
                thinking: { signature },
              },
            });
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(signatureChunk)}\n\n`));
            signatureSent = true;
            contentIndex++;

            // Send pending content
            if (pendingContent) {
              const pendingChunk = createChunk({
                responseId: chunk.responseId,
                modelVersion: chunk.modelVersion,
                contentIndex,
                delta: { role: 'assistant', content: pendingContent },
              });
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(pendingChunk)}\n\n`));
              pendingContent = '';
              contentSent = true;
            }
          }

          // Extract tool calls
          const toolCalls = parts
            .filter((part) => part.functionCall)
            .map((part) => ({
              id:
                part.functionCall?.id ||
                `ccr_tool_${Math.random().toString(36).substring(2, 15)}`,
              type: 'function',
              function: {
                name: part.functionCall?.name ?? '',
                arguments: JSON.stringify(part.functionCall?.args || {}),
              },
            }));

          // Extract text content
          const textContent = parts
            .filter((part) => part.text && part.thought !== true)
            .map((part) => part.text)
            .join('\n');

          // Handle empty content after signature
          if (!textContent && signatureSent && !contentSent) {
            // Mark as sent without emitting placeholder text.
            // Tool_call or real text content will follow, and AnthropicTransformer
            // properly closes the thinking block before opening tool_use blocks.
            contentSent = true;
          }

          // Handle content before signature (Gemini 3.x)
          if (hasThinkingContent && textContent && !signatureSent) {
            if (chunk.modelVersion?.includes('3')) {
              pendingContent += textContent;
              return;
            } else {
              // Generate signature for older models
              const signatureChunk = createChunk({
                responseId: chunk.responseId,
                modelVersion: chunk.modelVersion,
                contentIndex,
                delta: {
                  role: 'assistant',
                  content: null,
                  thinking: { signature: `ccr_${Date.now()}` },
                },
              });
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(signatureChunk)}\n\n`));
              signatureSent = true;
            }
          }

          // Send text content
          if (textContent) {
            if (!pendingContent) contentIndex++;

            const contentChunk = createChunk({
              responseId: chunk.responseId,
              modelVersion: chunk.modelVersion,
              contentIndex,
              delta: { role: 'assistant', content: textContent },
              finishReason: candidate.finishReason,
              usageMetadata: chunk.usageMetadata,
              groundingMetadata: candidate.groundingMetadata,
            });
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(contentChunk)}\n\n`));
            contentSent = true;
          }

          // Send tool calls
          if (toolCalls.length > 0) {
            for (const tool of toolCalls) {
              contentIndex++;
              toolCallIndex++;

              const toolChunk = createChunk({
                responseId: chunk.responseId,
                modelVersion: chunk.modelVersion,
                contentIndex,
                delta: {
                  role: 'assistant',
                  tool_calls: [{ ...tool, index: toolCallIndex }],
                },
                finishReason: candidate.finishReason,
                usageMetadata: chunk.usageMetadata,
                groundingMetadata: candidate.groundingMetadata,
              });
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(toolChunk)}\n\n`));
            }
            contentSent = true;
          }
        } catch (_error) {
          logger?.error(`Error parsing ${providerName} stream chunk: ${chunkStr}`);
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (buffer) await processLine(buffer);
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            await processLine(line);
          }
        }
      } catch (error) {
        controller.error(error);
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Create an OpenAI-compatible stream chunk
 */
function createChunk(options: {
  responseId?: string;
  modelVersion?: string;
  contentIndex: number;
  delta: Record<string, unknown>;
  finishReason?: string;
  usageMetadata?: GeminiUsageMetadata;
  groundingMetadata?: GeminiCandidate['groundingMetadata'];
}): Record<string, unknown> {
  const {
    responseId,
    modelVersion,
    contentIndex,
    delta,
    finishReason,
    usageMetadata,
    groundingMetadata,
  } = options;

  const chunk: Record<string, unknown> = {
    choices: [
      {
        delta,
        finish_reason: finishReason?.toLowerCase() || null,
        index: contentIndex,
        logprobs: null,
      },
    ],
    created: Math.floor(Date.now() / 1000),
    id: responseId || '',
    model: modelVersion || '',
    object: 'chat.completion.chunk',
    system_fingerprint: 'fp_a49d71b8a1',
  };

  // Add usage metadata if available
  if (usageMetadata) {
    chunk.usage = {
      completion_tokens: usageMetadata.candidatesTokenCount || 0,
      prompt_tokens: usageMetadata.promptTokenCount || 0,
      prompt_tokens_details: {
        cached_tokens: usageMetadata.cachedContentTokenCount || 0,
      },
      total_tokens: usageMetadata.totalTokenCount || 0,
      output_tokens_details: {
        reasoning_tokens: usageMetadata.thoughtsTokenCount || 0,
      },
    };
  }

  // Add grounding annotations if available
  if (groundingMetadata?.groundingChunks?.length) {
    const annotations = groundingMetadata.groundingChunks.map((groundingChunk, index) => {
      const support = groundingMetadata.groundingSupports?.find((s) =>
        s.groundingChunkIndices?.includes(index)
      );
      return {
        type: 'url_citation',
        url_citation: {
          url: groundingChunk.web?.uri || '',
          title: groundingChunk.web?.title || '',
          content: support?.segment?.text || '',
          start_index: support?.segment?.startIndex || 0,
          end_index: support?.segment?.endIndex || 0,
        },
      };
    });
    (chunk.choices as Array<{ delta: Record<string, unknown> }>)[0].delta.annotations =
      annotations;
  }

  return chunk;
}
