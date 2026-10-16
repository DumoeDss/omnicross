import { createHash } from 'node:crypto';

import type { ImageOutputFormat } from '@omnicross/contracts/image-generation-types';
import sharp from 'sharp';

import { ImageGenerationError } from '../errors';
import { createSafeRemoteImageResolver } from '../openai-images/safeRemoteImageResolver';
import { DEFAULT_IMAGE_API_LIMITS } from '../openai-images/types';
import { InMemoryImageAsset, readImageAssetBytes, type ImageAsset } from '../ports';

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function apiUrl(base: string, path: string, version = 'v1'): string {
  const url = new URL(base);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ImageGenerationError('invalid_image_request', { param: 'provider.baseUrl' });
  }
  const prefix = url.pathname.replace(/\/+$/u, '');
  const alreadyVersioned = new RegExp(`/${version}$`, 'u').test(prefix);
  url.pathname = `${prefix}${alreadyVersioned ? '' : `/${version}`}/${path.replace(/^\/+/, '')}`;
  return url.toString();
}

export async function readBoundedBytes(
  source: AsyncIterable<Uint8Array>, maxBytes: number, signal: AbortSignal,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of source) {
    signal.throwIfAborted();
    total += chunk.byteLength;
    if (total > maxBytes) throw new ImageGenerationError('image_too_large');
    chunks.push(chunk);
  }
  signal.throwIfAborted();
  return Buffer.concat(chunks, total);
}

export async function responseJson(response: Response, maxBytes: number, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const code = response.status === 401 || response.status === 403 ? 'upstream_auth_required'
      : response.status === 429 ? 'upstream_rate_limited'
        : 'image_generation_failed';
    throw new ImageGenerationError(code, { httpStatus: response.status });
  }
  if (!response.body) throw new ImageGenerationError('upstream_protocol_changed');
  const reader = response.body.getReader();
  async function* chunks(): AsyncIterable<Uint8Array> {
    try { while (true) { const next = await reader.read(); if (next.done) return; yield next.value; } }
    finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
  const bytes = await readBoundedBytes(chunks(), maxBytes, signal);
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required');
    return parsed as Record<string, unknown>;
  } catch { throw new ImageGenerationError('upstream_protocol_changed'); }
}

export function decodeImageBase64(value: unknown, maxBytes: number): Uint8Array {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4 + 40) {
    throw new ImageGenerationError('image_too_large');
  }
  const base64 = value.replace(/^data:image\/(?:png|jpeg|webp);base64,/u, '');
  if (!base64 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(base64) || base64.length % 4 === 1) {
    throw new ImageGenerationError('upstream_protocol_changed');
  }
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > maxBytes) throw new ImageGenerationError('image_too_large');
  if (bytes.toString('base64').replace(/=+$/, '') !== base64.replace(/=+$/, '')) {
    throw new ImageGenerationError('upstream_protocol_changed');
  }
  return bytes;
}

/** Full raster decoding precedes exposure; provider-supplied MIME metadata is never trusted. */
export async function createApiImageAsset(
  bytes: Uint8Array,
  limits: { maxBytes: number; maxPixels: number },
  format?: ImageOutputFormat,
): Promise<ImageAsset> {
  if (!bytes.byteLength || bytes.byteLength > limits.maxBytes) throw new ImageGenerationError('image_too_large');
  let input: ReturnType<typeof sharp> | undefined;
  let raster: ReturnType<typeof sharp> | undefined;
  try {
    input = sharp(bytes, { limitInputPixels: limits.maxPixels, failOn: 'warning', animated: false });
    const metadata = await input.metadata();
    if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) !== 1) {
      throw new ImageGenerationError('unsupported_image_type');
    }
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > limits.maxPixels) {
      throw new ImageGenerationError('image_too_large');
    }
    raster = input.clone().raw();
    const decoded = await raster.toBuffer();
    if (decoded.byteLength > limits.maxPixels * 4) throw new ImageGenerationError('image_too_large');
    let encoded = bytes;
    if (format && metadata.format !== format) encoded = await input.toFormat(format).toBuffer();
    if (encoded.byteLength > limits.maxBytes) throw new ImageGenerationError('image_too_large');
    return new InMemoryImageAsset(encoded, {
      mimeType: `image/${format ?? metadata.format}` as `image/${ImageOutputFormat}`,
      width: metadata.width,
      height: metadata.height,
      hasAlpha: format === 'jpeg' ? false : metadata.hasAlpha === true,
      sha256: createHash('sha256').update(encoded).digest('hex'),
    });
  } catch (error) {
    if (error instanceof ImageGenerationError) throw error;
    throw new ImageGenerationError('unsupported_image_type');
  } finally {
    raster?.destroy();
    input?.destroy();
  }
}

export async function downloadApiImage(url: string, signal: AbortSignal, maxBytes: number): Promise<Uint8Array> {
  const resolver = createSafeRemoteImageResolver();
  const asset = await resolver.resolve({
    url, signal,
    limits: { ...DEFAULT_IMAGE_API_LIMITS, maxFileBytes: maxBytes, maxTotalInputBytes: maxBytes },
    materializer: {
      materialize: async (source) => {
        const bytes = await readBoundedBytes(source, maxBytes, signal);
        return createApiImageAsset(bytes, { maxBytes, maxPixels: 67_108_864 });
      },
    },
  });
  return readImageAssetBytes(asset, maxBytes, signal);
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = (): void => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
