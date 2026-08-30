import type {
  ImageCapabilities,
  ImageProviderEvent,
} from '@omnicross/contracts/image-generation-types';
import {
  ImageGenerationError,
  InMemoryImageAsset,
  serializeImageGenerationError,
  type ImageProviderContext,
  type ImageProviderRequest,
} from '@omnicross/core/image-generation';
import type {
  ImageExecutionScheduler,
  ImageExecutionSchedulerGrant,
} from '@omnicross/subscriptions';
import sharp from 'sharp';

import type { SyntheticVerifiedImageProviderTestSeam } from '../image-generation/ImageRuntimeGenerationFactory';
import type {
  MountedImageReferenceStore,
  MountedResponsesImageStateStore,
} from '../image-generation/ImageStorageMountCatalog';

export const SYNTHETIC_IMAGE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNgZGJuAAAAlQCHMZ/9HQAAAABJRU5ErkJggg==',
  'base64',
);

export const SYNTHETIC_OUTPUT_PNG = await sharp({
  create: {
    width: 1024,
    height: 1024,
    channels: 4,
    background: { r: 1, g: 2, b: 3, alpha: 0.5 },
  },
}).png().toBuffer();

export interface SyntheticVerifiedImageCapture {
  readonly generationIds: string[];
  readonly schedulers: ImageExecutionScheduler[];
  readonly referenceStores: MountedImageReferenceStore[];
  readonly stateStores: MountedResponsesImageStateStore[];
  readonly contexts: ImageProviderContext[];
  readonly requests: ImageProviderRequest[];
  starts: number;
  active: number;
  maxActive: number;
  cancels: number;
  releases: number;
}

export interface SyntheticVerifiedImageBehavior {
  readonly accountId?: string;
  readonly beforeComplete?: (
    request: ImageProviderRequest,
    context: ImageProviderContext,
  ) => Promise<void> | void;
  readonly failWith?: ConstructorParameters<typeof ImageGenerationError>[0];
}

export function createSyntheticVerifiedImageCapture(): SyntheticVerifiedImageCapture {
  return {
    generationIds: [],
    schedulers: [],
    referenceStores: [],
    stateStores: [],
    contexts: [],
    requests: [],
    starts: 0,
    active: 0,
    maxActive: 0,
    cancels: 0,
    releases: 0,
  };
}

export function createSyntheticVerifiedImageProviderSeam(
  capture: SyntheticVerifiedImageCapture,
  behavior: SyntheticVerifiedImageBehavior = {},
): SyntheticVerifiedImageProviderTestSeam {
  return Object.freeze({
    label: 'synthetic-verified-image-provider-test-only' as const,
    createProvider: ({ generationId, scheduler, now, referenceStore, stateStore }) => {
      capture.generationIds.push(generationId);
      capture.schedulers.push(scheduler);
      capture.referenceStores.push(referenceStore);
      capture.stateStores.push(stateStore);
      const capabilities: ImageCapabilities = Object.freeze({
        available: true,
        models: Object.freeze(['gpt-image-2']),
        generate: true,
        edit: true,
        maskEdit: true,
        maxInputImages: 16,
        maxOutputImages: 4,
        streaming: true,
        maxPartialImages: 3,
        transparentBackground: true,
        flexibleSizes: true,
        outputFormats: Object.freeze(['png', 'jpeg', 'webp']),
        qualityLevels: Object.freeze(['auto', 'low', 'medium', 'high']),
        moderationModes: Object.freeze(['auto', 'low']),
        outputCompression: Object.freeze({
          supported: true,
          formats: Object.freeze(['jpeg', 'webp']),
          min: 0,
          max: 100,
        }),
        responsesTool: true,
        multiTurnEdit: true,
        supportsFileId: false,
        supportsImageUrl: false,
        resolvedAt: now(),
        oldestEvidenceAt: now(),
      });
      return Object.freeze({
        id: 'codex-subscription',
        acquire: async (context: ImageProviderContext) => {
          capture.contexts.push(context);
          let released = false;
          return {
            providerId: 'codex-subscription',
            capabilities,
            start: (request: ImageProviderRequest) => {
              capture.starts += 1;
              capture.requests.push(request);
              let cancelled = false;
              let grant: ImageExecutionSchedulerGrant | undefined;
              const events = (async function* (): AsyncIterable<ImageProviderEvent> {
                const accountKey = scheduler.deriveAccountKey(
                  behavior.accountId ?? 'synthetic-tier-a-account',
                );
                grant = await scheduler.acquire({
                  tenantId: context.tenantId,
                  accountKey,
                  signal: context.signal,
                });
                capture.active += 1;
                capture.maxActive = Math.max(capture.maxActive, capture.active);
                try {
                  yield { type: 'accepted', acceptedAt: now() };
                  await behavior.beforeComplete?.(request, context);
                  if (cancelled || context.signal.aborted || grant.signal?.aborted) {
                    throw new ImageGenerationError('request_cancelled');
                  }
                  if (behavior.failWith) {
                    yield {
                      type: 'failed',
                      error: serializeImageGenerationError(
                        new ImageGenerationError(behavior.failWith),
                      ),
                    };
                    return;
                  }
                  for (let partialImageIndex = 0;
                    partialImageIndex < request.partialImages;
                    partialImageIndex += 1) {
                    for (let outputIndex = 0; outputIndex < request.n; outputIndex += 1) {
                      yield {
                        type: 'partial_image',
                        outputIndex,
                        partialImageIndex,
                        image: {
                          artifact: new InMemoryImageAsset(SYNTHETIC_IMAGE_PNG, {
                            mimeType: 'image/png',
                            width: 1,
                            height: 1,
                            hasAlpha: true,
                          }),
                        },
                      };
                    }
                  }
                  yield {
                    type: 'completed',
                    images: Array.from({ length: request.n }, () => ({
                      artifact: new InMemoryImageAsset(SYNTHETIC_OUTPUT_PNG, {
                        mimeType: 'image/png',
                        width: 1024,
                        height: 1024,
                        hasAlpha: true,
                      }),
                    })),
                  };
                } finally {
                  capture.active = Math.max(0, capture.active - 1);
                  await grant?.release();
                }
              })();
              return {
                events,
                cancel: async () => {
                  if (!cancelled) capture.cancels += 1;
                  cancelled = true;
                  await grant?.release();
                },
              };
            },
            release: async () => {
              if (released) return;
              released = true;
              capture.releases += 1;
            },
          };
        },
      });
    },
  });
}
