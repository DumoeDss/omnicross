import {
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ImageCleanupService,
  type ImageCleanupTimer,
} from '../ImageCleanupService';
import { ImageStartupReconciler } from '../ImageStartupReconciler';
import { ImageStorageMountCatalog } from '../ImageStorageMountCatalog';

const sandboxes: string[] = [];

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'omnicross-image-cleanup-'));
  sandboxes.push(root);
  return root;
}

afterEach(() => {
  const systemTemporary = resolve(tmpdir());
  for (const root of sandboxes.splice(0)) {
    const absolute = resolve(root);
    const rel = relative(systemTemporary, absolute);
    if (!isAbsolute(absolute) || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('refusing to clean an unverified image-cleanup sandbox');
    }
    rmSync(absolute, { recursive: true, force: true });
  }
});

function setup(root: string) {
  const applicationData = join(root, 'private-data');
  const workspace = join(root, 'workspace');
  const home = join(root, 'home');
  const systemTemporary = join(root, 'system-temporary');
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
    activeStorageRoot: join(root, 'durable-first'),
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
  });
  const temporaryPaths = catalog.active().resolver;
  const reconciler = new ImageStartupReconciler({
    catalog,
    temporaryPaths,
    staleTemporaryAfterMs: 1_000,
    now: () => 100,
  });
  return { catalog, reconciler };
}

describe('ImageCleanupService', () => {
  it('publishes and rolls back cleanup cadence, staleness owner, and evidence policy', async () => {
    const environment = setup(sandbox());
    const replacementReconciler = new ImageStartupReconciler({
      catalog: environment.catalog,
      temporaryPaths: environment.catalog.active().resolver,
      staleTemporaryAfterMs: 5_000,
      now: () => 100,
    });
    const initialRun = vi.spyOn(environment.reconciler, 'run');
    const replacementRun = vi.spyOn(replacementReconciler, 'run');
    const initialEvidence = vi.fn(async () => ({ entriesRemoved: 0, bytesRemoved: 0 }));
    const replacementEvidence = vi.fn(async () => ({ entriesRemoved: 3, bytesRemoved: 45 }));
    const scheduled: number[] = [];
    let cleared = 0;
    const service = new ImageCleanupService({
      reconciler: environment.reconciler,
      catalog: environment.catalog,
      intervalMs: 1_000,
      evidence: { cleanup: initialEvidence },
      scheduleInterval(_callback, intervalMs) {
        scheduled.push(intervalMs);
        return { unref() {} };
      },
      clearScheduledInterval() { cleared += 1; },
      now: () => 100,
    });
    service.start();
    const change = service.preparePolicy({
      reconciler: replacementReconciler,
      intervalMs: 2_000,
      evidence: { cleanup: replacementEvidence },
    });
    change.publish();
    expect(scheduled).toEqual([1_000, 2_000]);
    expect(cleared).toBe(1);
    await expect(service.runOnce()).resolves.toMatchObject({
      evidenceEntriesRemoved: 3,
      evidenceBytesRemoved: 45,
    });
    expect(replacementRun).toHaveBeenCalledOnce();
    expect(initialRun).not.toHaveBeenCalled();

    change.rollback();
    expect(scheduled).toEqual([1_000, 2_000, 1_000]);
    expect(cleared).toBe(2);
    await service.runOnce();
    expect(initialRun).toHaveBeenCalledOnce();
    expect(initialEvidence).toHaveBeenCalledOnce();
    await service.stop();
  });

  it('unrefs one timer, reports counts/bytes only, retires empty mounts, and resets idempotently', async () => {
    const root = sandbox();
    const environment = setup(root);
    environment.catalog.activate(join(root, 'durable-second'));
    let scheduled = 0;
    let cleared = 0;
    let unrefed = 0;
    const timers = new Set<ImageCleanupTimer>();
    const service = new ImageCleanupService({
      reconciler: environment.reconciler,
      catalog: environment.catalog,
      intervalMs: 1_000,
      now: () => 100,
      evidence: {
        async cleanup() {
          return { entriesRemoved: 2, bytesRemoved: 30 };
        },
      },
      scheduleInterval() {
        scheduled += 1;
        const timer = { unref: () => { unrefed += 1; } };
        timers.add(timer);
        return timer;
      },
      clearScheduledInterval(timer) {
        if (timers.delete(timer)) cleared += 1;
      },
    });

    service.start();
    service.start();
    expect(scheduled).toBe(1);
    expect(unrefed).toBe(1);
    expect(service.status().running).toBe(true);
    await expect(service.runOnce()).resolves.toMatchObject({
      evidenceEntriesRemoved: 2,
      evidenceBytesRemoved: 30,
      evidenceCleanupFailures: 0,
      retiredMountsRemoved: 1,
      referenceEntries: 0,
      referenceBytes: 0,
      stateCalls: 0,
      stateResponses: 0,
      pendingReferenceDeletes: 0,
    });
    expect(environment.catalog.status()).toEqual({ mounts: 1, retiredMounts: 0 });
    const serialized = JSON.stringify(service.status());
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain('tenant');
    expect(service.status().passesCompleted).toBe(1);

    await service.stop();
    await service.stop();
    expect(cleared).toBe(1);
    expect(service.status().running).toBe(false);
    await service.reset();
    await service.reset();
    expect(service.status()).toMatchObject({ passesCompleted: 0, passFailures: 0, finishedAt: 0 });
  });

  it('shares an in-flight pass across concurrent callers', async () => {
    const environment = setup(sandbox());
    let evidenceCalls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const service = new ImageCleanupService({
      reconciler: environment.reconciler,
      catalog: environment.catalog,
      intervalMs: 1_000,
      now: () => 100,
      evidence: {
        async cleanup() {
          evidenceCalls += 1;
          await gate;
          return { entriesRemoved: 0, bytesRemoved: 0 };
        },
      },
    });
    const first = service.runOnce();
    const second = service.runOnce();
    await vi.waitFor(() => expect(evidenceCalls).toBe(1));
    release!();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(evidenceCalls).toBe(1);
    expect(service.status().passesCompleted).toBe(1);
  });

  it('keeps evidence cleanup best-effort and still retires an empty mount', async () => {
    const root = sandbox();
    const environment = setup(root);
    environment.catalog.activate(join(root, 'durable-second'));
    const service = new ImageCleanupService({
      reconciler: environment.reconciler,
      catalog: environment.catalog,
      intervalMs: 1_000,
      now: () => 100,
      evidence: {
        async cleanup() {
          throw new Error('injected evidence cleanup failure');
        },
      },
    });
    await expect(service.runOnce()).resolves.toMatchObject({
      evidenceCleanupFailures: 1,
      retiredMountsRemoved: 1,
    });
    expect(service.status()).toMatchObject({ passesCompleted: 1, passFailures: 0 });
  });
});
