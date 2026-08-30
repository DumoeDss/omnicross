import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createDaemonImagePathResolver,
  type CreateDaemonImagePathResolverOptions,
  type VerifiedDaemonImagePath,
} from '../imagePathResolver';

const sandboxes: string[] = [];

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'omnicross-image-path-resolver-'));
  sandboxes.push(root);
  return root;
}

function options(root: string): CreateDaemonImagePathResolverOptions {
  const applicationData = join(root, 'private-application-data');
  const processDirectory = join(root, 'workspace');
  const userHome = join(root, 'home');
  const temporaryDirectory = join(root, 'system-temporary');
  for (const path of [applicationData, processDirectory, userHome, temporaryDirectory]) {
    mkdirSync(path, { recursive: true });
  }
  return {
    configPath: join(applicationData, 'config.json'),
    processDirectory,
    userHome,
    temporaryDirectory,
  };
}

afterEach(() => {
  const systemTemporary = resolve(tmpdir());
  for (const root of sandboxes.splice(0)) {
    const absolute = resolve(root);
    const rel = relative(systemTemporary, absolute);
    if (!isAbsolute(absolute) || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('refusing to clean an unverified test sandbox');
    }
    rmSync(absolute, { recursive: true, force: true });
  }
});

describe('DaemonImagePathResolver', () => {
  it('derives separate restrictive roots from private application data', () => {
    const input = options(sandbox());
    const resolver = createDaemonImagePathResolver(input);
    const paths = resolver.paths;

    expect(paths.applicationDataRoot).toBe(resolve(join(input.configPath, '..')));
    expect(new Set([
      paths.temporaryRoot,
      paths.artifactsRoot,
      paths.stateRoot,
      paths.evidenceRoot,
      paths.mountManifestRoot,
    ]).size).toBe(5);
    expect(paths.mountManifestPath).toBe(join(paths.mountManifestRoot, 'catalog.v1.json'));
    for (const path of [
      paths.temporaryRoot,
      paths.artifactsRoot,
      paths.stateRoot,
      paths.evidenceRoot,
      paths.mountManifestRoot,
    ]) {
      expect(statSync(path).isDirectory()).toBe(true);
      if (process.platform !== 'win32') expect(statSync(path).mode & 0o077).toBe(0);
    }
  });

  it('rejects broad roots and roots inside detected worktrees', () => {
    const root = sandbox();
    const input = options(root);
    expect(() => createDaemonImagePathResolver({
      ...input,
      storageRoot: resolve(input.processDirectory!),
    })).toThrow(/too broad/);

    const worktree = join(root, 'repo');
    mkdirSync(join(worktree, '.git'), { recursive: true });
    expect(() => createDaemonImagePathResolver({
      ...input,
      storageRoot: join(worktree, 'images'),
    })).toThrow(/outside every detected worktree/);
    expect(() => createDaemonImagePathResolver({
      ...input,
      configPath: join(worktree, 'private', 'config.json'),
    })).toThrow(/outside every detected worktree/);
  });

  it('rejects roots that traverse an existing symlink', () => {
    const root = sandbox();
    const input = options(root);
    const actual = join(root, 'actual-storage');
    const linked = join(root, 'linked-storage');
    mkdirSync(actual, { recursive: true });
    symlinkSync(actual, linked, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => createDaemonImagePathResolver({
      ...input,
      storageRoot: join(linked, 'images'),
    })).toThrow(/symbolic link/);
  });

  it('rejects durable roots that overlap temporary, evidence, or mount-catalog control roots', () => {
    const root = sandbox();
    const input = options(root);
    const imagesRoot = join(resolve(join(input.configPath, '..')), 'images');
    for (const storageRoot of [
      imagesRoot,
      join(imagesRoot, 'temporary'),
      join(imagesRoot, 'evidence', 'nested'),
      join(imagesRoot, 'mount-catalog'),
    ]) {
      expect(() => createDaemonImagePathResolver({ ...input, storageRoot }))
        .toThrow(/must not overlap daemon image control roots/);
    }
  });

  it('allows destructive operations only through resolver-issued opaque capabilities', () => {
    const root = sandbox();
    const resolver = createDaemonImagePathResolver(options(root));
    const file = resolver.createOpaqueFile('artifacts', 'bin');
    expect(basename(file.absolutePath)).toMatch(/^file-[a-f0-9]{32}\.bin$/u);
    writeFileSync(file.absolutePath, 'owned');
    resolver.removeFile(file);
    expect(existsSync(file.absolutePath)).toBe(false);

    const directory = resolver.createOpaqueDirectory('temporary');
    mkdirSync(directory.absolutePath, { mode: 0o700 });
    resolver.removeEmptyDirectory(directory);
    expect(existsSync(directory.absolutePath)).toBe(false);

    const outside = join(root, 'caller-filename.txt');
    writeFileSync(outside, 'foreign');
    const forged = {
      area: 'artifacts',
      absolutePath: outside,
      kind: 'opaque-file',
    } as VerifiedDaemonImagePath;
    expect(() => resolver.removeFile(forged)).toThrow(/unverified image path/);
    expect(readFileSync(outside, 'utf8')).toBe('foreign');
  });

  it('revalidates root identity and symlinks immediately before deletion', () => {
    const root = sandbox();
    const resolver = createDaemonImagePathResolver(options(root));
    const file = resolver.createOpaqueFile('artifacts', 'bin');
    const outside = join(root, 'replacement-target');
    mkdirSync(outside);
    rmdirSync(resolver.paths.artifactsRoot);
    symlinkSync(
      outside,
      resolver.paths.artifactsRoot,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    writeFileSync(join(outside, basename(file.absolutePath)), 'foreign');

    expect(() => resolver.removeFile(file)).toThrow(/symbolic link|root identity changed/);
    expect(readFileSync(join(outside, basename(file.absolutePath)), 'utf8')).toBe('foreign');
  });
});
