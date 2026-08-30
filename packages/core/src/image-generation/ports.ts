import { randomUUID } from 'node:crypto';

import type {
  ImageAction,
  ImageArtifactId,
  ImageArtifactMetadata,
  ImageBackground,
  ImageGenerationErrorCode,
  ImageOutputFormat,
  ImageQuality,
  ImageReferenceId,
  ImageReferenceMetadata,
  ImageUsage,
  SensitiveOpaqueImageReference,
} from '@omnicross/contracts/image-generation-types';

export interface ImageAsset extends ImageArtifactMetadata {
  /** Every call returns a new bounded, independently readable byte stream. */
  open(options?: { readonly signal?: AbortSignal }): Promise<ReadableStream<Uint8Array>>;
}

export class InMemoryImageAsset implements ImageAsset {
  readonly artifactId: ImageArtifactId;
  readonly mimeType: `image/${string}`;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly hasAlpha?: boolean;
  readonly sha256?: string;
  readonly independentlyDecodable = true as const;
  readonly #bytes: Uint8Array;

  constructor(
    bytes: Uint8Array,
    metadata: Omit<ImageArtifactMetadata, 'artifactId' | 'byteLength' | 'independentlyDecodable'> & {
      readonly artifactId?: ImageArtifactId;
    },
  ) {
    if (bytes.byteLength === 0) throw new TypeError('Image asset bytes must not be empty.');
    this.#bytes = bytes.slice();
    this.artifactId = metadata.artifactId ?? (randomUUID() as ImageArtifactId);
    this.mimeType = metadata.mimeType;
    this.byteLength = bytes.byteLength;
    this.width = metadata.width;
    this.height = metadata.height;
    this.hasAlpha = metadata.hasAlpha;
    this.sha256 = metadata.sha256;
  }

  async open(options: { readonly signal?: AbortSignal } = {}): Promise<ReadableStream<Uint8Array>> {
    if (options.signal?.aborted) throw options.signal.reason;
    const bytes = this.#bytes.slice();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        if (options.signal?.aborted) {
          controller.error(options.signal.reason);
          return;
        }
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }
}

export async function readImageAssetBytes(
  asset: ImageAsset,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || asset.byteLength > maxBytes) {
    throw new RangeError('Image asset exceeds the bounded read limit.');
  }
  if (signal?.aborted) throw signal.reason;
  const reader = (await asset.open({ signal })).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason;
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes || total > asset.byteLength) {
        await reader.cancel();
        throw new RangeError('Image asset stream exceeded its declared bound.');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total !== asset.byteLength) throw new RangeError('Image asset stream length did not match metadata.');
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export interface ImageReferenceValue {
  readonly artifact?: ImageAsset;
  readonly providerReference?: SensitiveOpaqueImageReference;
}

export interface ImageReferenceSaveInput extends ImageReferenceValue {
  readonly tenantId: string;
  readonly ttlMs: number;
  readonly metadata: Omit<ImageReferenceMetadata, 'referenceId' | 'createdAt' | 'expiresAt'>;
}

export interface ImageReferenceLease {
  readonly metadata: ImageReferenceMetadata;
  readonly value: ImageReferenceValue;
  release(): Promise<void>;
}

export type ImageReferenceResolution =
  | { readonly status: 'found'; readonly lease: ImageReferenceLease }
  | { readonly status: 'expired' }
  | { readonly status: 'not_found' };

export interface ImageReferenceStore {
  save(input: ImageReferenceSaveInput): Promise<ImageReferenceMetadata>;
  resolve(tenantId: string, referenceId: ImageReferenceId): Promise<ImageReferenceResolution>;
  delete(tenantId: string, referenceId: ImageReferenceId): Promise<boolean>;
  cleanup(now?: number): Promise<number>;
}

interface InMemoryReferenceEntry {
  readonly tenantId: string;
  readonly metadata: ImageReferenceMetadata;
  readonly value: ImageReferenceValue;
  activeLeases: number;
  deleted: boolean;
}

/** Deterministic-clock test double; production wiring supplies a bounded persistent store. */
export class InMemoryImageReferenceStore implements ImageReferenceStore {
  readonly #entries = new Map<ImageReferenceId, InMemoryReferenceEntry>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async save(input: ImageReferenceSaveInput): Promise<ImageReferenceMetadata> {
    if (!input.artifact && !input.providerReference) {
      throw new TypeError('A retained image reference requires content or an opaque provider reference.');
    }
    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) {
      throw new RangeError('Image reference TTL must be a positive integer.');
    }
    const now = this.#now();
    const metadata: ImageReferenceMetadata = {
      ...input.metadata,
      referenceId: randomUUID() as ImageReferenceId,
      createdAt: now,
      expiresAt: now + input.ttlMs,
    };
    this.#entries.set(metadata.referenceId, {
      tenantId: input.tenantId,
      metadata,
      value: { artifact: input.artifact, providerReference: input.providerReference },
      activeLeases: 0,
      deleted: false,
    });
    return metadata;
  }

  async resolve(tenantId: string, referenceId: ImageReferenceId): Promise<ImageReferenceResolution> {
    const entry = this.#entries.get(referenceId);
    if (!entry || entry.tenantId !== tenantId || entry.deleted) return { status: 'not_found' };
    if (entry.metadata.expiresAt <= this.#now()) return { status: 'expired' };
    entry.activeLeases += 1;
    let released = false;
    return {
      status: 'found',
      lease: {
        metadata: entry.metadata,
        value: entry.value,
        async release() {
          if (released) return;
          released = true;
          entry.activeLeases = Math.max(0, entry.activeLeases - 1);
        },
      },
    };
  }

  async delete(tenantId: string, referenceId: ImageReferenceId): Promise<boolean> {
    const entry = this.#entries.get(referenceId);
    if (!entry || entry.tenantId !== tenantId || entry.deleted) return false;
    entry.deleted = true;
    if (entry.activeLeases === 0) this.#entries.delete(referenceId);
    return true;
  }

  async cleanup(now = this.#now()): Promise<number> {
    let removed = 0;
    for (const [referenceId, entry] of this.#entries) {
      if ((entry.deleted || entry.metadata.expiresAt <= now) && entry.activeLeases === 0) {
        this.#entries.delete(referenceId);
        removed += 1;
      }
    }
    return removed;
  }
}

export interface ImageTelemetryOutputMetadata {
  readonly mimeType: `image/${string}`;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly hasAlpha?: boolean;
}

/** No content-bearing, credential, tenant, account, URL, or raw-reference field exists here. */
export interface ImageTelemetryRecord {
  readonly requestId: string;
  readonly providerId: string;
  readonly model: string;
  readonly action: ImageAction;
  readonly quality: ImageQuality;
  readonly background: ImageBackground;
  readonly outputFormat: ImageOutputFormat;
  readonly streaming: boolean;
  readonly inputCount: number;
  readonly inputBytes: number;
  readonly requestedOutputCount: number;
  readonly outputs: readonly ImageTelemetryOutputMetadata[];
  readonly startedAt: number;
  readonly acceptedAt?: number;
  readonly finishedAt: number;
  readonly terminal: 'completed' | 'failed' | 'cancelled';
  readonly errorCode?: ImageGenerationErrorCode;
  readonly usage?: ImageUsage;
  readonly usageUnavailable: boolean;
  /** Count-only cleanup signal; never contains tenant or reference identifiers. */
  readonly retentionRollbackFailures?: number;
}

export interface ImageTelemetrySink {
  record(record: ImageTelemetryRecord): void | Promise<void>;
}

export async function emitImageTelemetry(
  sink: ImageTelemetrySink | undefined,
  record: ImageTelemetryRecord,
): Promise<void> {
  try {
    await sink?.record(record);
  } catch {
    // Observability is best-effort and must never affect image execution.
  }
}
