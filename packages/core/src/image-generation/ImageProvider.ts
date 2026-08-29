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
}

export interface ImageJob {
  readonly events: AsyncIterable<ImageProviderEvent<ImageAsset>>;
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
