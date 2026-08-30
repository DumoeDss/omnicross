import type {
  ImageCapabilities,
  ImageGenerationErrorCode,
  ImageProviderCompletedEvent,
  ImageProviderEvent,
  ImageProviderFailedEvent,
  ImageProviderOutput,
  ImageReferenceMetadata,
  ImageUsage,
} from '@omnicross/contracts/image-generation-types';

import {
  ImageGenerationError,
  imageGenerationErrorFromPublic,
  normalizeImageGenerationError,
  serializeImageGenerationError,
} from './errors';
import type {
  ImageJob,
  ImageProviderContext,
  ImageProviderLease,
  ImageProviderRequest,
} from './ImageProvider';
import type { ImageProviderRegistry } from './ImageProviderRegistry';
import {
  emitImageTelemetry,
  type ImageAsset,
  type ImageReferenceStore,
  type ImageTelemetryRecord,
  type ImageTelemetrySink,
} from './ports';

export interface ImageRetentionPolicy {
  readonly enabled: boolean;
  readonly ttlMs: number;
}

export interface ImageOrchestratorRunOptions {
  readonly providerId: string;
  readonly retention?: ImageRetentionPolicy;
  /** Hosted Responses execution must be affirmed by the same acquired capability snapshot. */
  readonly requireResponsesTool?: boolean;
}

export interface ImageOrchestratorOptions {
  readonly registry: ImageProviderRegistry;
  readonly referenceStore?: ImageReferenceStore;
  readonly telemetrySink?: ImageTelemetrySink;
  readonly now?: () => number;
}

function unsupported(param?: string): never {
  throw new ImageGenerationError('unsupported_capability', { param });
}

function assertRequestSupported(request: ImageProviderRequest, capabilities: ImageCapabilities): void {
  if (typeof request.prompt !== 'string' || !request.prompt.trim() || request.prompt.length > 32_000) {
    throw new ImageGenerationError('invalid_image_request', { param: 'prompt' });
  }
  if (!capabilities.available) unsupported();
  if (!capabilities.models.includes(request.model)) {
    throw new ImageGenerationError('unsupported_model', { param: 'model' });
  }
  if (!Number.isInteger(request.n) || request.n <= 0) {
    throw new ImageGenerationError('invalid_image_request', { param: 'n' });
  }
  if (request.n > capabilities.maxOutputImages) unsupported('n');
  if (!capabilities.outputFormats.includes(request.outputFormat)) unsupported('output_format');
  if (!Array.isArray(capabilities.qualityLevels) || !capabilities.qualityLevels.includes(request.quality)) {
    unsupported('quality');
  }
  if (!Array.isArray(capabilities.moderationModes) || !capabilities.moderationModes.includes(request.moderation)) {
    unsupported('moderation');
  }
  if (
    request.outputCompression !== undefined &&
    (!Number.isInteger(request.outputCompression) || request.outputCompression < 0 || request.outputCompression > 100)
  ) {
    throw new ImageGenerationError('invalid_image_request', { param: 'output_compression' });
  }
  if (request.outputCompression !== undefined) {
    const compression = capabilities.outputCompression;
    if (
      !compression ||
      compression.supported !== true ||
      !compression.formats.includes(request.outputFormat) ||
      request.outputCompression < compression.min ||
      request.outputCompression > compression.max
    ) {
      unsupported('output_compression');
    }
  }
  if (request.background === 'transparent' && !capabilities.transparentBackground) {
    unsupported('background');
  }
  if (request.size.kind === 'pixels' && !capabilities.flexibleSizes) unsupported('size');
  if (request.stream && !capabilities.streaming) unsupported('stream');
  if (!Number.isInteger(request.partialImages) || request.partialImages < 0) {
    throw new ImageGenerationError('invalid_image_request', { param: 'partial_images' });
  }
  if (request.partialImages > 0 && !request.stream) {
    throw new ImageGenerationError('invalid_image_request', { param: 'partial_images' });
  }
  if (request.partialImages > capabilities.maxPartialImages) unsupported('partial_images');

  if (request.action === 'generate') {
    if (!capabilities.generate) unsupported('action');
    return;
  }
  if (!capabilities.edit) unsupported('action');
  if (request.images.length === 0) {
    throw new ImageGenerationError('invalid_image_request', { param: 'images' });
  }
  if (request.images.length > capabilities.maxInputImages) unsupported('images');
  if (request.mask && !capabilities.maskEdit) unsupported('mask');
}

function sanitizeUsage(value: ImageUsage | undefined): ImageUsage | undefined {
  if (value === undefined) return undefined;
  const keys = [
    'totalTokens',
    'inputTokens',
    'outputTokens',
    'inputTextTokens',
    'inputImageTokens',
    'outputImageTokens',
    'generatedImages',
  ] as const satisfies readonly (keyof ImageUsage)[];
  const output: Partial<Record<(typeof keys)[number], number>> = {};
  for (const key of keys) {
    const item = value[key];
    if (item === undefined) continue;
    if (!Number.isSafeInteger(item) || item < 0) {
      throw new ImageGenerationError('upstream_protocol_changed');
    }
    output[key] = item;
  }
  return Object.keys(output).length ? output : undefined;
}

function assertArtifactMetadata(asset: ImageAsset): void {
  if (
    asset.independentlyDecodable !== true ||
    !asset.mimeType.startsWith('image/') ||
    !Number.isSafeInteger(asset.byteLength) ||
    asset.byteLength <= 0 ||
    !Number.isSafeInteger(asset.width) ||
    asset.width <= 0 ||
    !Number.isSafeInteger(asset.height) ||
    asset.height <= 0 ||
    typeof asset.open !== 'function'
  ) {
    throw new ImageGenerationError('upstream_protocol_changed');
  }
}

function sanitizeProviderOutput(value: ImageProviderOutput<ImageAsset>): ImageProviderOutput<ImageAsset> {
  if (!value || typeof value !== 'object') {
    throw new ImageGenerationError('upstream_protocol_changed');
  }
  assertArtifactMetadata(value.artifact);
  if (
    value.providerReference !== undefined &&
    (typeof value.providerReference !== 'string' || value.providerReference.length === 0 || value.providerReference.length > 4_096)
  ) {
    throw new ImageGenerationError('upstream_protocol_changed');
  }
  if (
    value.revisedPrompt !== undefined &&
    (typeof value.revisedPrompt !== 'string' || value.revisedPrompt.length > 32_000)
  ) {
    throw new ImageGenerationError('upstream_protocol_changed');
  }
  return {
    artifact: value.artifact,
    ...(value.providerReference !== undefined ? { providerReference: value.providerReference } : {}),
    ...(value.revisedPrompt !== undefined ? { revisedPrompt: value.revisedPrompt } : {}),
  };
}

const OUTPUT_MIME_TYPES = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
} as const;

function assertFinalOutputMatchesRequest(output: ImageProviderOutput<ImageAsset>, request: ImageProviderRequest): void {
  const artifact = output.artifact;
  if (artifact.mimeType !== OUTPUT_MIME_TYPES[request.outputFormat]) {
    throw new ImageGenerationError('upstream_protocol_changed');
  }
  if (
    request.size.kind === 'pixels' &&
    (artifact.width !== request.size.width || artifact.height !== request.size.height)
  ) {
    throw new ImageGenerationError('upstream_protocol_changed');
  }
  if (request.background === 'transparent' && artifact.hasAlpha !== true) {
    throw new ImageGenerationError('upstream_protocol_changed');
  }
}

function cancellationError(cause?: unknown): ImageGenerationError {
  return new ImageGenerationError('request_cancelled', { cause });
}

export class ImageOrchestrator {
  readonly #registry: ImageProviderRegistry;
  readonly #referenceStore?: ImageReferenceStore;
  readonly #telemetrySink?: ImageTelemetrySink;
  readonly #now: () => number;

  constructor(options: ImageOrchestratorOptions) {
    this.#registry = options.registry;
    this.#referenceStore = options.referenceStore;
    this.#telemetrySink = options.telemetrySink;
    this.#now = options.now ?? Date.now;
  }

  async getCapabilities(providerId: string, context: ImageProviderContext): Promise<ImageCapabilities> {
    let lease: ImageProviderLease | undefined;
    try {
      if (context.signal.aborted) throw cancellationError(context.signal.reason);
      lease = await this.#registry.require(providerId).acquire(context);
      if (context.signal.aborted) throw cancellationError(context.signal.reason);
      return lease.capabilities;
    } catch (error) {
      if (context.signal.aborted) throw cancellationError(context.signal.reason);
      throw normalizeImageGenerationError(error);
    } finally {
      await lease?.release();
    }
  }

  async *run(
    request: ImageProviderRequest,
    context: ImageProviderContext,
    options: ImageOrchestratorRunOptions,
  ): AsyncIterable<ImageProviderEvent<ImageAsset>> {
    const startedAt = this.#now();
    let acceptedAt: number | undefined;
    let lease: ImageProviderLease | undefined;
    let job: ImageJob | undefined;
    let iterator: AsyncIterator<ImageProviderEvent<ImageAsset>> | undefined;
    let releaseStarted = false;
    let cancelled = false;
    let cancelPromise: Promise<void> | undefined;
    let telemetrySent = false;
    let terminalCode: ImageGenerationErrorCode | undefined;
    let terminalKind: ImageTelemetryRecord['terminal'] = 'failed';
    let finalImages: readonly ImageAsset[] = [];
    let finalUsage: ImageProviderCompletedEvent<ImageAsset>['usage'];
    let accepted = false;
    let providerTerminal = false;

    const releaseOnce = async (): Promise<void> => {
      if (!lease || releaseStarted) return;
      releaseStarted = true;
      await lease.release();
    };
    const cancelOnce = (reason = 'request_cancelled'): Promise<void> => {
      if (!job || cancelled) return cancelPromise ?? Promise.resolve();
      cancelled = true;
      cancelPromise = Promise.resolve(job.cancel(reason)).catch(() => undefined);
      return cancelPromise;
    };
    const cancelStartedNonterminalOnce = (reason = 'request_cancelled'): Promise<void> => {
      if (providerTerminal) return cancelPromise ?? Promise.resolve();
      return cancelOnce(reason);
    };
    const sendTelemetry = async (): Promise<void> => {
      if (telemetrySent) return;
      telemetrySent = true;
      const editInputs = request.action === 'edit' ? request.images : [];
      await emitImageTelemetry(this.#telemetrySink, {
        requestId: context.requestId,
        providerId: options.providerId,
        model: request.model,
        action: request.action,
        quality: request.quality,
        background: request.background,
        outputFormat: request.outputFormat,
        streaming: request.stream,
        inputCount: editInputs.length,
        inputBytes: editInputs.reduce((sum, asset) => sum + asset.byteLength, 0),
        requestedOutputCount: request.n,
        outputs: finalImages.map((asset) => ({
          mimeType: asset.mimeType,
          byteLength: asset.byteLength,
          width: asset.width,
          height: asset.height,
          hasAlpha: asset.hasAlpha,
        })),
        startedAt,
        acceptedAt,
        finishedAt: this.#now(),
        terminal: terminalKind,
        errorCode: terminalCode,
        usage: finalUsage,
        usageUnavailable: finalUsage === undefined,
      });
    };

    const onAbort = (): void => {
      void cancelStartedNonterminalOnce();
    };
    context.signal.addEventListener('abort', onAbort, { once: true });

    try {
      if (context.signal.aborted) throw cancellationError(context.signal.reason);
      lease = await this.#registry.require(options.providerId).acquire(context);
      if (context.signal.aborted) throw cancellationError(context.signal.reason);
      assertRequestSupported(request, lease.capabilities);
      if (options.requireResponsesTool === true && lease.capabilities.responsesTool !== true) {
        unsupported('tools');
      }
      job = await lease.start(request);
      if (context.signal.aborted) throw cancellationError(context.signal.reason);
      iterator = job.events[Symbol.asyncIterator]();

      let pendingTerminal: ImageProviderCompletedEvent<ImageAsset> | ImageProviderFailedEvent | undefined;
      const partialIndexes = new Map<number, number>();
      const partialCounts = new Map<number, number>();

      while (true) {
        let next: IteratorResult<ImageProviderEvent<ImageAsset>>;
        try {
          const read = iterator.next();
          if (context.signal.aborted) throw cancellationError(context.signal.reason);
          next = await Promise.race([
            read,
            new Promise<never>((_resolve, reject) => {
              const abort = () => reject(cancellationError(context.signal.reason));
              context.signal.addEventListener('abort', abort, { once: true });
              void read.then(
                () => context.signal.removeEventListener('abort', abort),
                () => context.signal.removeEventListener('abort', abort),
              );
            }),
          ]);
        } catch (error) {
          if (context.signal.aborted) throw cancellationError(context.signal.reason);
          throw normalizeImageGenerationError(error, 'image_generation_failed', {
            retrySafety: accepted ? 'after_acceptance' : 'unknown',
          });
        }

        if (next.done) {
          if (!pendingTerminal) throw new ImageGenerationError('upstream_protocol_changed');
          if (pendingTerminal.type === 'completed') {
            const { usage: providerUsage, ...terminalWithoutUsage } = pendingTerminal;
            const safeUsage = sanitizeUsage(providerUsage);
            const references = await this.#retainCompleted(
              pendingTerminal,
              context,
              options.retention,
            );
            const completed: ImageProviderCompletedEvent<ImageAsset> = {
              ...terminalWithoutUsage,
              ...(safeUsage ? { usage: safeUsage } : {}),
              ...(references.length ? { references } : {}),
            };
            finalImages = completed.images.map((image) => image.artifact);
            finalUsage = completed.usage;
            terminalKind = 'completed';
            await sendTelemetry();
            yield completed;
          } else {
            const safeError = imageGenerationErrorFromPublic(pendingTerminal.error);
            terminalCode = safeError.code;
            terminalKind = safeError.code === 'request_cancelled' ? 'cancelled' : 'failed';
            await sendTelemetry();
            yield { type: 'failed', error: serializeImageGenerationError(safeError) };
          }
          return;
        }

        const event = next.value;
        if (pendingTerminal) {
          throw new ImageGenerationError('upstream_protocol_changed', {
            retrySafety: accepted ? 'after_acceptance' : 'unknown',
          });
        }

        switch (event.type) {
          case 'accepted':
            if (accepted || !Number.isFinite(event.acceptedAt)) {
              throw new ImageGenerationError('upstream_protocol_changed');
            }
            accepted = true;
            acceptedAt = event.acceptedAt;
            yield { type: 'accepted', acceptedAt: event.acceptedAt };
            break;
          case 'partial_image': {
            if (!accepted) throw new ImageGenerationError('upstream_protocol_changed');
            const image = sanitizeProviderOutput(event.image);
            if (
              !Number.isInteger(event.outputIndex) ||
              event.outputIndex < 0 ||
              event.outputIndex >= request.n ||
              !Number.isInteger(event.partialImageIndex) ||
              event.partialImageIndex < 0
            ) {
              throw new ImageGenerationError('upstream_protocol_changed');
            }
            const previous = partialIndexes.get(event.outputIndex);
            if (previous != null && event.partialImageIndex <= previous) {
              throw new ImageGenerationError('upstream_protocol_changed');
            }
            const nextCount = (partialCounts.get(event.outputIndex) ?? 0) + 1;
            if (nextCount > request.partialImages || event.partialImageIndex >= request.partialImages) {
              throw new ImageGenerationError('upstream_protocol_changed');
            }
            partialIndexes.set(event.outputIndex, event.partialImageIndex);
            partialCounts.set(event.outputIndex, nextCount);
            yield {
              type: 'partial_image',
              outputIndex: event.outputIndex,
              partialImageIndex: event.partialImageIndex,
              image,
            };
            break;
          }
          case 'completed': {
            if (!accepted || !Array.isArray(event.images) || event.images.length !== request.n) {
              throw new ImageGenerationError('upstream_protocol_changed', {
                retrySafety: accepted ? 'after_acceptance' : 'unknown',
              });
            }
            const images = event.images.map((image) => {
              const output = sanitizeProviderOutput(image);
              assertFinalOutputMatchesRequest(output, request);
              return output;
            });
            pendingTerminal = {
              type: 'completed',
              images,
              ...(event.usage !== undefined ? { usage: event.usage } : {}),
            };
            providerTerminal = true;
            break;
          }
          case 'failed':
            pendingTerminal = event;
            providerTerminal = true;
            break;
          default:
            throw new ImageGenerationError('upstream_protocol_changed');
        }
      }
    } catch (error) {
      const normalized = context.signal.aborted
        ? cancellationError(context.signal.reason)
        : normalizeImageGenerationError(error, 'image_generation_failed', {
            retrySafety: acceptedAt == null ? 'unknown' : 'after_acceptance',
          });
      terminalCode = normalized.code;
      terminalKind = normalized.code === 'request_cancelled' ? 'cancelled' : 'failed';
      await sendTelemetry();
      throw normalized;
    } finally {
      context.signal.removeEventListener('abort', onAbort);
      await cancelStartedNonterminalOnce();
      try {
        await iterator?.return?.();
      } catch {
        // Closing a failed provider iterator must not replace the stable error.
      }
      await cancelPromise;
      await releaseOnce();
    }
  }

  async #retainCompleted(
    event: ImageProviderCompletedEvent<ImageAsset>,
    context: ImageProviderContext,
    retention: ImageRetentionPolicy | undefined,
  ): Promise<ImageReferenceMetadata[]> {
    if (!retention?.enabled) return [];
    if (!this.#referenceStore) {
      throw new ImageGenerationError('image_generation_failed', { retrySafety: 'after_acceptance' });
    }
    if (!Number.isSafeInteger(retention.ttlMs) || retention.ttlMs <= 0) {
      throw new ImageGenerationError('invalid_image_request', { param: 'reference_ttl' });
    }
    const references: ImageReferenceMetadata[] = [];
    for (const image of event.images) {
      const asset = image.artifact;
      references.push(
        await this.#referenceStore.save({
          tenantId: context.tenantId,
          ttlMs: retention.ttlMs,
          artifact: asset,
          providerReference: image.providerReference,
          metadata: {
            mimeType: asset.mimeType,
            byteLength: asset.byteLength,
            width: asset.width,
            height: asset.height,
          },
        }),
      );
    }
    return references;
  }
}
