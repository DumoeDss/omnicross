/**
 * ReasoningTransformer Unit Tests
 *
 * Tests for reasoning/thinking mode support:
 * - Converting reasoning config to thinking parameters
 * - Converting reasoning_content to thinking blocks
 * - Enable/disable functionality
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ReasoningTransformer } from '../transformers/ReasoningTransformer';
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
  name: 'test-provider',
  baseUrl: 'https://api.test.com',
  apiKey: 'test-key',
  models: ['model-a'],
};

// Mock context
const mockContext: TransformerContext = {
  logger: mockLogger,
  providerName: 'test-provider',
};

describe('ReasoningTransformer', () => {
  let transformer: ReasoningTransformer;

  beforeEach(() => {
    transformer = new ReasoningTransformer();
    transformer.logger = mockLogger;
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('enables by default', () => {
      const t = new ReasoningTransformer();
      expect(t.name).toBe('reasoning');
    });

    it('can be disabled via options', async () => {
      const disabledTransformer = new ReasoningTransformer({ enable: false });

      const request: UnifiedChatRequest = {
        model: 'test',
        messages: [{ role: 'user', content: 'Hello' }],
        reasoning: { enabled: true, max_tokens: 10000 },
      };

      const result = await disabledTransformer.transformRequestIn(
        request,
        mockProvider,
        mockContext
      );

      expect((result as any).thinking).toEqual({
        type: 'disabled',
        budget_tokens: -1,
      });
      expect((result as any).enable_thinking).toBe(false);
    });
  });

  describe('transformRequestIn', () => {
    it('converts reasoning config to thinking parameters', async () => {
      const request: UnifiedChatRequest = {
        model: 'test',
        messages: [{ role: 'user', content: 'Hello' }],
        reasoning: {
          enabled: true,
          effort: 'medium',
          max_tokens: 15000,
        },
      };

      const result = await transformer.transformRequestIn(request, mockProvider, mockContext);

      // Adaptive-thinking contract: the budget is derived from the effort
      // level via calculateThinkingBudget, not passed through verbatim. For an
      // unknown model with no token-limit entry and userMaxTokens=15000 at the
      // 'medium' ratio (0.5): min(15000*0.5, 15000*0.75) = 7500.
      expect((result as any).thinking).toEqual({
        type: 'enabled',
        budget_tokens: 7500,
      });
      expect((result as any).enable_thinking).toBe(true);
    });

    it('disables thinking when no effort level is provided', async () => {
      // Without an effort level, effortLevel defaults to 'none', which the
      // adaptive-thinking contract treats as "thinking off".
      const request: UnifiedChatRequest = {
        model: 'test',
        messages: [{ role: 'user', content: 'Hello' }],
        reasoning: {
          enabled: true,
          max_tokens: 15000,
        },
      };

      const result = await transformer.transformRequestIn(request, mockProvider, mockContext);

      expect((result as any).thinking).toEqual({
        type: 'disabled',
        budget_tokens: undefined,
      });
      expect((result as any).enable_thinking).toBe(false);
    });

    it('passes through request without reasoning config', async () => {
      const request: UnifiedChatRequest = {
        model: 'test',
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const result = await transformer.transformRequestIn(request, mockProvider, mockContext);

      expect((result as any).thinking).toBeUndefined();
      expect((result as any).enable_thinking).toBeUndefined();
    });

    it('handles reasoning config without max_tokens', async () => {
      const request: UnifiedChatRequest = {
        model: 'test',
        messages: [{ role: 'user', content: 'Hello' }],
        reasoning: {
          enabled: true,
          effort: 'medium',
        },
      };

      const result = await transformer.transformRequestIn(request, mockProvider, mockContext);

      // With an effort level but no max_tokens (and no token-limit entry for
      // the model), calculateThinkingBudget cannot compute a budget and
      // returns undefined, while thinking stays enabled.
      expect((result as any).thinking).toEqual({
        type: 'enabled',
        budget_tokens: undefined,
      });
    });
  });

  describe('transformResponseOut', () => {
    describe('JSON response handling', () => {
      it('converts reasoning_content to thinking in response', async () => {
        const jsonResponse = {
          id: 'test-123',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: 'The answer.',
              reasoning_content: 'Let me think...',
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

        expect(resultJson.thinking).toEqual({
          content: 'Let me think...',
        });
        expect(resultJson.choices[0].message.reasoning_content).toBeUndefined();
      });

      it('passes through response without reasoning_content', async () => {
        const jsonResponse = {
          id: 'test-123',
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

        expect(resultJson.thinking).toBeUndefined();
        expect(resultJson.choices[0].message.content).toBe('Hello!');
      });

      it('skips transformation when disabled', async () => {
        const disabledTransformer = new ReasoningTransformer({ enable: false });

        const jsonResponse = {
          choices: [{
            message: {
              content: 'Test',
              reasoning_content: 'Should be kept',
            },
          }],
        };

        const response = new Response(JSON.stringify(jsonResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });

        const result = await disabledTransformer.transformResponseOut(response, mockContext);

        // When disabled, response should be passed through unchanged
        expect(result.headers.get('Content-Type')).toBe('application/json');
      });
    });

    describe('Stream response handling', () => {
      it('converts reasoning_content chunks to thinking blocks', async () => {
        const chunks = [
          'data: {"id":"1","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
          'data: {"id":"1","choices":[{"index":0,"delta":{"reasoning_content":"Deep"}}]}\n\n',
          'data: {"id":"1","choices":[{"index":0,"delta":{"reasoning_content":" thought"}}]}\n\n',
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

        // Verify thinking blocks are created
        expect(fullContent).toContain('"thinking"');
        expect(fullContent).toContain('"content":"Deep"');
      });

      it('handles tool_calls transition from reasoning', async () => {
        const chunks = [
          'data: {"id":"1","choices":[{"index":0,"delta":{"reasoning_content":"Thinking"}}]}\n\n',
          'data: {"id":"1","choices":[{"index":0,"delta":{"tool_calls":[{"id":"call_1"}]}}]}\n\n',
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

        // Should contain signature when transitioning to tool_calls
        expect(fullContent).toContain('"signature"');
      });

      it('skips stream transformation when disabled', async () => {
        const disabledTransformer = new ReasoningTransformer({ enable: false });

        const chunks = [
          'data: {"id":"1","choices":[{"index":0,"delta":{"reasoning_content":"Test"}}]}\n\n',
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

        const result = await disabledTransformer.transformResponseOut(response, mockContext);

        // Should pass through without modification
        expect(result).toBe(response);
      });

      it('passes through non-stream responses', async () => {
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
      expect(transformer.name).toBe('reasoning');
    });

    it('has static TransformerName', () => {
      expect(ReasoningTransformer.TransformerName).toBe('reasoning');
    });
  });
});
