import type { ImageReferenceId } from '@omnicross/contracts/image-generation-types';

import { ImageGenerationError } from '../errors';
import type { ImageAsset } from '../ports';
import type { ImageRequestResourceScope } from './TemporaryImageAsset';
import type { ImageApiRuntime, ImageRemoteMaterializer } from './types';
import { validateRaster } from './validateRaster';

export type ClosedImageInput =
  | { readonly file_id: string }
  | { readonly image_url: string };

function invalid(param = 'image'): never {
  throw new ImageGenerationError('invalid_image_request', { param });
}

function closedInput(value: unknown, maxRemoteUrlBytes: number): ClosedImageInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1) invalid();
  const key = keys[0];
  if (key !== 'file_id' && key !== 'image_url') invalid();
  const item = record[key];
  const maxBytes = key === 'file_id' ? 256 : maxRemoteUrlBytes;
  if (typeof item !== 'string' || !item || Buffer.byteLength(item, 'utf8') > maxBytes) invalid();
  return { [key]: item } as ClosedImageInput;
}

function decodedBase64Length(value: string): number {
  if (value.length === 0 || value.length % 4 !== 0) invalid();
  let padding = 0;
  if (value.charCodeAt(value.length - 1) === 0x3d) padding += 1;
  if (value.charCodeAt(value.length - 2) === 0x3d) padding += 1;
  const decoded = (value.length / 4) * 3 - padding;
  if (!Number.isSafeInteger(decoded) || decoded <= 0) invalid();
  return decoded;
}

function validateBase64(value: string, padding: number): void {
  const alphabetEnd = value.length - padding;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const alphabet =
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2b || code === 0x2f;
    if (index < alphabetEnd ? !alphabet : code !== 0x3d) invalid();
  }
  const alphabetValue = (code: number): number => {
    if (code >= 0x41 && code <= 0x5a) return code - 0x41;
    if (code >= 0x61 && code <= 0x7a) return code - 0x61 + 26;
    if (code >= 0x30 && code <= 0x39) return code - 0x30 + 52;
    return code === 0x2b ? 62 : 63;
  };
  if (padding === 1 && (alphabetValue(value.charCodeAt(value.length - 2)) & 0x03) !== 0) invalid();
  if (padding === 2 && (alphabetValue(value.charCodeAt(value.length - 3)) & 0x0f) !== 0) invalid();
}

async function* decodeBase64Chunks(value: string): AsyncIterable<Uint8Array> {
  const blockCharacters = 64 * 1024;
  for (let offset = 0; offset < value.length; offset += blockCharacters) {
    const end = Math.min(value.length, offset + blockCharacters);
    yield Buffer.from(value.slice(offset, end), 'base64');
  }
}

async function resolveDataUrl(
  value: string,
  runtime: ImageApiRuntime,
  scope: ImageRequestResourceScope,
  signal: AbortSignal,
): Promise<ImageAsset> {
  const comma = value.indexOf(',');
  if (comma < 0) invalid();
  const descriptor = value.slice(0, comma).toLowerCase();
  if (!['data:image/png;base64', 'data:image/jpeg;base64', 'data:image/webp;base64'].includes(descriptor)) {
    invalid();
  }
  const encoded = value.slice(comma + 1);
  const decoded = decodedBase64Length(encoded);
  if (decoded > runtime.limits.maxFileBytes) throw new ImageGenerationError('image_too_large');
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  validateBase64(encoded, padding);
  const file = await scope.materialize(decodeBase64Chunks(encoded), {
    declaredBytes: decoded,
    maxBytes: runtime.limits.maxFileBytes,
    signal,
  });
  return validateRaster(file, runtime.limits);
}

async function resolveReference(
  referenceId: string,
  runtime: ImageApiRuntime,
  scope: ImageRequestResourceScope,
): Promise<ImageAsset> {
  if (!runtime.referenceStore) throw new ImageGenerationError('unsupported_capability', { param: 'file_id' });
  const result = await runtime.referenceStore.resolve(runtime.tenantId, referenceId as ImageReferenceId);
  if (result.status === 'not_found') throw new ImageGenerationError('image_reference_not_found', { param: 'file_id' });
  if (result.status === 'expired') throw new ImageGenerationError('image_reference_expired', { param: 'file_id' });
  const asset = result.lease.value.artifact;
  if (!asset) {
    await result.lease.release();
    throw new ImageGenerationError('unsupported_capability', { param: 'file_id' });
  }
  if (
    asset.byteLength !== result.lease.metadata.byteLength ||
    asset.width !== result.lease.metadata.width ||
    asset.height !== result.lease.metadata.height ||
    asset.mimeType !== result.lease.metadata.mimeType
  ) {
    await result.lease.release();
    throw new ImageGenerationError('upstream_protocol_changed');
  }
  scope.addLease(result.lease);
  return asset;
}

export async function resolveImageInput(
  value: unknown,
  runtime: ImageApiRuntime,
  scope: ImageRequestResourceScope,
  signal: AbortSignal,
): Promise<ImageAsset> {
  const input = closedInput(value, runtime.limits.maxRemoteUrlBytes);
  if ('file_id' in input) return resolveReference(input.file_id, runtime, scope);
  if (input.image_url.toLowerCase().startsWith('data:')) {
    return resolveDataUrl(input.image_url, runtime, scope, signal);
  }
  if (!runtime.remoteResolver) {
    throw new ImageGenerationError('unsupported_capability', { param: 'image_url' });
  }
  const materializer: ImageRemoteMaterializer = {
    async materialize(source, declaredBytes, remoteSignal) {
      const file = await scope.materialize(source, {
        maxBytes: runtime.limits.maxFileBytes,
        ...(declaredBytes !== undefined ? { declaredBytes } : {}),
        signal: remoteSignal,
      });
      return validateRaster(file, runtime.limits);
    },
  };
  return runtime.remoteResolver.resolve({
    url: input.image_url,
    signal,
    limits: runtime.limits,
    materializer,
  });
}

export function parseImageInputList(value: unknown, maxRemoteUrlBytes: number): readonly unknown[] {
  const list = Array.isArray(value) ? value : [value];
  if (list.length < 1 || list.length > 16) invalid();
  for (const item of list) closedInput(item, maxRemoteUrlBytes);
  return list;
}
