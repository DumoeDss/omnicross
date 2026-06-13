/**
 * AnthropicTransformer - Bidirectional transformer for Anthropic Messages API.
 *
 * This file is a thin facade that delegates to sibling modules in this
 * directory:
 * - `./AnthropicTypes`            - shared types + small helpers
 * - `./AnthropicConversion`       - non-streaming request/response conversion
 *                                   (re-exports response converters from
 *                                   `./AnthropicResponseConversion`)
 * - `./AnthropicStreaming`        - SSE stream conversion (both directions)
 * - `./AnthropicToolHandling`     - tool_use / server-tool conversion
 *
 * Public API (class name, constructor signature, method signatures) is
 * preserved exactly so existing import sites (proxy servers, engine
 * adapters, `TransformerHandler`, etc.) require no changes.
 *
 * @module transformer/transformers/AnthropicTransformer
 */

import type {
  LLMProvider,
  Transformer,
  TransformerContext,
  TransformerLogger,
  TransformerOptions,
  UnifiedChatRequest,
} from '../types';

import {
  buildAnthropicRequestBody,
  convertAnthropicResponseToOpenAI,
  convertOpenAIResponseToAnthropic,
  transformAnthropicRequestToUnified,
} from './AnthropicConversion';
import {
  convertAnthropicStreamToOpenAI,
  convertOpenAIStreamToAnthropic,
} from './AnthropicStreaming';

// Re-export internal types so legacy consumers that imported from
// `./AnthropicTransformer` continue to compile (none in tree today, but cheap
// to keep the facade complete).
export type {
  AnthropicContent,
  AnthropicImageContent,
  AnthropicMessage,
  AnthropicRequest,
  AnthropicTextContent,
  AnthropicThinkingContent,
  AnthropicToolResultContent,
  AnthropicToolUseContent,
} from './AnthropicTypes';

/**
 * AnthropicTransformer handles Anthropic Messages API format conversion.
 *
 * Features:
 * - Converts Anthropic Messages API requests to unified format
 * - Converts responses back to Anthropic format
 * - Supports both x-api-key and Bearer authentication
 * - Handles thinking/reasoning blocks
 */
export class AnthropicTransformer implements Transformer {
  static TransformerName = 'anthropic';
  name = 'anthropic';
  logger?: TransformerLogger;
  endPoint = '/v1/messages';

  private useBearer: boolean;

  constructor(options?: TransformerOptions) {
    this.useBearer = (options?.UseBearer as boolean) ?? false;
  }

  /**
   * Handle authentication - Anthropic uses x-api-key header
   */
  async auth(
    request: unknown,
    provider: LLMProvider,
    _context: TransformerContext
  ): Promise<{ body: unknown; config: { headers: Record<string, string | undefined> } }> {
    const headers: Record<string, string | undefined> = {};

    if (this.useBearer) {
      headers['authorization'] = `Bearer ${provider.apiKey}`;
      headers['x-api-key'] = undefined;
    } else {
      headers['x-api-key'] = provider.apiKey;
      headers['authorization'] = undefined;
    }

    return {
      body: request,
      config: { headers },
    };
  }

  /**
   * Transform Anthropic request to unified format.
   */
  async transformRequestOut(
    request: unknown,
    _context: TransformerContext
  ): Promise<UnifiedChatRequest> {
    return transformAnthropicRequestToUnified(request);
  }

  /**
   * Transform OpenAI/unified response back to Anthropic format
   * (auto-detects stream vs JSON via Content-Type).
   */
  async transformResponseIn(
    response: Response,
    context?: TransformerContext
  ): Promise<Response> {
    const contentType = response.headers.get('Content-Type') ?? '';

    if (contentType.includes('text/event-stream')) {
      if (!response.body) {
        throw new Error('Stream response body is null');
      }
      const convertedStream = convertOpenAIStreamToAnthropic(response.body, context, this.logger);
      return new Response(convertedStream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    } else {
      const data = await response.json();
      const anthropicResponse = convertOpenAIResponseToAnthropic(data);
      return new Response(JSON.stringify(anthropicResponse), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  /**
   * Transform unified request to Anthropic Messages API format.
   * This is the reverse of transformRequestOut — converts OpenAI/unified format
   * to Anthropic's expected request body structure.
   */
  async transformRequestIn(
    request: UnifiedChatRequest,
    _provider: LLMProvider,
    _context: TransformerContext
  ): Promise<Record<string, unknown>> {
    return buildAnthropicRequestBody(request);
  }

  /**
   * Transform Anthropic response to OpenAI/unified format
   * (auto-detects stream vs JSON via Content-Type).
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
      const convertedStream = convertAnthropicStreamToOpenAI(response.body, this.logger);
      return new Response(convertedStream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    } else {
      const data = await response.json();
      const openaiResponse = convertAnthropicResponseToOpenAI(data);
      return new Response(JSON.stringify(openaiResponse), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
}
