import type http from 'node:http';

import type {
  ImageProviderCompletedEvent,
  ImageProviderEvent,
  ImageUsage,
} from '@omnicross/contracts/image-generation-types';

import { ImageGenerationError } from '../errors';
import type { ImageAsset } from '../ports';
import type { ImageRequestResourceScope, StagedTemporaryFile } from './TemporaryImageAsset';
import { imageApiErrorFromProvider, safeImageRequestId } from './imageApiErrors';
import type { ImageApiLimits } from './types';

function cancelled(signal: AbortSignal): never {
  throw new ImageGenerationError('request_cancelled', { cause: signal.reason });
}

async function writeWithBackpressure(
  response: http.ServerResponse,
  chunk: string | Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || response.destroyed || response.writableEnded) cancelled(signal);
  if (response.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      response.removeListener('drain', onDrain);
      response.removeListener('close', onClose);
      response.removeListener('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const onDrain = (): void => { cleanup(); resolve(); };
    const onClose = (): void => { cleanup(); reject(new ImageGenerationError('request_cancelled')); };
    const onError = (): void => { cleanup(); reject(new ImageGenerationError('request_cancelled')); };
    const onAbort = (): void => { cleanup(); reject(new ImageGenerationError('request_cancelled', { cause: signal.reason })); };
    response.once('drain', onDrain);
    response.once('close', onClose);
    response.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function* encodeAssetBase64Chunks(
  asset: ImageAsset,
  limit: number,
  signal: AbortSignal,
): AsyncIterable<Uint8Array> {
  if (asset.byteLength <= 0 || asset.byteLength > limit) throw new ImageGenerationError('image_too_large');
  const reader = (await asset.open({ signal })).getReader();
  let carry = Buffer.alloc(0);
  let observed = 0;
  try {
    while (true) {
      if (signal.aborted) cancelled(signal);
      const next = await reader.read();
      if (next.done) break;
      observed += next.value.byteLength;
      if (observed > limit || observed > asset.byteLength) throw new ImageGenerationError('image_too_large');
      const source = carry.byteLength
        ? Buffer.concat([carry, Buffer.from(next.value)])
        : Buffer.from(next.value);
      const complete = source.byteLength - (source.byteLength % 3);
      if (complete) yield Buffer.from(source.subarray(0, complete).toString('base64'), 'ascii');
      carry = Buffer.from(source.subarray(complete));
    }
    if (observed !== asset.byteLength) throw new ImageGenerationError('upstream_protocol_changed');
    if (carry.byteLength) yield Buffer.from(carry.toString('base64'), 'ascii');
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

interface StagedOutput {
  readonly base64: StagedTemporaryFile;
  readonly revisedPrompt?: string;
}

export function outputUsage(usage: ImageUsage | undefined): Record<string, unknown> | undefined {
  if (!usage) return undefined;
  return {
    ...(usage.totalTokens !== undefined ? { total_tokens: usage.totalTokens } : {}),
    ...(usage.inputTokens !== undefined ? { input_tokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { output_tokens: usage.outputTokens } : {}),
    ...(usage.generatedImages !== undefined ? { generated_images: usage.generatedImages } : {}),
    ...(
      usage.inputTextTokens !== undefined || usage.inputImageTokens !== undefined
        ? {
            input_tokens_details: {
              ...(usage.inputTextTokens !== undefined ? { text_tokens: usage.inputTextTokens } : {}),
              ...(usage.inputImageTokens !== undefined ? { image_tokens: usage.inputImageTokens } : {}),
            },
          }
        : {}
    ),
    ...(usage.outputImageTokens !== undefined
      ? { output_tokens_details: { image_tokens: usage.outputImageTokens } }
      : {}),
  };
}

async function stageOutputs(
  event: ImageProviderCompletedEvent<ImageAsset>,
  count: number,
  scope: ImageRequestResourceScope,
  limits: ImageApiLimits,
  signal: AbortSignal,
): Promise<readonly StagedOutput[]> {
  if (event.images.length !== count) throw new ImageGenerationError('upstream_protocol_changed');
  const total = event.images.reduce((sum, image) => sum + image.artifact.byteLength, 0);
  if (!Number.isSafeInteger(total) || total > limits.maxTotalOutputBytes) {
    throw new ImageGenerationError('image_too_large');
  }
  const outputs: StagedOutput[] = [];
  for (const image of event.images) {
    const encodedLength = Math.ceil(image.artifact.byteLength / 3) * 4;
    const base64 = await scope.materialize(
      encodeAssetBase64Chunks(image.artifact, limits.maxOutputBytes, signal),
      {
        kind: 'spool',
        maxBytes: encodedLength,
        declaredBytes: encodedLength,
        signal,
      },
    );
    outputs.push({
      base64,
      ...(image.revisedPrompt !== undefined ? { revisedPrompt: image.revisedPrompt } : {}),
    });
  }
  return outputs;
}

async function terminalEvent(
  events: AsyncIterable<ImageProviderEvent<ImageAsset>>,
  signal: AbortSignal,
): Promise<ImageProviderCompletedEvent<ImageAsset>> {
  let accepted = false;
  let completed: ImageProviderCompletedEvent<ImageAsset> | undefined;
  for await (const event of events) {
    if (signal.aborted) cancelled(signal);
    if (event.type === 'accepted') {
      if (accepted || completed) throw new ImageGenerationError('upstream_protocol_changed');
      accepted = true;
    } else if (event.type === 'partial_image') {
      throw new ImageGenerationError('upstream_protocol_changed');
    } else if (event.type === 'failed') {
      throw imageApiErrorFromProvider(event.error);
    } else {
      if (!accepted || completed) throw new ImageGenerationError('upstream_protocol_changed');
      completed = event;
    }
  }
  if (!completed) throw new ImageGenerationError('upstream_protocol_changed');
  return completed;
}

export async function writeImageApiResponse(options: {
  readonly response: http.ServerResponse;
  readonly events: AsyncIterable<ImageProviderEvent<ImageAsset>>;
  readonly requestedCount: number;
  readonly requestId: string;
  readonly createdAt: number;
  readonly scope: ImageRequestResourceScope;
  readonly limits: ImageApiLimits;
  readonly signal: AbortSignal;
}): Promise<void> {
  const completed = await terminalEvent(options.events, options.signal);
  const outputs = await stageOutputs(
    completed,
    options.requestedCount,
    options.scope,
    options.limits,
    options.signal,
  );
  const usage = outputUsage(completed.usage);
  options.response.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'x-request-id': safeImageRequestId(options.requestId),
  });
  await writeWithBackpressure(
    options.response,
    `{"created":${Math.floor(options.createdAt / 1000)},"data":[`,
    options.signal,
  );
  for (let index = 0; index < outputs.length; index += 1) {
    const output = outputs[index]!;
    await writeWithBackpressure(options.response, `${index ? ',' : ''}{"b64_json":"`, options.signal);
    const reader = (await output.base64.open(options.signal)).getReader();
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
    await writeWithBackpressure(
      options.response,
      `"${output.revisedPrompt !== undefined ? `,"revised_prompt":${JSON.stringify(output.revisedPrompt)}` : ''}}`,
      options.signal,
    );
  }
  await writeWithBackpressure(
    options.response,
    `]${usage ? `,"usage":${JSON.stringify(usage)}` : ''}}`,
    options.signal,
  );
  options.response.end();
  await Promise.all(outputs.map((output) => output.base64.dispose()));
}

export { writeWithBackpressure };
