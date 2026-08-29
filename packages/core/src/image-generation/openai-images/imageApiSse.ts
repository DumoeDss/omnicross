import type http from 'node:http';

import type { ImageProviderEvent, ImageProviderOutput } from '@omnicross/contracts/image-generation-types';

import { ImageGenerationError } from '../errors';
import type { ImageAsset } from '../ports';
import type { ImageRequestResourceScope, StagedTemporaryFile } from './TemporaryImageAsset';
import {
  imageApiErrorFromProvider,
  safeImageRequestId,
  serializeImageApiError,
} from './imageApiErrors';
import {
  encodeAssetBase64Chunks,
  outputUsage,
  writeWithBackpressure,
} from './imageApiResponse';
import type { ImageApiLimits } from './types';

type SseAction = 'generation' | 'edit';

function cancelled(signal: AbortSignal): never {
  throw new ImageGenerationError('request_cancelled', { cause: signal.reason });
}

async function stageAsset(
  asset: ImageAsset,
  scope: ImageRequestResourceScope,
  limits: ImageApiLimits,
  signal: AbortSignal,
): Promise<StagedTemporaryFile> {
  const encodedLength = Math.ceil(asset.byteLength / 3) * 4;
  return scope.materialize(encodeAssetBase64Chunks(asset, limits.maxOutputBytes, signal), {
    kind: 'spool',
    maxBytes: encodedLength,
    declaredBytes: encodedLength,
    signal,
  });
}

async function writeAssetFrame(options: {
  readonly response: http.ServerResponse;
  readonly spool: StagedTemporaryFile;
  readonly type: string;
  readonly beforeImage: Readonly<Record<string, unknown>>;
  readonly afterImage?: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
}): Promise<void> {
  const prefix = JSON.stringify({ type: options.type, ...options.beforeImage, b64_json: '__IMAGE__' });
  const marker = '"__IMAGE__"';
  const markerAt = prefix.indexOf(marker);
  await writeWithBackpressure(
    options.response,
    `event: ${options.type}\ndata: ${prefix.slice(0, markerAt)}"`,
    options.signal,
  );
  const reader = (await options.spool.open(options.signal)).getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      await writeWithBackpressure(options.response, next.value, options.signal);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const suffixObject = options.afterImage ?? {};
  const suffix = JSON.stringify(suffixObject);
  await writeWithBackpressure(
    options.response,
    `"${prefix.slice(markerAt + marker.length, -1)}${suffix === '{}' ? '' : `,${suffix.slice(1, -1)}`}}\n\n`,
    options.signal,
  );
}

async function emitOutput(options: {
  readonly response: http.ServerResponse;
  readonly output: ImageProviderOutput<ImageAsset>;
  readonly type: string;
  readonly outputIndex: number;
  readonly partialImageIndex?: number;
  readonly finalFields?: Readonly<Record<string, unknown>>;
  readonly scope: ImageRequestResourceScope;
  readonly limits: ImageApiLimits;
  readonly signal: AbortSignal;
}): Promise<void> {
  const spool = await stageAsset(options.output.artifact, options.scope, options.limits, options.signal);
  try {
    await writeAssetFrame({
      response: options.response,
      spool,
      type: options.type,
      beforeImage: {
        output_index: options.outputIndex,
        ...(options.partialImageIndex !== undefined
          ? { partial_image_index: options.partialImageIndex }
          : {}),
      },
      afterImage: {
        ...(options.output.revisedPrompt !== undefined
          ? { revised_prompt: options.output.revisedPrompt }
          : {}),
        ...(options.finalFields ?? {}),
      },
      signal: options.signal,
    });
  } finally {
    await spool.dispose();
  }
}

export async function writeImageApiSse(options: {
  readonly action: SseAction;
  readonly response: http.ServerResponse;
  readonly events: AsyncIterable<ImageProviderEvent<ImageAsset>>;
  readonly requestedCount: number;
  readonly requestId: string;
  readonly createdAt: number;
  readonly metadata: {
    readonly background: 'auto' | 'opaque' | 'transparent';
    readonly outputFormat: 'png' | 'jpeg' | 'webp';
    readonly quality: 'auto' | 'low' | 'medium' | 'high';
    readonly size: string;
  };
  readonly scope: ImageRequestResourceScope;
  readonly limits: ImageApiLimits;
  readonly signal: AbortSignal;
}): Promise<void> {
  const prefix = options.action === 'generation' ? 'image_generation' : 'image_edit';
  let accepted = false;
  let completed = false;
  try {
    for await (const event of options.events) {
      if (options.signal.aborted) cancelled(options.signal);
      if (event.type === 'accepted') {
        if (accepted) throw new ImageGenerationError('upstream_protocol_changed');
        accepted = true;
        options.response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'x-request-id': safeImageRequestId(options.requestId),
        });
        options.response.flushHeaders();
        continue;
      }
      if (event.type === 'failed') throw imageApiErrorFromProvider(event.error);
      if (!accepted) throw new ImageGenerationError('upstream_protocol_changed');
      if (event.type === 'partial_image') {
        await emitOutput({
          response: options.response,
          output: event.image,
          type: `${prefix}.partial_image`,
          outputIndex: event.outputIndex,
          partialImageIndex: event.partialImageIndex,
          finalFields: {
            background: options.metadata.background,
            created_at: Math.floor(options.createdAt / 1000),
            output_format: options.metadata.outputFormat,
            quality: options.metadata.quality,
            size: options.metadata.size,
          },
          scope: options.scope,
          limits: options.limits,
          signal: options.signal,
        });
        continue;
      }
      if (event.images.length !== options.requestedCount) {
        throw new ImageGenerationError('upstream_protocol_changed');
      }
      const total = event.images.reduce((sum, output) => sum + output.artifact.byteLength, 0);
      if (!Number.isSafeInteger(total) || total > options.limits.maxTotalOutputBytes) {
        throw new ImageGenerationError('image_too_large');
      }
      const usage = outputUsage(event.usage);
      for (let index = 0; index < event.images.length; index += 1) {
        await emitOutput({
          response: options.response,
          output: event.images[index]!,
          type: `${prefix}.completed`,
          outputIndex: index,
          finalFields: {
            background: options.metadata.background,
            created_at: Math.floor(options.createdAt / 1000),
            output_format: options.metadata.outputFormat,
            quality: options.metadata.quality,
            size: options.metadata.size,
            ...(index === event.images.length - 1 && usage ? { usage } : {}),
          },
          scope: options.scope,
          limits: options.limits,
          signal: options.signal,
        });
      }
      completed = true;
    }
    if (!completed) throw new ImageGenerationError('upstream_protocol_changed');
    if (!options.response.writableEnded) options.response.end();
  } catch (error) {
    const mapped = serializeImageApiError(error);
    if (!accepted) throw mapped.domainError;
    if (
      mapped.domainError.code !== 'request_cancelled' &&
      !options.signal.aborted &&
      !options.response.destroyed &&
      !options.response.writableEnded
    ) {
      const body = JSON.stringify({ type: 'error', error: mapped.body.error });
      await writeWithBackpressure(options.response, `event: error\ndata: ${body}\n\n`, options.signal)
        .catch(() => undefined);
      options.response.end();
    }
    throw mapped.domainError;
  }
}
