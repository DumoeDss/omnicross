import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ImageReferenceId } from '@omnicross/contracts/image-generation-types';
import type {
  ResponsesImageCallBinding,
  ResponsesImageCallId,
  ResponsesImageStateCommitInput,
} from '@omnicross/core/image-generation/responses';

import {
  FileResponsesImageStateStore,
  type FileResponsesImageStateStoreLimits,
} from '../FileResponsesImageStateStore';
import { createDaemonImagePathResolver, type DaemonImagePathResolver } from '../imagePathResolver';

const sandboxes: string[] = [];

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'omnicross-responses-image-state-'));
  sandboxes.push(root);
  return root;
}

afterEach(() => {
  const systemTemporary = resolve(tmpdir());
  for (const root of sandboxes.splice(0)) {
    const absolute = resolve(root);
    const rel = relative(systemTemporary, absolute);
    if (!isAbsolute(absolute) || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('refusing to clean an unverified responses-image-state sandbox');
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

function limits(
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

const callId = (suffix: string) =>
  `ig_${suffix.padEnd(16, suffix)}` as ResponsesImageCallId;
const referenceId = (suffix: string) =>
  `imgref_${suffix.padEnd(32, suffix)}` as ImageReferenceId;
const binding = (
  suffix: string,
  expiresAt = 200,
): ResponsesImageCallBinding => Object.freeze({
  callId: callId(suffix),
  referenceId: referenceId(suffix),
  expiresAt,
});

function commitInput(
  responseId: string,
  bindings: readonly ResponsesImageCallBinding[],
  tenantId = 'tenant-a',
  responseExpiresAt = 200,
): ResponsesImageStateCommitInput {
  return { tenantId, responseId, bindings, responseExpiresAt };
}

describe('FileResponsesImageStateStore', () => {
  it('persists ordered calls and explicit known-empty response markers across restart', async () => {
    const resolver = paths(sandbox());
    const first = new FileResponsesImageStateStore({ paths: resolver, limits: limits(), now: () => 100 });
    const a = binding('a');
    const b = binding('b');
    await expect(first.commit(commitInput('resp_ordered', [b, a]))).resolves.toEqual([]);
    await expect(first.commit(commitInput('resp_known_empty', []))).resolves.toEqual([]);

    const manifestPath = join(resolver.paths.stateRoot, 'responses-image-state.v1.json');
    const manifest = readFileSync(manifestPath, 'utf8');
    expect(manifest).not.toContain('tenant-a');
    expect(manifest).toContain('resp_known_empty');
    expect(JSON.parse(manifest)).toMatchObject({ version: 1 });

    const restarted = new FileResponsesImageStateStore({
      paths: resolver,
      limits: limits(),
      now: () => 100,
    });
    const ordered = await restarted.resolveResponse('tenant-a', 'resp_ordered');
    expect(ordered.status).toBe('found');
    if (ordered.status === 'found') {
      expect(ordered.lease.callIds).toEqual([b.callId, a.callId]);
      await ordered.lease.release();
      await ordered.lease.release();
    }
    const empty = await restarted.resolveResponse('tenant-a', 'resp_known_empty');
    expect(empty.status).toBe('found');
    if (empty.status === 'found') {
      expect(empty.lease.callIds).toEqual([]);
      await empty.lease.release();
    }
    const direct = await restarted.resolveCall('tenant-a', b.callId);
    expect(direct.status).toBe('found');
    if (direct.status === 'found') {
      expect(direct.lease.binding).toEqual(b);
      await direct.lease.release();
    }
  });

  it('keeps multi-call commit failure atomic and enforces exact idempotency', async () => {
    const resolver = paths(sandbox());
    const healthy = new FileResponsesImageStateStore({ paths: resolver, limits: limits(), now: () => 100 });
    const prior = binding('c');
    await healthy.commit(commitInput('resp_prior', [prior]));
    await expect(healthy.commit(commitInput('resp_prior', [prior]))).resolves.toEqual([]);
    await expect(healthy.commit(commitInput('resp_prior', [binding('d'), prior])))
      .rejects.toMatchObject({ code: 'image_generation_failed' });

    const manifestPath = join(resolver.paths.stateRoot, 'responses-image-state.v1.json');
    const priorManifest = readFileSync(manifestPath);
    const failing = new FileResponsesImageStateStore({
      paths: resolver,
      limits: limits(),
      now: () => 100,
      replaceManifest: () => { throw new Error('injected state manifest failure'); },
    });
    const nextA = binding('e');
    const nextB = binding('f');
    await expect(failing.commit(commitInput('resp_unpublished', [nextA, nextB])))
      .rejects.toThrow(/injected state manifest failure/);
    expect(readFileSync(manifestPath).equals(priorManifest)).toBe(true);
    expect(await failing.resolveResponse('tenant-a', 'resp_unpublished'))
      .toEqual({ status: 'not_found' });
    expect(await failing.resolveCall('tenant-a', nextA.callId)).toEqual({ status: 'not_found' });
    const restored = await failing.resolveCall('tenant-a', prior.callId);
    expect(restored.status).toBe('found');
    if (restored.status === 'found') await restored.lease.release();
  });

  it('hides cross-tenant state and persists bounded owner-only expiry tombstones', async () => {
    let now = 100;
    const resolver = paths(sandbox());
    const first = new FileResponsesImageStateStore({
      paths: resolver,
      limits: limits({ maxTombstones: 2 }),
      now: () => now,
    });
    const expiring = binding('g', 105);
    await first.commit(commitInput('resp_expiring', [expiring], 'tenant-a', 105));
    expect(await first.resolveCall('tenant-b', expiring.callId)).toEqual({ status: 'not_found' });
    expect(await first.resolveResponse('tenant-b', 'resp_expiring')).toEqual({ status: 'not_found' });

    now = 106;
    expect(await first.cleanup()).toEqual([expiring]);
    const restarted = new FileResponsesImageStateStore({
      paths: resolver,
      limits: limits({ maxTombstones: 2 }),
      now: () => now,
    });
    expect(await restarted.resolveCall('tenant-a', expiring.callId)).toEqual({ status: 'expired' });
    expect(await restarted.resolveResponse('tenant-a', 'resp_expiring')).toEqual({ status: 'expired' });
    expect(await restarted.resolveCall('tenant-b', expiring.callId)).toEqual({ status: 'not_found' });

    now = 117;
    await restarted.cleanup();
    expect(await restarted.resolveCall('tenant-a', expiring.callId)).toEqual({ status: 'not_found' });
    expect(await restarted.resolveResponse('tenant-a', 'resp_expiring'))
      .toEqual({ status: 'not_found' });
  });

  it('uses LRU capacity eviction while active call and response leases remain pinned', async () => {
    const resolver = paths(sandbox());
    const store = new FileResponsesImageStateStore({
      paths: resolver,
      limits: limits({ maxCalls: 2, maxResponses: 2 }),
      now: () => 100,
    });
    const first = binding('h');
    const second = binding('i');
    const third = binding('j');
    await store.commit(commitInput('resp_first', [first]));
    await store.commit(commitInput('resp_second', [second]));

    const callLease = await store.resolveCall('tenant-a', first.callId);
    const responseLease = await store.resolveResponse('tenant-a', 'resp_first');
    expect(callLease.status).toBe('found');
    expect(responseLease.status).toBe('found');
    await expect(store.commit(commitInput('resp_third', [third])))
      .resolves.toEqual([second]);
    expect(await store.resolveCall('tenant-a', second.callId)).toEqual({ status: 'not_found' });
    expect(await store.resolveResponse('tenant-a', 'resp_second')).toEqual({ status: 'not_found' });
    const stillFound = await store.resolveCall('tenant-a', first.callId);
    expect(stillFound.status).toBe('found');
    if (stillFound.status === 'found') await stillFound.lease.release();

    if (callLease.status === 'found') await callLease.lease.release();
    if (responseLease.status === 'found') await responseLease.lease.release();
  });

  it('rejects capacity replacement when every eligible call or response is leased', async () => {
    const resolver = paths(sandbox());
    const store = new FileResponsesImageStateStore({
      paths: resolver,
      limits: limits({ maxCalls: 1, maxResponses: 1 }),
      now: () => 100,
    });
    const first = binding('k');
    await store.commit(commitInput('resp_pinned', [first]));
    const callLease = await store.resolveCall('tenant-a', first.callId);
    const responseLease = await store.resolveResponse('tenant-a', 'resp_pinned');
    const replacement = binding('l');
    await expect(store.commit(commitInput('resp_replacement', [replacement])))
      .rejects.toMatchObject({ code: 'image_generation_failed' });

    if (callLease.status === 'found') await callLease.lease.release();
    await expect(store.commit(commitInput('resp_replacement', [replacement])))
      .rejects.toMatchObject({ code: 'image_generation_failed' });
    if (responseLease.status === 'found') await responseLease.lease.release();
    await expect(store.commit(commitInput('resp_replacement', [replacement])))
      .resolves.toEqual([first]);
  });

  it('keeps deletes non-disclosing while leases pin state until cleanup', async () => {
    const resolver = paths(sandbox());
    const store = new FileResponsesImageStateStore({ paths: resolver, limits: limits(), now: () => 100 });
    const item = binding('m');
    await store.commit(commitInput('resp_delete', [item]));
    const callLease = await store.resolveCall('tenant-a', item.callId);
    const responseLease = await store.resolveResponse('tenant-a', 'resp_delete');
    expect(await store.deleteCall('tenant-b', item.callId)).toBeUndefined();
    expect(await store.deleteResponse('tenant-b', 'resp_delete')).toBe(false);
    expect(await store.deleteCall('tenant-a', item.callId)).toEqual(item);
    expect(await store.deleteResponse('tenant-a', 'resp_delete')).toBe(true);
    expect(await store.deleteCall('tenant-a', item.callId)).toBeUndefined();
    expect(await store.deleteResponse('tenant-a', 'resp_delete')).toBe(false);
    expect(await store.resolveCall('tenant-a', item.callId)).toEqual({ status: 'not_found' });
    expect(await store.cleanup()).toEqual([]);

    if (callLease.status === 'found') {
      expect(callLease.lease.binding).toEqual(item);
      await callLease.lease.release();
      await callLease.lease.release();
    }
    expect(await store.cleanup()).toEqual([item]);
    if (responseLease.status === 'found') await responseLease.lease.release();
    expect(await store.cleanup()).toEqual([]);
    expect(store.status()).toEqual({
      calls: 0,
      responses: 0,
      tombstones: 0,
      pendingReferenceDeletes: 1,
    });
  });

  it('serializes concurrent commits without partial response markers', async () => {
    const resolver = paths(sandbox());
    const store = new FileResponsesImageStateStore({
      paths: resolver,
      limits: limits({ maxCalls: 2, maxResponses: 2 }),
      now: () => 100,
    });
    const items = [binding('n'), binding('o'), binding('p')];
    await Promise.all(items.map((item, index) =>
      store.commit(commitInput(`resp_concurrent_${index}`, [item]))));
    expect(store.status()).toMatchObject({ calls: 2, responses: 2 });
    expect(await store.resolveCall('tenant-a', items[0]!.callId)).toEqual({ status: 'not_found' });
    expect(await store.resolveResponse('tenant-a', 'resp_concurrent_0'))
      .toEqual({ status: 'not_found' });
    for (const item of items.slice(1)) {
      const found = await store.resolveCall('tenant-a', item.callId);
      expect(found.status).toBe('found');
      if (found.status === 'found') await found.lease.release();
    }
  });
});
