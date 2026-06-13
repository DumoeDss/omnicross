/**
 * TransformerService Unit Tests
 *
 * Tests for the TransformerService core functionality including:
 * - Transformer registration
 * - Transformer retrieval
 * - Initialization
 * - Chain resolution
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TransformerService } from '../TransformerService';
import type {
  LLMProvider,
  Transformer,
  TransformerChainConfig,
  TransformerConstructor,
  TransformerContext,
  UnifiedChatRequest,
} from '../types';

// Mock logger to suppress console output during tests
const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

// Mock transformer instance
const createMockTransformer = (name: string, hasEndpoint = false): Transformer => ({
  name,
  endPoint: hasEndpoint ? '/v1/chat/completions' : undefined,
  transformRequestIn: vi.fn().mockResolvedValue({}),
  transformResponseOut: vi.fn().mockResolvedValue(new Response()),
});

// Mock transformer class
class MockTransformerClass implements Transformer {
  static TransformerName = 'mock-class';
  name = 'mock-class';
  endPoint = '/v1/test';

  async transformRequestIn(
    request: UnifiedChatRequest,
    _provider: LLMProvider,
    _context: TransformerContext
  ): Promise<Record<string, unknown>> {
    return { ...request, transformed: true };
  }

  async transformResponseOut(response: Response): Promise<Response> {
    return response;
  }
}

describe('TransformerService', () => {
  let service: TransformerService;

  beforeEach(() => {
    service = new TransformerService(mockLogger);
    vi.clearAllMocks();
  });

  describe('registerTransformer', () => {
    it('registers a transformer instance by name', () => {
      const transformer = createMockTransformer('test-transformer');
      service.registerTransformer('test', transformer);

      expect(service.hasTransformer('test')).toBe(true);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Registered transformer: test')
      );
    });

    it('registers a transformer with endpoint and logs it', () => {
      const transformer = createMockTransformer('endpoint-transformer', true);
      service.registerTransformer('endpoint', transformer);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('endpoint: /v1/chat/completions')
      );
    });

    it('registers a transformer constructor', () => {
      service.registerTransformer('mock-class', MockTransformerClass as unknown as TransformerConstructor);

      expect(service.hasTransformer('mock-class')).toBe(true);
    });
  });

  describe('getTransformer', () => {
    it('returns undefined for non-existent transformer', () => {
      expect(service.getTransformer('non-existent')).toBeUndefined();
    });

    it('returns registered transformer', () => {
      const transformer = createMockTransformer('test');
      service.registerTransformer('test', transformer);

      const result = service.getTransformer('test');
      expect(result).toBe(transformer);
    });
  });

  describe('getAllTransformers', () => {
    it('returns empty map when no transformers registered', () => {
      const all = service.getAllTransformers();
      expect(all.size).toBe(0);
    });

    it('returns all registered transformers', () => {
      service.registerTransformer('t1', createMockTransformer('t1'));
      service.registerTransformer('t2', createMockTransformer('t2'));

      const all = service.getAllTransformers();
      expect(all.size).toBe(2);
      expect(all.has('t1')).toBe(true);
      expect(all.has('t2')).toBe(true);
    });

    it('returns a copy of the map (not the original)', () => {
      service.registerTransformer('t1', createMockTransformer('t1'));
      const all = service.getAllTransformers();

      all.set('t2', createMockTransformer('t2'));
      expect(service.hasTransformer('t2')).toBe(false);
    });
  });

  describe('getTransformersWithEndpoint', () => {
    it('returns only transformers with endpoints', () => {
      service.registerTransformer('with-endpoint', createMockTransformer('with-endpoint', true));
      service.registerTransformer('without-endpoint', createMockTransformer('without-endpoint', false));

      const result = service.getTransformersWithEndpoint();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('with-endpoint');
    });
  });

  describe('getTransformersWithoutEndpoint', () => {
    it('returns only transformers without endpoints', () => {
      service.registerTransformer('with-endpoint', createMockTransformer('with-endpoint', true));
      service.registerTransformer('without-endpoint', createMockTransformer('without-endpoint', false));

      const result = service.getTransformersWithoutEndpoint();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('without-endpoint');
    });
  });

  describe('removeTransformer', () => {
    it('removes registered transformer', () => {
      service.registerTransformer('test', createMockTransformer('test'));
      expect(service.hasTransformer('test')).toBe(true);

      const removed = service.removeTransformer('test');
      expect(removed).toBe(true);
      expect(service.hasTransformer('test')).toBe(false);
    });

    it('returns false for non-existent transformer', () => {
      const removed = service.removeTransformer('non-existent');
      expect(removed).toBe(false);
    });
  });

  describe('hasTransformer', () => {
    it('returns true for registered transformer', () => {
      service.registerTransformer('test', createMockTransformer('test'));
      expect(service.hasTransformer('test')).toBe(true);
    });

    it('returns false for non-existent transformer', () => {
      expect(service.hasTransformer('non-existent')).toBe(false);
    });
  });

  describe('initialize', () => {
    it('initializes without default transformers', async () => {
      await service.initialize();

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('initialized with 0 transformers')
      );
    });

    it('initializes with default transformers', async () => {
      const transformers = {
        't1': createMockTransformer('t1'),
        't2': createMockTransformer('t2'),
      };

      await service.initialize(transformers);

      expect(service.hasTransformer('t1')).toBe(true);
      expect(service.hasTransformer('t2')).toBe(true);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('initialized with 2 transformers')
      );
    });

    it('initializes with transformer constructors', async () => {
      const transformers = {
        'mock': MockTransformerClass as unknown as Transformer,
      };

      await service.initialize(transformers);

      expect(service.hasTransformer('mock-class')).toBe(true);
    });
  });

  describe('resolveTransformerChain', () => {
    beforeEach(() => {
      service.registerTransformer('transformer-a', createMockTransformer('transformer-a'));
      service.registerTransformer('transformer-b', createMockTransformer('transformer-b'));
      service.registerTransformer('model-specific', createMockTransformer('model-specific'));
    });

    it('returns empty chain for undefined config', () => {
      const chain = service.resolveTransformerChain(undefined);

      expect(chain.providerTransformers).toHaveLength(0);
      expect(chain.modelTransformers).toHaveLength(0);
    });

    it('resolves provider-level transformers', () => {
      const config: TransformerChainConfig = {
        use: ['transformer-a', 'transformer-b'],
      };

      const chain = service.resolveTransformerChain(config);

      expect(chain.providerTransformers).toHaveLength(2);
      expect(chain.providerTransformers[0].name).toBe('transformer-a');
      expect(chain.providerTransformers[1].name).toBe('transformer-b');
    });

    it('resolves model-specific transformers', () => {
      const config: TransformerChainConfig = {
        use: ['transformer-a'],
        'gpt-4': {
          use: ['model-specific'],
        },
      };

      const chain = service.resolveTransformerChain(config, 'gpt-4');

      expect(chain.providerTransformers).toHaveLength(1);
      expect(chain.modelTransformers).toHaveLength(1);
      expect(chain.modelTransformers[0].name).toBe('model-specific');
    });

    it('handles model config as array directly', () => {
      const config: TransformerChainConfig = {
        use: ['transformer-a'],
        'gpt-4': ['model-specific'],
      };

      const chain = service.resolveTransformerChain(config, 'gpt-4');

      expect(chain.modelTransformers).toHaveLength(1);
    });

    it('warns for non-existent transformers', () => {
      const config: TransformerChainConfig = {
        use: ['non-existent'],
      };

      const chain = service.resolveTransformerChain(config);

      expect(chain.providerTransformers).toHaveLength(0);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Transformer not found: non-existent')
      );
    });
  });

  describe('resolveTransformerReferences', () => {
    beforeEach(() => {
      service.registerTransformer('test', createMockTransformer('test'));
      service.registerTransformer('mock-class', MockTransformerClass as unknown as TransformerConstructor);
    });

    it('resolves string references', () => {
      const instances = service.resolveTransformerReferences(['test']);

      expect(instances).toHaveLength(1);
      expect(instances[0].name).toBe('test');
    });

    it('resolves tuple references with options', () => {
      const instances = service.resolveTransformerReferences([
        ['mock-class', { option: 'value' }],
      ]);

      expect(instances).toHaveLength(1);
    });

    it('assigns logger to resolved transformers', () => {
      const instances = service.resolveTransformerReferences(['test']);

      expect(instances[0].logger).toBe(mockLogger);
    });
  });

  describe('getTransformerNames', () => {
    it('returns empty array when no transformers', () => {
      expect(service.getTransformerNames()).toEqual([]);
    });

    it('returns all transformer names', () => {
      service.registerTransformer('a', createMockTransformer('a'));
      service.registerTransformer('b', createMockTransformer('b'));

      const names = service.getTransformerNames();
      expect(names).toContain('a');
      expect(names).toContain('b');
    });
  });

  describe('clear', () => {
    it('removes all transformers', () => {
      service.registerTransformer('a', createMockTransformer('a'));
      service.registerTransformer('b', createMockTransformer('b'));

      service.clear();

      expect(service.getTransformerNames()).toHaveLength(0);
      expect(mockLogger.info).toHaveBeenCalledWith('All transformers cleared');
    });
  });
});
