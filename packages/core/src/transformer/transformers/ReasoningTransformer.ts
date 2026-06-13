/**
 * ReasoningTransformer - Transformer for reasoning/thinking mode support
 *
 * Handles:
 * - Converting reasoning config to thinking API parameters
 * - Converting reasoning_content in responses to thinking blocks
 * - Calculating thinking budget based on model and effort level
 *
 * @module transformer/transformers/ReasoningTransformer
 */

import { buildAnthropicThinking,
  buildQwenThinkingConfig,
  calculateThinkingBudget,
  getOpenAIReasoningEffort } from '@omnicross/contracts/thinking-config';

import type {
  LLMProvider,
  Transformer,
  TransformerContext,
  TransformerLogger,
  TransformerOptions,
  UnifiedChatRequest,
} from '../types';

/**
 * Extended request type for reasoning support
 */
interface ReasoningEnabledRequest extends UnifiedChatRequest {
  thinking?: {
    type: 'enabled' | 'disabled';
    budget_tokens?: number;
  };
  enable_thinking?: boolean;
  thinking_budget?: number;
  reasoning_effort?: string;
}

/**
 * ReasoningTransformer handles reasoning/thinking mode for compatible models
 *
 * Features:
 * - Converts reasoning config to thinking API parameters
 * - Can be enabled/disabled via options
 * - Converts reasoning_content in stream responses to thinking blocks
 */
export class ReasoningTransformer implements Transformer {
  static TransformerName = 'reasoning';
  name = 'reasoning';
  logger?: TransformerLogger;

  private enabled: boolean;

  constructor(options?: TransformerOptions) {
    this.enabled = options?.enable !== false;
  }

  /**
   * Transform request: convert reasoning config to thinking parameters
   * Uses model-specific budget calculation based on effort level
   */
  async transformRequestIn(
    request: UnifiedChatRequest,
    provider: LLMProvider,
    _context: TransformerContext
  ): Promise<Record<string, unknown>> {
    const extendedRequest = request as ReasoningEnabledRequest;
    const modelId = request.model;

    if (!this.enabled) {
      extendedRequest.thinking = {
        type: 'disabled',
        budget_tokens: -1,
      };
      extendedRequest.enable_thinking = false;
      return extendedRequest as unknown as Record<string, unknown>;
    }

    if (request.reasoning) {
      const effortLevel = request.reasoning.effort || 'none';
      const userMaxTokens = request.reasoning.max_tokens || request.max_tokens;

      // Calculate budget based on model and effort level
      const calculatedBudget = calculateThinkingBudget(modelId, effortLevel, userMaxTokens);

      // Determine provider type for appropriate config
      const providerName = provider.name?.toLowerCase() || '';

      if (providerName === 'anthropic' || providerName.includes('claude')) {
        // Anthropic/Claude: use thinking object with budget_tokens
        const thinkingConfig = buildAnthropicThinking(modelId, effortLevel, userMaxTokens);
        if (thinkingConfig) {
          extendedRequest.thinking = thinkingConfig;
        } else {
          extendedRequest.thinking = {
            type: 'disabled',
          };
        }
      } else if (providerName === 'openai' || modelId.match(/^o[134]/i)) {
        // OpenAI o-series: use reasoning_effort parameter
        const reasoningEffort = getOpenAIReasoningEffort(effortLevel);
        if (reasoningEffort) {
          extendedRequest.reasoning_effort = reasoningEffort;
        }
        // Also set thinking for compatibility
        extendedRequest.thinking = {
          type: effortLevel === 'none' ? 'disabled' : 'enabled',
          budget_tokens: calculatedBudget,
        };
      } else if (providerName === 'deepseek' && modelId?.startsWith('deepseek-v4')) {
        // DeepSeek V4: use thinking object + reasoning_effort ("high" or "max")
        extendedRequest.thinking = {
          type: effortLevel === 'none' ? 'disabled' : 'enabled',
          budget_tokens: calculatedBudget,
        };
        if (effortLevel !== 'none') {
          // V4 only accepts "high" or "max" (low/medium map to "high")
          extendedRequest.reasoning_effort = effortLevel === 'high' ? 'max' : 'high';
        }
      } else if (providerName === 'deepseek' || providerName === 'qwen' || providerName === 'alibaba') {
        // Legacy DeepSeek/Qwen: use enable_thinking and thinking_budget
        const qwenConfig = buildQwenThinkingConfig(effortLevel, userMaxTokens);
        extendedRequest.enable_thinking = qwenConfig.enable_thinking;
        if (qwenConfig.thinking_budget) {
          extendedRequest.thinking_budget = qwenConfig.thinking_budget;
        }
        // Also set thinking for compatibility
        extendedRequest.thinking = {
          type: qwenConfig.enable_thinking ? 'enabled' : 'disabled',
          budget_tokens: calculatedBudget,
        };
      } else {
        // Default: use generic thinking config
        extendedRequest.thinking = {
          type: effortLevel === 'none' ? 'disabled' : 'enabled',
          budget_tokens: calculatedBudget,
        };
        extendedRequest.enable_thinking = effortLevel !== 'none';
      }

      this.logger?.debug(`[ReasoningTransformer] Model: ${modelId}, Effort: ${effortLevel}, Budget: ${calculatedBudget}`);
    }

    return extendedRequest as unknown as Record<string, unknown>;
  }

  /**
   * Transform response: convert reasoning_content to thinking blocks
   */
  async transformResponseOut(
    response: Response,
    _context: TransformerContext
  ): Promise<Response> {
    if (!this.enabled) return response;

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

    if (jsonResponse.choices?.[0]?.message?.reasoning_content) {
      jsonResponse.thinking = {
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
  private handleStreamResponse(response: Response): Response {
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
          this.logger?.debug('Processing reasoning line:', line);

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

              // Check if reasoning is complete (content or tool_calls appears)
              if (
                (data.choices?.[0]?.delta?.content || data.choices?.[0]?.delta?.tool_calls) &&
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
                delete thinkingChunk.choices[0].delta.reasoning_content;

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
                this.logger?.error('Error processing reasoning stream line:', error);
                controller.enqueue(encoder.encode(line + '\n'));
              }
            }
          }
        } catch (error) {
          this.logger?.error('Reasoning stream error:', error);
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
