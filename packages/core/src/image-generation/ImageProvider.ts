import type {
  ImageCapabilities,
  ImageProviderEvent,
  NormalizedImageRequest,
} from '@omnicross/contracts/image-generation-types';

import type { ImageAsset } from './ports';

export type ImageProviderRequest = NormalizedImageRequest<ImageAsset>;

export interface ImageProviderContext {
  readonly requestId: string;
  readonly tenantId: string;
  readonly signal: AbortSignal;
  readonly sessionKey?: string;
  readonly preferredAccountId?: string;
  readonly preferredAccountGroup?: string;
  readonly boundAccountFallbackPolicy?: 'strict' | 'pool';
}

/** Optional numeric-only job observations exposed to the orchestrator. */
export interface ImageJobObservabilitySnapshot {
  readonly queueWaitMs?: number;
  readonly generationStartedAt?: number;
  readonly retryCount?: number;
  readonly authRefreshCount?: number;
}

export interface ImageJobObservability {
  snapshot(): ImageJobObservabilitySnapshot;
}

export interface ImageJob {
  readonly events: AsyncIterable<ImageProviderEvent<ImageAsset>>;
  readonly observability?: ImageJobObservability;
  cancel(reason?: string): Promise<void>;
}

export interface ImageProviderLease {
  readonly providerId: string;
  readonly capabilities: ImageCapabilities;
  start(request: ImageProviderRequest): Promise<ImageJob> | ImageJob;
  release(): Promise<void>;
}

export interface ImageProvider {
  readonly id: string;
  acquire(context: ImageProviderContext): Promise<ImageProviderLease>;
}
