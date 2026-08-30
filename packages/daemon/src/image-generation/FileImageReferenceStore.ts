import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  createReadStream,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';

import type {
  ImageArtifactId,
  ImageReferenceId,
  ImageReferenceMetadata,
  SensitiveOpaqueImageReference,
} from '@omnicross/contracts/image-generation-types';
import {
  ImageGenerationError,
  type ImageAsset,
  type ImageReferenceLease,
  type ImageReferenceResolution,
  type ImageReferenceSaveInput,
  type ImageReferenceStore,
} from '@omnicross/core/image-generation';

import type { SecretBox } from '../secrets';
import type { DaemonImagePathResolver } from './imagePathResolver';
import {
  deriveImageTenantHmac,
  isImageTenantHmac,
  loadOrCreateImageTenantHmacSalt,
} from './imageTenantHmac';

const MANIFEST_VERSION = 1;
const MANIFEST_NAME = 'references.v1.json';
const REFERENCE_ID = /^imgref_[A-Za-z0-9_-]{32}$/u;
const ARTIFACT_FILE = /^artifact-[a-f0-9]{32}\.bin$/u;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;

export interface FileImageReferenceStoreLimits {
  readonly ttlMs: number;
  readonly maxArtifactBytes: number;
  readonly maxTotalBytes: number;
  readonly maxTenantBytes: number;
  readonly maxEntries: number;
  readonly maxTombstones: number;
  readonly tombstoneTtlMs: number;
}

export interface FileImageReferenceStoreOptions {
  readonly paths: DaemonImagePathResolver;
  readonly limits: FileImageReferenceStoreLimits;
  readonly secretBox?: SecretBox;
  readonly now?: () => number;
  readonly random?: (bytes: number) => Buffer;
  readonly replaceManifest?: (targetPath: string, contents: Uint8Array) => void;
}

export interface FileImageReferenceReconciliationResult {
  readonly metadataRemoved: number;
  readonly metadataDegradedToProviderReference: number;
  readonly orphanFilesRemoved: number;
  readonly incompleteFilesRemoved: number;
  readonly invalidDescendants: number;
}

interface PersistedEntry {
  readonly referenceId: string;
  readonly tenantKey: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly mimeType: `image/${string}`;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly artifactId?: string;
  readonly artifactFile?: string;
  readonly encryptedProviderReference?: string;
  readonly deleted?: true;
}

interface PersistedTombstone {
  readonly referenceId: string;
  readonly tenantKey: string;
  readonly expiresAt: number;
}

interface PersistedManifest {
  readonly version: typeof MANIFEST_VERSION;
  readonly revision: number;
  readonly entries: PersistedEntry[];
  readonly tombstones: PersistedTombstone[];
}

interface RuntimeEntry {
  persisted: PersistedEntry;
  activeLeases: number;
}

interface Victim {
  readonly entry: RuntimeEntry;
  readonly expired: boolean;
}

function positive(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
}

function validateLimits(limits: FileImageReferenceStoreLimits): void {
  for (const [name, value] of Object.entries(limits)) positive(value, `image references ${name}`);
  if (limits.maxTotalBytes < limits.maxTenantBytes) {
    throw new TypeError('image reference total bytes must cover tenant bytes');
  }
  if (limits.maxTenantBytes < limits.maxArtifactBytes) {
    throw new TypeError('image reference tenant bytes must cover one artifact');
  }
}

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function validEntry(value: unknown): value is PersistedEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  const allowed = new Set([
    'referenceId', 'tenantKey', 'createdAt', 'expiresAt', 'mimeType', 'byteLength',
    'width', 'height', 'artifactId', 'artifactFile', 'encryptedProviderReference', 'deleted',
  ]);
  if (keys.some((key) => !allowed.has(key))) return false;
  return typeof row.referenceId === 'string' && REFERENCE_ID.test(row.referenceId) &&
    isImageTenantHmac(row.tenantKey) &&
    safeInteger(row.createdAt) && safeInteger(row.expiresAt) && row.expiresAt > row.createdAt &&
    typeof row.mimeType === 'string' && /^image\/[a-z0-9.+-]{1,64}$/u.test(row.mimeType) &&
    safeInteger(row.byteLength) && row.byteLength > 0 &&
    safeInteger(row.width) && row.width > 0 && safeInteger(row.height) && row.height > 0 &&
    (row.artifactId === undefined || (typeof row.artifactId === 'string' && row.artifactId.length <= 128)) &&
    (row.artifactFile === undefined || (typeof row.artifactFile === 'string' && ARTIFACT_FILE.test(row.artifactFile))) &&
    (row.encryptedProviderReference === undefined ||
      (typeof row.encryptedProviderReference === 'string' && row.encryptedProviderReference.startsWith('enc:v1:'))) &&
    (row.deleted === undefined || row.deleted === true) &&
    (row.artifactFile !== undefined || row.encryptedProviderReference !== undefined);
}

function validTombstone(value: unknown): value is PersistedTombstone {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).every((key) => ['referenceId', 'tenantKey', 'expiresAt'].includes(key)) &&
    typeof row.referenceId === 'string' && REFERENCE_ID.test(row.referenceId) &&
    isImageTenantHmac(row.tenantKey) &&
    safeInteger(row.expiresAt);
}

function metadata(entry: PersistedEntry): ImageReferenceMetadata {
  return {
    referenceId: entry.referenceId as ImageReferenceId,
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
    mimeType: entry.mimeType,
    byteLength: entry.byteLength,
    width: entry.width,
    height: entry.height,
  };
}

class PersistentImageAsset implements ImageAsset {
  readonly artifactId: ImageArtifactId;
  readonly mimeType: `image/${string}`;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly independentlyDecodable = true as const;

  constructor(
    private readonly store: FileImageReferenceStore,
    private readonly fileName: string,
    entry: PersistedEntry,
  ) {
    this.artifactId = (entry.artifactId ?? entry.referenceId) as ImageArtifactId;
    this.mimeType = entry.mimeType;
    this.byteLength = entry.byteLength;
    this.width = entry.width;
    this.height = entry.height;
  }

  async open(options: { readonly signal?: AbortSignal } = {}): Promise<ReadableStream<Uint8Array>> {
    if (options.signal?.aborted) throw new ImageGenerationError('request_cancelled');
    return this.store.openArtifact(this.fileName, this.byteLength, options.signal);
  }
}

export class FileImageReferenceStore implements ImageReferenceStore {
  readonly #paths: DaemonImagePathResolver;
  #limits: FileImageReferenceStoreLimits;
  readonly #secretBox: SecretBox | undefined;
  readonly #now: () => number;
  readonly #random: (bytes: number) => Buffer;
  readonly #replaceManifest: (targetPath: string, contents: Uint8Array) => void;
  readonly #tenantSalt: Buffer;
  #revision = 0;
  #entries = new Map<string, RuntimeEntry>();
  #tombstones = new Map<string, PersistedTombstone>();
  #tail: Promise<void> = Promise.resolve();

  constructor(options: FileImageReferenceStoreOptions) {
    validateLimits(options.limits);
    this.#paths = options.paths;
    this.#limits = options.limits;
    this.#secretBox = options.secretBox;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? randomBytes;
    this.#replaceManifest = options.replaceManifest ?? ((target, contents) => this.atomicReplace(target, contents));
    this.#tenantSalt = loadOrCreateImageTenantHmacSalt(this.#paths, this.#random);
    this.loadManifest();
  }

  async save(input: ImageReferenceSaveInput): Promise<ImageReferenceMetadata> {
    return this.saveWithLimits(input, this.#limits);
  }

  /** Generation-bound write entry point; reads and maintenance remain shared. */
  async saveWithLimits(
    input: ImageReferenceSaveInput,
    limits: FileImageReferenceStoreLimits,
  ): Promise<ImageReferenceMetadata> {
    validateLimits(limits);
    return this.exclusive(async () => {
      this.validateSaveInput(input, limits);
      const now = this.#now();
      const tenantKey = this.tenantKey(input.tenantId);
      const referenceId = this.newReferenceId();
      let artifactFile: string | undefined;
      let artifactPath: string | undefined;
      let encryptedProviderReference: string | undefined;
      if (input.providerReference !== undefined) {
        if (this.#secretBox) encryptedProviderReference = this.#secretBox.encrypt(input.providerReference);
        else if (!input.artifact) throw new TypeError('provider-only image references require secret-box protection');
      }

      const byteLength = input.artifact?.byteLength ?? 0;
      const victims = this.selectVictims(tenantKey, byteLength, now, limits);
      if (input.artifact) {
        const written = await this.writeArtifact(input.artifact, limits);
        artifactFile = written.fileName;
        artifactPath = written.path;
      }

      const entry: PersistedEntry = {
        referenceId,
        tenantKey,
        createdAt: now,
        expiresAt: now + input.ttlMs,
        mimeType: input.metadata.mimeType,
        byteLength: input.metadata.byteLength,
        width: input.metadata.width,
        height: input.metadata.height,
        ...(input.artifact ? { artifactId: input.artifact.artifactId, artifactFile } : {}),
        ...(encryptedProviderReference ? { encryptedProviderReference } : {}),
      };
      const nextEntries = new Map(this.#entries);
      for (const victim of victims) nextEntries.delete(victim.entry.persisted.referenceId);
      nextEntries.set(referenceId, { persisted: entry, activeLeases: 0 });
      const nextTombstones = this.nextTombstones(victims, now, limits);

      try {
        this.persist(nextEntries, nextTombstones);
      } catch (error) {
        if (artifactPath) this.safeUnlinkArtifactPath(artifactPath);
        throw error;
      }
      this.#entries = nextEntries;
      this.#tombstones = nextTombstones;
      for (const victim of victims) this.removeArtifact(victim.entry.persisted);
      return metadata(entry);
    });
  }

  /** Updates only app-session maintenance policy; pinned writes pass their own limits. */
  updateMaintenanceLimits(limits: FileImageReferenceStoreLimits): void {
    validateLimits(limits);
    this.#limits = { ...limits };
  }

  async resolve(tenantId: string, referenceId: ImageReferenceId): Promise<ImageReferenceResolution> {
    return this.exclusive(async () => {
      const tenantKey = this.tenantKey(tenantId);
      const entry = this.#entries.get(referenceId);
      if (!entry || entry.persisted.tenantKey !== tenantKey || entry.persisted.deleted) {
        const tombstone = this.#tombstones.get(referenceId);
        return tombstone && tombstone.tenantKey === tenantKey && tombstone.expiresAt > this.#now()
          ? { status: 'expired' }
          : { status: 'not_found' };
      }
      if (entry.persisted.expiresAt <= this.#now()) return { status: 'expired' };

      let artifact: ImageAsset | undefined;
      if (entry.persisted.artifactFile) {
        if (!this.validArtifact(entry.persisted.artifactFile, entry.persisted.byteLength)) {
          return { status: 'not_found' };
        }
        artifact = new PersistentImageAsset(this, entry.persisted.artifactFile, entry.persisted);
      }
      let providerReference: SensitiveOpaqueImageReference | undefined;
      if (entry.persisted.encryptedProviderReference && this.#secretBox) {
        try {
          providerReference = this.#secretBox.decrypt(entry.persisted.encryptedProviderReference) as SensitiveOpaqueImageReference;
        } catch {
          if (!artifact) return { status: 'not_found' };
        }
      }
      if (!artifact && !providerReference) return { status: 'not_found' };

      entry.activeLeases += 1;
      let released = false;
      const lease: ImageReferenceLease = {
        metadata: metadata(entry.persisted),
        value: {
          ...(artifact ? { artifact } : {}),
          ...(providerReference ? { providerReference } : {}),
        },
        release: async () => {
          if (released) return;
          released = true;
          await this.releaseLease(entry.persisted.referenceId);
        },
      };
      return { status: 'found', lease };
    });
  }

  async delete(tenantId: string, referenceId: ImageReferenceId): Promise<boolean> {
    return this.deleteByHashedTenantKey(this.tenantKey(tenantId), referenceId);
  }

  /** Daemon-internal cleanup path; accepts only the local reference-domain tenant HMAC. */
  async deleteByHashedTenantKey(
    tenantKey: string,
    referenceId: ImageReferenceId,
  ): Promise<boolean> {
    if (!isImageTenantHmac(tenantKey)) {
      throw new TypeError('image reference tenant key is invalid');
    }
    return this.exclusive(async () => {
      const entry = this.#entries.get(referenceId);
      if (!entry || entry.persisted.tenantKey !== tenantKey || entry.persisted.deleted) {
        return false;
      }
      const nextEntries = new Map(this.#entries);
      if (entry.activeLeases > 0) {
        nextEntries.set(referenceId, {
          activeLeases: entry.activeLeases,
          persisted: { ...entry.persisted, deleted: true },
        });
      } else {
        nextEntries.delete(referenceId);
      }
      this.persist(nextEntries, this.#tombstones);
      this.#entries = nextEntries;
      if (entry.activeLeases === 0) this.removeArtifact(entry.persisted);
      return true;
    });
  }

  async cleanup(now = this.#now()): Promise<number> {
    return this.exclusive(async () => {
      const victims: Victim[] = [];
      for (const entry of this.#entries.values()) {
        if (entry.activeLeases === 0 && (entry.persisted.deleted || entry.persisted.expiresAt <= now)) {
          victims.push({ entry, expired: !entry.persisted.deleted && entry.persisted.expiresAt <= now });
        }
      }
      const nextEntries = new Map(this.#entries);
      for (const victim of victims) nextEntries.delete(victim.entry.persisted.referenceId);
      const nextTombstones = this.nextTombstones(victims, now);
      const tombstonesChanged = nextTombstones.size !== this.#tombstones.size ||
        [...nextTombstones].some(([id, value]) => this.#tombstones.get(id)?.expiresAt !== value.expiresAt);
      if (victims.length > 0 || tombstonesChanged) {
        this.persist(nextEntries, nextTombstones);
        this.#entries = nextEntries;
        this.#tombstones = nextTombstones;
        for (const victim of victims) this.removeArtifact(victim.entry.persisted);
      }
      return victims.length;
    });
  }

  status(): { readonly entries: number; readonly bytes: number; readonly tombstones: number } {
    let bytes = 0;
    for (const entry of this.#entries.values()) {
      if (entry.persisted.artifactFile) bytes += entry.persisted.byteLength;
    }
    return Object.freeze({ entries: this.#entries.size, bytes, tombstones: this.#tombstones.size });
  }

  async hasLiveReferenceByHashedTenantKey(
    tenantKey: string,
    referenceId: ImageReferenceId,
    now = this.#now(),
  ): Promise<boolean> {
    if (!isImageTenantHmac(tenantKey) || !REFERENCE_ID.test(referenceId)) return false;
    return this.exclusive(async () => {
      const entry = this.#entries.get(referenceId);
      if (
        !entry ||
        entry.persisted.tenantKey !== tenantKey ||
        entry.persisted.deleted ||
        entry.persisted.expiresAt <= now
      ) return false;
      if (entry.persisted.artifactFile &&
        this.validArtifact(entry.persisted.artifactFile, entry.persisted.byteLength)) return true;
      if (entry.persisted.encryptedProviderReference && this.#secretBox) {
        try {
          this.#secretBox.decrypt(entry.persisted.encryptedProviderReference);
          return true;
        } catch {
          return false;
        }
      }
      return false;
    });
  }

  async reconcileOwnedFiles(maxEntries: number): Promise<FileImageReferenceReconciliationResult> {
    positive(maxEntries, 'image reference reconciliation bound');
    return this.exclusive(async () => {
      const nextEntries = new Map(this.#entries);
      let metadataRemoved = 0;
      let metadataDegradedToProviderReference = 0;
      for (const [referenceId, entry] of [...this.#entries].slice(0, maxEntries)) {
        if (!entry.persisted.artifactFile ||
          this.validArtifact(entry.persisted.artifactFile, entry.persisted.byteLength)) continue;
        let providerReferenceUsable = false;
        if (entry.persisted.encryptedProviderReference && this.#secretBox) {
          try {
            this.#secretBox.decrypt(entry.persisted.encryptedProviderReference);
            providerReferenceUsable = true;
          } catch {
            // Invalid encrypted metadata is never served.
          }
        }
        if (providerReferenceUsable) {
          const { artifactFile: _artifactFile, artifactId: _artifactId, ...providerOnly } =
            entry.persisted;
          nextEntries.set(referenceId, {
            activeLeases: entry.activeLeases,
            persisted: providerOnly,
          });
          metadataDegradedToProviderReference += 1;
        } else if (entry.activeLeases === 0) {
          nextEntries.delete(referenceId);
          metadataRemoved += 1;
        }
      }
      if (metadataRemoved > 0 || metadataDegradedToProviderReference > 0) {
        this.persist(nextEntries, this.#tombstones);
        this.#entries = nextEntries;
      }

      const referenced = new Set(
        [...this.#entries.values()]
          .map((entry) => entry.persisted.artifactFile)
          .filter((value): value is string => value !== undefined),
      );
      const root = this.#paths.verifiedRoot('artifacts');
      let orphanFilesRemoved = 0;
      let incompleteFilesRemoved = 0;
      let invalidDescendants = 0;
      for (const name of readdirSync(root).slice(0, maxEntries)) {
        const ownedArtifact = ARTIFACT_FILE.test(name);
        const incomplete = /^artifact-[a-f0-9]{32}\.tmp$/u.test(name);
        if ((!ownedArtifact || referenced.has(name)) && !incomplete) continue;
        const path = resolve(root, name);
        let info;
        try {
          info = lstatSync(path);
        } catch {
          continue;
        }
        if (info.isSymbolicLink() || !info.isFile()) {
          invalidDescendants += 1;
          continue;
        }
        this.safeUnlinkArtifactPath(path);
        if (incomplete) incompleteFilesRemoved += 1;
        else orphanFilesRemoved += 1;
      }
      return Object.freeze({
        metadataRemoved,
        metadataDegradedToProviderReference,
        orphanFilesRemoved,
        incompleteFilesRemoved,
        invalidDescendants,
      });
    });
  }

  async openArtifact(
    fileName: string,
    byteLength: number,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    if (signal?.aborted) throw new ImageGenerationError('request_cancelled');
    const path = this.artifactPath(fileName);
    const beforeOpen = lstatSync(path);
    if (beforeOpen.isSymbolicLink() || !beforeOpen.isFile() || beforeOpen.size !== byteLength) {
      throw new ImageGenerationError('image_reference_not_found');
    }
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    const fd = openSync(path, constants.O_RDONLY | noFollow);
    try {
      const opened = fstatSync(fd);
      const afterOpen = lstatSync(path);
      if (
        !opened.isFile() ||
        opened.size !== byteLength ||
        afterOpen.isSymbolicLink() ||
        !afterOpen.isFile() ||
        afterOpen.size !== byteLength ||
        opened.dev !== afterOpen.dev ||
        opened.ino !== afterOpen.ino ||
        beforeOpen.dev !== afterOpen.dev ||
        beforeOpen.ino !== afterOpen.ino
      ) {
        throw new ImageGenerationError('image_reference_not_found');
      }
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    const source = createReadStream(path, {
      fd,
      start: 0,
      end: byteLength - 1,
      autoClose: true,
      ...(signal ? { signal } : {}),
    });
    return Readable.toWeb(source) as ReadableStream<Uint8Array>;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private tenantKey(tenantId: string): string {
    if (typeof tenantId !== 'string' || !tenantId || tenantId.length > 256) {
      throw new TypeError('image reference tenant id is invalid');
    }
    return deriveImageTenantHmac(this.#tenantSalt, 'reference', tenantId);
  }

  private newReferenceId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = `imgref_${this.#random(24).toString('base64url')}`;
      if (REFERENCE_ID.test(id) && !this.#entries.has(id) && !this.#tombstones.has(id)) return id;
    }
    throw new Error('failed to allocate an image reference id');
  }

  private validateSaveInput(
    input: ImageReferenceSaveInput,
    limits: FileImageReferenceStoreLimits,
  ): void {
    this.tenantKey(input.tenantId);
    positive(input.ttlMs, 'image reference ttl');
    if (input.ttlMs > limits.ttlMs) throw new ImageGenerationError('invalid_image_request');
    if (!input.artifact && !input.providerReference) throw new TypeError('image reference requires a value');
    if (!/^image\/[a-z0-9.+-]{1,64}$/u.test(input.metadata.mimeType)) {
      throw new TypeError('image reference mime type is invalid');
    }
    for (const [name, value] of Object.entries({
      byteLength: input.metadata.byteLength,
      width: input.metadata.width,
      height: input.metadata.height,
    })) positive(value, `image reference ${name}`);
    if (input.artifact) {
      if (
        input.artifact.byteLength !== input.metadata.byteLength ||
        input.artifact.mimeType !== input.metadata.mimeType ||
        input.artifact.width !== input.metadata.width ||
        input.artifact.height !== input.metadata.height
      ) throw new TypeError('image reference metadata does not match its artifact');
      if (input.artifact.byteLength > limits.maxArtifactBytes) {
        throw new ImageGenerationError('image_too_large');
      }
    }
    if (input.metadata.byteLength > limits.maxArtifactBytes) {
      throw new ImageGenerationError('image_too_large');
    }
    if (input.providerReference !== undefined &&
      (typeof input.providerReference !== 'string' || input.providerReference.length === 0 ||
        input.providerReference.length > 4_096)) {
      throw new TypeError('opaque image provider reference is invalid');
    }
  }

  private selectVictims(
    tenantKey: string,
    newBytes: number,
    now: number,
    limits: FileImageReferenceStoreLimits,
  ): Victim[] {
    const victims = new Map<string, Victim>();
    for (const entry of this.#entries.values()) {
      if (entry.activeLeases === 0 && (entry.persisted.deleted || entry.persisted.expiresAt <= now)) {
        victims.set(entry.persisted.referenceId, {
          entry,
          expired: !entry.persisted.deleted && entry.persisted.expiresAt <= now,
        });
      }
    }
    const remaining = (): RuntimeEntry[] => [...this.#entries.values()]
      .filter((entry) => !victims.has(entry.persisted.referenceId));
    const bytesFor = (entries: RuntimeEntry[]): number => entries.reduce(
      (sum, entry) => sum + (entry.persisted.artifactFile ? entry.persisted.byteLength : 0),
      0,
    );
    const candidates = (tenant?: string): RuntimeEntry[] => remaining()
      .filter((entry) => entry.activeLeases === 0 && !entry.persisted.deleted &&
        (tenant === undefined || entry.persisted.tenantKey === tenant))
      .sort((a, b) => a.persisted.createdAt - b.persisted.createdAt ||
        a.persisted.referenceId.localeCompare(b.persisted.referenceId));
    const evictOne = (tenant?: string): boolean => {
      const candidate = candidates(tenant)[0];
      if (!candidate) return false;
      victims.set(candidate.persisted.referenceId, { entry: candidate, expired: false });
      return true;
    };

    while (bytesFor(remaining().filter((entry) => entry.persisted.tenantKey === tenantKey)) + newBytes >
      limits.maxTenantBytes) {
      if (!evictOne(tenantKey)) throw new ImageGenerationError('image_too_large');
    }
    while (bytesFor(remaining()) + newBytes > limits.maxTotalBytes) {
      if (!evictOne()) throw new ImageGenerationError('image_too_large');
    }
    while (remaining().length + 1 > limits.maxEntries) {
      if (!evictOne()) throw new ImageGenerationError('image_too_large');
    }
    return [...victims.values()];
  }

  private nextTombstones(
    victims: readonly Victim[],
    now: number,
    limits = this.#limits,
  ): Map<string, PersistedTombstone> {
    const next = new Map(
      [...this.#tombstones].filter(([, value]) => value.expiresAt > now),
    );
    for (const victim of victims) {
      if (!victim.expired) continue;
      next.set(victim.entry.persisted.referenceId, {
        referenceId: victim.entry.persisted.referenceId,
        tenantKey: victim.entry.persisted.tenantKey,
        expiresAt: now + limits.tombstoneTtlMs,
      });
    }
    const ordered = [...next.values()].sort((a, b) =>
      a.expiresAt - b.expiresAt || a.referenceId.localeCompare(b.referenceId));
    while (ordered.length > limits.maxTombstones) {
      const removed = ordered.shift();
      if (removed) next.delete(removed.referenceId);
    }
    return next;
  }

  private async writeArtifact(
    asset: ImageAsset,
    limits: FileImageReferenceStoreLimits,
  ): Promise<{ fileName: string; path: string }> {
    const root = this.#paths.verifiedRoot('artifacts');
    const suffix = this.#random(16).toString('hex');
    const tempPath = join(root, `artifact-${suffix}.tmp`);
    const fileName = `artifact-${suffix}.bin`;
    const finalPath = join(root, fileName);
    const handle = await open(tempPath, 'wx', 0o600);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let observed = 0;
    let writeFailure: unknown;
    try {
      reader = (await asset.open()).getReader();
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        observed += next.value.byteLength;
        if (observed > asset.byteLength || observed > limits.maxArtifactBytes) {
          throw new ImageGenerationError('image_too_large');
        }
        let offset = 0;
        while (offset < next.value.byteLength) {
          const result = await handle.write(next.value, offset, next.value.byteLength - offset, null);
          if (result.bytesWritten <= 0) throw new Error('image artifact write made no progress');
          offset += result.bytesWritten;
        }
      }
      if (observed !== asset.byteLength) throw new Error('image artifact stream length mismatch');
      await handle.sync();
    } catch (error) {
      await reader?.cancel().catch(() => undefined);
      writeFailure = error;
    } finally {
      reader?.releaseLock();
      await handle.close().catch(() => undefined);
    }
    if (writeFailure !== undefined) {
      this.safeUnlinkArtifactPath(tempPath);
      throw writeFailure;
    }
    let linked = false;
    try {
      this.#paths.verifiedRoot('artifacts');
      linkSync(tempPath, finalPath);
      linked = true;
      unlinkSync(tempPath);
      return { fileName, path: finalPath };
    } catch (error) {
      if (linked) this.safeUnlinkArtifactPath(finalPath);
      this.safeUnlinkArtifactPath(tempPath);
      throw error;
    }
  }

  private artifactPath(fileName: string): string {
    if (!ARTIFACT_FILE.test(fileName)) throw new TypeError('invalid image artifact filename');
    const root = this.#paths.verifiedRoot('artifacts');
    const path = resolve(root, fileName);
    if (!samePath(dirname(path), root) || basename(path) !== fileName) {
      throw new TypeError('image artifact escaped its root');
    }
    return path;
  }

  private validArtifact(fileName: string, byteLength: number): boolean {
    try {
      const path = this.artifactPath(fileName);
      const info = lstatSync(path);
      return !info.isSymbolicLink() && info.isFile() && info.size === byteLength;
    } catch {
      return false;
    }
  }

  private removeArtifact(entry: PersistedEntry): void {
    if (!entry.artifactFile) return;
    try {
      this.safeUnlinkArtifactPath(this.artifactPath(entry.artifactFile));
    } catch {
      // Reconciliation owns verified orphan cleanup; never broaden deletion here.
    }
  }

  private safeUnlinkArtifactPath(path: string): void {
    const root = this.#paths.verifiedRoot('artifacts');
    const target = resolve(path);
    const name = basename(target);
    if (!samePath(dirname(target), root) || !/^artifact-[a-f0-9]{32}\.(?:bin|tmp)$/u.test(name)) {
      throw new TypeError('refusing to unlink an unverified image artifact');
    }
    if (!existsSync(target)) return;
    const info = lstatSync(target);
    if (info.isSymbolicLink() || !info.isFile()) throw new TypeError('refusing to unlink an unverified image artifact');
    unlinkSync(target);
  }

  private async releaseLease(referenceId: string): Promise<void> {
    await this.exclusive(async () => {
      const entry = this.#entries.get(referenceId);
      if (!entry || entry.activeLeases <= 0) return;
      entry.activeLeases -= 1;
      if (!entry.persisted.deleted || entry.activeLeases > 0) return;
      const nextEntries = new Map(this.#entries);
      nextEntries.delete(referenceId);
      try {
        this.persist(nextEntries, this.#tombstones);
        this.#entries = nextEntries;
        this.removeArtifact(entry.persisted);
      } catch {
        // The persisted deleted marker already keeps future readers fail-closed.
      }
    });
  }

  private manifestPath(): string {
    return join(this.#paths.verifiedRoot('state'), MANIFEST_NAME);
  }

  private persist(
    entries: ReadonlyMap<string, RuntimeEntry>,
    tombstones: ReadonlyMap<string, PersistedTombstone>,
  ): void {
    const manifest: PersistedManifest = {
      version: MANIFEST_VERSION,
      revision: this.#revision + 1,
      entries: [...entries.values()].map((entry) => entry.persisted),
      tombstones: [...tombstones.values()],
    };
    const serialized = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    if (serialized.byteLength > MAX_MANIFEST_BYTES) throw new Error('image reference manifest exceeds its bound');
    this.#replaceManifest(this.manifestPath(), serialized);
    this.#revision = manifest.revision;
  }

  private atomicReplace(targetPath: string, contents: Uint8Array): void {
    const root = this.#paths.verifiedRoot('state');
    if (!samePath(dirname(resolve(targetPath)), root) || basename(targetPath) !== MANIFEST_NAME) {
      throw new TypeError('invalid image reference manifest target');
    }
    const temporaryPath = join(root, `.references.${process.pid}.${this.#random(8).toString('hex')}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temporaryPath, 'wx', 0o600);
      writeFileSync(fd, contents);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporaryPath, targetPath);
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* preserve the original failure */ }
      }
      if (existsSync(temporaryPath)) {
        try { unlinkSync(temporaryPath); } catch { /* preserve the original failure */ }
      }
    }
  }

  private loadManifest(): void {
    const path = this.manifestPath();
    if (!existsSync(path)) return;
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_MANIFEST_BYTES) {
      throw new TypeError('image reference manifest is invalid');
    }
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('image reference manifest is invalid');
    }
    const manifest = parsed as Record<string, unknown>;
    if (
      Object.keys(manifest).some((key) => !['version', 'revision', 'entries', 'tombstones'].includes(key)) ||
      manifest.version !== MANIFEST_VERSION ||
      !safeInteger(manifest.revision) ||
      !Array.isArray(manifest.entries) ||
      !Array.isArray(manifest.tombstones)
    ) throw new TypeError('image reference manifest is invalid');
    let repaired = manifest.entries.length > this.#limits.maxEntries ||
      manifest.tombstones.length > this.#limits.maxTombstones;
    const entries = new Map<string, RuntimeEntry>();
    let totalBytes = 0;
    const tenantBytes = new Map<string, number>();
    for (const value of manifest.entries.slice(0, this.#limits.maxEntries)) {
      if (!validEntry(value) || entries.has(value.referenceId)) {
        repaired = true;
        continue;
      }
      const bytes = value.artifactFile ? value.byteLength : 0;
      const nextTenantBytes = (tenantBytes.get(value.tenantKey) ?? 0) + bytes;
      if (
        value.byteLength > this.#limits.maxArtifactBytes ||
        totalBytes + bytes > this.#limits.maxTotalBytes ||
        nextTenantBytes > this.#limits.maxTenantBytes
      ) {
        repaired = true;
        continue;
      }
      entries.set(value.referenceId, { persisted: value, activeLeases: 0 });
      totalBytes += bytes;
      tenantBytes.set(value.tenantKey, nextTenantBytes);
    }
    const tombstones = new Map<string, PersistedTombstone>();
    for (const value of manifest.tombstones.slice(0, this.#limits.maxTombstones)) {
      if (
        !validTombstone(value) ||
        tombstones.has(value.referenceId) ||
        entries.has(value.referenceId)
      ) {
        repaired = true;
        continue;
      }
      tombstones.set(value.referenceId, value);
    }
    this.#revision = manifest.revision as number;
    this.#entries = entries;
    this.#tombstones = tombstones;
    if (repaired) this.persist(entries, tombstones);
  }
}
