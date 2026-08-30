import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { SensitiveOpaqueImageReference } from '@omnicross/contracts/image-generation-types';
import {
  InMemoryImageAsset,
  readImageAssetBytes,
} from '@omnicross/core/image-generation';
import type { ResponsesImageCallId } from '@omnicross/core/image-generation/responses';

import { SecretBox } from '../../secrets';
import {
  ImageStorageMountCatalog,
  MountedImageReferenceStore,
  MountedResponsesImageStateStore,
  type ImageStorageMountCatalogOptions,
} from '../ImageStorageMountCatalog';

const sandboxes: string[] = [];

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'omnicross-image-persistence-'));
  sandboxes.push(root);
  return root;
}

afterEach(() => {
  const systemTemporary = resolve(tmpdir());
  for (const root of sandboxes.splice(0)) {
    const absolute = resolve(root);
    const rel = relative(systemTemporary, absolute);
    if (!isAbsolute(absolute) || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('refusing to clean an unverified image-persistence sandbox');
    }
    rmSync(absolute, { recursive: true, force: true });
  }
});

function options(root: string, overrides: Partial<ImageStorageMountCatalogOptions> = {}) {
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
    activeStorageRoot: join(root, 'durable'),
    referenceLimits: {
      ttlMs: 10_000,
      maxArtifactBytes: 32,
      maxTotalBytes: 128,
      maxTenantBytes: 128,
      maxEntries: 16,
      maxTombstones: 16,
      tombstoneTtlMs: 10,
    },
    responsesStateLimits: {
      maxCalls: 16,
      maxResponses: 16,
      maxTombstones: 16,
      tombstoneTtlMs: 10,
    },
    now: () => 100,
    ...overrides,
  } satisfies ImageStorageMountCatalogOptions;
}

async function save(
  store: MountedImageReferenceStore,
  tenantId: string,
  value: string,
  providerReference?: string,
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
    ...(providerReference
      ? { providerReference: providerReference as SensitiveOpaqueImageReference }
      : {}),
    metadata: {
      mimeType: artifact.mimeType,
      byteLength: artifact.byteLength,
      width: artifact.width,
      height: artifact.height,
    },
  });
}

describe('image persistence hardening', () => {
  it('quarantines corrupt reference and state manifests without serving their prior rows', async () => {
    const root = sandbox();
    const catalogOptions = options(root);
    const first = new ImageStorageMountCatalog(catalogOptions);
    const references = new MountedImageReferenceStore(first);
    const state = new MountedResponsesImageStateStore(first);
    const reference = await save(references, 'tenant-a', 'valid');
    await state.commit({
      tenantId: 'tenant-a',
      responseId: 'resp_known_empty_corrupt',
      bindings: [],
      responseExpiresAt: 1_000,
    });
    writeFileSync(join(first.active().resolver.paths.stateRoot, 'references.v1.json'), '{broken');
    writeFileSync(
      join(first.active().resolver.paths.stateRoot, 'responses-image-state.v1.json'),
      '{broken',
    );

    const recovered = new ImageStorageMountCatalog({
      ...catalogOptions,
      reconcileCorruptManifests: true,
    });
    expect(recovered.startupReconciliationStatus()).toEqual({
      corruptManifestsQuarantined: 2,
    });
    const names = readdirSync(recovered.active().resolver.paths.stateRoot);
    expect(names.filter((name) => /^\.corrupt-(?:references|responses-state)-/u.test(name)))
      .toHaveLength(2);
    expect(await new MountedImageReferenceStore(recovered).resolve('tenant-a', reference.referenceId))
      .toEqual({ status: 'not_found' });
    expect(await new MountedResponsesImageStateStore(recovered)
      .resolveResponse('tenant-a', 'resp_known_empty_corrupt'))
      .toEqual({ status: 'not_found' });
  });

  it('rejects a symlink swap after lease acquisition without following or modifying its target', async () => {
    const root = sandbox();
    const catalog = new ImageStorageMountCatalog(options(root));
    const references = new MountedImageReferenceStore(catalog);
    const reference = await save(references, 'tenant-a', 'leased');
    const lease = await references.resolve('tenant-a', reference.referenceId);
    expect(lease.status).toBe('found');
    const [artifactName] = readdirSync(catalog.active().resolver.paths.artifactsRoot);
    const artifactPath = join(catalog.active().resolver.paths.artifactsRoot, artifactName!);
    unlinkSync(artifactPath);
    const foreign = join(root, 'foreign-target');
    mkdirSync(foreign);
    writeFileSync(join(foreign, 'sentinel.txt'), 'foreign');
    symlinkSync(foreign, artifactPath, process.platform === 'win32' ? 'junction' : 'dir');

    if (lease.status === 'found') {
      await expect(readImageAssetBytes(lease.lease.value.artifact!, 32))
        .rejects.toMatchObject({ code: 'image_reference_not_found' });
      await lease.lease.release();
    }
    expect(readFileSync(join(foreign, 'sentinel.txt'), 'utf8')).toBe('foreign');
  });

  it('keeps tenant and provider sentinels out of every persisted JSON document', async () => {
    const root = sandbox();
    const tenantSentinel = 'raw-tenant-secret-sentinel';
    const providerSentinel = 'opaque-provider-secret-sentinel';
    const catalog = new ImageStorageMountCatalog(options(root, {
      secretBox: new SecretBox(Buffer.alloc(32, 9)),
    }));
    const references = new MountedImageReferenceStore(catalog);
    const state = new MountedResponsesImageStateStore(catalog);
    const reference = await save(references, tenantSentinel, 'png', providerSentinel);
    await state.commit({
      tenantId: tenantSentinel,
      responseId: 'resp_secret_scan',
      bindings: [{
        callId: `ig_${'s'.repeat(16)}` as ResponsesImageCallId,
        referenceId: reference.referenceId,
        expiresAt: reference.expiresAt,
      }],
      responseExpiresAt: 1_000,
    });

    const jsonFiles = [
      catalog.active().resolver.paths.mountManifestPath,
      join(catalog.active().resolver.paths.stateRoot, 'references.v1.json'),
      join(catalog.active().resolver.paths.stateRoot, 'responses-image-state.v1.json'),
    ];
    for (const path of jsonFiles) {
      const contents = readFileSync(path, 'utf8');
      expect(contents).not.toContain(tenantSentinel);
      expect(contents).not.toContain(providerSentinel);
    }
  });
});
