import type { RemoteImageAssetResolver } from '@omnicross/core/image-generation';
import type { ImagesServerConfig } from '@omnicross/core/outbound-api';
import type { SubscriptionAccountService } from '@omnicross/subscriptions';

import type { PreparedServerConfigChange } from '../admin/serverConfigTransaction';
import type {
  FileCodexImageCapabilityEvidenceManifestOwner,
  FileCodexImageCapabilityEvidenceSource,
} from './FileCodexImageCapabilityEvidenceSource';
import type { ImageCleanupService } from './ImageCleanupService';
import {
  createImageRuntimeGeneration,
  type ImageRuntimeMetadataObservability,
  type ProductionImageRuntimeGeneration,
  type SyntheticVerifiedImageProviderTestSeam,
} from './ImageRuntimeGenerationFactory';
import {
  ImageRuntimeManager,
} from './ImageRuntimeManager';
import {
  ImageStorageMountCatalog,
  MountedImageReferenceStore,
  MountedResponsesImageStateStore,
  type ImageStorageMountPolicy,
} from './ImageStorageMountCatalog';
import { ImageStartupReconciler } from './ImageStartupReconciler';
import type { DaemonImageActiveScopeRegistry } from './imageTemporaryResources';

export interface ImageRuntimeConfigControllerOptions {
  readonly manager: ImageRuntimeManager;
  readonly subscriptionAccounts: Pick<SubscriptionAccountService, 'getStrategy'>;
  readonly storageCatalog: ImageStorageMountCatalog;
  readonly referenceStore: MountedImageReferenceStore;
  readonly stateStore: MountedResponsesImageStateStore;
  readonly activeTemporaryScopes?: DaemonImageActiveScopeRegistry;
  readonly evidenceOwner?: FileCodexImageCapabilityEvidenceManifestOwner;
  readonly cleanupService?: ImageCleanupService;
  readonly observability?: ImageRuntimeMetadataObservability;
  readonly provenRemoteResolver?: RemoteImageAssetResolver;
  readonly firstGenerationNumber?: number;
  readonly createGeneration?: typeof createImageRuntimeGeneration;
  readonly testOnlySyntheticVerifiedProvider?: SyntheticVerifiedImageProviderTestSeam;
}

export interface ImageRuntimeConfigController {
  prepareConfig(config: ImagesServerConfig): Promise<PreparedServerConfigChange>;
}

export function imageStoragePolicy(config: ImagesServerConfig): ImageStorageMountPolicy {
  return Object.freeze({
    referenceLimits: Object.freeze({
      ttlMs: config.references.ttlMs,
      maxArtifactBytes: config.references.maxArtifactBytes,
      maxTotalBytes: config.references.maxTotalBytes,
      maxTenantBytes: config.references.maxTenantBytes,
      maxEntries: config.references.maxEntries,
      maxTombstones: config.references.maxTombstones,
      tombstoneTtlMs: config.references.tombstoneTtlMs,
    }),
    responsesStateLimits: Object.freeze({
      maxCalls: config.references.maxCalls,
      maxResponses: config.references.maxResponses,
      maxTombstones: config.references.maxTombstones,
      tombstoneTtlMs: config.references.tombstoneTtlMs,
    }),
  });
}

/** Coordinates one failure-atomic storage-mount + runtime-generation update. */
export function createImageRuntimeConfigController(
  options: ImageRuntimeConfigControllerOptions,
): ImageRuntimeConfigController {
  let nextGenerationNumber = options.firstGenerationNumber ?? 1;
  const createGeneration = options.createGeneration ?? createImageRuntimeGeneration;

  return Object.freeze({
    prepareConfig: async (config: ImagesServerConfig): Promise<PreparedServerConfigChange> => {
      const storagePolicy = imageStoragePolicy(config);
      const mount = options.storageCatalog.prepareActivation(
        config.references.storageRoot,
        storagePolicy,
      );
      const referenceStore = options.referenceStore.bindWriteBackend(
        mount.backend,
        storagePolicy.referenceLimits,
      );
      const stateStore = options.stateStore.bindWriteBackend(
        mount.backend,
        storagePolicy.responsesStateLimits,
      );
      const releaseStorageBackend = options.storageCatalog.retainBackend(mount.backend);
      let storageBackendReleased = false;
      const releaseStorageOnce = (): void => {
        if (storageBackendReleased) return;
        storageBackendReleased = true;
        releaseStorageBackend();
      };
      let generation: ProductionImageRuntimeGeneration | undefined;
      let evidenceSource: FileCodexImageCapabilityEvidenceSource | undefined;
      let runtimeChange: ReturnType<ImageRuntimeManager['prepare']> | undefined;
      let cleanupChange: ReturnType<ImageCleanupService['preparePolicy']> | undefined;
      try {
        evidenceSource = options.evidenceOwner?.createSource(config.evidenceTtlMs);
        const createdGeneration = createGeneration({
          generationId: `image-runtime-${nextGenerationNumber++}`,
          config,
          subscriptionAccounts: options.subscriptionAccounts,
          storage: {
            paths: mount.backend.resolver,
            referenceStore,
            stateStore,
          },
          ...(options.observability ? { observability: options.observability } : {}),
          ...(options.activeTemporaryScopes
            ? { activeTemporaryScopes: options.activeTemporaryScopes }
            : {}),
          ...(evidenceSource ? { evidenceSource } : {}),
          ...(options.provenRemoteResolver
            ? { provenRemoteResolver: options.provenRemoteResolver }
            : {}),
          ...(options.testOnlySyntheticVerifiedProvider
            ? { testOnlySyntheticVerifiedProvider: options.testOnlySyntheticVerifiedProvider }
            : {}),
        });
        generation = Object.freeze({
          ...createdGeneration,
          dispose: async (): Promise<void> => {
            try {
              await createdGeneration.dispose();
            } finally {
              evidenceSource?.dispose();
              releaseStorageOnce();
            }
          },
        }) as ProductionImageRuntimeGeneration;
        runtimeChange = options.manager.prepare(generation);
        if (options.cleanupService) {
          cleanupChange = options.cleanupService.preparePolicy({
            reconciler: new ImageStartupReconciler({
              catalog: options.storageCatalog,
              temporaryPaths: mount.backend.resolver,
              staleTemporaryAfterMs: config.temporary.staleAfterMs,
              ...(options.activeTemporaryScopes
                ? { activeTemporaryScopes: options.activeTemporaryScopes }
                : {}),
            }),
            intervalMs: Math.min(
              config.temporary.cleanupIntervalMs,
              config.references.cleanupIntervalMs,
            ),
            ...(options.evidenceOwner ? { evidence: options.evidenceOwner } : {}),
          });
        }
      } catch (error) {
        cleanupChange?.dispose();
        mount.dispose();
        await generation?.dispose();
        evidenceSource?.dispose();
        releaseStorageOnce();
        throw error;
      }

      const preparedRuntime = runtimeChange;
      return Object.freeze({
        publish: (): void => {
          mount.publish();
          preparedRuntime.publish();
          cleanupChange?.publish();
        },
        rollback: (): void => {
          cleanupChange?.rollback();
          preparedRuntime.rollback();
          mount.rollback();
        },
        dispose: async (): Promise<void> => {
          cleanupChange?.dispose();
          await preparedRuntime.dispose();
          mount.dispose();
        },
      });
    },
  });
}
