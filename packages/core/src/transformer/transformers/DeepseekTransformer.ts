/**
 * DeepseekTransformer - Transformer for DeepSeek API compatibility
 *
 * Handles:
 * - max_tokens limit (8192 max for DeepSeek)
 * - reasoning_content → thinking block conversion in streams
 *
 * @module transformer/transformers/DeepseekTransformer
 */

import type {
  LLMProvider,
  Transformer,
  TransformerContext,
  TransformerLogger,
  UnifiedChatRequest,
} from '../types';

/**
 * DeepseekTransformer handles DeepSeek-specific API adaptations
 *
 * Features:
 * - Limits max_tokens to 8192 (DeepSeek API constraint)
 * - Converts reasoning_content in stream responses to thinking blocks
 */
export class DeepseekTransformer implements Transformer {
  static TransformerName = 'deepseek';
  name = 'deepseek';
  logger?: TransformerLogger;

  /**
   * Transform request: limit max_tokens to 8192 for legacy models only
   * V4 models support up to 384K output tokens
   */
  async transformRequestIn(
    request: UnifiedChatRequest,
    _provider: LLMProvider,
    _context: TransformerContext
  ): Promise<Record<string, unknown>> {
    const isV4 = request.model?.startsWith('deepseek-v4');
    if (!isV4 && request.max_tokens && request.max_tokens > 8192) {
      this.logger?.debug('DeepSeek: Limiting max_tokens from %d to 8192', request.max_tokens);
      request.max_tokens = 8192;
    }
    return request as unknown as Record<string, unknown>;
  }

  /**
   * Transform response: convert reasoning_content to thinking blocks
   */
  async transformResponseOut(
    response: Response,
    _context: TransformerContext
  ): Promise<Response> {
    const contentType = response.headers.get('Content-Type') ?? '';

    if (contentType.includes('application/json')) {
      return this.handleJsonResponse(response);
    } else if (contentType.includes('stream') || contentType.includes('text/event-stream')) {
      return this.handleStreamResponse(response);
    }

    return response;
  }

  /**
   * Handle JSON (non-streaming) response
   */
  private async handleJsonResponse(response: Response): Promise<Response> {
    const jsonResponse = await response.json();

    // Convert reasoning_content to thinking if present
    if (jsonResponse.choices?.[0]?.message?.reasoning_content) {
      jsonResponse.choices[0].message.thinking = {
        content: jsonResponse.choices[0].message.reasoning_content,
      };
      delete jsonResponse.choices[0].message.reasoning_content;
    }

    return new Response(JSON.stringify(jsonResponse), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  /**
   * Handle streaming response - convert reasoning_content to thinking blocks
   */
  private async handleStreamResponse(response: Response): Promise<Response> {
    if (!response.body) {
      return response;
    }

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let reasoningContent = '';
    let isReasoningComplete = false;
    let buffer = '';

    const stream = new ReadableStream({
      start: async (controller) => {
        const reader = response.body!.getReader();

        const processLine = (line: string) => {
          if (line.startsWith('data: ') && line.trim() !== 'data: [DONE]') {
            try {
              const data = JSON.parse(line.slice(6));

              // Extract reasoning_content from delta
              if (data.choices?.[0]?.delta?.reasoning_content) {
                reasoningContent += data.choices[0].delta.reasoning_content;

                const thinkingChunk = {
                  ...data,
                  choices: [
                    {
                      ...data.choices[0],
                      delta: {
                        ...data.choices[0].delta,
                        thinking: {
                          content: data.choices[0].delta.reasoning_content,
                        },
                      },
                    },
                  ],
                };
                delete thinkingChunk.choices[0].delta.reasoning_content;

                const thinkingLine = `data: ${JSON.stringify(thinkingChunk)}\n\n`;
                controller.enqueue(encoder.encode(thinkingLine));
                return;
              }

              // Check if reasoning is complete (content appears after reasoning)
              if (
                data.choices?.[0]?.delta?.content &&
                reasoningContent &&
                !isReasoningComplete
              ) {
                isReasoningComplete = true;
                const signature = Date.now().toString();

                // Send thinking signature chunk
                const thinkingChunk = {
                  ...data,
                  choices: [
                    {
                      ...data.choices[0],
                      delta: {
                        ...data.choices[0].delta,
                        content: null,
                        thinking: {
                          signature: signature,
                        },
                      },
                    },
                  ],
                };

                const thinkingLine = `data: ${JSON.stringify(thinkingChunk)}\n\n`;
                controller.enqueue(encoder.encode(thinkingLine));
              }

              // Clean up reasoning_content if present
              if (data.choices?.[0]?.delta?.reasoning_content) {
                delete data.choices[0].delta.reasoning_content;
              }

              // Send the modified chunk if delta has content
              if (
                data.choices?.[0]?.delta &&
                Object.keys(data.choices[0].delta).length > 0
              ) {
                if (isReasoningComplete) {
                  data.choices[0].index++;
                }
                const modifiedLine = `data: ${JSON.stringify(data)}\n\n`;
                controller.enqueue(encoder.encode(modifiedLine));
              }
            } catch (_e) {
              // JSON parsing failed, pass through original
              controller.enqueue(encoder.encode(line + '\n'));
            }
          } else {
            // Pass through non-data lines
            controller.enqueue(encoder.encode(line + '\n'));
          }
        };

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              // Process remaining buffer
              if (buffer.trim()) {
                const lines = buffer.split('\n');
                for (const line of lines) {
                  if (line.trim()) {
                    controller.enqueue(encoder.encode(line + '\n'));
                  }
                }
              }
              break;
            }

            const chunk = decoder.decode(value, { stream: true });
            buffer += chunk;

            // Process complete lines
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                processLine(line);
              } catch (error) {
                this.logger?.error('Error processing DeepSeek stream line:', error);
                controller.enqueue(encoder.encode(line + '\n'));
              }
            }
          }
        } catch (error) {
          this.logger?.error('DeepSeek stream error:', error);
          controller.error(error);
        } finally {
          try {
            reader.releaseLock();
          } catch (e) {
            this.logger?.error('Error releasing reader lock:', e);
          }
          controller.close();
        }
      },
    });

    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      }),
    });
  }
}
