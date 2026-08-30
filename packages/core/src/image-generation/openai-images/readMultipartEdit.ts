import type http from 'node:http';

import Busboy from 'busboy';

import { ImageGenerationError } from '../errors';
import type { ImageAsset } from '../ports';
import type { ImageRequestResourceScope, StagedTemporaryFile } from './TemporaryImageAsset';
import type { ImageApiLimits } from './types';
import { assertCompatibleMask, validateRaster } from './validateRaster';

function invalid(param?: string): ImageGenerationError {
  return new ImageGenerationError('invalid_image_request', { param });
}

function tooLarge(): ImageGenerationError {
  return new ImageGenerationError('image_too_large');
}

function declaredLength(value: string | string[] | undefined, limit: number): number | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) || !/^(0|[1-9]\d*)$/.test(value)) throw tooLarge();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > limit) throw tooLarge();
  return parsed;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

const MAX_MULTIPART_HEADER_BYTES = 16 * 1024;

function multipartBoundary(contentType: string): string {
  const match = /(?:^|;)\s*boundary=(?:"([^"]*)"|([^;\s]*))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (
    !boundary || boundary.length > 200 ||
    !/^[\x20-\x7e]+$/.test(boundary) || boundary.endsWith(' ')
  ) {
    throw invalid('content_type');
  }
  return boundary;
}

/**
 * Busboy 1.6 documents a configurable headerPairs limit but internally fixes
 * multipart parsing at 2000 pairs. Keep a small streaming guard in front of it
 * so the injected Images limit is authoritative even when it is stricter.
 */
class MultipartHeaderPairGuard {
  readonly #opening: Buffer;
  readonly #betweenParts: Buffer;
  readonly #maxPairs: number;
  #state: 'preamble' | 'headers' | 'body' | 'done' = 'preamble';
  #pending = Buffer.alloc(0);

  constructor(boundary: string, maxPairs: number) {
    this.#opening = Buffer.from(`--${boundary}`, 'latin1');
    this.#betweenParts = Buffer.from(`\r\n--${boundary}`, 'latin1');
    this.#maxPairs = maxPairs;
  }

  push(chunk: Uint8Array): void {
    if (this.#state === 'done') return;
    let data = this.#pending.length === 0
      ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      : Buffer.concat([this.#pending, Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)]);
    this.#pending = Buffer.alloc(0);

    while (data.length > 0) {
      if (this.#state === 'preamble') {
        const start = data.indexOf(this.#opening);
        if (start < 0) {
          if (data.length > MAX_MULTIPART_HEADER_BYTES) throw tooLarge();
          this.#pending = Buffer.from(data);
          return;
        }
        data = data.subarray(start + this.#opening.length);
        if (data.length < 2) {
          this.#pending = Buffer.concat([this.#opening, data]);
          return;
        }
        if (data[0] === 0x2d && data[1] === 0x2d) {
          this.#state = 'done';
          return;
        }
        if (data[0] !== 0x0d || data[1] !== 0x0a) throw invalid('content_type');
        data = data.subarray(2);
        this.#state = 'headers';
        continue;
      }

      if (this.#state === 'headers') {
        const end = data.indexOf('\r\n\r\n');
        if (end < 0) {
          if (data.length > MAX_MULTIPART_HEADER_BYTES) throw tooLarge();
          this.#pending = Buffer.from(data);
          return;
        }
        const block = data.subarray(0, end);
        const pairs = block.length === 0 ? 0 : block.toString('latin1').split('\r\n').length;
        if (pairs > this.#maxPairs) throw tooLarge();
        data = data.subarray(end + 4);
        this.#state = 'body';
        continue;
      }

      let searchFrom = 0;
      let boundaryAt = -1;
      while ((boundaryAt = data.indexOf(this.#betweenParts, searchFrom)) >= 0) {
        const suffix = boundaryAt + this.#betweenParts.length;
        if (data.length < suffix + 2) {
          this.#pending = Buffer.from(data.subarray(boundaryAt));
          return;
        }
        if (
          (data[suffix] === 0x2d && data[suffix + 1] === 0x2d) ||
          (data[suffix] === 0x0d && data[suffix + 1] === 0x0a)
        ) break;
        searchFrom = boundaryAt + 1;
      }
      if (boundaryAt < 0) {
        const keep = Math.min(data.length, this.#betweenParts.length - 1);
        this.#pending = Buffer.from(data.subarray(data.length - keep));
        return;
      }
      const suffix = boundaryAt + this.#betweenParts.length;
      if (data[suffix] === 0x2d && data[suffix + 1] === 0x2d) {
        this.#state = 'done';
        return;
      }
      data = data.subarray(suffix + 2);
      this.#state = 'headers';
    }
  }

  finish(): void {
    if (this.#state !== 'done') throw invalid();
  }
}

export interface MultipartEditBody {
  readonly fields: Readonly<Record<string, string>>;
  readonly images: readonly ImageAsset[];
  readonly mask?: ImageAsset;
}

interface PendingFile {
  readonly kind: 'image' | 'mask';
  readonly staged: Promise<StagedTemporaryFile>;
}

export async function readMultipartEdit(
  request: http.IncomingMessage,
  scope: ImageRequestResourceScope,
  limits: ImageApiLimits,
  signal: AbortSignal,
): Promise<MultipartEditBody> {
  if (signal.aborted) throw new ImageGenerationError('request_cancelled', { cause: signal.reason });
  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string' || !/^multipart\/form-data(?:\s*;|$)/i.test(contentType)) {
    throw invalid('content_type');
  }
  const encoding = request.headers['content-encoding'];
  if (Array.isArray(encoding) || (encoding !== undefined && encoding.trim().toLowerCase() !== 'identity')) {
    throw invalid('content_encoding');
  }
  const expected = declaredLength(request.headers['content-length'], limits.maxMultipartBytes);
  const headerGuard = new MultipartHeaderPairGuard(
    multipartBoundary(contentType),
    limits.maxHeaderPairs,
  );
  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  const pending: PendingFile[] = [];
  let imageCount = 0;
  let maskCount = 0;
  let observed = 0;
  let settled = false;

  let parser: ReturnType<typeof Busboy>;
  try {
    parser = Busboy({
      headers: request.headers,
      limits: {
        fileSize: limits.maxFileBytes,
        files: limits.maxFiles,
        fields: limits.maxFields,
        parts: limits.maxParts,
        headerPairs: limits.maxHeaderPairs,
        fieldNameSize: limits.maxFieldNameBytes,
        fieldSize: limits.maxFieldValueBytes,
      },
    });
  } catch {
    throw invalid('content_type');
  }

  const parsed = new Promise<void>((resolve, reject) => {
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      request.unpipe(parser);
      request.pause();
      parser.destroy(error instanceof Error ? error : invalid());
      reject(error);
    };
    const onAbort = (): void => fail(new ImageGenerationError('request_cancelled', { cause: signal.reason }));
    let requestEnded = false;
    const onEnd = (): void => { requestEnded = true; };
    const onClose = (): void => {
      if (!requestEnded) fail(invalid());
    };
    const onRequestError = (): void => fail(invalid());
    const onData = (chunk: Buffer): void => {
      observed += chunk.byteLength;
      if (!Number.isSafeInteger(observed) || observed > limits.maxMultipartBytes || (expected !== undefined && observed > expected)) {
        fail(tooLarge());
        return;
      }
      try {
        headerGuard.push(chunk);
      } catch (error) {
        fail(error);
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    request.on('data', onData);
    request.once('aborted', onAbort);
    request.once('end', onEnd);
    request.once('close', onClose);
    request.once('error', onRequestError);

    parser.on('file', (name, file) => {
      if (settled) {
        file.resume();
        return;
      }
      if (byteLength(name) > limits.maxFieldNameBytes) {
        file.resume();
        fail(tooLarge());
        return;
      }
      let kind: PendingFile['kind'];
      if (name === 'image' || name === 'image[]') {
        imageCount += 1;
        if (imageCount > 16) {
          file.resume();
          fail(invalid('image'));
          return;
        }
        kind = 'image';
      } else if (name === 'mask') {
        maskCount += 1;
        if (maskCount > 1) {
          file.resume();
          fail(invalid('mask'));
          return;
        }
        kind = 'mask';
      } else {
        file.resume();
        fail(invalid(name.length <= 128 ? name : undefined));
        return;
      }
      let truncated = false;
      file.once('limit', () => {
        truncated = true;
      });
      const staged = scope.materialize(file, {
        maxBytes: limits.maxFileBytes,
        signal,
      }).then((value) => {
        if (truncated || file.truncated) throw tooLarge();
        return value;
      });
      staged.catch(fail);
      pending.push({ kind, staged });
    });

    parser.on('field', (name, value, info) => {
      if (settled) return;
      if (
        info.nameTruncated || info.valueTruncated ||
        byteLength(name) > limits.maxFieldNameBytes || byteLength(value) > limits.maxFieldValueBytes
      ) {
        fail(tooLarge());
        return;
      }
      if (Object.hasOwn(fields, name)) {
        fail(invalid(name.length <= 128 ? name : undefined));
        return;
      }
      fields[name] = value;
    });
    parser.once('filesLimit', () => fail(tooLarge()));
    parser.once('fieldsLimit', () => fail(tooLarge()));
    parser.once('partsLimit', () => fail(tooLarge()));
    parser.once('error', (error) => fail(error instanceof ImageGenerationError ? error : invalid()));
    parser.once('finish', () => {
      if (settled) return;
      try {
        headerGuard.finish();
      } catch (error) {
        fail(error);
        return;
      }
      if (expected !== undefined && observed !== expected) {
        fail(invalid());
        return;
      }
      settled = true;
      resolve();
    });
    request.pipe(parser);

    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
      request.removeListener('data', onData);
      request.removeListener('aborted', onAbort);
      request.removeListener('end', onEnd);
      request.removeListener('close', onClose);
      request.removeListener('error', onRequestError);
    };
    parser.once('close', cleanup);
  });

  await parsed;
  if (imageCount < 1 || imageCount > 16) throw invalid('image');
  const staged = await Promise.all(pending.map((item) => item.staged));
  const images: ImageAsset[] = [];
  let mask: ImageAsset | undefined;
  for (let index = 0; index < staged.length; index += 1) {
    const asset = await validateRaster(staged[index]!, limits);
    if (pending[index]!.kind === 'mask') mask = asset;
    else images.push(asset);
  }
  if (mask) assertCompatibleMask(images[0]!, mask);
  return { fields, images, ...(mask ? { mask } : {}) };
}
