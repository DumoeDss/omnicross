import { randomBytes } from 'node:crypto';

import {
  createImageApiContributions,
  createResponsesImageGenerationContribution,
  ImageGenerationError,
  ImageOrchestrator,
  ImageProviderRegistry,
  type ImageApiAuditRecord,
  type ImageProvider,
  type ImageTelemetrySink,
  type RemoteImageAssetResolver,
} from '@omnicross/core/image-generation';
import {
  type ImagesServerConfig,
  validateImagesServerConfig,
} from '@omnicross/core/outbound-api';
import {
  createCodexSubscriptionImageProvider,
  type ImageExecutionScheduler,
  type SubscriptionAccountService,
} from '@omnicross/subscriptions';

import { FileCodexImageCapabilityEvidenceSource } from './FileCodexImageCapabilityEvidenceSource';
import {
  createTrustedImageApiRuntimeResolver,
  type TrustedImageApiRuntimeResolver,
} from './ImageApiRuntimeResolver';
import { DaemonImageExecutionScheduler } from './ImageExecutionScheduler';
import type { PreparedImageRuntimeGeneration } from './ImageRuntimeManager';
import {
  MountedImageReferenceStore,
  MountedResponsesImageStateStore,
} from './ImageStorageMountCatalog';
import {
  DaemonImageTemporaryResourceFactory,
  type DaemonImageActiveScopeRegistry,
} from './imageTemporaryResources';
import type { DaemonImagePathResolver } from './imagePathResolver';
import { loadOrCreateImageTenantHmacSalt } from './imageTenantHmac';

const GENERATION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

export interface ImageRuntimeGenerationSharedStorage {
  /** Resolver associated with the catalog's already-active mount. */
  readonly paths: DaemonImagePathResolver;
  readonly referenceStore: MountedImageReferenceStore;
  readonly stateStore: MountedResponsesImageStateStore;
}

export interface ImageRuntimeMetadataObservability {
  readonly telemetrySink?: ImageTelemetrySink;
  readonly audit?: (record: ImageApiAuditRecord) => void | Promise<void>;
}

/**
 * Explicit deterministic Tier-A seam. It replaces only the provider inside an
 * otherwise-production runtime generation and is never inferred from config.
 */
export interface SyntheticVerifiedImageProviderTestSeam {
  readonly label: 'synthetic-verified-image-provider-test-only';
  createProvider(context: Readonly<{
    generationId: string;
    scheduler: ImageExecutionScheduler;
    now: () => number;
    referenceStore: MountedImageReferenceStore;
    stateStore: MountedResponsesImageStateStore;
  }>): ImageProvider;
}

export interface ImageRuntimeGenerationFactoryOptions {
  readonly generationId: string;
  readonly config: ImagesServerConfig;
  readonly subscriptionAccounts: Pick<SubscriptionAccountService, 'getStrategy'>;
  readonly storage: ImageRuntimeGenerationSharedStorage;
  readonly provenRemoteResolver?: RemoteImageAssetResolver;
  readonly observability?: ImageRuntimeMetadataObservability;
  readonly createRequestId?: () => string;
  readonly createCallId?: () => `ig_${string}`;
  readonly now?: () => number;
  /** Test seam; production loads the persistent daemon-local HMAC salt. */
  readonly privateHmacKey?: Uint8Array;
  /** App-session owner used to protect live directories across generations. */
  readonly activeTemporaryScopes?: DaemonImageActiveScopeRegistry;
  /** Immutable TTL view scoped to this runtime generation. */
  readonly evidenceSource?: FileCodexImageCapabilityEvidenceSource;
  /** App-session catalog lease retained until this generation is disposed. */
  readonly releaseStorageBackend?: () => void;
  /** Test-only Tier-A provider; production leaves this absent. */
  readonly testOnlySyntheticVerifiedProvider?: SyntheticVerifiedImageProviderTestSeam;
}

export interface ProductionImageRuntimeComponents {
  readonly providerRegistry: ImageProviderRegistry;
  readonly orchestrator: ImageOrchestrator;
  readonly scheduler: DaemonImageExecutionScheduler;
  readonly evidenceSource: FileCodexImageCapabilityEvidenceSource;
  readonly temporaryResources: DaemonImageTemporaryResourceFactory;
  readonly runtimeResolver: TrustedImageApiRuntimeResolver;
  readonly referenceStore: MountedImageReferenceStore;
  readonly stateStore: MountedResponsesImageStateStore;
}

export type ProductionImageRuntimeGeneration = PreparedImageRuntimeGeneration & {
  readonly components?: ProductionImageRuntimeComponents;
};

function snapshotConfig(config: ImagesServerConfig): ImagesServerConfig {
  return {
    ...config,
    modelAliases: { ...config.modelAliases },
    account: { ...config.account },
    queue: { ...config.queue },
    temporary: { ...config.temporary },
    limits: { ...config.limits },
    references: { ...config.references },
    remote: { ...config.remote },
  };
}

/**
 * Builds a complete generation without changing the storage catalog's active
 * mount. Catalog activation must be composed by a failure-atomic transaction.
 */
export function createImageRuntimeGeneration(
  options: ImageRuntimeGenerationFactoryOptions,
): ProductionImageRuntimeGeneration {
  if (!GENERATION_ID.test(options.generationId)) {
    throw new TypeError('image runtime generation id is invalid');
  }
  const config = snapshotConfig(options.config);
  const configErrors = validateImagesServerConfig(config);
  if (configErrors.length > 0) {
    throw new TypeError(`image runtime configuration is invalid: ${configErrors[0]}`);
  }
  if (config.remote.enabled && !options.provenRemoteResolver) {
    throw new TypeError('enabled image remote loading requires a proven resolver');
  }
  if (!config.enabled) {
    let disposed = false;
    return Object.freeze({
      id: options.generationId,
      enabled: false as const,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        options.evidenceSource?.dispose();
        options.releaseStorageBackend?.();
      },
    });
  }

  const authStrategy = options.subscriptionAccounts.getStrategy('codex');
  if (!authStrategy || authStrategy.providerId !== 'codex') {
    throw new TypeError('enabled image runtime requires the Codex subscription strategy');
  }

  const privateHmacKey = options.privateHmacKey
    ? Buffer.from(options.privateHmacKey)
    : loadOrCreateImageTenantHmacSalt(options.storage.paths, randomBytes);
  if (privateHmacKey.byteLength !== 32) {
    privateHmacKey.fill(0);
    throw new TypeError('image runtime private HMAC key is invalid');
  }

  let scheduler: DaemonImageExecutionScheduler | undefined;
  let runtimeResolver: ReturnType<typeof createTrustedImageApiRuntimeResolver> | undefined;
  let evidenceSource: FileCodexImageCapabilityEvidenceSource | undefined;
  try {
    scheduler = new DaemonImageExecutionScheduler({
      config: config.queue,
      hmacKey: privateHmacKey,
    });
    evidenceSource = options.evidenceSource ?? new FileCodexImageCapabilityEvidenceSource({
      paths: options.storage.paths,
      ttlMs: config.evidenceTtlMs,
      hmacSalt: privateHmacKey,
      ...(options.now ? { now: options.now } : {}),
    });
    const generationEvidenceSource = evidenceSource;
    const temporaryResources = new DaemonImageTemporaryResourceFactory({
      paths: options.storage.paths,
      config: config.temporary,
      ...(options.activeTemporaryScopes
        ? { activeScopes: options.activeTemporaryScopes }
        : {}),
    });
    runtimeResolver = createTrustedImageApiRuntimeResolver({
      config,
      referenceStore: options.storage.referenceStore,
      hmacKey: privateHmacKey,
      ...(options.provenRemoteResolver
        ? { provenRemoteResolver: options.provenRemoteResolver }
        : {}),
    });
    if (
      options.testOnlySyntheticVerifiedProvider &&
      options.testOnlySyntheticVerifiedProvider.label !== 'synthetic-verified-image-provider-test-only'
    ) {
      throw new TypeError('synthetic verified image provider test seam label is invalid');
    }
    const provider = options.testOnlySyntheticVerifiedProvider
      ? options.testOnlySyntheticVerifiedProvider.createProvider({
          generationId: options.generationId,
          scheduler,
          now: options.now ?? Date.now,
          referenceStore: options.storage.referenceStore,
          stateStore: options.storage.stateStore,
        })
      : createCodexSubscriptionImageProvider({
          authStrategy,
          evidenceSource: generationEvidenceSource,
          executionScheduler: scheduler,
          generationTimeoutMs: config.queue.generationTimeoutMs,
          now: options.now,
        });
    if (provider.id !== config.provider) {
      throw new TypeError('synthetic verified image provider id must match configured provider');
    }
    const providerRegistry = new ImageProviderRegistry([provider]);
    const orchestrator = new ImageOrchestrator({
      registry: providerRegistry,
      referenceStore: options.storage.referenceStore,
      ...(options.observability?.telemetrySink
        ? { telemetrySink: options.observability.telemetrySink }
        : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    const imageApi = createImageApiContributions({
      orchestrator,
      resolveRuntime: runtimeResolver.resolve,
      createResourceScope: temporaryResources.createResourceScope,
      ...(options.observability?.audit ? { audit: options.observability.audit } : {}),
      ...(options.createRequestId ? { createRequestId: options.createRequestId } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    const hosted = createResponsesImageGenerationContribution({
      orchestrator,
      referenceStore: options.storage.referenceStore,
      stateStore: options.storage.stateStore,
      ...(options.createCallId ? { createCallId: options.createCallId } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    const inspectCapability = async (apiKeyId: string) => {
      try {
        const capabilities = await orchestrator.getCapabilities(config.provider, {
          requestId: `${options.generationId}:capability-inspection`,
          tenantId: apiKeyId,
          signal: new AbortController().signal,
          sessionKey: `outbound:images:${apiKeyId}`,
          ...(config.account.id ? { preferredAccountId: config.account.id } : {}),
          ...(config.account.group ? { preferredAccountGroup: config.account.group } : {}),
          boundAccountFallbackPolicy: config.account.fallback,
        });
        const available = capabilities.available === true &&
          capabilities.generate === true &&
          capabilities.models.includes(config.defaultModel);
        return Object.freeze({
          enabled: true as const,
          available,
          providerId: config.provider,
          model: config.defaultModel,
          ...(!available ? { reason: capabilities.reason ?? 'runtime_unavailable' as const } : {}),
          capabilities,
        });
      } catch (error) {
        return Object.freeze({
          enabled: true as const,
          available: false as const,
          providerId: config.provider,
          model: config.defaultModel,
          reason: error instanceof ImageGenerationError &&
            (error.code === 'upstream_auth_required' || error.code === 'invalid_api_key')
            ? 'account_unverified' as const
            : 'runtime_unavailable' as const,
        });
      }
    };
    const resolverToDispose = runtimeResolver;
    const schedulerToDispose = scheduler;
    const readRuntimeStatus = () => Object.freeze({
      queue: schedulerToDispose.status(),
      temporary: Object.freeze({
        ...temporaryResources.budget.status(),
        maxActiveScopes: config.temporary.maxActiveScopes,
        maxTotalBytes: config.temporary.maxTotalBytes,
        maxTenantBytes: config.temporary.maxTenantBytes,
      }),
      storage: Object.freeze({
        ...options.storage.referenceStore.status(),
        maxReferenceEntries: config.references.maxEntries,
        maxReferenceBytes: config.references.maxTotalBytes,
        maxTenantReferenceBytes: config.references.maxTenantBytes,
        maxStateCalls: config.references.maxCalls,
        maxStateResponses: config.references.maxResponses,
      }),
    });
    const components: ProductionImageRuntimeComponents = Object.freeze({
      providerRegistry,
      orchestrator,
      scheduler,
      evidenceSource: generationEvidenceSource,
      temporaryResources,
      runtimeResolver,
      referenceStore: options.storage.referenceStore,
      stateStore: options.storage.stateStore,
    });
    let disposed = false;
    return Object.freeze({
      id: options.generationId,
      enabled: true as const,
      imageApi,
      hosted,
      hostedRuntime: Object.freeze({
        providerId: config.provider,
        imageModel: config.defaultModel,
        referenceTtlMs: config.references.ttlMs,
        maxOutputBytes: config.limits.maxOutputBytes,
        maxTotalOutputBytes: config.limits.maxTotalOutputBytes,
        ...(config.account.id ? { preferredAccountId: config.account.id } : {}),
        ...(config.account.group ? { preferredAccountGroup: config.account.group } : {}),
        boundAccountFallbackPolicy: config.account.fallback,
      }),
      inspectCapability,
      readRuntimeStatus,
      components,
      dispose: (): void => {
        if (disposed) return;
        disposed = true;
        schedulerToDispose.shutdown();
        resolverToDispose.dispose();
        generationEvidenceSource.dispose();
        options.releaseStorageBackend?.();
      },
    });
  } catch (error) {
    scheduler?.shutdown();
    runtimeResolver?.dispose();
    evidenceSource?.dispose();
    options.releaseStorageBackend?.();
    throw error;
  } finally {
    privateHmacKey.fill(0);
  }
}
