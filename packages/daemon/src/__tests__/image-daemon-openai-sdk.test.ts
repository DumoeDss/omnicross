import { afterEach, describe, expect, it } from 'vitest';

import { InMemoryImageAsset } from '@omnicross/core/image-generation';

import type { DaemonImageE2eHarness } from './daemonImageE2eHarness';
import { createDaemonImageE2eHarness } from './daemonImageE2eHarness';
import {
  SYNTHETIC_IMAGE_PNG,
  SYNTHETIC_OUTPUT_PNG,
} from './syntheticVerifiedImageProvider';

type OpenAIAPIError = import('openai').APIError;

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (!Number.isSafeInteger(nodeMajor) || nodeMajor < 22) {
  throw new Error(`Daemon Images SDK E2E requires Node.js 22+; current runtime is ${process.version}.`);
}
const { default: OpenAI, APIError, toFile } = await import('openai');

const harnesses: DaemonImageE2eHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
});

async function setup(
  behavior: Parameters<typeof createDaemonImageE2eHarness>[0] = {},
) {
  const harness = await createDaemonImageE2eHarness(behavior);
  harnesses.push(harness);
  return {
    harness,
    client: new OpenAI({ apiKey: harness.token, baseURL: harness.baseURL, maxRetries: 0 }),
  };
}

async function jsonEdit(
  harness: DaemonImageE2eHarness,
  token: string,
  referenceId: string,
): Promise<Response> {
  return fetch(`${harness.baseURL}/images/edits`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-image-2',
      prompt: 'edit retained local reference',
      image: { file_id: referenceId },
      output_format: 'png',
    }),
  });
}

describe('official OpenAI JavaScript SDK through the booted daemon', () => {
  it('generates non-stream outputs and conditionally lists the image model', async () => {
    const { client, harness } = await setup();
    const result = await client.images.generate({
      model: 'gpt-image-2',
      prompt: 'two deterministic daemon images',
      n: 2,
      output_format: 'png',
      quality: 'high',
      size: '1024x1024',
    });
    expect(result.data).toHaveLength(2);
    for (const item of result.data) {
      expect(Buffer.from(item.b64_json!, 'base64')).toEqual(SYNTHETIC_OUTPUT_PNG);
    }
    expect(harness.capture.requests[0]).toMatchObject({
      action: 'generate',
      model: 'gpt-image-2',
      n: 2,
      outputFormat: 'png',
    });

    const models = await client.models.list();
    expect(models.data.filter((model) => model.id === 'gpt-image-2')).toHaveLength(1);
  });

  it('supports SDK multipart edit/mask and maps partial/completed SSE events', async () => {
    const { client, harness } = await setup();
    const edited = await client.images.edit({
      model: 'gpt-image-2',
      prompt: 'edit with an alpha mask',
      image: await toFile(SYNTHETIC_IMAGE_PNG, '../caller-name.bin', {
        type: 'application/octet-stream',
      }),
      mask: await toFile(SYNTHETIC_IMAGE_PNG, 'mask.png', { type: 'image/png' }),
      output_format: 'png',
    });
    expect(Buffer.from(edited.data[0]!.b64_json!, 'base64')).toEqual(SYNTHETIC_OUTPUT_PNG);
    const editRequest = harness.capture.requests[0];
    expect(editRequest?.action).toBe('edit');
    if (editRequest?.action !== 'edit') throw new Error('expected captured edit request');
    expect(editRequest.images).toHaveLength(1);
    expect(editRequest.images[0]).toMatchObject({ mimeType: 'image/png', width: 1, height: 1 });
    expect(editRequest.mask).toMatchObject({ mimeType: 'image/png', hasAlpha: true });

    const stream = await client.images.generate({
      model: 'gpt-image-2',
      prompt: 'stream deterministic partials',
      stream: true,
      partial_images: 2,
      output_format: 'png',
    });
    const events: Array<Record<string, unknown>> = [];
    for await (const event of stream) events.push(event as unknown as Record<string, unknown>);
    expect(events.map((event) => event.type)).toEqual([
      'image_generation.partial_image',
      'image_generation.partial_image',
      'image_generation.completed',
    ]);
    expect(events.slice(0, 2).map((event) => event.partial_image_index)).toEqual([0, 1]);
    expect(Buffer.from(events[2]!.b64_json as string, 'base64')).toEqual(SYNTHETIC_OUTPUT_PNG);
  });

  it('resolves JSON references only for their tenant and keeps them across hot reload', async () => {
    const { harness } = await setup();
    const reference = await harness.capture.referenceStores[0]!.save({
      tenantId: harness.keyId,
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

    const sameTenant = await jsonEdit(harness, harness.token, reference.referenceId);
    expect(sameTenant.status).toBe(200);
    expect(Buffer.from((await sameTenant.json() as { data: Array<{ b64_json: string }> })
      .data[0]!.b64_json, 'base64')).toEqual(SYNTHETIC_OUTPUT_PNG);

    const second = await harness.adminFetch('POST', '/admin/api/keys', { name: 'other-tenant' });
    expect(second.status).toBe(201);
    const other = second.json as { id: string; plaintextOnce: string };
    expect((await harness.adminFetch(
      'POST',
      `/admin/api/keys/${encodeURIComponent(other.id)}/permissions`,
      { permissions: ['images'] },
    )).status).toBe(200);
    const crossTenant = await jsonEdit(harness, other.plaintextOnce, reference.referenceId);
    expect(crossTenant.status).toBe(404);
    expect(await crossTenant.json()).toMatchObject({
      error: { code: 'image_reference_not_found' },
    });

    const server = (await harness.adminFetch('GET', '/admin/api/server')).json as {
      server: { images: Record<string, unknown> & { queue: Record<string, number> } };
    };
    const images = server.server.images;
    const updated = await harness.adminFetch('PUT', '/admin/api/server', {
      images: {
        ...images,
        queue: { ...images.queue, maxQueuedJobs: images.queue.maxQueuedJobs + 1 },
      },
    });
    expect(updated.status).toBe(200);
    expect(harness.capture.generationIds).toEqual(['image-runtime-2', 'image-runtime-3']);
    expect((await jsonEdit(harness, harness.token, reference.referenceId)).status).toBe(200);
  });

  it('maps validation/provider failures and releases resources after cancellation', async () => {
    const first = await setup();
    const invalid = await first.client.images.generate({
      model: 'gpt-image-2',
      prompt: 'invalid transparency combination',
      background: 'transparent',
      output_format: 'jpeg',
    }).catch((error: unknown) => error);
    expect(invalid).toBeInstanceOf(APIError);
    expect(invalid).toMatchObject({ status: 400, code: 'invalid_image_request' });
    expect(first.harness.capture.starts).toBe(0);

    const failed = await setup({ failWith: 'image_generation_failed' });
    const providerError = await failed.client.images.generate({
      model: 'gpt-image-2',
      prompt: 'synthetic terminal failure',
    }).catch((error: unknown) => error);
    expect(providerError).toBeInstanceOf(APIError);
    expect(providerError as OpenAIAPIError).toMatchObject({
      status: 502,
      code: 'image_generation_failed',
    });

    const cancelled = await setup({
      beforeComplete: () => new Promise((resolve) => setTimeout(resolve, 150)),
    });
    const controller = new AbortController();
    const stream = await cancelled.client.images.generate({
      model: 'gpt-image-2',
      prompt: 'cancel the real daemon stream',
      stream: true,
      partial_images: 0,
    }, { signal: controller.signal });
    controller.abort();
    await (async () => {
      for await (const _event of stream) { /* no terminal is expected */ }
    })().catch(() => undefined);
    await expect.poll(() => cancelled.harness.capture.cancels).toBe(1);
    await expect.poll(() => cancelled.harness.daemon.imageRuntimeManager.resourceStatus())
      .toMatchObject({
        queue: { activeJobs: 0, waitingJobs: 0 },
        temporary: { activeScopes: 0, totalBytes: 0 },
      });
  });
});
