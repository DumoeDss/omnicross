import type http from 'node:http';

import { ImageGenerationError } from '../errors';

function invalid(param?: string): never {
  throw new ImageGenerationError('invalid_image_request', { param });
}

function tooLarge(): never {
  throw new ImageGenerationError('image_too_large');
}

function mediaType(value: string | undefined): string {
  return (value ?? '').split(';', 1)[0]!.trim().toLowerCase();
}

function declaredLength(value: string | string[] | undefined, limit: number): number | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) || !/^(0|[1-9]\d*)$/.test(value)) tooLarge();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > limit) tooLarge();
  return parsed;
}

export interface ReadJsonBodyOptions {
  readonly maxBytes: number;
  readonly signal: AbortSignal;
}

/** Strict, one-shot JSON reader for an Images extension-owned request body. */
export async function readJsonBody(
  request: http.IncomingMessage,
  options: ReadJsonBodyOptions,
): Promise<unknown> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new TypeError('The JSON body limit must be a positive safe integer.');
  }
  if (options.signal.aborted) {
    throw new ImageGenerationError('request_cancelled', { cause: options.signal.reason });
  }
  if (mediaType(request.headers['content-type']) !== 'application/json') invalid('content_type');
  const encoding = request.headers['content-encoding'];
  if (Array.isArray(encoding) || (encoding !== undefined && encoding.trim().toLowerCase() !== 'identity')) {
    invalid('content_encoding');
  }
  const expected = declaredLength(request.headers['content-length'], options.maxBytes);
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  const pieces: string[] = [];
  let observed = 0;
  const abort = (): void => {
    request.destroy(options.signal.reason instanceof Error ? options.signal.reason : undefined);
  };
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    try {
      for await (const raw of request) {
        if (options.signal.aborted) {
          throw new ImageGenerationError('request_cancelled', { cause: options.signal.reason });
        }
        const chunk = raw instanceof Uint8Array ? raw : Buffer.from(raw as unknown as ArrayBuffer);
        observed += chunk.byteLength;
        if (!Number.isSafeInteger(observed) || observed > options.maxBytes || (expected !== undefined && observed > expected)) {
          tooLarge();
        }
        pieces.push(decoder.decode(chunk, { stream: true }));
      }
      pieces.push(decoder.decode());
    } catch (error) {
      if (options.signal.aborted) {
        throw new ImageGenerationError('request_cancelled', { cause: options.signal.reason });
      }
      if (error instanceof ImageGenerationError) throw error;
      invalid();
    }
    if (observed === 0 || (expected !== undefined && observed !== expected)) invalid();
    try {
      return JSON.parse(pieces.join('')) as unknown;
    } catch {
      invalid();
    }
  } finally {
    options.signal.removeEventListener('abort', abort);
  }
}
