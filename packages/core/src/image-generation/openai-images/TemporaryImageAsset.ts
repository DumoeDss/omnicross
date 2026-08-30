import { createReadStream } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  open,
  chmod,
  realpath,
  rm,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';

import type { ImageArtifactMetadata } from '@omnicross/contracts/image-generation-types';

import { ImageGenerationError } from '../errors';
import type { ImageAsset, ImageReferenceLease } from '../ports';
import type { ImageApiLimits } from './types';

type ResourceKind = 'input' | 'spool';

export const IMAGE_REQUEST_DIRECTORY_MARKER_NAME = '.omnicross-images-owner.json';
export const IMAGE_REQUEST_DIRECTORY_MARKER_CONTENT =
  '{"schema":"omnicross-images-temporary","version":1}\n';

function cancelled(signal: AbortSignal): never {
  throw new ImageGenerationError('request_cancelled', { cause: signal.reason });
}

function tooLarge(): never {
  throw new ImageGenerationError('image_too_large');
}

function assertPositiveLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('Temporary file limits must be positive safe integers.');
}

/** Internal request-scoped file. It deliberately has no path property or getter. */
export class StagedTemporaryFile {
  readonly byteLength: number;
  readonly #path: string;
  readonly #scope: ImageRequestResourceScope;
  readonly #kind: ResourceKind;
  #disposed = false;

  constructor(scope: ImageRequestResourceScope, path: string, byteLength: number, kind: ResourceKind) {
    this.#scope = scope;
    this.#path = path;
    this.byteLength = byteLength;
    this.#kind = kind;
  }

  async open(signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    if (this.#disposed) throw new ImageGenerationError('request_cancelled');
    this.#scope.assertActive();
    if (signal?.aborted) cancelled(signal);
    const source = createReadStream(this.#path, {
      flags: 'r',
      mode: 0o600,
      start: 0,
      end: this.byteLength - 1,
      autoClose: true,
      ...(signal ? { signal } : {}),
    });
    return Readable.toWeb(source) as ReadableStream<Uint8Array>;
  }

  /** Internal validator seam; no path is returned or retained by the caller. */
  async inspect<T>(callback: (privatePath: string) => Promise<T>): Promise<T> {
    if (this.#disposed) throw new ImageGenerationError('request_cancelled');
    this.#scope.assertActive();
    return callback(this.#path);
  }

  async dispose(): Promise<void> {
    if (this.#disposed || this.#kind !== 'spool') return;
    this.#disposed = true;
    await this.#scope.releaseSpool(this.#path, this.byteLength);
  }

  toImageAsset(
    metadata: Omit<ImageArtifactMetadata, 'artifactId' | 'byteLength' | 'independentlyDecodable'>,
  ): TemporaryImageAsset {
    return new TemporaryImageAsset(this, metadata);
  }
}

export class TemporaryImageAsset implements ImageAsset {
  readonly artifactId;
  readonly mimeType;
  readonly byteLength;
  readonly width;
  readonly height;
  readonly hasAlpha;
  readonly sha256;
  readonly independentlyDecodable = true as const;
  readonly #file: StagedTemporaryFile;

  constructor(
    file: StagedTemporaryFile,
    metadata: Omit<ImageArtifactMetadata, 'artifactId' | 'byteLength' | 'independentlyDecodable'>,
  ) {
    if (file.byteLength <= 0) throw new TypeError('Temporary image assets must not be empty.');
    this.#file = file;
    this.artifactId = randomUUID() as ImageArtifactMetadata['artifactId'];
    this.mimeType = metadata.mimeType;
    this.byteLength = file.byteLength;
    this.width = metadata.width;
    this.height = metadata.height;
    this.hasAlpha = metadata.hasAlpha;
    this.sha256 = metadata.sha256;
  }

  open(options: { readonly signal?: AbortSignal } = {}): Promise<ReadableStream<Uint8Array>> {
    return this.#file.open(options.signal);
  }
}

export class RequestFileWriter {
  readonly #scope: ImageRequestResourceScope;
  readonly #handle: FileHandle;
  readonly #path: string;
  readonly #kind: ResourceKind;
  readonly #maxBytes: number;
  readonly #declaredBytes?: number;
  #byteLength = 0;
  #done = false;

  constructor(options: {
    scope: ImageRequestResourceScope;
    handle: FileHandle;
    path: string;
    kind: ResourceKind;
    maxBytes: number;
    declaredBytes?: number;
  }) {
    this.#scope = options.scope;
    this.#handle = options.handle;
    this.#path = options.path;
    this.#kind = options.kind;
    this.#maxBytes = options.maxBytes;
    this.#declaredBytes = options.declaredBytes;
  }

  get byteLength(): number {
    return this.#byteLength;
  }

  async write(chunk: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (this.#done) throw new TypeError('Temporary writer is already closed.');
    if (signal?.aborted) cancelled(signal);
    if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) return;
    const next = this.#byteLength + chunk.byteLength;
    if (!Number.isSafeInteger(next) || next > this.#maxBytes || (this.#declaredBytes !== undefined && next > this.#declaredBytes)) {
      tooLarge();
    }
    this.#scope.reserve(this.#kind, chunk.byteLength);
    try {
      let offset = 0;
      while (offset < chunk.byteLength) {
        if (signal?.aborted) cancelled(signal);
        const result = await this.#handle.write(chunk, offset, chunk.byteLength - offset, null);
        if (result.bytesWritten <= 0) throw new ImageGenerationError('image_generation_failed');
        offset += result.bytesWritten;
      }
      this.#byteLength = next;
    } catch (error) {
      this.#scope.unreserve(this.#kind, chunk.byteLength);
      throw error;
    }
  }

  async finish(): Promise<StagedTemporaryFile> {
    if (this.#done) throw new TypeError('Temporary writer is already closed.');
    this.#done = true;
    this.#scope.writerFinished(this);
    try {
      await this.#handle.sync();
    } finally {
      await this.#handle.close().catch(() => undefined);
    }
    if (this.#byteLength === 0 || (this.#declaredBytes !== undefined && this.#byteLength !== this.#declaredBytes)) {
      throw new ImageGenerationError('invalid_image_request');
    }
    const info = await stat(this.#path);
    if (!info.isFile() || info.size !== this.#byteLength) throw new ImageGenerationError('image_generation_failed');
    return new StagedTemporaryFile(this.#scope, this.#path, this.#byteLength, this.#kind);
  }

  async abort(): Promise<void> {
    if (this.#done) return;
    this.#done = true;
    this.#scope.writerFinished(this);
    await this.#handle.close().catch(() => undefined);
  }
}

export interface CreateImageRequestResourceScopeOptions {
  readonly limits: ImageApiLimits;
  readonly signal: AbortSignal;
  readonly tempRoot?: string;
  /** Trusted tenant identity; required whenever a shared budget is injected. */
  readonly tenantId?: string;
  readonly sharedBudget?: ImageTemporaryResourceBudget;
  /** Write the fixed, content-free daemon ownership marker into the request directory. */
  readonly ownedDirectoryMarker?: boolean;
  /** Host-private lease hook used to keep recurring cleanup away from live scopes. */
  readonly onDirectoryActive?: (privateDirectory: string) => () => void;
}

/** One active-scope reservation from the daemon's cross-request budget. */
export interface ImageTemporaryResourceBudgetLease {
  /** Atomically charge bytes before a write; a thrown call MUST charge nothing. */
  reserve(bytes: number): void;
  /** Infallibly release up to the bytes previously reserved by this lease. */
  release(bytes: number): void;
  /** Idempotently and infallibly release the active-scope reservation. */
  releaseScope(): void;
}

/** Credential/content-blind shared temporary budget port. */
export interface ImageTemporaryResourceBudget {
  /** Atomically acquire one active scope for a trusted, non-empty tenant. */
  acquireScope(tenantId: string): ImageTemporaryResourceBudgetLease;
}

export interface ImageRequestResourceOwnership {
  readonly tenantId: string;
  readonly sharedBudget: ImageTemporaryResourceBudget;
  readonly ownedDirectoryMarker?: boolean;
}

export class ImageRequestResourceScope {
  readonly #limits: ImageApiLimits;
  readonly #signal: AbortSignal;
  readonly #safeRoot: string;
  readonly #requestDirectory: string;
  readonly #budgetLease: ImageTemporaryResourceBudgetLease | undefined;
  readonly #releaseDirectoryLease: (() => void) | undefined;
  readonly #writers = new Set<RequestFileWriter>();
  readonly #leases = new Set<ImageReferenceLease>();
  #inputBytes = 0;
  #spoolBytes = 0;
  #cleaned = false;
  #cleanupPromise?: Promise<void>;

  private constructor(options: {
    limits: ImageApiLimits;
    signal: AbortSignal;
    safeRoot: string;
    requestDirectory: string;
    budgetLease?: ImageTemporaryResourceBudgetLease;
    releaseDirectoryLease?: () => void;
  }) {
    this.#limits = options.limits;
    this.#signal = options.signal;
    this.#safeRoot = options.safeRoot;
    this.#requestDirectory = options.requestDirectory;
    this.#budgetLease = options.budgetLease;
    this.#releaseDirectoryLease = options.releaseDirectoryLease;
  }

  static async create(options: CreateImageRequestResourceScopeOptions): Promise<ImageRequestResourceScope> {
    if (options.signal.aborted) cancelled(options.signal);
    const tenantId = options.tenantId?.trim();
    if (options.sharedBudget && !tenantId) {
      throw new TypeError('A shared image temporary budget requires a trusted tenant id.');
    }
    const budgetLease = options.sharedBudget?.acquireScope(tenantId!);
    let createdDirectory: string | undefined;
    let requestDirectory: string | undefined;
    try {
      const requestedRoot = resolve(options.tempRoot ?? tmpdir());
      await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
      const safeRoot = await realpath(requestedRoot);
      createdDirectory = await mkdtemp(join(safeRoot, 'omnicross-images-'));
      await chmod(createdDirectory, 0o700);
      requestDirectory = await realpath(createdDirectory);
      if (dirname(requestDirectory) !== safeRoot || !basename(requestDirectory).startsWith('omnicross-images-')) {
        throw new TypeError('Temporary image request directory escaped the injected safe root.');
      }
      if (options.ownedDirectoryMarker) {
        const marker = await open(
          join(requestDirectory, IMAGE_REQUEST_DIRECTORY_MARKER_NAME),
          'wx',
          0o600,
        );
        try {
          await marker.writeFile(IMAGE_REQUEST_DIRECTORY_MARKER_CONTENT, { encoding: 'utf8' });
          await marker.sync();
        } finally {
          await marker.close().catch(() => undefined);
        }
      }
      const releaseDirectoryLease = options.onDirectoryActive?.(requestDirectory);
      return new ImageRequestResourceScope({
        ...options,
        safeRoot,
        requestDirectory,
        ...(budgetLease ? { budgetLease } : {}),
        ...(releaseDirectoryLease ? { releaseDirectoryLease } : {}),
      });
    } catch (error) {
      if (createdDirectory) {
        await rm(createdDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
          .catch(() => undefined);
      }
      budgetLease?.releaseScope();
      throw error;
    }
  }

  assertActive(): void {
    if (this.#cleaned) throw new ImageGenerationError('request_cancelled');
    if (this.#signal.aborted) cancelled(this.#signal);
  }

  reserve(kind: ResourceKind, bytes: number): void {
    this.assertActive();
    const current = kind === 'input' ? this.#inputBytes : this.#spoolBytes;
    const max = kind === 'input' ? this.#limits.maxTotalInputBytes : this.#limits.maxSpoolBytes;
    if (!Number.isSafeInteger(current + bytes) || current + bytes > max) tooLarge();
    this.#budgetLease?.reserve(bytes);
    if (kind === 'input') this.#inputBytes += bytes;
    else this.#spoolBytes += bytes;
  }

  unreserve(kind: ResourceKind, bytes: number): void {
    const current = kind === 'input' ? this.#inputBytes : this.#spoolBytes;
    const released = Math.min(current, Math.max(0, bytes));
    if (kind === 'input') this.#inputBytes -= released;
    else this.#spoolBytes -= released;
    if (released > 0) this.#budgetLease?.release(released);
  }

  writerFinished(writer: RequestFileWriter): void {
    this.#writers.delete(writer);
  }

  async releaseSpool(privatePath: string, bytes: number): Promise<void> {
    const target = resolve(privatePath);
    if (dirname(target) !== this.#requestDirectory || basename(target).length < 16) {
      throw new TypeError('Refusing to remove an unverified image spool.');
    }
    try {
      await unlink(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    } finally {
      this.unreserve('spool', bytes);
    }
  }

  async createWriter(options: {
    readonly kind: ResourceKind;
    readonly maxBytes: number;
    readonly declaredBytes?: number;
  }): Promise<RequestFileWriter> {
    this.assertActive();
    assertPositiveLimit(options.maxBytes);
    if (options.declaredBytes !== undefined) {
      if (!Number.isSafeInteger(options.declaredBytes) || options.declaredBytes <= 0) tooLarge();
      if (options.declaredBytes > options.maxBytes) tooLarge();
    }
    const privatePath = join(this.#requestDirectory, randomUUID());
    const handle = await open(privatePath, 'wx', 0o600);
    const writer = new RequestFileWriter({
      scope: this,
      handle,
      path: privatePath,
      ...options,
    });
    this.#writers.add(writer);
    return writer;
  }

  async materialize(
    source: AsyncIterable<Uint8Array>,
    options: {
      readonly kind?: ResourceKind;
      readonly maxBytes?: number;
      readonly declaredBytes?: number;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<StagedTemporaryFile> {
    const signal = options.signal ?? this.#signal;
    const writer = await this.createWriter({
      kind: options.kind ?? 'input',
      maxBytes: options.maxBytes ?? this.#limits.maxFileBytes,
      ...(options.declaredBytes !== undefined ? { declaredBytes: options.declaredBytes } : {}),
    });
    try {
      for await (const chunk of source) await writer.write(chunk, signal);
      return await writer.finish();
    } catch (error) {
      await writer.abort();
      throw error;
    }
  }

  addLease(lease: ImageReferenceLease): void {
    this.assertActive();
    this.#leases.add(lease);
  }

  async cleanup(): Promise<void> {
    if (this.#cleanupPromise) return this.#cleanupPromise;
    this.#cleaned = true;
    this.#cleanupPromise = (async () => {
      try {
        await Promise.allSettled([...this.#writers].map((writer) => writer.abort()));
        this.#writers.clear();
        await Promise.allSettled([...this.#leases].map((lease) => lease.release()));
        this.#leases.clear();
        const target = resolve(this.#requestDirectory);
        if (dirname(target) !== this.#safeRoot || !basename(target).startsWith('omnicross-images-')) {
          throw new TypeError('Refusing to clean an unverified temporary image directory.');
        }
        await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } finally {
        this.unreserve('input', this.#inputBytes);
        this.unreserve('spool', this.#spoolBytes);
        this.#budgetLease?.releaseScope();
        this.#releaseDirectoryLease?.();
      }
    })();
    return this.#cleanupPromise;
  }
}

export function createImageRequestResourceScope(
  limits: ImageApiLimits,
  signal: AbortSignal,
  tempRoot?: string,
  ownership?: ImageRequestResourceOwnership,
): Promise<ImageRequestResourceScope> {
  return ImageRequestResourceScope.create({
    limits,
    signal,
    ...(tempRoot ? { tempRoot } : {}),
    ...(ownership ? ownership : {}),
  });
}
