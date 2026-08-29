import type {
  ImageBackground,
  ImageModeration,
  ImageOutputFormat,
  ImageQuality,
  ImageRequestOptions,
  ImageSize,
  NormalizedImageGenerateRequest,
} from '@omnicross/contracts/image-generation-types';

import { ImageGenerationError } from '../errors';
import type { ImageApiRuntime } from './types';

const OPTION_KEYS = new Set([
  'prompt',
  'model',
  'n',
  'quality',
  'size',
  'background',
  'output_format',
  'output_compression',
  'moderation',
  'stream',
  'partial_images',
  'user',
]);

export interface NormalizeImageOptionsInput {
  readonly action: 'generate' | 'edit';
  readonly multipart?: boolean;
  readonly extraKeys?: readonly string[];
}

function invalid(param?: string): never {
  throw new ImageGenerationError('invalid_image_request', { param });
}

function recordOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function scalar(value: unknown, multipart: boolean): unknown {
  if (!multipart || typeof value !== 'string') return value;
  return value.trim();
}

function integer(
  value: unknown,
  fallback: number,
  param: string,
  min: number,
  max: number,
  multipart: boolean,
): number {
  const item = scalar(value, multipart);
  const parsed = typeof item === 'string' && /^\d+$/.test(item) ? Number(item) : item;
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < min || (parsed as number) > max) invalid(param);
  return parsed as number;
}

function booleanValue(value: unknown, fallback: boolean, param: string, multipart: boolean): boolean {
  if (value === undefined) return fallback;
  const item = scalar(value, multipart);
  if (item === true || item === 'true') return true;
  if (item === false || item === 'false') return false;
  return invalid(param);
}

function enumValue<T extends string>(
  value: unknown,
  fallback: T,
  allowed: readonly T[],
  param: string,
  multipart: boolean,
): T {
  if (value === undefined) return fallback;
  const item = scalar(value, multipart);
  if (typeof item !== 'string' || !allowed.includes(item as T)) invalid(param);
  return item as T;
}

function parseSize(value: unknown, multipart: boolean): ImageSize {
  if (value === undefined || scalar(value, multipart) === 'auto') return { kind: 'auto' };
  const item = scalar(value, multipart);
  if (typeof item !== 'string') invalid('size');
  const match = /^(\d+)x(\d+)$/.exec(item);
  if (!match) invalid('size');
  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixels = width * height;
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  if (
    !Number.isSafeInteger(pixels) ||
    width % 16 !== 0 ||
    height % 16 !== 0 ||
    width <= 0 ||
    height <= 0 ||
    long > 3840 ||
    long / short > 3 ||
    pixels < 655_360 ||
    pixels > 8_294_400
  ) invalid('size');
  return { kind: 'pixels', width, height };
}

export function normalizeImageOptions(
  value: unknown,
  runtime: ImageApiRuntime,
  input: NormalizeImageOptionsInput,
): ImageRequestOptions {
  const record = recordOf(value);
  const allowed = new Set([...OPTION_KEYS, ...(input.extraKeys ?? [])]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) invalid(key);
  }
  const multipart = input.multipart === true;
  const promptValue = scalar(record.prompt, multipart);
  if (typeof promptValue !== 'string' || !promptValue.trim() || promptValue.length > 32_000) {
    invalid('prompt');
  }
  const requestedModel = record.model === undefined
    ? runtime.defaultModel
    : scalar(record.model, multipart);
  if (typeof requestedModel !== 'string' || !requestedModel.trim() || requestedModel.length > 128) {
    invalid('model');
  }
  const model = runtime.modelAliases.get(requestedModel) ?? requestedModel;
  const n = integer(record.n, 1, 'n', 1, 10, multipart);
  const quality = enumValue<ImageQuality>(record.quality, 'auto', ['auto', 'low', 'medium', 'high'], 'quality', multipart);
  const size = parseSize(record.size, multipart);
  const background = enumValue<ImageBackground>(record.background, 'auto', ['auto', 'opaque', 'transparent'], 'background', multipart);
  const outputFormat = enumValue<ImageOutputFormat>(record.output_format, 'png', ['png', 'jpeg', 'webp'], 'output_format', multipart);
  const outputCompression = record.output_compression === undefined
    ? undefined
    : integer(record.output_compression, 0, 'output_compression', 0, 100, multipart);
  const moderation = enumValue<ImageModeration>(record.moderation, 'auto', ['auto', 'low'], 'moderation', multipart);
  const stream = booleanValue(record.stream, false, 'stream', multipart);
  const partialImages = integer(record.partial_images, 0, 'partial_images', 0, 3, multipart);
  if (background === 'transparent' && outputFormat === 'jpeg') invalid('background');
  if (outputCompression !== undefined && outputFormat === 'png') invalid('output_compression');
  if (partialImages > 0 && !stream) invalid('partial_images');

  let userFingerprint: string | undefined;
  if (record.user !== undefined) {
    const user = scalar(record.user, multipart);
    if (typeof user !== 'string' || !user || user.length > 256) invalid('user');
    if (runtime.fingerprintUser) {
      const fingerprint = runtime.fingerprintUser(user);
      if (typeof fingerprint !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(fingerprint)) {
        throw new TypeError('The injected image user fingerprint is not a safe identifier.');
      }
      userFingerprint = fingerprint;
    }
  }

  return {
    model,
    prompt: promptValue,
    n,
    quality,
    size,
    background,
    outputFormat,
    ...(outputCompression !== undefined ? { outputCompression } : {}),
    moderation,
    stream,
    partialImages,
    ...(userFingerprint !== undefined ? { userFingerprint } : {}),
  };
}

export function normalizeGenerateRequest(
  value: unknown,
  runtime: ImageApiRuntime,
): NormalizedImageGenerateRequest {
  return { action: 'generate', ...normalizeImageOptions(value, runtime, { action: 'generate' }) };
}
