import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
} from 'node:path';

export type DaemonImagePathArea =
  | 'temporary'
  | 'artifacts'
  | 'state'
  | 'evidence'
  | 'mountManifest';

export interface DaemonImagePaths {
  readonly applicationDataRoot: string;
  readonly imagesRoot: string;
  readonly temporaryRoot: string;
  readonly durableRoot: string;
  readonly artifactsRoot: string;
  readonly stateRoot: string;
  readonly evidenceRoot: string;
  readonly mountManifestRoot: string;
  readonly mountManifestPath: string;
}

export interface ImageRootValidationOptions {
  readonly label?: string;
  readonly processDirectory?: string;
  readonly userHome?: string;
  readonly temporaryDirectory?: string;
}

export interface CreateDaemonImagePathResolverOptions extends ImageRootValidationOptions {
  readonly configPath: string;
  readonly storageRoot?: string;
}

export interface VerifiedDaemonImagePath {
  readonly area: DaemonImagePathArea;
  readonly absolutePath: string;
  readonly kind: 'opaque-file' | 'opaque-directory' | 'mount-manifest';
}

interface RootIdentity {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
}

const OPAQUE_NAME = /^(?:file|directory)-[a-f0-9]{32}(?:\.(?:bin|json|tmp))?$/u;
const MOUNT_MANIFEST_NAME = 'catalog.v1.json';

function normalized(path: string): string {
  const canonical = resolve(path);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

function samePath(left: string, right: string): boolean {
  return normalized(left) === normalized(right);
}

function isSameOrDescendant(candidate: string, parent: string): boolean {
  const rel = relative(parent, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function assertNoSymlinkComponents(target: string): void {
  const absolute = resolve(target);
  const filesystemRoot = parse(absolute).root;
  let cursor = filesystemRoot;
  for (const segment of relative(filesystemRoot, absolute).split(/[\\/]+/u).filter(Boolean)) {
    cursor = join(cursor, segment);
    if (!existsSync(cursor)) break;
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new TypeError('image storage paths must not traverse a symbolic link');
    }
  }
}

function isInsideDetectedWorktree(target: string): boolean {
  let cursor = resolve(target);
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  while (true) {
    if (existsSync(join(cursor, '.git'))) return true;
    const parent = dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
}

function isBroadRoot(target: string, options: ImageRootValidationOptions): boolean {
  const filesystemRoot = parse(target).root;
  const processDirectory = resolve(options.processDirectory ?? process.cwd());
  const userHome = resolve(options.userHome ?? homedir());
  const temporaryDirectory = resolve(options.temporaryDirectory ?? tmpdir());
  return samePath(target, filesystemRoot) ||
    samePath(target, userHome) ||
    samePath(target, temporaryDirectory) ||
    isSameOrDescendant(processDirectory, target) ||
    isSameOrDescendant(userHome, target) ||
    isSameOrDescendant(temporaryDirectory, target);
}

/** Pure validation shared by strict admin writes and runtime path construction. */
export function validateImageRootCandidate(
  candidate: string,
  options: ImageRootValidationOptions = {},
): string[] {
  const label = options.label ?? 'image storage root';
  if (!candidate.trim() || !isAbsolute(candidate)) return [`${label} must be an absolute path`];
  const target = resolve(candidate);
  const errors: string[] = [];
  if (isBroadRoot(target, options)) errors.push(`${label} is too broad`);
  try {
    assertNoSymlinkComponents(target);
  } catch {
    errors.push(`${label} must not traverse a symbolic link`);
  }
  if (isInsideDetectedWorktree(target)) {
    errors.push(`${label} must be outside every detected worktree`);
  }
  return errors;
}

function ensurePrivateDirectory(path: string): RootIdentity {
  assertNoSymlinkComponents(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(path);
  const canonical = realpathSync.native(path);
  if (!samePath(canonical, path)) throw new TypeError('image storage directory canonicalization changed its path');
  const info = statSync(canonical);
  if (!info.isDirectory()) throw new TypeError('image storage root must be a directory');
  chmodSync(canonical, 0o700);
  return { path: canonical, device: info.dev, inode: info.ino };
}

function assertRootIdentity(identity: RootIdentity): void {
  assertNoSymlinkComponents(identity.path);
  const canonical = realpathSync.native(identity.path);
  const info = statSync(canonical);
  if (
    !samePath(canonical, identity.path) ||
    !info.isDirectory() ||
    info.dev !== identity.device ||
    info.ino !== identity.inode
  ) {
    throw new TypeError('image storage root identity changed');
  }
}

/**
 * Owns all daemon Images filesystem names. Callers receive opaque capabilities,
 * never a filename-accepting delete primitive; destructive methods revalidate
 * the root identity, descendant relationship, basename, and symlink state.
 */
export class DaemonImagePathResolver {
  readonly paths: DaemonImagePaths;
  readonly #roots: Readonly<Record<DaemonImagePathArea, RootIdentity>>;
  readonly #issued = new WeakSet<object>();

  constructor(options: CreateDaemonImagePathResolverOptions) {
    if (!isAbsolute(options.configPath)) throw new TypeError('daemon configPath must be absolute');
    const applicationDataRoot = resolve(dirname(options.configPath));
    const applicationErrors = validateImageRootCandidate(applicationDataRoot, {
      ...options,
      label: 'daemon application data root',
    });
    if (applicationErrors.length > 0) throw new TypeError(applicationErrors.join('; '));

    const imagesRoot = join(applicationDataRoot, 'images');
    const durableRoot = resolve(options.storageRoot ?? join(imagesRoot, 'storage'));
    const durableErrors = validateImageRootCandidate(durableRoot, {
      ...options,
      label: 'image durable storage root',
    });
    const reservedRoots = [
      join(imagesRoot, 'temporary'),
      join(imagesRoot, 'evidence'),
      join(imagesRoot, 'mount-catalog'),
    ];
    if (reservedRoots.some((reserved) =>
      isSameOrDescendant(durableRoot, reserved) || isSameOrDescendant(reserved, durableRoot))) {
      durableErrors.push('image durable storage root must not overlap daemon image control roots');
    }
    if (durableErrors.length > 0) throw new TypeError(durableErrors.join('; '));

    const paths: DaemonImagePaths = Object.freeze({
      applicationDataRoot,
      imagesRoot,
      temporaryRoot: join(imagesRoot, 'temporary'),
      durableRoot,
      artifactsRoot: join(durableRoot, 'artifacts'),
      stateRoot: join(durableRoot, 'state'),
      evidenceRoot: join(imagesRoot, 'evidence'),
      mountManifestRoot: join(imagesRoot, 'mount-catalog'),
      mountManifestPath: join(imagesRoot, 'mount-catalog', MOUNT_MANIFEST_NAME),
    });

    const rootEntries: Array<[DaemonImagePathArea, string]> = [
      ['temporary', paths.temporaryRoot],
      ['artifacts', paths.artifactsRoot],
      ['state', paths.stateRoot],
      ['evidence', paths.evidenceRoot],
      ['mountManifest', paths.mountManifestRoot],
    ];
    const roots = {} as Record<DaemonImagePathArea, RootIdentity>;
    for (const [area, path] of rootEntries) roots[area] = ensurePrivateDirectory(path);
    this.paths = paths;
    this.#roots = Object.freeze(roots);
  }

  createOpaqueFile(
    area: Exclude<DaemonImagePathArea, 'temporary' | 'mountManifest'>,
    format: 'bin' | 'json' | 'tmp' = 'bin',
  ): VerifiedDaemonImagePath {
    return this.issue(area, `file-${randomBytes(16).toString('hex')}.${format}`, 'opaque-file');
  }

  createOpaqueDirectory(
    area: Exclude<DaemonImagePathArea, 'mountManifest'> = 'temporary',
  ): VerifiedDaemonImagePath {
    return this.issue(area, `directory-${randomBytes(16).toString('hex')}`, 'opaque-directory');
  }

  mountManifest(): VerifiedDaemonImagePath {
    return this.issue('mountManifest', MOUNT_MANIFEST_NAME, 'mount-manifest');
  }

  /** Revalidate and return one internal root for store-local bounded I/O. */
  verifiedRoot(area: DaemonImagePathArea): string {
    const root = this.#roots[area];
    assertRootIdentity(root);
    return root.path;
  }

  /** Revalidate immediately before unlinking a resolver-issued file capability. */
  removeFile(target: VerifiedDaemonImagePath): void {
    const path = this.verifyDestructiveTarget(target, ['opaque-file', 'mount-manifest']);
    if (!existsSync(path)) return;
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new TypeError('refusing to unlink an unverified image file');
    }
    unlinkSync(path);
  }

  /** Only empty opaque directories may be removed until the owned-marker layer is composed. */
  removeEmptyDirectory(target: VerifiedDaemonImagePath): void {
    const path = this.verifyDestructiveTarget(target, ['opaque-directory']);
    if (!existsSync(path)) return;
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new TypeError('refusing to remove an unverified image directory');
    }
    rmdirSync(path);
  }

  private issue(
    area: DaemonImagePathArea,
    name: string,
    kind: VerifiedDaemonImagePath['kind'],
  ): VerifiedDaemonImagePath {
    const handle = Object.freeze({
      area,
      absolutePath: join(this.#roots[area].path, name),
      kind,
    });
    this.#issued.add(handle);
    return handle;
  }

  private verifyDestructiveTarget(
    target: VerifiedDaemonImagePath,
    allowedKinds: readonly VerifiedDaemonImagePath['kind'][],
  ): string {
    if (!target || typeof target !== 'object' || !this.#issued.has(target)) {
      throw new TypeError('refusing a destructive operation on an unverified image path');
    }
    if (!allowedKinds.includes(target.kind)) {
      throw new TypeError('refusing a destructive operation for the wrong image path kind');
    }
    const root = this.#roots[target.area];
    assertRootIdentity(root);
    const candidate = resolve(target.absolutePath);
    if (!samePath(dirname(candidate), root.path) || !isSameOrDescendant(candidate, root.path)) {
      throw new TypeError('refusing a destructive operation outside the verified image root');
    }
    const name = basename(candidate);
    const validName = target.kind === 'mount-manifest'
      ? name === MOUNT_MANIFEST_NAME
      : OPAQUE_NAME.test(name);
    if (!validName) throw new TypeError('refusing a caller-derived image filename');
    assertNoSymlinkComponents(candidate);
    return candidate;
  }
}

export function createDaemonImagePathResolver(
  options: CreateDaemonImagePathResolverOptions,
): DaemonImagePathResolver {
  return new DaemonImagePathResolver(options);
}
