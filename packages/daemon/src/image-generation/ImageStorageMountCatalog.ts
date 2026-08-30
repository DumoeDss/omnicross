import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { ImageGenerationError } from '@omnicross/core/image-generation';
import type {
  ImageReferenceId,
} from '@omnicross/contracts/image-generation-types';
import type {
  ImageReferenceResolution,
  ImageReferenceSaveInput,
  ImageReferenceStore,
} from '@omnicross/core/image-generation';
import type {
  ResponsesImageCallBinding,
  ResponsesImageCallId,
  ResponsesImageCallResolution,
  ResponsesImageResponseResolution,
  ResponsesImageStateCommitInput,
  ResponsesImageStateStore,
} from '@omnicross/core/image-generation/responses';

import type { SecretBox } from '../secrets';
import {
  FileImageReferenceStore,
  type FileImageReferenceStoreLimits,
} from './FileImageReferenceStore';
import {
  FileResponsesImageStateStore,
  type FileResponsesImageStateStoreLimits,
} from './FileResponsesImageStateStore';
import {
  createDaemonImagePathResolver,
  type CreateDaemonImagePathResolverOptions,
  type DaemonImagePathResolver,
} from './imagePathResolver';

const CATALOG_VERSION = 1;
const CATALOG_NAME = 'catalog.v1.json';
const MAX_CATALOG_BYTES = 1024 * 1024;
const MAX_MOUNTS = 64;
const MOUNT_ID_PATTERN = /^mount_[a-f0-9]{32}$/u;

interface PersistedMount {
  readonly id: string;
  readonly durableRoot: string;
  readonly createdAt: number;
}

interface PersistedCatalog {
  readonly version: typeof CATALOG_VERSION;
  readonly revision: number;
  readonly activeMountId: string;
  readonly mounts: readonly PersistedMount[];
}

export interface ImageStorageMountBackend {
  readonly id: string;
  readonly createdAt: number;
  readonly resolver: DaemonImagePathResolver;
  readonly references: FileImageReferenceStore;
  readonly responsesState: FileResponsesImageStateStore;
}

export interface ImageStorageMountCatalogOptions {
  readonly pathOptions: Omit<CreateDaemonImagePathResolverOptions, 'storageRoot'>;
  readonly activeStorageRoot?: string;
  readonly referenceLimits: FileImageReferenceStoreLimits;
  readonly responsesStateLimits: FileResponsesImageStateStoreLimits;
  readonly secretBox?: SecretBox;
  readonly now?: () => number;
  readonly random?: (bytes: number) => Buffer;
  readonly replaceCatalog?: (targetPath: string, contents: Uint8Array) => void;
  readonly reconcileCorruptManifests?: boolean;
}

export interface ImageStorageMountPolicy {
  readonly referenceLimits: FileImageReferenceStoreLimits;
  readonly responsesStateLimits: FileResponsesImageStateStoreLimits;
}

export interface PreparedImageStorageMountActivation {
  readonly backend: ImageStorageMountBackend;
  publish(): ImageStorageMountBackend;
  rollback(): void;
  dispose(): void;
}

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function exactKeys(row: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(row).every((key) => allowedKeys.has(key));
}

function validMount(value: unknown): value is PersistedMount {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return exactKeys(row, ['id', 'durableRoot', 'createdAt']) &&
    typeof row.id === 'string' && MOUNT_ID_PATTERN.test(row.id) &&
    typeof row.durableRoot === 'string' && isAbsolute(row.durableRoot) &&
    safeInteger(row.createdAt);
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

/** Owns the durable-root set independently from any one runtime generation. */
export class ImageStorageMountCatalog {
  readonly #pathOptions: Omit<CreateDaemonImagePathResolverOptions, 'storageRoot'>;
  #referenceLimits: FileImageReferenceStoreLimits;
  #responsesStateLimits: FileResponsesImageStateStoreLimits;
  readonly #secretBox: SecretBox | undefined;
  readonly #now: () => number;
  readonly #random: (bytes: number) => Buffer;
  readonly #replaceCatalog: (targetPath: string, contents: Uint8Array) => void;
  readonly #catalogResolver: DaemonImagePathResolver;
  readonly #reconcileCorruptManifests: boolean;
  #revision = 0;
  #activeMountId = '';
  #mounts = new Map<string, ImageStorageMountBackend>();
  #backendRetainers = new Map<string, number>();
  #corruptManifestsQuarantined = 0;

  constructor(options: ImageStorageMountCatalogOptions) {
    this.#pathOptions = options.pathOptions;
    this.#referenceLimits = { ...options.referenceLimits };
    this.#responsesStateLimits = { ...options.responsesStateLimits };
    this.#secretBox = options.secretBox;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? randomBytes;
    this.#catalogResolver = this.createResolver(options.activeStorageRoot);
    this.#reconcileCorruptManifests = options.reconcileCorruptManifests ?? false;
    this.#replaceCatalog = options.replaceCatalog ??
      ((target, contents) => this.atomicReplace(target, contents));

    if (existsSync(this.catalogPath())) {
      try {
        this.loadCatalog();
      } catch (error) {
        if (!this.#reconcileCorruptManifests || !this.isManifestError(error)) throw error;
        this.quarantineManifest(this.#catalogResolver, 'mountManifest', CATALOG_NAME, 'catalog');
        const initial = this.createBackend(
          this.newMountId(),
          this.#catalogResolver,
          this.#now(),
        );
        const mounts = new Map([[initial.id, initial]]);
        this.persist(initial.id, mounts);
        this.#activeMountId = initial.id;
        this.#mounts = mounts;
      }
      const desiredRoot = this.createResolver(options.activeStorageRoot).paths.durableRoot;
      if (!samePath(this.active().resolver.paths.durableRoot, desiredRoot)) {
        this.activate(options.activeStorageRoot);
      }
    } else {
      const initial = this.createBackend(this.newMountId(), this.#catalogResolver, this.#now());
      const mounts = new Map([[initial.id, initial]]);
      this.persist(initial.id, mounts);
      this.#activeMountId = initial.id;
      this.#mounts = mounts;
    }
  }

  active(): ImageStorageMountBackend {
    const backend = this.#mounts.get(this.#activeMountId);
    if (!backend) throw new Error('image storage catalog has no active mount');
    return backend;
  }

  mountsForRead(): readonly ImageStorageMountBackend[] {
    const active = this.active();
    return Object.freeze([
      active,
      ...[...this.#mounts.values()].filter((mount) => mount.id !== active.id),
    ]);
  }

  status(): { readonly mounts: number; readonly retiredMounts: number } {
    return Object.freeze({
      mounts: this.#mounts.size,
      retiredMounts: Math.max(0, this.#mounts.size - 1),
    });
  }

  startupReconciliationStatus(): { readonly corruptManifestsQuarantined: number } {
    return Object.freeze({ corruptManifestsQuarantined: this.#corruptManifestsQuarantined });
  }

  utilization(): {
    readonly referenceEntries: number;
    readonly referenceBytes: number;
    readonly referenceTombstones: number;
    readonly stateCalls: number;
    readonly stateResponses: number;
    readonly stateTombstones: number;
    readonly pendingReferenceDeletes: number;
  } {
    let referenceEntries = 0;
    let referenceBytes = 0;
    let referenceTombstones = 0;
    let stateCalls = 0;
    let stateResponses = 0;
    let stateTombstones = 0;
    let pendingReferenceDeletes = 0;
    for (const mount of this.#mounts.values()) {
      const references = mount.references.status();
      const state = mount.responsesState.status();
      referenceEntries += references.entries;
      referenceBytes += references.bytes;
      referenceTombstones += references.tombstones;
      stateCalls += state.calls;
      stateResponses += state.responses;
      stateTombstones += state.tombstones;
      pendingReferenceDeletes += state.pendingReferenceDeletes;
    }
    return Object.freeze({
      referenceEntries,
      referenceBytes,
      referenceTombstones,
      stateCalls,
      stateResponses,
      stateTombstones,
      pendingReferenceDeletes,
    });
  }

  /** Pins a backend object until its owning runtime generation drains. */
  retainBackend(backend: ImageStorageMountBackend): () => void {
    if (!MOUNT_ID_PATTERN.test(backend.id)) {
      throw new TypeError('image storage backend id is invalid');
    }
    this.#backendRetainers.set(backend.id, (this.#backendRetainers.get(backend.id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = Math.max(0, (this.#backendRetainers.get(backend.id) ?? 0) - 1);
      if (remaining === 0) this.#backendRetainers.delete(backend.id);
      else this.#backendRetainers.set(backend.id, remaining);
    };
  }

  activate(storageRoot?: string): ImageStorageMountBackend {
    const resolver = this.createResolver(storageRoot);
    const existing = [...this.#mounts.values()].find((mount) =>
      samePath(mount.resolver.paths.durableRoot, resolver.paths.durableRoot));
    if (existing?.id === this.#activeMountId) return existing;

    const candidate = existing ?? this.createBackend(this.newMountId(), resolver, this.#now());
    if (!existing && this.#mounts.size >= MAX_MOUNTS) {
      throw new ImageGenerationError('image_generation_failed');
    }
    const nextMounts = new Map(this.#mounts);
    nextMounts.set(candidate.id, candidate);
    this.persist(candidate.id, nextMounts);
    this.#mounts = nextMounts;
    this.#activeMountId = candidate.id;
    return candidate;
  }

  /** Prepare a validated backend without changing the catalog's active mount. */
  prepareActivation(
    storageRoot?: string,
    policy: ImageStorageMountPolicy = {
      referenceLimits: this.#referenceLimits,
      responsesStateLimits: this.#responsesStateLimits,
    },
  ): PreparedImageStorageMountActivation {
    const resolver = this.createResolver(storageRoot);
    const existing = [...this.#mounts.values()].find((mount) =>
      samePath(mount.resolver.paths.durableRoot, resolver.paths.durableRoot));
    const candidate = existing ?? this.createBackend(
      this.newMountId(),
      resolver,
      this.#now(),
      policy,
    );
    if (!existing && this.#mounts.size >= MAX_MOUNTS) {
      throw new ImageGenerationError('image_generation_failed');
    }
    const previousMountId = this.#activeMountId;
    const previousPolicy: ImageStorageMountPolicy = {
      referenceLimits: { ...this.#referenceLimits },
      responsesStateLimits: { ...this.#responsesStateLimits },
    };
    let state: 'prepared' | 'published' | 'rolled_back' | 'disposed' = 'prepared';

    return Object.freeze({
      backend: candidate,
      publish: (): ImageStorageMountBackend => {
        if (state === 'published') return candidate;
        if (state !== 'prepared') {
          throw new TypeError('prepared image storage activation cannot be published');
        }
        if (candidate.id === this.#activeMountId) {
          this.applyMaintenancePolicy(this.#mounts, policy);
          this.#referenceLimits = { ...policy.referenceLimits };
          this.#responsesStateLimits = { ...policy.responsesStateLimits };
          state = 'published';
          return candidate;
        }
        const nextMounts = new Map(this.#mounts);
        nextMounts.set(candidate.id, candidate);
        this.persist(candidate.id, nextMounts);
        this.applyMaintenancePolicy(nextMounts, policy);
        this.#mounts = nextMounts;
        this.#activeMountId = candidate.id;
        this.#referenceLimits = { ...policy.referenceLimits };
        this.#responsesStateLimits = { ...policy.responsesStateLimits };
        state = 'published';
        return candidate;
      },
      rollback: (): void => {
        if (state === 'rolled_back') return;
        if (state !== 'published') return;
        if (this.#activeMountId !== candidate.id || !this.#mounts.has(previousMountId)) {
          throw new TypeError('published image storage activation cannot be rolled back');
        }
        // Retain the candidate as a retired mount: work admitted during the
        // publication window may already have durable references there.
        this.persist(previousMountId, this.#mounts);
        this.applyMaintenancePolicy(this.#mounts, previousPolicy);
        this.#activeMountId = previousMountId;
        this.#referenceLimits = { ...previousPolicy.referenceLimits };
        this.#responsesStateLimits = { ...previousPolicy.responsesStateLimits };
        state = 'rolled_back';
      },
      dispose: (): void => {
        if (state === 'disposed') return;
        if (state === 'published') return;
        state = 'disposed';
      },
    });
  }

  retireEmptyMount(mountId: string): boolean {
    if (!MOUNT_ID_PATTERN.test(mountId)) throw new TypeError('image storage mount id is invalid');
    if (mountId === this.#activeMountId) return false;
    if ((this.#backendRetainers.get(mountId) ?? 0) > 0) return false;
    const mount = this.#mounts.get(mountId);
    if (!mount || !this.isVerifiedEmpty(mount)) return false;
    const nextMounts = new Map(this.#mounts);
    nextMounts.delete(mountId);
    this.persist(this.#activeMountId, nextMounts);
    this.#mounts = nextMounts;
    return true;
  }

  private createResolver(storageRoot?: string): DaemonImagePathResolver {
    return createDaemonImagePathResolver({
      ...this.#pathOptions,
      ...(storageRoot !== undefined ? { storageRoot } : {}),
    });
  }

  private createBackend(
    id: string,
    resolver: DaemonImagePathResolver,
    createdAt: number,
    policy: ImageStorageMountPolicy = {
      referenceLimits: this.#referenceLimits,
      responsesStateLimits: this.#responsesStateLimits,
    },
  ): ImageStorageMountBackend {
    if (!safeInteger(createdAt)) throw new TypeError('image storage mount creation time is invalid');
    const createReferences = () => new FileImageReferenceStore({
        paths: resolver,
        limits: policy.referenceLimits,
        ...(this.#secretBox ? { secretBox: this.#secretBox } : {}),
        now: this.#now,
        random: this.#random,
      });
    const createResponsesState = () => new FileResponsesImageStateStore({
        paths: resolver,
        limits: policy.responsesStateLimits,
        now: this.#now,
        random: this.#random,
      });
    let references: FileImageReferenceStore;
    try {
      references = createReferences();
    } catch (error) {
      if (!this.#reconcileCorruptManifests || !this.isManifestError(error)) throw error;
      this.quarantineManifest(resolver, 'state', 'references.v1.json', 'references');
      references = createReferences();
    }
    let responsesState: FileResponsesImageStateStore;
    try {
      responsesState = createResponsesState();
    } catch (error) {
      if (!this.#reconcileCorruptManifests || !this.isManifestError(error)) throw error;
      this.quarantineManifest(
        resolver,
        'state',
        'responses-image-state.v1.json',
        'responses-state',
      );
      responsesState = createResponsesState();
    }
    return Object.freeze({ id, createdAt, resolver, references, responsesState });
  }

  private applyMaintenancePolicy(
    mounts: ReadonlyMap<string, ImageStorageMountBackend>,
    policy: ImageStorageMountPolicy,
  ): void {
    for (const mount of mounts.values()) {
      mount.references.updateMaintenanceLimits(policy.referenceLimits);
      mount.responsesState.updateMaintenanceLimits(policy.responsesStateLimits);
    }
  }

  private newMountId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = `mount_${this.#random(16).toString('hex')}`;
      if (MOUNT_ID_PATTERN.test(id) && !this.#mounts.has(id)) return id;
    }
    throw new Error('failed to allocate an image storage mount id');
  }

  private isManifestError(error: unknown): boolean {
    return error instanceof SyntaxError ||
      (error instanceof Error && /manifest|catalog/u.test(error.message));
  }

  private quarantineManifest(
    resolver: DaemonImagePathResolver,
    area: 'state' | 'mountManifest',
    name: string,
    label: string,
  ): void {
    const root = resolver.verifiedRoot(area);
    const source = join(root, name);
    if (!existsSync(source)) throw new TypeError('corrupt image manifest is missing');
    const info = lstatSync(source);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new TypeError('refusing to quarantine an unverified image manifest');
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const target = join(root, `.corrupt-${label}-${this.#random(8).toString('hex')}.json`);
      if (existsSync(target)) continue;
      resolver.verifiedRoot(area);
      renameSync(source, target);
      this.#corruptManifestsQuarantined += 1;
      return;
    }
    throw new Error('failed to allocate an image manifest quarantine path');
  }

  private isVerifiedEmpty(mount: ImageStorageMountBackend): boolean {
    mount.resolver.verifiedRoot('artifacts');
    mount.resolver.verifiedRoot('state');
    const references = mount.references.status();
    const state = mount.responsesState.status();
    return references.entries === 0 && references.bytes === 0 && references.tombstones === 0 &&
      state.calls === 0 && state.responses === 0 && state.tombstones === 0 &&
      state.pendingReferenceDeletes === 0 &&
      readdirSync(mount.resolver.paths.artifactsRoot).length === 0;
  }

  private catalogPath(): string {
    return this.#catalogResolver.paths.mountManifestPath;
  }

  private persist(activeMountId: string, mounts: ReadonlyMap<string, ImageStorageMountBackend>): void {
    if (!mounts.has(activeMountId) || mounts.size === 0 || mounts.size > MAX_MOUNTS) {
      throw new TypeError('image storage catalog snapshot is invalid');
    }
    const catalog: PersistedCatalog = {
      version: CATALOG_VERSION,
      revision: this.#revision + 1,
      activeMountId,
      mounts: [...mounts.values()].map((mount) => {
        mount.resolver.verifiedRoot('artifacts');
        mount.resolver.verifiedRoot('state');
        return {
          id: mount.id,
          durableRoot: mount.resolver.paths.durableRoot,
          createdAt: mount.createdAt,
        };
      }),
    };
    const serialized = Buffer.from(JSON.stringify(catalog, null, 2) + '\n', 'utf8');
    if (serialized.byteLength > MAX_CATALOG_BYTES) {
      throw new Error('image storage mount catalog exceeds its bound');
    }
    this.#replaceCatalog(this.catalogPath(), serialized);
    this.#revision = catalog.revision;
  }

  private atomicReplace(targetPath: string, contents: Uint8Array): void {
    const root = this.#catalogResolver.verifiedRoot('mountManifest');
    if (!samePath(dirname(resolve(targetPath)), root) || basename(targetPath) !== CATALOG_NAME) {
      throw new TypeError('invalid image storage mount catalog target');
    }
    const temporaryPath = join(
      root,
      `.catalog.${process.pid}.${this.#random(8).toString('hex')}.tmp`,
    );
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

  private loadCatalog(): void {
    const path = this.catalogPath();
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_CATALOG_BYTES) {
      throw new TypeError('image storage mount catalog is invalid');
    }
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('image storage mount catalog is invalid');
    }
    const catalog = parsed as Record<string, unknown>;
    if (
      !exactKeys(catalog, ['version', 'revision', 'activeMountId', 'mounts']) ||
      catalog.version !== CATALOG_VERSION ||
      !safeInteger(catalog.revision) ||
      typeof catalog.activeMountId !== 'string' ||
      !MOUNT_ID_PATTERN.test(catalog.activeMountId) ||
      !Array.isArray(catalog.mounts) ||
      catalog.mounts.length === 0 || catalog.mounts.length > MAX_MOUNTS
    ) throw new TypeError('image storage mount catalog is invalid');

    const mounts = new Map<string, ImageStorageMountBackend>();
    const roots: string[] = [];
    for (const value of catalog.mounts) {
      if (!validMount(value) || mounts.has(value.id) || roots.some((root) => samePath(root, value.durableRoot))) {
        throw new TypeError('image storage mount catalog contains an invalid mount');
      }
      const resolver = this.createResolver(value.durableRoot);
      if (!samePath(resolver.paths.durableRoot, value.durableRoot)) {
        throw new TypeError('image storage mount root changed during validation');
      }
      roots.push(value.durableRoot);
      mounts.set(value.id, this.createBackend(value.id, resolver, value.createdAt));
    }
    if (!mounts.has(catalog.activeMountId)) {
      throw new TypeError('image storage mount catalog active mount is missing');
    }
    this.#revision = catalog.revision;
    this.#activeMountId = catalog.activeMountId;
    this.#mounts = mounts;
  }
}

export class MountedImageReferenceStore implements ImageReferenceStore {
  constructor(
    private readonly catalog: ImageStorageMountCatalog,
    private readonly writeBackend?: ImageStorageMountBackend,
    private readonly writeLimits?: FileImageReferenceStoreLimits,
  ) {}

  bindWriteBackend(
    backend: ImageStorageMountBackend,
    limits: FileImageReferenceStoreLimits,
  ): MountedImageReferenceStore {
    return new MountedImageReferenceStore(this.catalog, backend, { ...limits });
  }

  status() {
    return Object.freeze({
      ...this.catalog.status(),
      ...this.catalog.utilization(),
    });
  }

  save(input: ImageReferenceSaveInput) {
    if (this.writeBackend && this.writeLimits) {
      return this.writeBackend.references.saveWithLimits(input, this.writeLimits);
    }
    return this.catalog.active().references.save(input);
  }

  async resolve(tenantId: string, referenceId: ImageReferenceId): Promise<ImageReferenceResolution> {
    let expired = false;
    for (const mount of this.catalog.mountsForRead()) {
      const result = await mount.references.resolve(tenantId, referenceId);
      if (result.status === 'found') return result;
      if (result.status === 'expired') expired = true;
    }
    return expired ? { status: 'expired' } : { status: 'not_found' };
  }

  async delete(tenantId: string, referenceId: ImageReferenceId): Promise<boolean> {
    let deleted = false;
    for (const mount of this.catalog.mountsForRead()) {
      deleted = await mount.references.delete(tenantId, referenceId) || deleted;
    }
    return deleted;
  }

  async deleteByHashedTenantKey(tenantKey: string, referenceId: ImageReferenceId): Promise<boolean> {
    let deleted = false;
    for (const mount of this.catalog.mountsForRead()) {
      deleted = await mount.references.deleteByHashedTenantKey(tenantKey, referenceId) || deleted;
    }
    return deleted;
  }

  async cleanup(now?: number): Promise<number> {
    let removed = 0;
    for (const mount of this.catalog.mountsForRead()) {
      removed += now === undefined
        ? await mount.references.cleanup()
        : await mount.references.cleanup(now);
    }
    return removed;
  }
}

export class MountedResponsesImageStateStore implements ResponsesImageStateStore {
  constructor(
    private readonly catalog: ImageStorageMountCatalog,
    private readonly writeBackend?: ImageStorageMountBackend,
    private readonly writeLimits?: FileResponsesImageStateStoreLimits,
  ) {}

  bindWriteBackend(
    backend: ImageStorageMountBackend,
    limits: FileResponsesImageStateStoreLimits,
  ): MountedResponsesImageStateStore {
    return new MountedResponsesImageStateStore(this.catalog, backend, { ...limits });
  }

  commit(input: ResponsesImageStateCommitInput): Promise<readonly ResponsesImageCallBinding[]> {
    if (this.writeBackend && this.writeLimits) {
      return this.writeBackend.responsesState.commitWithLimits(input, this.writeLimits);
    }
    return this.catalog.active().responsesState.commit(input);
  }

  async resolveCall(
    tenantId: string,
    callId: ResponsesImageCallId,
  ): Promise<ResponsesImageCallResolution> {
    let expired = false;
    for (const mount of this.catalog.mountsForRead()) {
      const result = await mount.responsesState.resolveCall(tenantId, callId);
      if (result.status === 'found') return result;
      if (result.status === 'expired') expired = true;
    }
    return expired ? { status: 'expired' } : { status: 'not_found' };
  }

  async resolveResponse(
    tenantId: string,
    responseId: string,
  ): Promise<ResponsesImageResponseResolution> {
    let expired = false;
    for (const mount of this.catalog.mountsForRead()) {
      const result = await mount.responsesState.resolveResponse(tenantId, responseId);
      if (result.status === 'found') return result;
      if (result.status === 'expired') expired = true;
    }
    return expired ? { status: 'expired' } : { status: 'not_found' };
  }

  async deleteCall(
    tenantId: string,
    callId: ResponsesImageCallId,
  ): Promise<ResponsesImageCallBinding | undefined> {
    let removed: ResponsesImageCallBinding | undefined;
    for (const mount of this.catalog.mountsForRead()) {
      removed = await mount.responsesState.deleteCall(tenantId, callId) ?? removed;
    }
    return removed;
  }

  async deleteResponse(tenantId: string, responseId: string): Promise<boolean> {
    let deleted = false;
    for (const mount of this.catalog.mountsForRead()) {
      deleted = await mount.responsesState.deleteResponse(tenantId, responseId) || deleted;
    }
    return deleted;
  }

  async cleanup(now?: number): Promise<readonly ResponsesImageCallBinding[]> {
    const removed: ResponsesImageCallBinding[] = [];
    for (const mount of this.catalog.mountsForRead()) {
      removed.push(...(now === undefined
        ? await mount.responsesState.cleanup()
        : await mount.responsesState.cleanup(now)));
    }
    return Object.freeze(removed);
  }
}
