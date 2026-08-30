import { afterEach, describe, expect, it } from 'vitest';

import { DaemonImageExecutionScheduler } from '../image-generation/ImageExecutionScheduler';
import { FileCodexImageCapabilityEvidenceSource } from '../image-generation/FileCodexImageCapabilityEvidenceSource';
import { createDaemonImagePathResolver } from '../image-generation/imagePathResolver';
import type { DaemonImageE2eHarness } from './daemonImageE2eHarness';
import { createDaemonImageE2eHarness } from './daemonImageE2eHarness';
import { SYNTHETIC_OUTPUT_PNG } from './syntheticVerifiedImageProvider';

let harness: DaemonImageE2eHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('real daemon Images composition with the labeled Tier-A provider seam', () => {
  it('composes evidence cleanup and removes only expired evidence rows', async () => {
    harness = await createDaemonImageE2eHarness();
    const paths = createDaemonImagePathResolver({ configPath: harness.configPath });
    let now = 0;
    const expiredWriter = new FileCodexImageCapabilityEvidenceSource({
      paths,
      ttlMs: 10,
      now: () => now,
    });
    await expiredWriter.recordSuccessfulVerification({
      accountId: 'expired-account',
      model: 'gpt-image-2',
      request: {
        action: 'generate', n: 1, quality: 'low', size: 'auto', background: 'opaque',
        outputFormat: 'png', moderation: 'auto', stream: false, partialImages: 0,
      },
    });
    now = Date.now();
    const freshWriter = new FileCodexImageCapabilityEvidenceSource({
      paths,
      ttlMs: 60_000,
      now: () => now,
    });
    await freshWriter.recordSuccessfulVerification({
      accountId: 'fresh-account',
      model: 'gpt-image-2',
      request: {
        action: 'generate', n: 1, quality: 'low', size: 'auto', background: 'opaque',
        outputFormat: 'png', moderation: 'auto', stream: false, partialImages: 0,
      },
    });

    await expect(harness.daemon.imageCleanupService.runOnce()).resolves.toMatchObject({
      evidenceEntriesRemoved: 1,
      evidenceCleanupFailures: 0,
    });
    expect(freshWriter.status()).toMatchObject({ entries: 1, freshEntries: 1 });
    const fresh = await freshWriter.resolve({
      accountId: 'fresh-account',
      signal: new AbortController().signal,
    });
    expect(fresh.account.values?.available).toBe(true);
  });

  it('boots registry, router, runtime, scheduler, stores, audit, temp budget, and cleanup', async () => {
    harness = await createDaemonImageE2eHarness();

    expect(harness.daemon.openAIOperationRegistry.has('images.generate')).toBe(true);
    expect(harness.daemon.openAIOperationRegistry.has('images.edit')).toBe(true);
    expect(harness.capture.generationIds).toEqual(['image-runtime-2']);
    expect(harness.capture.schedulers[0]).toBeInstanceOf(DaemonImageExecutionScheduler);
    expect(harness.daemon.imageCleanupService.status()).toMatchObject({
      running: true,
      passesCompleted: 1,
    });

    const response = await fetch(`${harness.baseURL}/images/generations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${harness.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-image-2',
        prompt: 'deterministic local Tier-A image',
        output_format: 'png',
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { data: Array<{ b64_json: string }> };
    expect(Buffer.from(body.data[0]!.b64_json, 'base64')).toEqual(SYNTHETIC_OUTPUT_PNG);

    expect(harness.capture.starts).toBe(1);
    expect(harness.capture.contexts[0]?.tenantId).toBe(harness.keyId);
    expect(harness.capture.contexts[0]?.tenantId).not.toBe(harness.token);
    expect(harness.capture.requests[0]?.action).toBe('generate');
    expect(harness.capture.maxActive).toBe(1);
    expect(harness.capture.schedulers[0]).toMatchObject({});
    await expect.poll(() => harness!.daemon.imageObservability.snapshot().apiRequests.length)
      .toBe(1);
    expect(harness.daemon.imageRuntimeManager.resourceStatus()).toMatchObject({
      queue: { activeJobs: 0, waitingJobs: 0 },
      temporary: { activeScopes: 0, totalBytes: 0 },
      storage: { referenceEntries: 1 },
    });
  });
});
