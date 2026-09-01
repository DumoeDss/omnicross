import OpenAI, { APIError, toFile } from 'openai';
import { afterEach, describe, expect, it } from 'vitest';

import type { ImageReferenceId } from '@omnicross/contracts/image-generation-types';

import {
  InMemoryImageAsset,
  InMemoryImageReferenceStore,
  type ImageReferenceStore,
} from '../../ports';
import { createImageContractHarness, type ImageContractHarness } from './contractHarness';

const harnesses: ImageContractHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
});

async function setup(options: Parameters<typeof createImageContractHarness>[0] = {}) {
  const harness = await createImageContractHarness(options);
  harnesses.push(harness);
  return {
    harness,
    client: new OpenAI({ apiKey: harness.token, baseURL: harness.baseURL, maxRetries: 0 }),
  };
}

async function rawJson(harness: ImageContractHarness, body: unknown) {
  return fetch(`${harness.baseURL}/images/edits`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${harness.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('Images HTTP security contracts', () => {
  it('fails closed when provider capability evidence is unavailable', async () => {
    const { client, harness } = await setup({ capabilities: { available: false } });
    const error = await client.images.generate({
      model: 'gpt-image-1',
      prompt: 'capability must be verified',
    }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(APIError);
    expect((error as APIError).status).toBe(422);
    expect((error as APIError).code).toBe('unsupported_capability');
    expect(harness.capture.starts).toBe(0);
  });

  it.each([
    [{ file_id: 'missing-reference' }, 'file_id'],
    [{ image_url: 'https://127.0.0.1/private.png?token=SECRET_QUERY' }, 'image_url'],
  ])('keeps unwired JSON carrier %j fail-closed', async (image, param) => {
    const { harness } = await setup();
    const response = await rawJson(harness, { prompt: 'edit', image });
    const wire = await response.text();
    expect(response.status).toBe(422);
    expect(JSON.parse(wire).error).toMatchObject({ code: 'unsupported_capability', param });
    expect(wire).not.toContain('SECRET_QUERY');
    expect(harness.capture.starts).toBe(0);
  });

  it('distinguishes owning-tenant expiry while hiding absent and cross-tenant references', async () => {
    let now = 100;
    const store = new InMemoryImageReferenceStore(() => now);
    const asset = new InMemoryImageAsset(Uint8Array.of(1), {
      mimeType: 'image/png',
      width: 1,
      height: 1,
      hasAlpha: true,
    });
    const metadata = {
      mimeType: asset.mimeType,
      byteLength: asset.byteLength,
      width: asset.width,
      height: asset.height,
    };
    const expired = await store.save({
      tenantId: 'outbound-key-tenant',
      ttlMs: 1,
      artifact: asset,
      metadata,
    });
    const crossTenant = await store.save({
      tenantId: 'another-tenant',
      ttlMs: 100,
      artifact: asset,
      metadata,
    });
    now = 102;
    const { harness } = await setup({ referenceStore: store });
    for (const [fileId, status, code] of [
      [expired.referenceId, 410, 'image_reference_expired'],
      [crossTenant.referenceId, 404, 'image_reference_not_found'],
      ['not-present', 404, 'image_reference_not_found'],
    ] as const) {
      const response = await rawJson(harness, {
        prompt: 'reference contract',
        image: { file_id: fileId },
      });
      expect(response.status).toBe(status);
      expect((await response.json() as { error: { code: string } }).error.code).toBe(code);
    }
    await harness.waitForIdle();
    expect(harness.capture.starts).toBe(0);
    expect(harness.capture.audits.map((audit) => audit.referenceOutcomes)).toEqual([
      { hits: 0, notFound: 0, expired: 1, failed: 0 },
      { hits: 0, notFound: 1, expired: 0, failed: 0 },
      { hits: 0, notFound: 1, expired: 0, failed: 0 },
    ]);
  });

  it('accepts ordered JSON images plus a distinct data-URL mask', async () => {
    const { harness } = await setup();
    const response = await rawJson(harness, {
      model: 'gpt-image-1',
      prompt: 'ordered JSON references',
      images: [
        { image_url: `data:image/png;base64,${harness.inputPng.toString('base64')}` },
        { image_url: `data:image/jpeg;base64,${harness.inputJpeg.toString('base64')}` },
      ],
      mask: { image_url: `data:image/png;base64,${harness.maskPng.toString('base64')}` },
      output_format: 'png',
    });
    expect(response.status).toBe(200);
    await harness.waitForIdle();
    const captured = harness.capture.requests[0];
    expect(captured?.action).toBe('edit');
    if (captured?.action === 'edit') {
      expect(captured.images.map((asset) => asset.mimeType)).toEqual(['image/png', 'image/jpeg']);
      expect(captured.mask).toMatchObject({ mimeType: 'image/png', hasAlpha: true });
    }
  });

  it('accepts a Codex-style inline image larger than the remote URL limit', async () => {
    const { harness } = await setup({ limits: { maxRemoteUrlBytes: 32 } });
    const imageUrl = `data:image/png;base64,${harness.inputPng.toString('base64')}`;
    expect(Buffer.byteLength(imageUrl, 'utf8')).toBeGreaterThan(32);
    const response = await rawJson(harness, {
      images: [{ image_url: imageUrl }],
      prompt: 'Codex built-in edit envelope',
      model: 'gpt-image-1',
      quality: 'auto',
      size: 'auto',
    });
    expect(response.status).toBe(200);
    await harness.waitForIdle();
    expect(harness.capture.requests[0]).toMatchObject({
      action: 'edit',
      quality: 'auto',
      images: [expect.objectContaining({ mimeType: 'image/png' })],
    });
  });

  it('holds an active reference lease through provider execution and releases it in finally', async () => {
    const referenceId = 'active-reference' as ImageReferenceId;
    const asset = new InMemoryImageAsset(Uint8Array.of(1), {
      mimeType: 'image/png',
      width: 1,
      height: 1,
      hasAlpha: true,
    });
    let releases = 0;
    const store: ImageReferenceStore = {
      async save() { throw new Error('not used'); },
      async resolve(tenantId, requestedId) {
        if (tenantId !== 'outbound-key-tenant' || requestedId !== referenceId) {
          return { status: 'not_found' };
        }
        return {
          status: 'found',
          lease: {
            metadata: {
              referenceId,
              createdAt: 1,
              expiresAt: 10_000,
              mimeType: asset.mimeType,
              byteLength: asset.byteLength,
              width: asset.width,
              height: asset.height,
            },
            value: { artifact: asset },
            async release() { releases += 1; },
          },
        };
      },
      async delete() { return false; },
      async cleanup() { return 0; },
    };
    const { harness } = await setup({
      referenceStore: store,
      onAccepted: () => { expect(releases).toBe(0); },
    });
    const response = await rawJson(harness, {
      model: 'gpt-image-1',
      prompt: 'lease contract',
      image: { file_id: referenceId },
    });
    expect(response.status).toBe(200);
    await harness.waitForIdle();
    expect(harness.capture.starts).toBe(1);
    expect(releases).toBe(1);
    expect(harness.capture.audits[0]).toMatchObject({
      referenceOutcomes: { hits: 1, notFound: 0, expired: 0, failed: 0 },
      cleanupOutcome: 'completed',
    });
  });

  it('rejects forged/corrupt multipart bytes before provider acquisition', async () => {
    const { client, harness } = await setup();
    const error = await client.images.edit({
      model: 'gpt-image-1',
      prompt: 'corrupt input',
      image: await toFile(Buffer.from('PNG MIME but not a PNG SECRET_BYTES'), 'forged.png', {
        type: 'image/png',
      }),
    }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(APIError);
    expect((error as APIError).status).toBe(415);
    expect((error as APIError).code).toBe('unsupported_image_type');
    expect(JSON.stringify((error as APIError).error)).not.toContain('SECRET_BYTES');
    expect(harness.capture.starts).toBe(0);
  });

  it('rejects a mismatched multipart mask before provider acquisition and cleans inputs', async () => {
    const { client, harness } = await setup();
    const error = await client.images.edit({
      model: 'gpt-image-1',
      prompt: 'mask mismatch',
      image: await toFile(harness.inputPng, 'primary.png', { type: 'image/png' }),
      mask: await toFile(harness.inputJpeg, 'mask.png', { type: 'image/png' }),
    }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(APIError);
    expect((error as APIError).status).toBe(400);
    expect((error as APIError).code).toBe('invalid_image_request');
    await harness.waitForIdle();
    expect(harness.capture.starts).toBe(0);
    expect(await harness.tempEntries()).toEqual([]);
  });

  it('rejects declared JSON and multipart aggregate overflow with no provider start', async () => {
    const jsonSetup = await setup({ limits: { maxJsonBytes: 64 } });
    const jsonResponse = await rawJson(jsonSetup.harness, {
      prompt: 'x'.repeat(100),
      image: { file_id: 'unused' },
    });
    expect(jsonResponse.status).toBe(413);
    expect((await jsonResponse.json() as { error: { code: string } }).error.code).toBe('image_too_large');
    expect(jsonSetup.harness.capture.starts).toBe(0);

    const multipartSetup = await setup({ limits: { maxMultipartBytes: 128 } });
    const error = await multipartSetup.client.images.edit({
      model: 'gpt-image-1',
      prompt: 'multipart aggregate',
      image: await toFile(multipartSetup.harness.inputPng, 'input.png', { type: 'image/png' }),
    }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(APIError);
    expect((error as APIError).status).toBe(413);
    expect(multipartSetup.harness.capture.starts).toBe(0);
  });

  it('cancels an accepted nonterminal job when local SSE output staging fails', async () => {
    const { harness } = await setup({ limits: { maxOutputBytes: 1 } });
    const response = await fetch(`${harness.baseURL}/images/generations`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${harness.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-image-1',
        prompt: 'bounded partial output',
        output_format: 'png',
        stream: true,
        partial_images: 1,
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('image_too_large');
    await harness.waitForIdle();
    expect(harness.capture.cancels).toBe(1);
    expect(harness.capture.releases).toBe(1);
    expect(await harness.tempEntries()).toEqual([]);
  });

  it('cleans request files and emits only metadata audit fields', async () => {
    const { client, harness } = await setup();
    const prompt = 'PROMPT_CONTENT_SENTINEL';
    await client.images.edit({
      model: 'gpt-image-1',
      prompt,
      image: await toFile(harness.inputPng, 'PATH_SENTINEL.png', { type: 'image/png' }),
    });
    await harness.waitForIdle();
    expect(await harness.tempEntries()).toEqual([]);
    const audit = JSON.stringify(harness.capture.audits);
    expect(audit).not.toContain(prompt);
    expect(audit).not.toContain('PATH_SENTINEL');
    expect(audit).not.toContain(harness.token);
    expect(harness.capture.audits[0]).toMatchObject({
      operationId: 'images.edit',
      inputCount: 1,
      cleanupOutcome: 'completed',
      terminal: 'completed',
    });
  });
});
