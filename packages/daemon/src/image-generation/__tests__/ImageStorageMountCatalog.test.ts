import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  InMemoryImageAsset,
  readImageAssetBytes,
} from '@omnicross/core/image-generation';
import type {
  ResponsesImageCallBinding,
  ResponsesImageCallId,
} from '@omnicross/core/image-generation/responses';

import type { FileImageReferenceStoreLimits } from '../FileImageReferenceStore';
import type { FileResponsesImageStateStoreLimits } from '../FileResponsesImageStateStore';
import {
  ImageStorageMountCatalog,
  MountedImageReferenceStore,
  MountedResponsesImageStateStore,
  type ImageStorageMountCatalogOptions,
  type ImageStorageMountPolicy,
} from '../ImageStorageMountCatalog';

const sandboxes: string[] = [];

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'omnicross-image-mounts-'));
  sandboxes.push(root);
  return root;
}

afterEach(() => {
  const systemTemporary = resolve(tmpdir());
  for (const root of sandboxes.splice(0)) {
    const absolute = resolve(root);
    const rel = relative(systemTemporary, absolute);
    if (!isAbsolute(absolute) || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('refusing to clean an unverified image-mount sandbox');
    }
    rmSync(absolute, { recursive: true, force: true });
  }
});

function referenceLimits(): FileImageReferenceStoreLimits {
  return {
    ttlMs: 10_000,
    maxArtifactBytes: 32,
    maxTotalBytes: 128,
    maxTenantBytes: 128,
    maxEntries: 32,
    maxTombstones: 16,
    tombstoneTtlMs: 10,
  };
}

function stateLimits(): FileResponsesImageStateStoreLimits {
  return {
    maxCalls: 32,
    maxResponses: 32,
    maxTombstones: 16,
    tombstoneTtlMs: 10,
  };
}

function policy(overrides: {
  maxArtifactBytes?: number;
  maxCalls?: number;
} = {}): ImageStorageMountPolicy {
  return {
    referenceLimits: {
      ...referenceLimits(),
      ...(overrides.maxArtifactBytes
        ? { maxArtifactBytes: overrides.maxArtifactBytes }
        : {}),
    },
    responsesStateLimits: {
      ...stateLimits(),
      ...(overrides.maxCalls ? { maxCalls: overrides.maxCalls } : {}),
    },
  };
}

function options(
  root: string,
  activeStorageRoot: string,
  overrides: Partial<ImageStorageMountCatalogOptions> = {},
): ImageStorageMountCatalogOptions {
  const applicationData = join(root, 'private-data');
  const workspace = join(root, 'workspace');
  const home = join(root, 'home');
  const systemTemporary = join(root, 'system-temporary');
  for (const path of [applicationData, workspace, home, systemTemporary]) {
    mkdirSync(path, { recursive: true });
  }
  return {
    pathOptions: {
      configPath: join(applicationData, 'config.json'),
      processDirectory: workspace,
      userHome: home,
      temporaryDirectory: systemTemporary,
    },
    activeStorageRoot,
    referenceLimits: referenceLimits(),
    responsesStateLimits: stateLimits(),
    now: () => 100,
    ...overrides,
  };
}

async function save(
  store: MountedImageReferenceStore,
  tenantId: string,
  value: string,
) {
  const artifact = new InMemoryImageAsset(Buffer.from(value), {
    mimeType: 'image/png',
    width: 1,
    height: 1,
  });
  return store.save({
    tenantId,
    ttlMs: 10_000,
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
  referenceId: ResponsesImageCallBinding['referenceId'],
  expiresAt: number,
): ResponsesImageCallBinding {
  return Object.freeze({
    callId: `ig_${suffix.padEnd(16, suffix)}` as ResponsesImageCallId,
    referenceId,
    expiresAt,
  });
}

describe('ImageStorageMountCatalog', () => {
  it('retains an empty retired backend until its runtime generation lease drains', async () => {
    const root = sandbox();
    const catalog = new ImageStorageMountCatalog(options(root, join(root, 'durable-first')));
    const references = new MountedImageReferenceStore(catalog);
    const retiredBackend = catalog.active();
    const oldGenerationStore = references.bindWriteBackend(retiredBackend, referenceLimits());
    const releaseGeneration = catalog.retainBackend(retiredBackend);
    catalog.prepareActivation(join(root, 'durable-second'), policy()).publish();

    expect(catalog.retireEmptyMount(retiredBackend.id)).toBe(false);
    const lateReference = await save(oldGenerationStore, 'tenant-a', 'late');
    const found = await references.resolve('tenant-a', lateReference.referenceId);
    expect(found).toMatchObject({ status: 'found' });
    if (found.status === 'found') await found.lease.release();
    releaseGeneration();
    expect(await references.delete('tenant-a', lateReference.referenceId)).toBe(true);
    expect(catalog.retireEmptyMount(retiredBackend.id)).toBe(true);
  });

  it('pins old HTTP/reference and hosted/state writes through publication and rollback', async () => {
    const root = sandbox();
    const firstRoot = join(root, 'durable-first');
    const secondRoot = join(root, 'durable-second');
    const catalog = new ImageStorageMountCatalog(options(root, firstRoot));
    const references = new MountedImageReferenceStore(catalog);
    const state = new MountedResponsesImageStateStore(catalog);
    const oldReferences = references.bindWriteBackend(catalog.active(), referenceLimits());
    const oldState = state.bindWriteBackend(catalog.active(), stateLimits());

    const activation = catalog.prepareActivation(secondRoot, policy());
    const replacementReferences = references.bindWriteBackend(
      activation.backend,
      policy().referenceLimits,
    );
    const replacementState = state.bindWriteBackend(
      activation.backend,
      policy().responsesStateLimits,
    );
    activation.publish();

    const oldReference = await save(oldReferences, 'tenant-a', 'old-http');
    const replacementReference = await save(replacementReferences, 'tenant-a', 'new-http');
    await oldState.commit({
      tenantId: 'tenant-a',
      responseId: 'resp_old_hosted',
      bindings: [binding('o', oldReference.referenceId, oldReference.expiresAt)],
      responseExpiresAt: 1_000,
    });
    await replacementState.commit({
      tenantId: 'tenant-a',
      responseId: 'resp_new_hosted',
      bindings: [binding('n', replacementReference.referenceId, replacementReference.expiresAt)],
      responseExpiresAt: 1_000,
    });
    expect(readdirSync(join(firstRoot, 'artifacts'))).toHaveLength(1);
    expect(readdirSync(join(secondRoot, 'artifacts'))).toHaveLength(1);

    activation.rollback();
    const publishedWindowReference = await save(
      replacementReferences,
      'tenant-a',
      'window',
    );
    const restoredReference = await save(references, 'tenant-a', 'restored');
    expect(readdirSync(join(firstRoot, 'artifacts'))).toHaveLength(2);
    expect(readdirSync(join(secondRoot, 'artifacts'))).toHaveLength(2);
    for (const reference of [oldReference, replacementReference, publishedWindowReference, restoredReference]) {
      const resolved = await references.resolve('tenant-a', reference.referenceId);
      expect(resolved.status).toBe('found');
      if (resolved.status === 'found') await resolved.lease.release();
    }
    for (const responseId of ['resp_old_hosted', 'resp_new_hosted']) {
      const resolved = await state.resolveResponse('tenant-a', responseId);
      expect(resolved.status).toBe('found');
      if (resolved.status === 'found') await resolved.lease.release();
    }
  });

  it('hot-reloads same-root reference and state policy without changing old generation enforcement', async () => {
    const root = sandbox();
    const durableRoot = join(root, 'durable');
    const catalog = new ImageStorageMountCatalog(options(root, durableRoot, {
      referenceLimits: policy({ maxArtifactBytes: 4 }).referenceLimits,
      responsesStateLimits: policy({ maxCalls: 1 }).responsesStateLimits,
    }));
    const references = new MountedImageReferenceStore(catalog);
    const state = new MountedResponsesImageStateStore(catalog);
    const oldReferences = references.bindWriteBackend(
      catalog.active(),
      policy({ maxArtifactBytes: 4 }).referenceLimits,
    );
    const oldState = state.bindWriteBackend(
      catalog.active(),
      policy({ maxCalls: 1 }).responsesStateLimits,
    );
    const nextPolicy = policy({ maxArtifactBytes: 16, maxCalls: 2 });
    const activation = catalog.prepareActivation(durableRoot, nextPolicy);
    const nextReferences = references.bindWriteBackend(
      activation.backend,
      nextPolicy.referenceLimits,
    );
    const nextState = state.bindWriteBackend(
      activation.backend,
      nextPolicy.responsesStateLimits,
    );
    activation.publish();

    await expect(save(oldReferences, 'tenant-a', '12345678'))
      .rejects.toMatchObject({ code: 'image_too_large' });
    const first = await save(nextReferences, 'tenant-a', '12345678');
    const second = await save(nextReferences, 'tenant-a', 'abcdefgh');
    const twoBindings = [
      binding('x', first.referenceId, first.expiresAt),
      binding('y', second.referenceId, second.expiresAt),
    ];
    await expect(oldState.commit({
      tenantId: 'tenant-a',
      responseId: 'resp_old_policy',
      bindings: twoBindings,
      responseExpiresAt: 1_000,
    })).rejects.toMatchObject({ code: 'image_generation_failed' });
    await expect(nextState.commit({
      tenantId: 'tenant-a',
      responseId: 'resp_new_policy',
      bindings: twoBindings,
      responseExpiresAt: 1_000,
    })).resolves.toEqual([]);
    expect(catalog.status()).toEqual({ mounts: 1, retiredMounts: 0 });
  });

  it('routes new writes to the active mount and resolves retired IDs after hot reload and restart', async () => {
    const root = sandbox();
    const firstRoot = join(root, 'durable-first');
    const secondRoot = join(root, 'durable-second');
    const catalog = new ImageStorageMountCatalog(options(root, firstRoot));
    const references = new MountedImageReferenceStore(catalog);
    const state = new MountedResponsesImageStateStore(catalog);
    const firstReference = await save(references, 'tenant-a', 'first');
    const firstBinding = binding('a', firstReference.referenceId, firstReference.expiresAt);
    await state.commit({
      tenantId: 'tenant-a',
      responseId: 'resp_first_mount',
      bindings: [firstBinding],
      responseExpiresAt: 1_000,
    });
    const firstMountId = catalog.active().id;

    catalog.activate(secondRoot);
    expect(catalog.active().id).not.toBe(firstMountId);
    const secondReference = await save(references, 'tenant-a', 'second');
    const secondBinding = binding('b', secondReference.referenceId, secondReference.expiresAt);
    await state.commit({
      tenantId: 'tenant-a',
      responseId: 'resp_second_mount',
      bindings: [secondBinding],
      responseExpiresAt: 1_000,
    });
    expect(readdirSync(join(firstRoot, 'artifacts'))).toHaveLength(1);
    expect(readdirSync(join(secondRoot, 'artifacts'))).toHaveLength(1);

    const oldReference = await references.resolve('tenant-a', firstReference.referenceId);
    expect(oldReference.status).toBe('found');
    if (oldReference.status === 'found') {
      expect(Buffer.from(await readImageAssetBytes(oldReference.lease.value.artifact!, 32)).toString())
        .toBe('first');
      await oldReference.lease.release();
    }
    const oldResponse = await state.resolveResponse('tenant-a', 'resp_first_mount');
    expect(oldResponse.status).toBe('found');
    if (oldResponse.status === 'found') {
      expect(oldResponse.lease.callIds).toEqual([firstBinding.callId]);
      await oldResponse.lease.release();
    }

    const restarted = new ImageStorageMountCatalog(options(root, secondRoot));
    expect(restarted.status()).toEqual({ mounts: 2, retiredMounts: 1 });
    const restartedReferences = new MountedImageReferenceStore(restarted);
    const restartedState = new MountedResponsesImageStateStore(restarted);
    for (const reference of [firstReference, secondReference]) {
      const found = await restartedReferences.resolve('tenant-a', reference.referenceId);
      expect(found.status).toBe('found');
      if (found.status === 'found') await found.lease.release();
    }
    for (const responseId of ['resp_first_mount', 'resp_second_mount']) {
      const found = await restartedState.resolveResponse('tenant-a', responseId);
      expect(found.status).toBe('found');
      if (found.status === 'found') await found.lease.release();
    }
  });

  it('leaves the prior active snapshot authoritative when catalog replacement fails', async () => {
    const root = sandbox();
    const firstRoot = join(root, 'durable-first');
    const secondRoot = join(root, 'durable-second');
    let fail = false;
    const catalog = new ImageStorageMountCatalog(options(root, firstRoot, {
      replaceCatalog(target, contents) {
        if (fail) throw new Error('injected catalog replacement failure');
        writeFileSync(target, contents);
      },
    }));
    const priorId = catalog.active().id;
    const manifestPath = join(root, 'private-data', 'images', 'mount-catalog', 'catalog.v1.json');
    const priorManifest = readFileSync(manifestPath);
    fail = true;
    expect(() => catalog.activate(secondRoot)).toThrow(/injected catalog replacement failure/);
    expect(catalog.active().id).toBe(priorId);
    expect(catalog.active().resolver.paths.durableRoot).toBe(resolve(firstRoot));
    expect(catalog.status()).toEqual({ mounts: 1, retiredMounts: 0 });
    expect(readFileSync(manifestPath).equals(priorManifest)).toBe(true);
  });

  it('retires only a non-active mount whose stores and artifact root are verified empty', async () => {
    const root = sandbox();
    const firstRoot = join(root, 'durable-first');
    const secondRoot = join(root, 'durable-second');
    const catalog = new ImageStorageMountCatalog(options(root, firstRoot));
    const references = new MountedImageReferenceStore(catalog);
    const state = new MountedResponsesImageStateStore(catalog);
    const retained = await save(references, 'tenant-a', 'retained');
    await state.commit({
      tenantId: 'tenant-a',
      responseId: 'resp_known_empty_mount',
      bindings: [],
      responseExpiresAt: 1_000,
    });
    const retiredId = catalog.active().id;
    catalog.activate(secondRoot);
    expect(catalog.retireEmptyMount(retiredId)).toBe(false);
    expect(catalog.retireEmptyMount(catalog.active().id)).toBe(false);

    expect(await references.delete('tenant-a', retained.referenceId)).toBe(true);
    expect(catalog.retireEmptyMount(retiredId)).toBe(false);
    expect(await state.deleteResponse('tenant-a', 'resp_known_empty_mount')).toBe(true);
    expect(catalog.retireEmptyMount(retiredId)).toBe(true);
    expect(catalog.status()).toEqual({ mounts: 1, retiredMounts: 0 });
    expect(await references.resolve('tenant-a', retained.referenceId)).toEqual({ status: 'not_found' });

    const restarted = new ImageStorageMountCatalog(options(root, secondRoot));
    expect(restarted.status()).toEqual({ mounts: 1, retiredMounts: 0 });
    await expect(new MountedImageReferenceStore(restarted).resolve('tenant-a', retained.referenceId))
      .resolves.toEqual({ status: 'not_found' });
  });
});
