/**
 * Derives the image runtime's `publishInput` (the port URL-only providers such
 * as WaveSpeed edit require) from the `images.storage` config block. Both
 * factory entry points (bootstrap + config-controller generation swaps) build
 * generations from the same normalized config, so wiring the publisher here
 * keeps publishing consistent across runtime restarts and config changes.
 *
 * Credentials follow the provider-key `$ENV_NAME` convention: a value starting
 * with `$` resolves from the environment at publish time, anything else is a
 * literal. An enabled-but-unusable block yields NO publisher (edit stays
 * capability-off) rather than a half-working one — same contract as the
 * Elftia host gate.
 *
 * @module daemon/image-generation/imagesStoragePublishInput
 */

import type { ApiImageProviderOptions } from '@omnicross/core/image-generation';
import { readImageAssetBytes } from '@omnicross/core/image-generation';
import {
  createObjectStoragePublisher,
  type ObjectStorageCredentials,
} from '@omnicross/core/object-storage';
import type { ImagesObjectStorageConfig } from '@omnicross/core/outbound-api';

export type StoragePublishInput = NonNullable<ApiImageProviderOptions['publishInput']>;

function resolveEnvRef(value: string): string {
  return value.startsWith('$') ? process.env[value.slice(1)]?.trim() ?? '' : value.trim();
}

function resolveCredentials(config: ImagesObjectStorageConfig): ObjectStorageCredentials | null {
  const accessKeyId = resolveEnvRef(config.accessKeyId);
  const secretAccessKey = resolveEnvRef(config.secretAccessKey);
  const sessionToken = config.sessionToken ? resolveEnvRef(config.sessionToken) : '';
  if (!accessKeyId || !secretAccessKey || !config.bucket.trim()) return null;
  return {
    accessKeyId,
    secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
  };
}

const MIME_EXTENSION: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

/**
 * Build a publishInput for the config's storage block, or undefined when
 * publishing is off (block absent/disabled) or unusable (missing credentials).
 */
export function createImagesStoragePublishInput(
  config: ImagesObjectStorageConfig | undefined,
  options: { maxInputBytes?: number; fetchImpl?: typeof globalThis.fetch } = {}
): StoragePublishInput | undefined {
  if (!config?.enabled) return undefined;
  const credentials = resolveCredentials(config);
  if (!credentials) return undefined;
  const maxInputBytes = options.maxInputBytes ?? 50 * 1024 * 1024;
  const publisher = createObjectStoragePublisher({
    kind: config.kind,
    target: {
      bucket: config.bucket,
      ...(config.region ? { region: config.region } : {}),
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      ...(config.prefix ? { prefix: config.prefix } : {}),
      ...(config.publicBaseUrl ? { publicBaseUrl: config.publicBaseUrl } : {}),
      urlMode: config.urlMode,
      ...(config.expiresInSeconds !== undefined
        ? { expiresInSeconds: config.expiresInSeconds }
        : {}),
      ...(config.forcePathStyle !== undefined ? { forcePathStyle: config.forcePathStyle } : {}),
    },
    credentials,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  return async (asset, signal) => {
    const bytes = await readImageAssetBytes(asset, maxInputBytes, signal);
    const extension = MIME_EXTENSION[asset.mimeType] ?? '';
    const published = await publisher.publish(
      {
        bytes,
        contentType: asset.mimeType,
        fileName: `input${extension}`,
        hints: { purpose: 'image-input' },
      },
      signal
    );
    return published.url;
  };
}
