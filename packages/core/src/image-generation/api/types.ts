import type { ImageCapabilities } from '@omnicross/contracts/image-generation-types';

import type { ImageAsset } from '../ports';
import type { ImageProviderContext } from '../ImageProvider';

export const IMAGE_API_PROTOCOLS = [
  'openai-images', 'gemini', 'gemini-interactions', 'vertex', 'xai', 'openrouter', 'wavespeed',
] as const;

export type ImageApiProtocol = (typeof IMAGE_API_PROTOCOLS)[number];

/** Credentials stay in the host's existing provider store. */
export interface ImageApiProviderConfig {
  readonly protocol: ImageApiProtocol;
  readonly sourceProviderId: string;
  readonly enabled?: boolean;
  /** Upstream model catalog, independent of public model routes. */
  readonly models?: readonly string[];
  /** Optional request names in this provider's catalog, independent of active routes. */
  readonly modelAliases?: Readonly<Record<string, string>>;
  /** Public route id to upstream model id; omitted entries use the public id. */
  readonly modelMap?: Readonly<Record<string, string>>;
}

export interface ImageApiCredentials {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface ApiImageProviderOptions {
  readonly id: string;
  readonly protocol: ImageApiProtocol;
  readonly models: Readonly<Record<string, string>>;
  readonly resolveCredentials: (signal: AbortSignal) => Promise<ImageApiCredentials | null>;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly maxTotalOutputBytes?: number;
  readonly maxPixels?: number;
  readonly pollIntervalMs?: number;
  readonly acquireExecution?: (context: ImageProviderContext, signal: AbortSignal) => Promise<{
    readonly signal?: AbortSignal;
    release(): void | Promise<void>;
  }>;
  /** Host-owned publication, needed by APIs accepting public input URLs only. */
  readonly publishInput?: (asset: ImageAsset, signal: AbortSignal) => Promise<string>;
  readonly downloadOutput?: (url: string, signal: AbortSignal, maxBytes: number) => Promise<Uint8Array>;
  readonly capabilityOverrides?: Partial<ImageCapabilities>;
}
