import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';

import sharp from 'sharp';

import { ImageGenerationError } from '../errors';
import type { ImageAsset } from '../ports';
import type { StagedTemporaryFile } from './TemporaryImageAsset';
import type { ImageApiLimits } from './types';

type RasterFormat = 'png' | 'jpeg' | 'webp';

function unsupported(): never {
  throw new ImageGenerationError('unsupported_image_type');
}

function tooLarge(): never {
  throw new ImageGenerationError('image_too_large');
}

function hasPrefix(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function signatureFormat(header: Uint8Array): RasterFormat {
  if (hasPrefix(header, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (hasPrefix(header, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (
    hasPrefix(header, [0x52, 0x49, 0x46, 0x46]) &&
    header[8] === 0x57 && header[9] === 0x45 && header[10] === 0x42 && header[11] === 0x50
  ) return 'webp';
  unsupported();
}

async function inspectContainer(privatePath: string, byteLength: number): Promise<RasterFormat> {
  if (byteLength < 12) unsupported();
  const handle = await open(privatePath, 'r');
  try {
    const header = Buffer.allocUnsafe(12);
    const headerRead = await handle.read(header, 0, header.byteLength, 0);
    if (headerRead.bytesRead !== header.byteLength) unsupported();
    const format = signatureFormat(header);
    if (format === 'png') {
      if (byteLength < 20) unsupported();
      const trailer = Buffer.allocUnsafe(12);
      const result = await handle.read(trailer, 0, trailer.byteLength, byteLength - trailer.byteLength);
      if (
        result.bytesRead !== trailer.byteLength ||
        trailer.readUInt32BE(0) !== 0 ||
        trailer.toString('ascii', 4, 8) !== 'IEND' ||
        !hasPrefix(trailer.subarray(8), [0xae, 0x42, 0x60, 0x82])
      ) unsupported();
    } else if (format === 'jpeg') {
      const trailer = Buffer.allocUnsafe(2);
      const result = await handle.read(trailer, 0, 2, byteLength - 2);
      if (result.bytesRead !== 2 || trailer[0] !== 0xff || trailer[1] !== 0xd9) unsupported();
    } else {
      const declared = header.readUInt32LE(4) + 8;
      if (declared !== byteLength) unsupported();
    }
    return format;
  } finally {
    await handle.close();
  }
}

function mapSharpFailure(error: unknown): never {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('pixel limit') || message.includes('memory') || message.includes('too large')) tooLarge();
  unsupported();
}

export interface ValidatedRasterMetadata {
  readonly format: RasterFormat;
  readonly mimeType: `image/${RasterFormat}`;
  readonly width: number;
  readonly height: number;
  readonly hasAlpha: boolean;
  readonly sha256: string;
}

export async function validateRaster(
  file: StagedTemporaryFile,
  limits: Pick<ImageApiLimits, 'maxFileBytes' | 'maxPixels' | 'maxRawBytes'>,
): Promise<ImageAsset> {
  if (file.byteLength > limits.maxFileBytes) tooLarge();
  const metadata = await file.inspect(async (privatePath) => {
    const format = await inspectContainer(privatePath, file.byteLength);
    const encoded = await readFile(privatePath);
    if (encoded.byteLength !== file.byteLength) unsupported();
    try {
      const image = sharp(encoded, {
        failOn: 'warning',
        sequentialRead: true,
        limitInputPixels: limits.maxPixels,
        pages: 1,
        animated: false,
      });
      const info = await image.metadata();
      image.destroy();
      if (info.format !== format) unsupported();
      if ((info.pages ?? 1) !== 1 || (info.pageHeight !== undefined && info.height !== info.pageHeight)) unsupported();
      const width = info.width;
      const height = info.height;
      const channels = info.channels;
      if (
        !width || !height || !channels ||
        !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || !Number.isSafeInteger(channels)
      ) unsupported();
      const pixels = width * height;
      const rawBytes = pixels * channels;
      if (
        !Number.isSafeInteger(pixels) || pixels <= 0 || pixels > limits.maxPixels ||
        !Number.isSafeInteger(rawBytes) || rawBytes <= 0 || rawBytes > limits.maxRawBytes
      ) tooLarge();
      const decoder = sharp(encoded, {
        failOn: 'warning',
        sequentialRead: true,
        limitInputPixels: limits.maxPixels,
        pages: 1,
        animated: false,
      }).raw();
      const decoded = await decoder.toBuffer({ resolveWithObject: true });
      decoder.destroy();
      if (
        decoded.info.width !== width || decoded.info.height !== height ||
        decoded.info.channels !== channels || decoded.data.byteLength !== rawBytes
      ) unsupported();
      return {
        format,
        mimeType: `image/${format}` as const,
        width,
        height,
        hasAlpha: info.hasAlpha === true,
        sha256: createHash('sha256').update(encoded).digest('hex'),
      } satisfies ValidatedRasterMetadata;
    } catch (error) {
      if (error instanceof ImageGenerationError) throw error;
      mapSharpFailure(error);
    }
  });
  return file.toImageAsset(metadata);
}

export function assertCompatibleMask(primary: ImageAsset, mask: ImageAsset): void {
  if (
    mask.mimeType !== primary.mimeType ||
    mask.width !== primary.width ||
    mask.height !== primary.height ||
    mask.hasAlpha !== true
  ) {
    throw new ImageGenerationError('invalid_image_request', { param: 'mask' });
  }
}
