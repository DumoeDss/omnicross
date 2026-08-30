import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ImageReferenceId } from '@omnicross/contracts/image-generation-types';
import {
  InMemoryImageAsset,
  readImageAssetBytes,
} from '@omnicross/core/image-generation';
import type {
  ResponsesImageCallBinding,
  ResponsesImageCallId,
} from '@omnicross/core/image-generation/responses';

import {
  FileImageReferenceStore,
  type FileImageReferenceStoreLimits,
} from '../FileImageReferenceStore';
import {
  FileResponsesImageStateStore,
  type FileResponsesImageStateStoreLimits,
} from '../FileResponsesImageStateStore';
import { createDaemonImagePathResolver, type DaemonImagePathResolver } from '../imagePathResolver';
import { ResponsesImageStateCleanupCoordinator } from '../responsesImageStateCleanupCoordinator';

const sandboxes: string[] = [];

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'omnicross-responses-cleanup-'));
  sandboxes.push(root);
  return root;
}

afterEach(() => {
  const systemTemporary = resolve(tmpdir());
  for (const root of sandboxes.splice(0)) {
    const absolute = resolve(root);
    const rel = relative(systemTemporary, absolute);
    if (!isAbsolute(absolute) || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('refusing to clean an unverified responses-cleanup sandbox');
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

function referenceLimits(): FileImageReferenceStoreLimits {
  return {
    ttlMs: 10_000,
    maxArtifactBytes: 16,
    maxTotalBytes: 64,
    maxTenantBytes: 64,
    maxEntries: 16,
    maxTombstones: 16,
    tombstoneTtlMs: 10,
  };
}

function stateLimits(
  overrides: Partial<FileResponsesImageStateStoreLimits> = {},
): FileResponsesImageStateStoreLimits {
  return {
    maxCalls: 16,
    maxResponses: 16,
    maxTombstones: 16,
    tombstoneTtlMs: 10,
    ...overrides,
  };
}

async function saveReference(
  store: FileImageReferenceStore,
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
  referenceId: ImageReferenceId,
  expiresAt: number,
): ResponsesImageCallBinding {
  return Object.freeze({
    callId: `ig_${suffix.padEnd(16, suffix)}` as ResponsesImageCallId,
    referenceId,
    expiresAt,
  });
}

describe('ResponsesImageStateCleanupCoordinator', () => {
  it('keeps capacity eviction non-expired and does not remove an actively leased artifact', async () => {
    let now = 100;
    const resolver = paths(sandbox());
    const references = new FileImageReferenceStore({
      paths: resolver,
      limits: referenceLimits(),
      now: () => now,
    });
    const state = new FileResponsesImageStateStore({
      paths: resolver,
      limits: stateLimits({ maxCalls: 1, maxResponses: 1 }),
      now: () => now,
    });
    const firstReference = await saveReference(references, 'tenant-a', 'one');
    const secondReference = await saveReference(references, 'tenant-a', 'two');
    const first = binding('a', firstReference.referenceId, firstReference.expiresAt);
    const second = binding('b', secondReference.referenceId, secondReference.expiresAt);
    await state.commit({
      tenantId: 'tenant-a',
      responseId: 'resp_first',
      bindings: [first],
      responseExpiresAt: 1_000,
    });
    const artifactLease = await references.resolve('tenant-a', first.referenceId);
    expect(artifactLease.status).toBe('found');

    now += 1;
    await expect(state.commit({
      tenantId: 'tenant-a',
      responseId: 'resp_second',
      bindings: [second],
      responseExpiresAt: 1_000,
    })).resolves.toEqual([first]);
    expect(await state.resolveCall('tenant-a', first.callId)).toEqual({ status: 'not_found' });
    expect(await state.resolveResponse('tenant-a', 'resp_first')).toEqual({ status: 'not_found' });
    expect(state.status().pendingReferenceDeletes).toBe(1);

    const coordinator = new ResponsesImageStateCleanupCoordinator({
      stateStore: state,
      referenceStore: references,
    });
    await expect(coordinator.drainPending()).resolves.toMatchObject({
      referenceDeletesAttempted: 1,
      referenceDeletesAcknowledged: 1,
      referenceDeleteFailures: 0,
      pendingReferenceDeletes: 0,
    });
    expect(await references.resolve('tenant-a', first.referenceId)).toEqual({ status: 'not_found' });
    expect(readdirSync(resolver.paths.artifactsRoot)).toHaveLength(2);
    if (artifactLease.status === 'found') {
      expect(Buffer.from(await readImageAssetBytes(artifactLease.lease.value.artifact!, 16)).toString())
        .toBe('one');
      await artifactLease.lease.release();
    }
    expect(readdirSync(resolver.paths.artifactsRoot)).toHaveLength(1);
  });

  it('restores expired-reference cleanup work after restart', async () => {
    let now = 100;
    const resolver = paths(sandbox());
    const references = new FileImageReferenceStore({
      paths: resolver,
      limits: referenceLimits(),
      now: () => now,
    });
    const state = new FileResponsesImageStateStore({
      paths: resolver,
      limits: stateLimits(),
      now: () => now,
    });
    const reference = await saveReference(references, 'tenant-a', 'expired');
    const item = binding('c', reference.referenceId, 105);
    await state.commit({
      tenantId: 'tenant-a',
      responseId: 'resp_expiring',
      bindings: [item],
      responseExpiresAt: 105,
    });
    now = 106;
    expect(await state.cleanup()).toEqual([item]);
    expect(state.status().pendingReferenceDeletes).toBe(1);

    const restarted = new FileResponsesImageStateStore({
      paths: resolver,
      limits: stateLimits(),
      now: () => now,
    });
    expect(restarted.status().pendingReferenceDeletes).toBe(1);
    const coordinator = new ResponsesImageStateCleanupCoordinator({
      stateStore: restarted,
      referenceStore: references,
    });
    await coordinator.drainPending();
    expect(restarted.status().pendingReferenceDeletes).toBe(0);
    expect(await restarted.resolveCall('tenant-a', item.callId)).toEqual({ status: 'expired' });
    expect(await references.resolve('tenant-a', reference.referenceId)).toEqual({ status: 'not_found' });
  });

  it('retains failed best-effort deletes for a later bounded pass', async () => {
    let now = 100;
    const resolver = paths(sandbox());
    const state = new FileResponsesImageStateStore({
      paths: resolver,
      limits: stateLimits(),
      now: () => now,
    });
    const item = binding(
      'd',
      `imgref_${'d'.repeat(32)}` as ImageReferenceId,
      105,
    );
    await state.commit({
      tenantId: 'tenant-a',
      responseId: 'resp_retry',
      bindings: [item],
      responseExpiresAt: 105,
    });
    now = 106;
    await state.cleanup();
    let fail = true;
    const coordinator = new ResponsesImageStateCleanupCoordinator({
      stateStore: state,
      maxReferenceDeletesPerPass: 1,
      referenceStore: {
        async deleteByHashedTenantKey() {
          if (fail) throw new Error('injected reference delete failure');
          return false;
        },
      },
    });
    await expect(coordinator.drainPending()).resolves.toMatchObject({
      referenceDeletesAttempted: 1,
      referenceDeletesAcknowledged: 0,
      referenceDeleteFailures: 1,
      pendingReferenceDeletes: 1,
    });
    fail = false;
    await expect(coordinator.drainPending()).resolves.toMatchObject({
      referenceDeletesAcknowledged: 1,
      referenceDeleteFailures: 0,
      pendingReferenceDeletes: 0,
    });
  });
});
