/**
 * DeepseekTransformer Unit Tests
 *
 * Tests for DeepSeek-specific transformations:
 * - max_tokens limit (8192)
 * - reasoning_content to thinking block conversion
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DeepseekTransformer } from '../transformers/DeepseekTransformer';
import type { LLMProvider, TransformerContext,UnifiedChatRequest } from '../types';

// Mock logger
const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

// Mock provider
const mockProvider: LLMProvider = {
  name: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  apiKey: 'test-key',
  models: ['deepseek-chat', 'deepseek-reasoner'],
};

// Mock context
const mockContext: TransformerContext = {
  logger: mockLogger,
  providerName: 'deepseek',
};

describe('DeepseekTransformer', () => {
  let transformer: DeepseekTransformer;

  beforeEach(() => {
    transformer = new DeepseekTransformer();
    transformer.logger = mockLogger;
    vi.clearAllMocks();
  });

  describe('transformRequestIn', () => {
    it('limits max_tokens to 8192 when exceeding limit', async () => {
      const request: UnifiedChatRequest = {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 16000,
      };

      const result = await transformer.transformRequestIn(request, mockProvider, mockContext);

      expect(result.max_tokens).toBe(8192);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Limiting max_tokens'),
        16000
      );
    });

    it('keeps max_tokens when within limit', async () => {
      const request: UnifiedChatRequest = {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 4096,
      };

      const result = await transformer.transformRequestIn(request, mockProvider, mockContext);

      expect(result.max_tokens).toBe(4096);
    });

    it('keeps max_tokens at exactly 8192', async () => {
      const request: UnifiedChatRequest = {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 8192,
      };

      const result = await transformer.transformRequestIn(request, mockProvider, mockContext);

      expect(result.max_tokens).toBe(8192);
    });

    it('handles request without max_tokens', async () => {
      const request: UnifiedChatRequest = {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const result = await transformer.transformRequestIn(request, mockProvider, mockContext);

      expect(result.max_tokens).toBeUndefined();
    });
  });

  describe('transformResponseOut', () => {
    describe('JSON response handling', () => {
      it('converts reasoning_content to thinking block', async () => {
        const jsonResponse = {
          id: 'chatcmpl-123',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: 'The answer is 42.',
              reasoning_content: 'Let me think about this carefully...',
            },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        };

        const response = new Response(JSON.stringify(jsonResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });

        const result = await transformer.transformResponseOut(response, mockContext);
        const resultJson = await result.json();

        expect(resultJson.choices[0].message.thinking).toEqual({
          content: 'Let me think about this carefully...',
        });
        expect(resultJson.choices[0].message.reasoning_content).toBeUndefined();
      });

      it('passes through response without reasoning_content', async () => {
        const jsonResponse = {
          id: 'chatcmpl-123',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: 'Hello!',
            },
            finish_reason: 'stop',
          }],
        };

        const response = new Response(JSON.stringify(jsonResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });

        const result = await transformer.transformResponseOut(response, mockContext);
        const resultJson = await result.json();

        expect(resultJson.choices[0].message.thinking).toBeUndefined();
        expect(resultJson.choices[0].message.content).toBe('Hello!');
      });
    });

    describe('Stream response handling', () => {
      it('converts reasoning_content chunks to thinking blocks', async () => {
        const chunks = [
          'data: {"id":"1","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
          'data: {"id":"1","choices":[{"index":0,"delta":{"reasoning_content":"Think"}}]}\n\n',
          'data: {"id":"1","choices":[{"index":0,"delta":{"reasoning_content":"ing..."}}]}\n\n',
          'data: {"id":"1","choices":[{"index":0,"delta":{"content":"Answer"}}]}\n\n',
          'data: [DONE]\n\n',
        ];

        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            for (const chunk of chunks) {
              controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
          },
        });

        const response = new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });

        const result = await transformer.transformResponseOut(response, mockContext);

        // Read all chunks from the transformed stream
        const reader = result.body!.getReader();
        const decoder = new TextDecoder();
        let fullContent = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          fullContent += decoder.decode(value, { stream: true });
        }

        // Verify thinking blocks are created
        expect(fullContent).toContain('"thinking"');
        expect(fullContent).toContain('"content":"Think"');
        expect(fullContent).toContain('"content":"ing..."');
      });

      it('adds signature when transitioning from reasoning to content', async () => {
        const chunks = [
          'data: {"id":"1","choices":[{"index":0,"delta":{"reasoning_content":"Thinking"}}]}\n\n',
          'data: {"id":"1","choices":[{"index":0,"delta":{"content":"Result"}}]}\n\n',
          'data: [DONE]\n\n',
        ];

        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            for (const chunk of chunks) {
              controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
          },
        });

        const response = new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });

        const result = await transformer.transformResponseOut(response, mockContext);

        const reader = result.body!.getReader();
        const decoder = new TextDecoder();
        let fullContent = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          fullContent += decoder.decode(value, { stream: true });
        }

        // Should contain signature in thinking block
        expect(fullContent).toContain('"signature"');
      });

      it('passes through non-stream responses unchanged', async () => {
        const response = new Response('plain text', {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        });

        const result = await transformer.transformResponseOut(response, mockContext);
        const text = await result.text();

        expect(text).toBe('plain text');
      });

      it('handles empty stream body', async () => {
        const response = new Response(null, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });

        const result = await transformer.transformResponseOut(response, mockContext);

        expect(result.body).toBeNull();
      });
    });
  });

  describe('transformer properties', () => {
    it('has correct name', () => {
      expect(transformer.name).toBe('deepseek');
    });
  });
});
