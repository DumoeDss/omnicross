import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ImageReferenceId } from '@omnicross/contracts/image-generation-types';
import {
  IMAGE_REQUEST_DIRECTORY_MARKER_CONTENT,
  IMAGE_REQUEST_DIRECTORY_MARKER_NAME,
  InMemoryImageAsset,
} from '@omnicross/core/image-generation';
import type {
  ResponsesImageCallBinding,
  ResponsesImageCallId,
} from '@omnicross/core/image-generation/responses';
import { DEFAULT_IMAGES_SERVER_CONFIG } from '@omnicross/core/outbound-api';

import type { FileImageReferenceStoreLimits } from '../FileImageReferenceStore';
import type { FileResponsesImageStateStoreLimits } from '../FileResponsesImageStateStore';
import { ImageStartupReconciler } from '../ImageStartupReconciler';
import {
  DaemonImageActiveScopeRegistry,
  DaemonImageTemporaryResourceFactory,
} from '../imageTemporaryResources';
import {
  ImageStorageMountCatalog,
  MountedImageReferenceStore,
  MountedResponsesImageStateStore,
} from '../ImageStorageMountCatalog';

const sandboxes: string[] = [];

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'omnicross-image-reconcile-'));
  sandboxes.push(root);
  return root;
}

afterEach(() => {
  const systemTemporary = resolve(tmpdir());
  for (const root of sandboxes.splice(0)) {
    const absolute = resolve(root);
    const rel = relative(systemTemporary, absolute);
    if (!isAbsolute(absolute) || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('refusing to clean an unverified image-reconcile sandbox');
    }
    rmSync(absolute, { recursive: true, force: true });
  }
});

function referenceLimits(): FileImageReferenceStoreLimits {
  return {
    ttlMs: 20_000,
    maxArtifactBytes: 32,
    maxTotalBytes: 256,
    maxTenantBytes: 256,
    maxEntries: 32,
    maxTombstones: 16,
    tombstoneTtlMs: 1_000,
  };
}

function stateLimits(): FileResponsesImageStateStoreLimits {
  return {
    maxCalls: 32,
    maxResponses: 32,
    maxTombstones: 16,
    tombstoneTtlMs: 1_000,
  };
}

function setup(root: string, now: () => number) {
  const applicationData = join(root, 'private-data');
  const workspace = join(root, 'workspace');
  const home = join(root, 'home');
  const systemTemporary = join(root, 'system-temporary');
  const durable = join(root, 'durable');
  for (const path of [applicationData, workspace, home, systemTemporary]) {
    mkdirSync(path, { recursive: true });
  }
  const catalog = new ImageStorageMountCatalog({
    pathOptions: {
      configPath: join(applicationData, 'config.json'),
      processDirectory: workspace,
      userHome: home,
      temporaryDirectory: systemTemporary,
    },
    activeStorageRoot: durable,
    referenceLimits: referenceLimits(),
    responsesStateLimits: stateLimits(),
    now,
  });
  return {
    catalog,
    references: new MountedImageReferenceStore(catalog),
    state: new MountedResponsesImageStateStore(catalog),
    resolver: catalog.active().resolver,
    catalogOptions: {
      pathOptions: {
        configPath: join(applicationData, 'config.json'),
        processDirectory: workspace,
        userHome: home,
        temporaryDirectory: systemTemporary,
      },
      activeStorageRoot: durable,
      referenceLimits: referenceLimits(),
      responsesStateLimits: stateLimits(),
      now,
    },
  };
}

async function save(
  store: MountedImageReferenceStore,
  value: string,
) {
  const artifact = new InMemoryImageAsset(Buffer.from(value), {
    mimeType: 'image/png',
    width: 1,
    height: 1,
  });
  return store.save({
    tenantId: 'tenant-a',
    ttlMs: 20_000,
    artifact,
    metadata: {
      mimeType: artifact.mimeType,
      byteLength: artifact.byteLength,
      width: artifact.width,
      height: artifact.height,
    },
  });
}

function binding(
  suffix: string,
  referenceId: ImageReferenceId,
  expiresAt: number,
): ResponsesImageCallBinding {
  return Object.freeze({
    callId: `ig_${suffix.padEnd(16, suffix)}` as ResponsesImageCallId,
    referenceId,
    expiresAt,
  });
}

describe('ImageStartupReconciler', () => {
  it('never removes an active owned scope even after its directory mtime is stale', async () => {
    const root = sandbox();
    const environment = setup(root, () => 100_000);
    const activeScopes = new DaemonImageActiveScopeRegistry(environment.resolver);
    const factory = new DaemonImageTemporaryResourceFactory({
      paths: environment.resolver,
      config: DEFAULT_IMAGES_SERVER_CONFIG.temporary,
      activeScopes,
    });
    const scope = await factory.createResourceScope(
      DEFAULT_IMAGES_SERVER_CONFIG.limits,
      new AbortController().signal,
      'tenant-a',
    );
    const directoryName = readdirSync(environment.resolver.paths.temporaryRoot)
      .find((name) => name.startsWith('omnicross-images-'));
    expect(directoryName).toBeTruthy();
    const directory = join(environment.resolver.paths.temporaryRoot, directoryName!);
    utimesSync(directory, new Date(0), new Date(0));

    const reconciler = new ImageStartupReconciler({
      catalog: environment.catalog,
      temporaryPaths: environment.resolver,
      staleTemporaryAfterMs: 1_000,
      activeTemporaryScopes: activeScopes,
      now: () => 100_000,
    });
    await expect(reconciler.run()).resolves.toMatchObject({
      temporaryDirectoriesRemoved: 0,
      activeTemporaryDirectoriesSkipped: 1,
    });
    expect(existsSync(directory)).toBe(true);
    expect(activeScopes.status()).toEqual({ activeDirectories: 1 });
    await scope.cleanup();
    expect(activeScopes.status()).toEqual({ activeDirectories: 0 });
    expect(existsSync(directory)).toBe(false);
  });

  it('removes bounded owned debris and broken links while leaving foreign temporary directories untouched', async () => {
    let now = 100_000;
    const root = sandbox();
    const environment = setup(root, () => now);
    const valid = await save(environment.references, 'valid');
    const missing = await save(environment.references, 'missing');
    const brokenBinding = binding(
      'b',
      `imgref_${'b'.repeat(32)}` as ImageReferenceId,
      now + 10_000,
    );
    await environment.state.commit({
      tenantId: 'tenant-a',
      responseId: 'resp_reconcile',
      bindings: [brokenBinding],
      responseExpiresAt: now + 10_000,
    });

    const referenceManifestPath = join(environment.resolver.paths.stateRoot, 'references.v1.json');
    const referenceManifest = JSON.parse(readFileSync(referenceManifestPath, 'utf8')) as {
      entries: Array<{ referenceId: string; artifactFile?: string }>;
    };
    const missingArtifact = referenceManifest.entries.find((entry) =>
      entry.referenceId === missing.referenceId)?.artifactFile;
    expect(missingArtifact).toBeTruthy();
    unlinkSync(join(environment.resolver.paths.artifactsRoot, missingArtifact!));
    const orphan = join(environment.resolver.paths.artifactsRoot, `artifact-${'c'.repeat(32)}.bin`);
    const incomplete = join(environment.resolver.paths.artifactsRoot, `artifact-${'d'.repeat(32)}.tmp`);
    writeFileSync(orphan, 'orphan');
    writeFileSync(incomplete, 'partial');
    const foreignTarget = join(root, 'foreign-artifact-target');
    mkdirSync(foreignTarget);
    writeFileSync(join(foreignTarget, 'sentinel.txt'), 'foreign');
    const invalidDescendant = join(
      environment.resolver.paths.artifactsRoot,
      `artifact-${'9'.repeat(32)}.bin`,
    );
    symlinkSync(foreignTarget, invalidDescendant, process.platform === 'win32' ? 'junction' : 'dir');
    const stateTransaction = join(
      environment.resolver.paths.stateRoot,
      `.references.123.${'e'.repeat(16)}.tmp`,
    );
    const catalogTransaction = join(
      environment.resolver.paths.mountManifestRoot,
      `.catalog.123.${'f'.repeat(16)}.tmp`,
    );
    writeFileSync(stateTransaction, 'partial');
    writeFileSync(catalogTransaction, 'partial');

    const ownedTemporary = join(environment.resolver.paths.temporaryRoot, 'omnicross-images-ABC123');
    mkdirSync(ownedTemporary);
    writeFileSync(
      join(ownedTemporary, IMAGE_REQUEST_DIRECTORY_MARKER_NAME),
      IMAGE_REQUEST_DIRECTORY_MARKER_CONTENT,
    );
    writeFileSync(join(ownedTemporary, 'input.bin'), 'temporary');
    utimesSync(ownedTemporary, new Date(0), new Date(0));
    const foreignTemporary = join(environment.resolver.paths.temporaryRoot, 'omnicross-images-FOREIGN');
    mkdirSync(foreignTemporary);
    writeFileSync(join(foreignTemporary, IMAGE_REQUEST_DIRECTORY_MARKER_NAME), 'foreign');
    utimesSync(foreignTemporary, new Date(0), new Date(0));

    const reconciler = new ImageStartupReconciler({
      catalog: environment.catalog,
      temporaryPaths: environment.resolver,
      staleTemporaryAfterMs: 1_000,
      maxEntriesPerMount: 100,
      now: () => now,
    });
    const result = await reconciler.run();
    expect(result).toMatchObject({
      mountsVisited: 1,
      brokenBindingsRemoved: 1,
      metadataRemoved: 1,
      orphanFilesRemoved: 1,
      incompleteFilesRemoved: 1,
      transactionFilesRemoved: 2,
      temporaryDirectoriesRemoved: 1,
      foreignTemporaryDirectoriesSkipped: 1,
      pendingReferenceDeletes: 0,
    });
    expect(result.invalidDescendantsSkipped).toBeGreaterThanOrEqual(1);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(incomplete)).toBe(false);
    expect(existsSync(stateTransaction)).toBe(false);
    expect(existsSync(catalogTransaction)).toBe(false);
    expect(existsSync(ownedTemporary)).toBe(false);
    expect(existsSync(foreignTemporary)).toBe(true);
    expect(existsSync(invalidDescendant)).toBe(true);
    expect(readFileSync(join(foreignTarget, 'sentinel.txt'), 'utf8')).toBe('foreign');
    expect(await environment.references.resolve('tenant-a', missing.referenceId))
      .toEqual({ status: 'not_found' });
    expect(await environment.state.resolveCall('tenant-a', brokenBinding.callId))
      .toEqual({ status: 'not_found' });
    const validResult = await environment.references.resolve('tenant-a', valid.referenceId);
    expect(validResult.status).toBe('found');
    if (validResult.status === 'found') await validResult.lease.release();
  });

  it('repairs invalid bounded manifest rows while preserving unrelated valid state on restart', async () => {
    const root = sandbox();
    const environment = setup(root, () => 100);
    const first = await save(environment.references, 'first');
    const second = await save(environment.references, 'second');
    const firstBinding = binding('c', first.referenceId, 1_000);
    await environment.state.commit({
      tenantId: 'tenant-a',
      responseId: 'resp_valid_recovery',
      bindings: [firstBinding],
      responseExpiresAt: 1_000,
    });

    const referencePath = join(environment.resolver.paths.stateRoot, 'references.v1.json');
    const references = JSON.parse(readFileSync(referencePath, 'utf8')) as {
      entries: unknown[];
    };
    references.entries.push({ referenceId: 'invalid-row-sentinel' });
    references.entries.push(references.entries[0]);
    writeFileSync(referencePath, JSON.stringify(references, null, 2) + '\n');

    const statePath = join(environment.resolver.paths.stateRoot, 'responses-image-state.v1.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      calls: unknown[];
      responses: unknown[];
    };
    state.calls.push({ callId: 'invalid-call-sentinel' });
    state.responses.push({ responseId: 'invalid-response-sentinel' });
    writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');

    const restartedCatalog = new ImageStorageMountCatalog(environment.catalogOptions);
    const restartedReferences = new MountedImageReferenceStore(restartedCatalog);
    const restartedState = new MountedResponsesImageStateStore(restartedCatalog);
    for (const reference of [first, second]) {
      const found = await restartedReferences.resolve('tenant-a', reference.referenceId);
      expect(found.status).toBe('found');
      if (found.status === 'found') await found.lease.release();
    }
    const response = await restartedState.resolveResponse('tenant-a', 'resp_valid_recovery');
    expect(response.status).toBe('found');
    if (response.status === 'found') await response.lease.release();
    expect(readFileSync(referencePath, 'utf8')).not.toContain('invalid-row-sentinel');
    expect(readFileSync(statePath, 'utf8')).not.toContain('invalid-call-sentinel');
    expect(readFileSync(statePath, 'utf8')).not.toContain('invalid-response-sentinel');
  });

  it('honors per-pass bounds for orphan reconciliation', async () => {
    const root = sandbox();
    const environment = setup(root, () => 10_000);
    for (const suffix of ['1', '2']) {
      writeFileSync(
        join(environment.resolver.paths.artifactsRoot, `artifact-${suffix.repeat(32)}.bin`),
        'orphan',
      );
    }
    const reconciler = new ImageStartupReconciler({
      catalog: environment.catalog,
      temporaryPaths: environment.resolver,
      staleTemporaryAfterMs: 1_000,
      maxEntriesPerMount: 1,
      now: () => 10_000,
    });
    const first = await reconciler.run();
    expect(first.orphanFilesRemoved).toBe(1);
    expect(readdirSync(environment.resolver.paths.artifactsRoot)).toHaveLength(1);
    const second = await reconciler.run();
    expect(second.orphanFilesRemoved).toBe(1);
    expect(readdirSync(environment.resolver.paths.artifactsRoot)).toEqual([]);
  });

  it('quarantines an unknown catalog schema and preserves valid stores at the configured root', async () => {
    const root = sandbox();
    const environment = setup(root, () => 100);
    const retained = await save(environment.references, 'retained');
    const catalogPath = environment.resolver.paths.mountManifestPath;
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as { version: number };
    catalog.version = 999;
    writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n');

    const recovered = new ImageStorageMountCatalog({
      ...environment.catalogOptions,
      reconcileCorruptManifests: true,
    });
    expect(recovered.startupReconciliationStatus()).toEqual({
      corruptManifestsQuarantined: 1,
    });
    expect(readdirSync(environment.resolver.paths.mountManifestRoot).some((name) =>
      /^\.corrupt-catalog-[a-f0-9]{16}\.json$/u.test(name))).toBe(true);
    const found = await new MountedImageReferenceStore(recovered)
      .resolve('tenant-a', retained.referenceId);
    expect(found.status).toBe('found');
    if (found.status === 'found') await found.lease.release();
  });
});
