import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  InMemoryImageAsset,
} from '@omnicross/core/image-generation';
import type { OutboundApiServerConfig } from '@omnicross/core/outbound-api';

import type { DaemonImageE2eHarness } from './daemonImageE2eHarness';
import { createDaemonImageE2eHarness } from './daemonImageE2eHarness';
import { SYNTHETIC_IMAGE_PNG } from './syntheticVerifiedImageProvider';

const harnesses: DaemonImageE2eHarness[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(harnesses.splice(0).reverse().map((harness) => harness.close()));
});

async function generate(
  harness: DaemonImageE2eHarness,
  token = harness.token,
  prompt = 'daemon lifecycle Tier-A request',
): Promise<Response> {
  return fetch(`${harness.baseURL}/images/generations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-image-2',
      prompt,
      output_format: 'png',
      size: '1024x1024',
    }),
  });
}

async function serverConfig(harness: DaemonImageE2eHarness): Promise<OutboundApiServerConfig> {
  const response = await harness.adminFetch('GET', '/admin/api/server');
  expect(response.status).toBe(200);
  return (response.json as { server: OutboundApiServerConfig }).server;
}

describe('daemon Images boot, hot reload, restart, and reset E2E', () => {
  it('starts default-disabled, applies exact permissions, and rolls publication back atomically', async () => {
    const harness = await createDaemonImageE2eHarness({}, {
      imagesEnabled: false,
      permissions: null,
    });
    harnesses.push(harness);

    expect(harness.daemon.providerProxy.getDeps().openAIOperationRegistry)
      .toBe(harness.daemon.openAIOperationRegistry);
    expect(harness.daemon.openAIOperationRegistry.has('images.generate')).toBe(true);
    expect(harness.daemon.openAIOperationRegistry.has('images.edit')).toBe(true);
    expect(harness.daemon.imageRuntimeManager.status().current.enabled).toBe(false);

    const legacyDenied = await generate(harness);
    expect(legacyDenied.status).toBe(403);
    expect(harness.capture.starts).toBe(0);

    expect((await harness.adminFetch(
      'POST',
      `/admin/api/keys/${encodeURIComponent(harness.keyId)}/permissions`,
      { permissions: ['images'] },
    )).status).toBe(200);
    const disabled = await generate(harness);
    expect(disabled.status).toBe(501);
    expect(await disabled.json()).toMatchObject({
      error: { code: 'unsupported_capability' },
    });
    expect(harness.capture.starts).toBe(0);

    const beforeEnable = await serverConfig(harness);
    const enabled = await harness.adminFetch('PUT', '/admin/api/server', {
      images: { ...beforeEnable.images!, enabled: true },
    });
    expect(enabled.status).toBe(200);
    expect((await generate(harness)).status).toBe(200);

    const committed = await serverConfig(harness);
    const committedGeneration = harness.daemon.imageRuntimeManager.status().current.generationId;
    const auditCount = harness.daemon.imageObservability.snapshot().configurationChanges.length;
    const listenerPrepare = vi.spyOn(harness.daemon.outboundApiServer, 'prepareConfig')
      .mockResolvedValue({
        publish: async () => { throw new Error('injected listener publication failure'); },
        rollback: async () => undefined,
        dispose: async () => undefined,
      });
    const failed = await harness.adminFetch('PUT', '/admin/api/server', {
      images: {
        ...committed.images!,
        queue: {
          ...committed.images!.queue,
          maxQueuedJobs: committed.images!.queue.maxQueuedJobs + 1,
        },
      },
    });
    expect(failed.status).toBe(500);
    expect(failed.text).toMatch(/failed during publish/);
    listenerPrepare.mockRestore();
    expect((await serverConfig(harness)).images).toEqual(committed.images);
    expect(harness.daemon.imageRuntimeManager.status().current.generationId)
      .toBe(committedGeneration);
    await expect.poll(() => harness.daemon.imageRuntimeManager.status().draining).toEqual([]);
    expect(harness.daemon.imageObservability.snapshot().configurationChanges).toHaveLength(auditCount);
    expect((await generate(harness)).status).toBe(200);

    expect((await harness.adminFetch(
      'POST',
      `/admin/api/keys/${encodeURIComponent(harness.keyId)}/permissions`,
      { permissions: [] },
    )).status).toBe(200);
    expect((await generate(harness)).status).toBe(403);

    const status = await harness.adminFetch('GET', '/admin/api/status');
    const serialized = `${status.text}\n${JSON.stringify(harness.daemon.imageObservability.snapshot())}`;
    expect(status.status).toBe(200);
    expect(serialized).not.toContain(harness.token);
    expect(serialized).not.toContain(harness.tempHome);
    expect(serialized).not.toContain('daemon lifecycle Tier-A request');
  });

  it('pins queued work to its generation and schedules one selected account fairly', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let entered = 0;
    const harness = await createDaemonImageE2eHarness({
      accountId: 'synthetic-selected-account-for-scheduling',
      beforeComplete: async () => {
        entered += 1;
        if (entered === 1) await firstGate;
      },
    });
    harnesses.push(harness);

    const first = generate(harness, harness.token, 'first queued generation');
    await expect.poll(() => harness.capture.active).toBe(1);
    const second = generate(harness, harness.token, 'second queued generation');
    await expect.poll(() => harness.daemon.imageRuntimeManager.resourceStatus()?.queue.waitingJobs)
      .toBe(1);

    const before = await serverConfig(harness);
    const reloaded = await harness.adminFetch('PUT', '/admin/api/server', {
      images: {
        ...before.images!,
        queue: {
          ...before.images!.queue,
          maxQueuedJobs: before.images!.queue.maxQueuedJobs + 1,
        },
      },
    });
    expect(reloaded.status).toBe(200);
    expect(harness.capture.generationIds).toEqual(['image-runtime-2', 'image-runtime-3']);
    expect(harness.daemon.imageRuntimeManager.status().draining).toEqual([
      expect.objectContaining({ generationId: 'image-runtime-2', httpLeases: 2 }),
    ]);

    releaseFirst();
    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    await expect.poll(() => harness.daemon.imageRuntimeManager.status().draining).toEqual([]);
    expect(harness.capture.maxActive).toBe(1);
    expect((await generate(harness, harness.token, 'post-reload generation')).status).toBe(200);
    expect(harness.capture.schedulers).toHaveLength(2);
    expect(JSON.stringify(harness.daemon.imageObservability.snapshot()))
      .not.toContain('synthetic-selected-account-for-scheduling');
  });

  it('preserves tenant references and known-empty Responses state across stop/reset/restart', async () => {
    const first = await createDaemonImageE2eHarness({}, { removeTempHomeOnClose: false });
    harnesses.push(first);
    const reference = await first.capture.referenceStores.at(-1)!.save({
      tenantId: first.keyId,
      ttlMs: 60_000,
      artifact: new InMemoryImageAsset(SYNTHETIC_IMAGE_PNG, {
        mimeType: 'image/png',
        width: 1,
        height: 1,
        hasAlpha: true,
      }),
      metadata: {
        mimeType: 'image/png',
        byteLength: SYNTHETIC_IMAGE_PNG.byteLength,
        width: 1,
        height: 1,
      },
    });
    await first.capture.stateStores.at(-1)!.commit({
      tenantId: first.keyId,
      responseId: 'resp_daemon_restart_known_empty',
      bindings: [],
      responseExpiresAt: Date.now() + 60_000,
    });
    const firstManager = first.daemon.imageRuntimeManager;
    const firstRegistry = first.daemon.openAIOperationRegistry;
    const sharedHome = first.tempHome;
    const key = { token: first.token, keyId: first.keyId };
    await first.close();
    expect(firstManager.status().disposed).toBe(true);
    expect(firstRegistry.has('images.generate')).toBe(false);

    const restarted = await createDaemonImageE2eHarness({}, {
      tempHome: sharedHome,
      initializeConfig: false,
      existingKey: key,
      removeTempHomeOnClose: true,
    });
    harnesses.push(restarted);
    expect(restarted.daemon.imageRuntimeManager).not.toBe(firstManager);
    expect(restarted.daemon.openAIOperationRegistry).not.toBe(firstRegistry);
    expect(restarted.daemon.providerProxy.getDeps().openAIOperationRegistry)
      .toBe(restarted.daemon.openAIOperationRegistry);

    const restoredReference = await restarted.capture.referenceStores.at(-1)!
      .resolve(restarted.keyId, reference.referenceId);
    expect(restoredReference.status).toBe('found');
    if (restoredReference.status === 'found') await restoredReference.lease.release();
    const restoredState = await restarted.capture.stateStores.at(-1)!
      .resolveResponse(restarted.keyId, 'resp_daemon_restart_known_empty');
    expect(restoredState.status).toBe('found');
    if (restoredState.status === 'found') {
      expect(restoredState.lease.callIds).toEqual([]);
      await restoredState.lease.release();
    }

    const edit = await fetch(`${restarted.baseURL}/images/edits`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${restarted.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-image-2',
        prompt: 'restart reference edit',
        image: { file_id: reference.referenceId },
        output_format: 'png',
      }),
    });
    expect(edit.status).toBe(200);
  });
});
