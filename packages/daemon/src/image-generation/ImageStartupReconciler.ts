import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

import {
  IMAGE_REQUEST_DIRECTORY_MARKER_CONTENT,
  IMAGE_REQUEST_DIRECTORY_MARKER_NAME,
} from '@omnicross/core/image-generation';

import {
  ImageStorageMountCatalog,
  MountedImageReferenceStore,
} from './ImageStorageMountCatalog';
import type { DaemonImagePathResolver } from './imagePathResolver';
import type { DaemonImageActiveScopeRegistry } from './imageTemporaryResources';
import { ResponsesImageStateCleanupCoordinator } from './responsesImageStateCleanupCoordinator';

const OWNED_TEMPORARY_DIRECTORY = /^omnicross-images-[A-Za-z0-9_-]{6,128}$/u;
const STATE_TRANSACTION_FILE = /^\.(?:references|responses-image-state)\.\d+\.[a-f0-9]{16}\.tmp$/u;
const CATALOG_TRANSACTION_FILE = /^\.catalog\.\d+\.[a-f0-9]{16}\.tmp$/u;

export interface ImageStartupReconcilerOptions {
  readonly catalog: ImageStorageMountCatalog;
  readonly temporaryPaths: DaemonImagePathResolver;
  readonly staleTemporaryAfterMs: number;
  readonly activeTemporaryScopes?: Pick<DaemonImageActiveScopeRegistry, 'isActive'>;
  readonly maxMountsPerPass?: number;
  readonly maxEntriesPerMount?: number;
  readonly maxTemporaryDirectoriesPerPass?: number;
  readonly now?: () => number;
}

export interface ImageStartupReconciliationResult {
  readonly corruptManifestsQuarantined: number;
  readonly mountsVisited: number;
  readonly stateBindingsRemoved: number;
  readonly brokenBindingsRemoved: number;
  readonly referenceEntriesRemoved: number;
  readonly metadataRemoved: number;
  readonly metadataDegradedToProviderReference: number;
  readonly orphanFilesRemoved: number;
  readonly incompleteFilesRemoved: number;
  readonly transactionFilesRemoved: number;
  readonly temporaryDirectoriesRemoved: number;
  readonly foreignTemporaryDirectoriesSkipped: number;
  readonly activeTemporaryDirectoriesSkipped: number;
  readonly invalidDescendantsSkipped: number;
  readonly pendingReferenceDeletes: number;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be positive.`);
  return value;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isDirectChild(path: string, root: string): boolean {
  const target = resolve(path);
  const rel = relative(root, target);
  return !samePath(target, root) && !isAbsolute(rel) && !rel.startsWith('..') &&
    samePath(dirname(target), root);
}

/** One bounded, synchronous-filesystem startup pass; it never follows symlinks. */
export class ImageStartupReconciler {
  readonly #catalog: ImageStorageMountCatalog;
  readonly #temporaryPaths: DaemonImagePathResolver;
  readonly #staleTemporaryAfterMs: number;
  readonly #activeTemporaryScopes: Pick<DaemonImageActiveScopeRegistry, 'isActive'> | undefined;
  readonly #maxMountsPerPass: number;
  readonly #maxEntriesPerMount: number;
  readonly #maxTemporaryDirectoriesPerPass: number;
  readonly #now: () => number;

  constructor(options: ImageStartupReconcilerOptions) {
    this.#catalog = options.catalog;
    this.#temporaryPaths = options.temporaryPaths;
    this.#staleTemporaryAfterMs = positiveInteger(
      options.staleTemporaryAfterMs,
      'image temporary stale interval',
    );
    this.#activeTemporaryScopes = options.activeTemporaryScopes;
    this.#maxMountsPerPass = positiveInteger(
      options.maxMountsPerPass ?? 16,
      'image startup mount bound',
    );
    this.#maxEntriesPerMount = positiveInteger(
      options.maxEntriesPerMount ?? 1_000,
      'image startup entry bound',
    );
    this.#maxTemporaryDirectoriesPerPass = positiveInteger(
      options.maxTemporaryDirectoriesPerPass ?? 100,
      'image startup temporary-directory bound',
    );
    this.#now = options.now ?? Date.now;
  }

  async run(): Promise<ImageStartupReconciliationResult> {
    const now = this.#now();
    if (!Number.isFinite(now)) throw new RangeError('image startup reconciliation time is invalid');
    const mountedReferences = new MountedImageReferenceStore(this.#catalog);
    const mounts = this.#catalog.mountsForRead().slice(0, this.#maxMountsPerPass);
    let stateBindingsRemoved = 0;
    let brokenBindingsRemoved = 0;
    let referenceEntriesRemoved = 0;
    let metadataRemoved = 0;
    let metadataDegradedToProviderReference = 0;
    let orphanFilesRemoved = 0;
    let incompleteFilesRemoved = 0;
    let transactionFilesRemoved = 0;
    let invalidDescendantsSkipped = 0;
    let pendingReferenceDeletes = 0;

    for (const mount of mounts) {
      const removedState = await mount.responsesState.cleanup(now);
      stateBindingsRemoved += removedState.length;
      const broken = await mount.responsesState.reconcileBrokenReferenceLinks(
        (tenantKey, referenceId) => this.hasLiveReference(tenantKey, referenceId, now),
        this.#maxEntriesPerMount,
      );
      brokenBindingsRemoved += broken.length;
      const cleanup = new ResponsesImageStateCleanupCoordinator({
        stateStore: mount.responsesState,
        referenceStore: mountedReferences,
        maxReferenceDeletesPerPass: this.#maxEntriesPerMount,
      });
      const drained = await cleanup.drainPending();
      pendingReferenceDeletes += drained.pendingReferenceDeletes;
      referenceEntriesRemoved += await mount.references.cleanup(now);
      const files = await mount.references.reconcileOwnedFiles(this.#maxEntriesPerMount);
      metadataRemoved += files.metadataRemoved;
      metadataDegradedToProviderReference += files.metadataDegradedToProviderReference;
      orphanFilesRemoved += files.orphanFilesRemoved;
      incompleteFilesRemoved += files.incompleteFilesRemoved;
      invalidDescendantsSkipped += files.invalidDescendants;
      const debris = this.removeTransactionFiles(
        mount.resolver,
        'state',
        STATE_TRANSACTION_FILE,
        this.#maxEntriesPerMount,
      );
      transactionFilesRemoved += debris.removed;
      invalidDescendantsSkipped += debris.invalid;
    }

    const catalogDebris = this.removeTransactionFiles(
      this.#temporaryPaths,
      'mountManifest',
      CATALOG_TRANSACTION_FILE,
      this.#maxEntriesPerMount,
    );
    transactionFilesRemoved += catalogDebris.removed;
    invalidDescendantsSkipped += catalogDebris.invalid;
    const temporary = this.removeStaleTemporaryDirectories(now);
    invalidDescendantsSkipped += temporary.invalid;

    return Object.freeze({
      corruptManifestsQuarantined:
        this.#catalog.startupReconciliationStatus().corruptManifestsQuarantined,
      mountsVisited: mounts.length,
      stateBindingsRemoved,
      brokenBindingsRemoved,
      referenceEntriesRemoved,
      metadataRemoved,
      metadataDegradedToProviderReference,
      orphanFilesRemoved,
      incompleteFilesRemoved,
      transactionFilesRemoved,
      temporaryDirectoriesRemoved: temporary.removed,
      foreignTemporaryDirectoriesSkipped: temporary.foreign,
      activeTemporaryDirectoriesSkipped: temporary.active,
      invalidDescendantsSkipped,
      pendingReferenceDeletes,
    });
  }

  private async hasLiveReference(
    tenantKey: string,
    referenceId: Parameters<MountedImageReferenceStore['resolve']>[1],
    now: number,
  ): Promise<boolean> {
    for (const mount of this.#catalog.mountsForRead()) {
      if (await mount.references.hasLiveReferenceByHashedTenantKey(tenantKey, referenceId, now)) {
        return true;
      }
    }
    return false;
  }

  private removeTransactionFiles(
    paths: DaemonImagePathResolver,
    area: 'state' | 'mountManifest',
    pattern: RegExp,
    limit: number,
  ): { readonly removed: number; readonly invalid: number } {
    const root = paths.verifiedRoot(area);
    let removed = 0;
    let invalid = 0;
    for (const name of readdirSync(root).filter((value) => pattern.test(value)).slice(0, limit)) {
      const path = resolve(root, name);
      if (!isDirectChild(path, root) || basename(path) !== name) {
        invalid += 1;
        continue;
      }
      const info = lstatSync(path);
      if (info.isSymbolicLink() || !info.isFile()) {
        invalid += 1;
        continue;
      }
      paths.verifiedRoot(area);
      unlinkSync(path);
      removed += 1;
    }
    return Object.freeze({ removed, invalid });
  }

  private removeStaleTemporaryDirectories(now: number): {
    readonly removed: number;
    readonly foreign: number;
    readonly invalid: number;
    readonly active: number;
  } {
    const root = this.#temporaryPaths.verifiedRoot('temporary');
    let removed = 0;
    let foreign = 0;
    let invalid = 0;
    let active = 0;
    for (const name of readdirSync(root).slice(0, this.#maxTemporaryDirectoriesPerPass)) {
      const path = resolve(root, name);
      if (!OWNED_TEMPORARY_DIRECTORY.test(name) || !isDirectChild(path, root)) {
        foreign += 1;
        continue;
      }
      const info = lstatSync(path);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        invalid += 1;
        continue;
      }
      if (info.mtimeMs + this.#staleTemporaryAfterMs > now) continue;
      if (this.#activeTemporaryScopes?.isActive(path)) {
        active += 1;
        continue;
      }
      const markerPath = resolve(path, IMAGE_REQUEST_DIRECTORY_MARKER_NAME);
      if (!isDirectChild(markerPath, path) || !existsSync(markerPath)) {
        foreign += 1;
        continue;
      }
      const marker = lstatSync(markerPath);
      if (marker.isSymbolicLink() || !marker.isFile() || marker.size > 256) {
        invalid += 1;
        continue;
      }
      if (readFileSync(markerPath, 'utf8') !== IMAGE_REQUEST_DIRECTORY_MARKER_CONTENT) {
        foreign += 1;
        continue;
      }
      this.#temporaryPaths.verifiedRoot('temporary');
      this.removeTreeWithoutFollowingSymlinks(path, root);
      removed += 1;
    }
    return Object.freeze({ removed, foreign, invalid, active });
  }

  private removeTreeWithoutFollowingSymlinks(path: string, expectedParent: string): void {
    if (!isDirectChild(path, expectedParent)) {
      throw new TypeError('refusing to remove a temporary path outside its verified parent');
    }
    const info = lstatSync(path);
    if (info.isSymbolicLink() || info.isFile()) {
      unlinkSync(path);
      return;
    }
    if (!info.isDirectory()) {
      throw new TypeError('refusing to remove an unsupported temporary descendant');
    }
    for (const name of readdirSync(path)) {
      this.removeTreeWithoutFollowingSymlinks(resolve(path, name), path);
    }
    rmdirSync(path);
  }
}
