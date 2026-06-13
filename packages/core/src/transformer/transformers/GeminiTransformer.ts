/**
 * GeminiTransformer - Bidirectional transformer for Google Gemini API
 *
 * Handles:
 * - Request: Gemini → unified (transformRequestOut, for endpoint decoding)
 * - Request: unified → Gemini (transformRequestIn, for provider encoding)
 * - Response: Gemini → OpenAI (transformResponseOut, for provider decoding)
 * - Response: OpenAI → Gemini (transformResponseIn, for endpoint encoding)
 * - Authentication with x-goog-api-key or Bearer header
 *
 * @module transformer/transformers/GeminiTransformer
 */

import type {
  LLMProvider,
  Transformer,
  TransformerContext,
  TransformerLogger,
  TransformerOptions,
  UnifiedChatRequest,
} from '../types';

import { transformResponseIn } from './utils/gemini.response-in';
import { transformResponseOut } from './utils/gemini.stream';
import { buildRequestBody, transformRequestOut as toUnifiedRequest } from './utils/gemini.util';

/**
 * GeminiTransformer handles Google Gemini API format conversion
 *
 * Features:
 * - Converts UnifiedChatRequest to Gemini Contents format
 * - Handles thinking/reasoning mode with thinkingConfig
 * - Converts Gemini responses to OpenAI-compatible format and vice versa
 * - Supports both streaming and non-streaming responses
 * - Supports x-goog-api-key (official) and Bearer (relay) authentication
 */
export class GeminiTransformer implements Transformer {
  static TransformerName = 'gemini';
  name = 'gemini';
  logger?: TransformerLogger;

  /**
   * API endpoint pattern for Gemini
   * :modelAndAction will be replaced with actual model and action
   */
  endPoint = '/v1beta/models/:modelAndAction';

  /** Use Bearer token instead of x-goog-api-key (for relay providers) */
  private useBearer: boolean;

  constructor(options?: TransformerOptions) {
    this.useBearer = (options?.UseBearer as boolean) ?? false;
  }

  /**
   * Handle authentication
   * - Official Gemini: x-goog-api-key header
   * - Relay providers: Authorization: Bearer header
   */
  async auth(
    request: unknown,
    provider: LLMProvider,
    _context: TransformerContext
  ): Promise<{ body: unknown; config: { headers: Record<string, string | undefined> } }> {
    const headers: Record<string, string | undefined> = {};

    if (this.useBearer) {
      headers['authorization'] = `Bearer ${provider.apiKey}`;
      headers['x-goog-api-key'] = undefined;
    } else {
      headers['x-goog-api-key'] = provider.apiKey;
      headers['authorization'] = undefined;
    }

    return {
      body: request,
      config: { headers },
    };
  }

  /**
   * Transform request from unified format to Gemini format
   * Also builds the correct URL for the Gemini API
   */
  async transformRequestIn(
    request: UnifiedChatRequest,
    provider: LLMProvider,
    _context: TransformerContext
  ): Promise<Record<string, unknown>> {
    const body = buildRequestBody(request);

    // Build the Gemini API URL
    const action = request.stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    const url = new URL(`./${request.model}:${action}`, provider.baseUrl);

    const headers: Record<string, string | undefined> = {};

    if (this.useBearer) {
      headers['authorization'] = `Bearer ${provider.apiKey}`;
      headers['x-goog-api-key'] = undefined;
    } else {
      headers['x-goog-api-key'] = provider.apiKey;
      // Remove standard Authorization header for Gemini
      headers['Authorization'] = undefined;
    }

    return {
      body,
      config: { url, headers },
    };
  }

  /**
   * Transform incoming request to unified format
   * (For requests coming into the Gemini endpoint)
   */
  async transformRequestOut(
    request: unknown,
    _context: TransformerContext
  ): Promise<UnifiedChatRequest> {
    return toUnifiedRequest(request as Record<string, unknown>);
  }

  /**
   * Transform Gemini response to OpenAI-compatible format
   */
  async transformResponseOut(
    response: Response,
    _context: TransformerContext
  ): Promise<Response> {
    return transformResponseOut(response, this.name, this.logger);
  }

  /**
   * Transform OpenAI-compatible response back to Gemini format
   * (For endpoint mode — returning Gemini-format responses to the client)
   */
  async transformResponseIn(
    response: Response,
    _context?: TransformerContext
  ): Promise<Response> {
    return transformResponseIn(response, this.logger);
  }
}
