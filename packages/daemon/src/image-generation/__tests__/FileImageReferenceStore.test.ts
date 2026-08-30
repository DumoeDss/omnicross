import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  ImageArtifactId,
  SensitiveOpaqueImageReference,
} from '@omnicross/contracts/image-generation-types';
import {
  InMemoryImageAsset,
  type ImageAsset,
  readImageAssetBytes,
} from '@omnicross/core/image-generation';

import { SecretBox } from '../../secrets';
import {
  FileImageReferenceStore,
  type FileImageReferenceStoreLimits,
} from '../FileImageReferenceStore';
import { createDaemonImagePathResolver, type DaemonImagePathResolver } from '../imagePathResolver';

const sandboxes: string[] = [];

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'omnicross-reference-store-'));
  sandboxes.push(root);
  return root;
}

afterEach(() => {
  const systemTemporary = resolve(tmpdir());
  for (const root of sandboxes.splice(0)) {
    const absolute = resolve(root);
    const rel = relative(systemTemporary, absolute);
    if (!isAbsolute(absolute) || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('refusing to clean an unverified reference-store sandbox');
    }
    rmSync(absolute, { recursive: true, force: true });
  }
});

function paths(root: string): DaemonImagePathResolver {
  const applicationData = join(root, 'private-data');
  const workspace = join(root, 'workspace');
  const home = join(root, 'home');
  const systemTemporary = join(root, 'system-temporary');
  for (const path of [applicationData, workspace, home, systemTemporary]) {
    mkdirSync(path, { recursive: true });
  }
  return createDaemonImagePathResolver({
    configPath: join(applicationData, 'config.json'),
    processDirectory: workspace,
    userHome: home,
    temporaryDirectory: systemTemporary,
  });
}

function limits(overrides: Partial<FileImageReferenceStoreLimits> = {}): FileImageReferenceStoreLimits {
  return {
    ttlMs: 10_000,
    maxArtifactBytes: 16,
    maxTotalBytes: 64,
    maxTenantBytes: 32,
    maxEntries: 16,
    maxTombstones: 16,
    tombstoneTtlMs: 1_000,
    ...overrides,
  };
}

function asset(value: string): InMemoryImageAsset {
  return new InMemoryImageAsset(Buffer.from(value), {
    mimeType: 'image/png',
    width: 1,
    height: 1,
  });
}

async function save(
  store: FileImageReferenceStore,
  tenantId: string,
  value: string,
  ttlMs = 10_000,
  providerReference?: string,
) {
  const artifact = asset(value);
  return store.save({
    tenantId,
    ttlMs,
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

describe('FileImageReferenceStore', () => {
  it('persists streamed artifacts, tenant HMACs, and encrypted provider references across restart', async () => {
    const resolver = paths(sandbox());
    const box = new SecretBox(Buffer.alloc(32, 7));
    const first = new FileImageReferenceStore({ paths: resolver, limits: limits(), secretBox: box });
    const reference = await save(first, 'raw-tenant-sentinel', 'image-bytes', 10_000, 'opaque-provider-sentinel');

    const manifest = readFileSync(join(resolver.paths.stateRoot, 'references.v1.json'), 'utf8');
    expect(manifest).not.toContain('raw-tenant-sentinel');
    expect(manifest).not.toContain('opaque-provider-sentinel');
    expect(manifest).toContain('enc:v1:');
    expect(statSync(join(resolver.paths.mountManifestRoot, 'tenant-hmac-salt.v1.bin')).size).toBe(32);
    const [artifactName] = readdirSync(resolver.paths.artifactsRoot);
    expect(artifactName).toMatch(/^artifact-[a-f0-9]{32}\.bin$/u);
    if (process.platform !== 'win32') expect(statSync(join(resolver.paths.artifactsRoot, artifactName!)).mode & 0o077).toBe(0);

    expect(await first.resolve('other-tenant', reference.referenceId)).toEqual({ status: 'not_found' });
    const found = await first.resolve('raw-tenant-sentinel', reference.referenceId);
    expect(found.status).toBe('found');
    if (found.status === 'found') {
      expect(Buffer.from(await readImageAssetBytes(found.lease.value.artifact!, 32)).toString()).toBe('image-bytes');
      expect(found.lease.value.providerReference).toBe('opaque-provider-sentinel');
      await found.lease.release();
      await found.lease.release();
    }

    const restarted = new FileImageReferenceStore({ paths: resolver, limits: limits(), secretBox: box });
    const restored = await restarted.resolve('raw-tenant-sentinel', reference.referenceId);
    expect(restored.status).toBe('found');
    if (restored.status === 'found') {
      expect(Buffer.from(await readImageAssetBytes(restored.lease.value.artifact!, 32)).toString()).toBe('image-bytes');
      await restored.lease.release();
    }
  });

  it('never persists an opaque provider reference without secret-box protection', async () => {
    const resolver = paths(sandbox());
    const store = new FileImageReferenceStore({ paths: resolver, limits: limits() });
    const reference = await save(store, 'tenant-a', 'bytes', 10_000, 'opaque-provider-sentinel');
    const manifest = readFileSync(join(resolver.paths.stateRoot, 'references.v1.json'), 'utf8');
    expect(manifest).not.toContain('opaque-provider-sentinel');
    const found = await store.resolve('tenant-a', reference.referenceId);
    expect(found.status).toBe('found');
    if (found.status === 'found') {
      expect(found.lease.value.providerReference).toBeUndefined();
      await found.lease.release();
    }
    await expect(store.save({
      tenantId: 'tenant-a',
      ttlMs: 100,
      providerReference: 'provider-only' as SensitiveOpaqueImageReference,
      metadata: { mimeType: 'image/png', byteLength: 1, width: 1, height: 1 },
    })).rejects.toThrow(/secret-box protection/);
  });

  it('enforces tenant/total quotas, pins leases, and makes capacity eviction not-found', async () => {
    let now = 1_000;
    const resolver = paths(sandbox());
    const store = new FileImageReferenceStore({
      paths: resolver,
      limits: limits({ maxArtifactBytes: 4, maxTenantBytes: 4, maxTotalBytes: 8, maxEntries: 3 }),
      now: () => now,
    });
    const pinned = await save(store, 'tenant-a', 'aaaa');
    const pin = await store.resolve('tenant-a', pinned.referenceId);
    expect(pin.status).toBe('found');
    now += 1;
    await expect(save(store, 'tenant-a', 'bbbb')).rejects.toMatchObject({ code: 'image_too_large' });

    const evictable = await save(store, 'tenant-b', 'bbbb');
    now += 1;
    const newest = await save(store, 'tenant-c', 'cccc');
    expect(await store.resolve('tenant-b', evictable.referenceId)).toEqual({ status: 'not_found' });
    expect((await store.resolve('tenant-c', newest.referenceId)).status).toBe('found');
    expect((await store.resolve('tenant-a', pinned.referenceId)).status).toBe('found');
    if (pin.status === 'found') await pin.lease.release();
  });

  it('preserves owner-only expiry with bounded tombstones', async () => {
    let now = 10_000;
    const resolver = paths(sandbox());
    const store = new FileImageReferenceStore({
      paths: resolver,
      limits: limits({ maxTombstones: 1, tombstoneTtlMs: 20 }),
      now: () => now,
    });
    const first = await save(store, 'tenant-a', 'one', 10);
    now += 1;
    const second = await save(store, 'tenant-a', 'two', 10);
    now += 11;
    expect(await store.cleanup()).toBe(2);
    expect(store.status().tombstones).toBe(1);
    const ownerStatuses = await Promise.all([
      store.resolve('tenant-a', first.referenceId),
      store.resolve('tenant-a', second.referenceId),
    ]);
    expect(ownerStatuses.map((result) => result.status).sort()).toEqual(['expired', 'not_found']);
    expect(await store.resolve('tenant-b', first.referenceId)).toEqual({ status: 'not_found' });
    expect(await store.resolve('tenant-b', second.referenceId)).toEqual({ status: 'not_found' });

    now += 21;
    await store.cleanup();
    expect(store.status().tombstones).toBe(0);
    expect(await store.resolve('tenant-a', first.referenceId)).toEqual({ status: 'not_found' });
    expect(await store.resolve('tenant-a', second.referenceId)).toEqual({ status: 'not_found' });
  });

  it('makes delete idempotent while an active lease pins artifact bytes', async () => {
    const resolver = paths(sandbox());
    const store = new FileImageReferenceStore({ paths: resolver, limits: limits() });
    const reference = await save(store, 'tenant-a', 'leased');
    const found = await store.resolve('tenant-a', reference.referenceId);
    expect(found.status).toBe('found');
    expect(await store.delete('tenant-a', reference.referenceId)).toBe(true);
    expect(await store.delete('tenant-a', reference.referenceId)).toBe(false);
    expect(await store.resolve('tenant-a', reference.referenceId)).toEqual({ status: 'not_found' });
    expect(store.status()).toMatchObject({ entries: 1, bytes: 6 });
    if (found.status === 'found') {
      expect(Buffer.from(await readImageAssetBytes(found.lease.value.artifact!, 16)).toString()).toBe('leased');
      await found.lease.release();
    }
    expect(store.status()).toMatchObject({ entries: 0, bytes: 0 });
    expect(readdirSync(resolver.paths.artifactsRoot)).toEqual([]);
  });

  it('serializes concurrent writers and retains only entries admitted by the count quota', async () => {
    let now = 1_000;
    const resolver = paths(sandbox());
    const store = new FileImageReferenceStore({
      paths: resolver,
      limits: limits({ maxEntries: 2 }),
      now: () => now++,
    });
    const references = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((value) => save(store, 'tenant-a', value)),
    );
    const statuses = await Promise.all(references.map((reference) =>
      store.resolve('tenant-a', reference.referenceId)));
    expect(statuses.map((result) => result.status)).toEqual([
      'not_found', 'not_found', 'not_found', 'found', 'found',
    ]);
    expect(store.status()).toMatchObject({ entries: 2, bytes: 2 });
    expect(readdirSync(resolver.paths.artifactsRoot)).toHaveLength(2);
  });

  it('removes temporary artifacts when opening or streaming the source fails', async () => {
    const resolver = paths(sandbox());
    const store = new FileImageReferenceStore({ paths: resolver, limits: limits() });
    const metadata = { mimeType: 'image/png' as const, byteLength: 1, width: 1, height: 1 };
    const failures: ImageAsset[] = [
      {
        artifactId: 'failure-open' as ImageArtifactId,
        ...metadata,
        independentlyDecodable: true,
        open: async () => { throw new Error('injected open failure'); },
      },
      {
        artifactId: 'failure-stream' as ImageArtifactId,
        ...metadata,
        independentlyDecodable: true,
        open: async () => new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Uint8Array.of(1));
            controller.error(new Error('injected stream failure'));
          },
        }),
      },
    ];

    for (const artifact of failures) {
      await expect(store.save({ tenantId: 'tenant-a', ttlMs: 100, artifact, metadata }))
        .rejects.toThrow(/injected/);
      expect(readdirSync(resolver.paths.artifactsRoot)).toEqual([]);
    }
    expect(store.status()).toMatchObject({ entries: 0, bytes: 0 });
  });

  it('keeps the prior manifest and removes the unpublished artifact on transaction failure', async () => {
    const resolver = paths(sandbox());
    const healthy = new FileImageReferenceStore({ paths: resolver, limits: limits() });
    const prior = await save(healthy, 'tenant-a', 'prior', 10_000);
    const priorManifest = readFileSync(join(resolver.paths.stateRoot, 'references.v1.json'));

    const failing = new FileImageReferenceStore({
      paths: resolver,
      limits: limits(),
      replaceManifest: () => {
        throw new Error('injected manifest replacement failure');
      },
    });
    await expect(save(failing, 'tenant-a', 'new')).rejects.toThrow(/injected manifest replacement failure/);
    expect(readFileSync(join(resolver.paths.stateRoot, 'references.v1.json')).equals(priorManifest)).toBe(true);
    expect(readdirSync(resolver.paths.artifactsRoot)).toHaveLength(1);
    expect((await healthy.resolve('tenant-a', prior.referenceId)).status).toBe('found');
  });
});
