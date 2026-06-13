/**
 * TransformerChainExecutor Unit Tests
 *
 * Tests for the chain execution logic including:
 * - Request chain execution
 * - Response chain execution
 * - Authentication handling
 * - Bypass optimization
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TransformerChainExecutor } from '../TransformerChainExecutor';
import type {
  LLMProvider,
  ResolvedTransformerChain,
  Transformer,
  UnifiedChatRequest,
} from '../types';

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
  models: ['model-a', 'model-b'],
};

// Mock request
const mockRequest: UnifiedChatRequest = {
  model: 'model-a',
  messages: [{ role: 'user', content: 'Hello' }],
  max_tokens: 1000,
  temperature: 0.7,
};

// Helper to create mock transformer
const createMockTransformer = (name: string, overrides: Partial<Transformer> = {}): Transformer => ({
  name,
  ...overrides,
});

describe('TransformerChainExecutor', () => {
  let executor: TransformerChainExecutor;

  beforeEach(() => {
    executor = new TransformerChainExecutor(mockLogger);
    vi.clearAllMocks();
  });

  describe('executeRequestChain', () => {
    it('returns original request when chain is empty', async () => {
      const chain: ResolvedTransformerChain = {
        providerTransformers: [],
        modelTransformers: [],
      };

      const result = await executor.executeRequestChain(
        mockRequest,
        mockProvider,
        chain
      );

      expect(result.requestBody).toBe(mockRequest);
      expect(result.bypass).toBe(false);
    });

    it('executes endpoint transformer transformRequestOut', async () => {
      const transformedBody = { ...mockRequest, transformed: true };
      const endpointTransformer = createMockTransformer('endpoint', {
        transformRequestOut: vi.fn().mockResolvedValue(transformedBody),
      });

      const chain: ResolvedTransformerChain = {
        providerTransformers: [],
        modelTransformers: [],
      };

      const result = await executor.executeRequestChain(
        mockRequest,
        mockProvider,
        chain,
        { endpointTransformer }
      );

      expect(endpointTransformer.transformRequestOut).toHaveBeenCalled();
      expect(result.requestBody).toEqual(transformedBody);
    });

    it('executes provider transformers in forward order', async () => {
      const executionOrder: string[] = [];

      const transformer1 = createMockTransformer('t1', {
        transformRequestIn: vi.fn().mockImplementation(async (req) => {
          executionOrder.push('t1');
          return { ...req, t1: true };
        }),
      });

      const transformer2 = createMockTransformer('t2', {
        transformRequestIn: vi.fn().mockImplementation(async (req) => {
          executionOrder.push('t2');
          return { ...req, t2: true };
        }),
      });

      const chain: ResolvedTransformerChain = {
        providerTransformers: [transformer1, transformer2],
        modelTransformers: [],
      };

      const result = await executor.executeRequestChain(
        mockRequest,
        mockProvider,
        chain
      );

      expect(executionOrder).toEqual(['t1', 't2']);
      expect(result.requestBody).toHaveProperty('t1', true);
      expect(result.requestBody).toHaveProperty('t2', true);
    });

    it('executes model transformers after provider transformers', async () => {
      const executionOrder: string[] = [];

      const providerTransformer = createMockTransformer('provider', {
        transformRequestIn: vi.fn().mockImplementation(async (req) => {
          executionOrder.push('provider');
          return req;
        }),
      });

      const modelTransformer = createMockTransformer('model', {
        transformRequestIn: vi.fn().mockImplementation(async (req) => {
          executionOrder.push('model');
          return req;
        }),
      });

      const chain: ResolvedTransformerChain = {
        providerTransformers: [providerTransformer],
        modelTransformers: [modelTransformer],
      };

      await executor.executeRequestChain(mockRequest, mockProvider, chain);

      expect(executionOrder).toEqual(['provider', 'model']);
    });

    it('handles transformer returning body and config', async () => {
      const transformer = createMockTransformer('t1', {
        transformRequestIn: vi.fn().mockResolvedValue({
          body: { modified: true },
          config: { headers: { 'X-Custom': 'value' } },
        }),
      });

      const chain: ResolvedTransformerChain = {
        providerTransformers: [transformer],
        modelTransformers: [],
      };

      const result = await executor.executeRequestChain(
        mockRequest,
        mockProvider,
        chain
      );

      expect(result.requestBody).toEqual({ modified: true });
      expect(result.config.headers).toEqual({ 'X-Custom': 'value' });
    });

    it('throws error when transformer fails', async () => {
      const error = new Error('Transform failed');
      const transformer = createMockTransformer('failing', {
        transformRequestIn: vi.fn().mockRejectedValue(error),
      });

      const chain: ResolvedTransformerChain = {
        providerTransformers: [transformer],
        modelTransformers: [],
      };

      await expect(
        executor.executeRequestChain(mockRequest, mockProvider, chain)
      ).rejects.toThrow('Transform failed');

      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('enables bypass when single endpoint transformer matches provider', async () => {
      const endpointTransformer = createMockTransformer('endpoint');

      const chain: ResolvedTransformerChain = {
        providerTransformers: [endpointTransformer],
        modelTransformers: [],
      };

      const result = await executor.executeRequestChain(
        mockRequest,
        mockProvider,
        chain,
        { endpointTransformer }
      );

      expect(result.bypass).toBe(true);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Bypass mode enabled')
      );
    });
  });

  describe('executeResponseChain', () => {
    const mockResponse = new Response(JSON.stringify({ result: 'ok' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    it('returns original response when chain is empty', async () => {
      const chain: ResolvedTransformerChain = {
        providerTransformers: [],
        modelTransformers: [],
      };

      const result = await executor.executeResponseChain(
        mockRequest,
        mockResponse.clone(),
        mockProvider,
        chain
      );

      expect(result.status).toBe(200);
    });

    it('executes model transformers in reverse order', async () => {
      const executionOrder: string[] = [];

      const transformer1 = createMockTransformer('t1', {
        transformResponseOut: vi.fn().mockImplementation(async (res) => {
          executionOrder.push('t1');
          return res;
        }),
      });

      const transformer2 = createMockTransformer('t2', {
        transformResponseOut: vi.fn().mockImplementation(async (res) => {
          executionOrder.push('t2');
          return res;
        }),
      });

      const chain: ResolvedTransformerChain = {
        providerTransformers: [],
        modelTransformers: [transformer1, transformer2],
      };

      await executor.executeResponseChain(
        mockRequest,
        mockResponse.clone(),
        mockProvider,
        chain
      );

      // Should be reversed: t2 first, then t1
      expect(executionOrder).toEqual(['t2', 't1']);
    });

    it('executes provider transformers in reverse order after model transformers', async () => {
      const executionOrder: string[] = [];

      const providerTransformer = createMockTransformer('provider', {
        transformResponseOut: vi.fn().mockImplementation(async (res) => {
          executionOrder.push('provider');
          return res;
        }),
      });

      const modelTransformer = createMockTransformer('model', {
        transformResponseOut: vi.fn().mockImplementation(async (res) => {
          executionOrder.push('model');
          return res;
        }),
      });

      const chain: ResolvedTransformerChain = {
        providerTransformers: [providerTransformer],
        modelTransformers: [modelTransformer],
      };

      await executor.executeResponseChain(
        mockRequest,
        mockResponse.clone(),
        mockProvider,
        chain
      );

      // Model first (reversed), then provider (reversed)
      expect(executionOrder).toEqual(['model', 'provider']);
    });

    it('executes endpoint transformer transformResponseIn last', async () => {
      const executionOrder: string[] = [];

      const endpointTransformer = createMockTransformer('endpoint', {
        transformResponseIn: vi.fn().mockImplementation(async (res) => {
          executionOrder.push('endpoint');
          return res;
        }),
      });

      const providerTransformer = createMockTransformer('provider', {
        transformResponseOut: vi.fn().mockImplementation(async (res) => {
          executionOrder.push('provider');
          return res;
        }),
      });

      const chain: ResolvedTransformerChain = {
        providerTransformers: [providerTransformer],
        modelTransformers: [],
      };

      await executor.executeResponseChain(
        mockRequest,
        mockResponse.clone(),
        mockProvider,
        chain,
        { endpointTransformer }
      );

      expect(executionOrder).toEqual(['provider', 'endpoint']);
    });

    it('throws error when transformer fails', async () => {
      const error = new Error('Response transform failed');
      const transformer = createMockTransformer('failing', {
        transformResponseOut: vi.fn().mockRejectedValue(error),
      });

      const chain: ResolvedTransformerChain = {
        providerTransformers: [transformer],
        modelTransformers: [],
      };

      await expect(
        executor.executeResponseChain(
          mockRequest,
          mockResponse.clone(),
          mockProvider,
          chain
        )
      ).rejects.toThrow('Response transform failed');
    });

    it('skips transformations in bypass mode', async () => {
      const _transformer = createMockTransformer('t1', {
        transformResponseOut: vi.fn(),
      });

      const endpointTransformer = createMockTransformer('endpoint', {
        transformResponseIn: vi.fn(),
      });

      // Setup bypass condition: single endpoint transformer
      const chain: ResolvedTransformerChain = {
        providerTransformers: [endpointTransformer],
        modelTransformers: [],
      };

      await executor.executeResponseChain(
        mockRequest,
        mockResponse.clone(),
        mockProvider,
        chain,
        { endpointTransformer }
      );

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Bypass mode')
      );
    });
  });

  describe('executeAuth', () => {
    it('returns unchanged request when no auth handler', async () => {
      const transformer = createMockTransformer('no-auth');

      const result = await executor.executeAuth(
        mockRequest,
        mockProvider,
        transformer,
        {}
      );

      expect(result.requestBody).toBe(mockRequest);
      expect(result.config).toEqual({});
    });

    it('executes auth handler and returns modified request', async () => {
      const authResult = {
        body: { ...mockRequest, authenticated: true },
        config: { headers: { 'Authorization': 'Bearer token' } },
      };

      const transformer = createMockTransformer('with-auth', {
        auth: vi.fn().mockResolvedValue(authResult),
      });

      const result = await executor.executeAuth(
        mockRequest,
        mockProvider,
        transformer,
        {}
      );

      expect(result.requestBody).toHaveProperty('authenticated', true);
      expect(result.config.headers).toHaveProperty('Authorization', 'Bearer token');
    });

    it('removes host header from auth config', async () => {
      const authResult = {
        body: mockRequest,
        config: {
          headers: {
            'Authorization': 'Bearer token',
            'host': 'should-be-removed',
          },
        },
      };

      const transformer = createMockTransformer('with-auth', {
        auth: vi.fn().mockResolvedValue(authResult),
      });

      const result = await executor.executeAuth(
        mockRequest,
        mockProvider,
        transformer,
        {}
      );

      expect(result.config.headers).not.toHaveProperty('host');
      expect(result.config.headers).toHaveProperty('Authorization');
    });

    it('handles auth returning just the request body', async () => {
      const modifiedRequest = { ...mockRequest, authApplied: true };

      const transformer = createMockTransformer('simple-auth', {
        auth: vi.fn().mockResolvedValue(modifiedRequest),
      });

      const result = await executor.executeAuth(
        mockRequest,
        mockProvider,
        transformer,
        {}
      );

      expect(result.requestBody).toEqual(modifiedRequest);
    });

    it('throws error when auth handler fails', async () => {
      const error = new Error('Auth failed');
      const transformer = createMockTransformer('failing-auth', {
        auth: vi.fn().mockRejectedValue(error),
      });

      await expect(
        executor.executeAuth(mockRequest, mockProvider, transformer, {})
      ).rejects.toThrow('Auth failed');

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Auth handler error')
      );
    });
  });
});
