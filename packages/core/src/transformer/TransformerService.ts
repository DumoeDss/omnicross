/**
 * TransformerService - Core service for managing transformer lifecycle
 *
 * Handles transformer registration, retrieval, and initialization.
 *
 * Adapted from the `musistudio/llms` project (MIT, © 2025 musistudio) — the
 * transformer IR upstream — for the Electron environment. See the package
 * `NOTICE` for full third-party attribution.
 *
 * @module transformer/TransformerService
 */

import type { ResolvedTransformerChain,
  Transformer,
  TransformerChainConfig,
  TransformerConstructor,
  TransformerLogger,
  TransformerOptions,
  TransformerReference } from './types';

/**
 * Default console logger implementation
 */
const defaultLogger: TransformerLogger = {
  debug: (msg, ...args) => console.debug(`[TransformerService] ${msg}`, ...args),
  info: (msg, ...args) => console.info(`[TransformerService] ${msg}`, ...args),
  warn: (msg, ...args) => console.warn(`[TransformerService] ${msg}`, ...args),
  error: (msg, ...args) => console.error(`[TransformerService] ${msg}`, ...args),
};

/**
 * TransformerService manages the lifecycle of all transformers.
 *
 * Features:
 * - Register transformers by name
 * - Get transformer by name
 * - Initialize default transformers
 * - Resolve transformer chains from configuration
 */
export class TransformerService {
  private transformers: Map<string, Transformer | TransformerConstructor> = new Map();
  private logger: TransformerLogger;

  // Performance optimization: Cache instantiated transformers
  private instanceCache = new Map<string, Transformer>();

  // Performance optimization: Cache endpoint transformer results
  private endpointTransformersCache: { name: string; transformer: Transformer }[] | null = null;
  private noEndpointTransformersCache: { name: string; transformer: Transformer }[] | null = null;

  constructor(logger?: TransformerLogger) {
    this.logger = logger ?? defaultLogger;
  }

  /**
   * Clear instance caches
   */
  clearInstanceCache(): void {
    this.instanceCache.clear();
    this.endpointTransformersCache = null;
    this.noEndpointTransformersCache = null;
  }

  /**
   * Get cache statistics for diagnostics
   */
  getCacheStats(): { instanceCacheSize: number; hasEndpointCache: boolean } {
    return {
      instanceCacheSize: this.instanceCache.size,
      hasEndpointCache: this.endpointTransformersCache !== null,
    };
  }

  /**
   * Register a transformer by name
   * @param name - Unique transformer name
   * @param transformer - Transformer instance or constructor
   */
  registerTransformer(name: string, transformer: Transformer | TransformerConstructor): void {
    this.transformers.set(name, transformer);

    // Invalidate caches when transformers change
    this.clearInstanceCache();

    const endpoint =
      'endPoint' in transformer
        ? transformer.endPoint
        : 'prototype' in transformer && transformer.prototype?.endPoint
          ? transformer.prototype.endPoint
          : undefined;

    this.logger.info(
      `Registered transformer: ${name}${endpoint ? ` (endpoint: ${endpoint})` : ' (no endpoint)'}`
    );
  }

  /**
   * Get a transformer by name
   * @param name - Transformer name
   * @returns Transformer instance/constructor or undefined
   */
  getTransformer(name: string): Transformer | TransformerConstructor | undefined {
    return this.transformers.get(name);
  }

  /**
   * Get all registered transformers
   * @returns Map of all transformers
   */
  getAllTransformers(): Map<string, Transformer | TransformerConstructor> {
    return new Map(this.transformers);
  }

  /**
   * Get transformers that have an endpoint defined
   * Uses cache to avoid redundant traversal
   * @returns Array of transformers with endpoints
   */
  getTransformersWithEndpoint(): { name: string; transformer: Transformer }[] {
    // Return cached result if available
    if (this.endpointTransformersCache) {
      return this.endpointTransformersCache;
    }

    const result: { name: string; transformer: Transformer }[] = [];

    this.transformers.forEach((transformer, name) => {
      // Handle both instances and constructors
      const instance = this.instantiateIfNeeded(transformer);
      if (instance?.endPoint) {
        result.push({ name, transformer: instance });
      }
    });

    // Cache the result
    this.endpointTransformersCache = result;
    return result;
  }

  /**
   * Get transformers without endpoints
   * Uses cache to avoid redundant traversal
   * @returns Array of transformers without endpoints
   */
  getTransformersWithoutEndpoint(): { name: string; transformer: Transformer }[] {
    // Return cached result if available
    if (this.noEndpointTransformersCache) {
      return this.noEndpointTransformersCache;
    }

    const result: { name: string; transformer: Transformer }[] = [];

    this.transformers.forEach((transformer, name) => {
      const instance = this.instantiateIfNeeded(transformer);
      if (instance && !instance.endPoint) {
        result.push({ name, transformer: instance });
      }
    });

    // Cache the result
    this.noEndpointTransformersCache = result;
    return result;
  }

  /**
   * Remove a transformer by name
   * @param name - Transformer name
   * @returns true if removed, false if not found
   */
  removeTransformer(name: string): boolean {
    const removed = this.transformers.delete(name);
    if (removed) {
      // Invalidate caches when transformers change
      this.clearInstanceCache();
    }
    return removed;
  }

  /**
   * Check if a transformer is registered
   * @param name - Transformer name
   * @returns true if registered
   */
  hasTransformer(name: string): boolean {
    return this.transformers.has(name);
  }

  /**
   * Initialize the service with default transformers
   * @param defaultTransformers - Map or object of default transformers
   */
  async initialize(
    defaultTransformers?: Record<string, Transformer | TransformerConstructor>
  ): Promise<void> {
    try {
      if (defaultTransformers) {
        await this.registerDefaultTransformers(defaultTransformers);
      }
      this.logger.info(
        `TransformerService initialized with ${this.transformers.size} transformers`
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`TransformerService init error: ${errorMessage}`);
      throw error;
    }
  }

  /**
   * Register default transformers from a map
   * @param transformers - Map of transformer name to transformer
   */
  private async registerDefaultTransformers(
    transformers: Record<string, Transformer | TransformerConstructor>
  ): Promise<void> {
    for (const [key, TransformerClass] of Object.entries(transformers)) {
      try {
        // Check if it's a constructor with static TransformerName
        if (this.isTransformerConstructor(TransformerClass)) {
          const staticName =
            (TransformerClass as TransformerConstructor).TransformerName ?? key;
          this.registerTransformer(staticName, TransformerClass);
        } else {
          // It's an instance
          const name = (TransformerClass as Transformer).name ?? key;
          // Assign logger to instance
          (TransformerClass as Transformer).logger = this.logger;
          this.registerTransformer(name, TransformerClass as Transformer);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error(`Failed to register transformer ${key}: ${errorMessage}`);
      }
    }
  }

  /**
   * Resolve a transformer chain configuration to actual transformer instances
   * @param chainConfig - Transformer chain configuration
   * @param modelName - Model name for model-specific transformers
   * @returns Resolved transformer chain with instances
   */
  resolveTransformerChain(
    chainConfig: TransformerChainConfig | undefined,
    modelName?: string
  ): ResolvedTransformerChain {
    const result: ResolvedTransformerChain = {
      providerTransformers: [],
      modelTransformers: [],
    };

    if (!chainConfig) {
      return result;
    }

    // Resolve provider-level transformers
    if (chainConfig.use) {
      result.providerTransformers = this.resolveTransformerReferences(chainConfig.use);
    }

    // Resolve model-specific transformers
    if (modelName && chainConfig[modelName]) {
      const modelConfig = chainConfig[modelName];
      if (Array.isArray(modelConfig)) {
        result.modelTransformers = this.resolveTransformerReferences(modelConfig);
      } else if (modelConfig && typeof modelConfig === 'object' && 'use' in modelConfig) {
        result.modelTransformers = this.resolveTransformerReferences(modelConfig.use ?? []);
      }
    }

    return result;
  }

  /**
   * Resolve an array of transformer references to instances
   * @param refs - Array of transformer references
   * @returns Array of transformer instances
   */
  resolveTransformerReferences(refs: TransformerReference[]): Transformer[] {
    const instances: Transformer[] = [];

    for (const ref of refs) {
      const [name, options] = Array.isArray(ref) ? ref : [ref, undefined];
      const transformer = this.getTransformer(name);

      if (!transformer) {
        this.logger.warn(`Transformer not found: ${name}`);
        continue;
      }

      const instance = this.instantiateIfNeeded(transformer, options);
      if (instance) {
        instance.logger = this.logger;
        instances.push(instance);
      }
    }

    return instances;
  }

  /**
   * Instantiate a transformer if it's a constructor
   * Uses instance cache to avoid redundant instantiation
   *
   * @param transformer - Transformer instance or constructor
   * @param options - Options to pass to constructor
   * @returns Transformer instance
   */
  private instantiateIfNeeded(
    transformer: Transformer | TransformerConstructor,
    options?: TransformerOptions
  ): Transformer | undefined {
    // If already an instance, return as-is
    if (!this.isTransformerConstructor(transformer)) {
      return transformer as Transformer;
    }

    // Build cache key from constructor name and options
    const constructorName = (transformer as TransformerConstructor).TransformerName || transformer.name || 'anonymous';
    const optionsHash = options ? JSON.stringify(options) : '';
    const cacheKey = `${constructorName}:${optionsHash}`;

    // Check cache first
    if (this.instanceCache.has(cacheKey)) {
      return this.instanceCache.get(cacheKey);
    }

    // Create new instance
    try {
      const instance = new (transformer as TransformerConstructor)(options);
      instance.logger = this.logger;

      // Cache the instance
      this.instanceCache.set(cacheKey, instance);

      return instance;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to instantiate transformer: ${errorMessage}`);
      return undefined;
    }
  }

  /**
   * Check if a value is a transformer constructor
   * @param value - Value to check
   * @returns true if it's a constructor
   */
  private isTransformerConstructor(
    value: Transformer | TransformerConstructor
  ): value is TransformerConstructor {
    return (
      typeof value === 'function' &&
      value.prototype &&
      (typeof value.prototype.transformRequestIn === 'function' ||
        typeof value.prototype.transformRequestOut === 'function' ||
        typeof value.prototype.transformResponseIn === 'function' ||
        typeof value.prototype.transformResponseOut === 'function' ||
        'TransformerName' in value)
    );
  }

  /**
   * Get list of all registered transformer names
   * @returns Array of transformer names
   */
  getTransformerNames(): string[] {
    return Array.from(this.transformers.keys());
  }

  /**
   * Clear all registered transformers
   */
  clear(): void {
    this.transformers.clear();
    this.clearInstanceCache();
    this.logger.info('All transformers cleared');
  }
}
