import { afterEach, describe, expect, it, vi } from 'vitest';

import { InMemoryImageAsset } from '@omnicross/core/image-generation';
import type { ImagesObjectStorageConfig } from '@omnicross/core/outbound-api';

import { createImagesStoragePublishInput } from '../imagesStoragePublishInput';

function asset(bytes = new Uint8Array([1, 2, 3])): InMemoryImageAsset {
  return new InMemoryImageAsset(bytes, { mimeType: 'image/png', width: 1, height: 1 });
}

function storageConfig(overrides: Partial<ImagesObjectStorageConfig> = {}): ImagesObjectStorageConfig {
  return {
    enabled: true,
    kind: 's3',
    bucket: 'media-bucket',
    endpoint: 'https://account.r2.cloudflarestorage.com',
    region: 'auto',
    prefix: 'omnicross',
    urlMode: 'signed',
    expiresInSeconds: 900,
    forcePathStyle: true,
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'secret-example',
    ...overrides,
  };
}

describe('images storage publishInput', () => {
  afterEach(() => {
    delete process.env['TEST_S3_SECRET'];
    vi.unstubAllEnvs();
  });

  it('yields no publisher while storage is absent, disabled, or missing credentials', () => {
    expect(createImagesStoragePublishInput(undefined)).toBeUndefined();
    expect(createImagesStoragePublishInput(storageConfig({ enabled: false }))).toBeUndefined();
    expect(createImagesStoragePublishInput(storageConfig({ secretAccessKey: '' }))).toBeUndefined();
    expect(createImagesStoragePublishInput(storageConfig({ bucket: '' }))).toBeUndefined();
    expect(createImagesStoragePublishInput(storageConfig({ secretAccessKey: '$TEST_S3_SECRET' })))
      .toBeUndefined();
  });

  it('publishes an asset through a presigned upload and returns the download URL', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const publishInput = createImagesStoragePublishInput(storageConfig(), { fetchImpl });
    expect(publishInput).toBeDefined();

    const url = await publishInput!(asset(), new AbortController().signal);

    const [uploadUrl, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(uploadUrl).pathname).toMatch(/^\/media-bucket\/omnicross\/image-input\//u);
    expect(init.method).toBe('PUT');
    expect(new Headers(init.headers).get('content-type')).toBe('image/png');
    expect(url).toMatch(
      /^https:\/\/account\.r2\.cloudflarestorage\.com\/media-bucket\/omnicross\/image-input\//u
    );
    expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe('900');
  });

  it('resolves $ENV_NAME credential references at publish time', async () => {
    process.env['TEST_S3_SECRET'] = 'env-resolved-secret';
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const target = String(input);
      if (!target.includes('X-Amz-Signature') && !target.includes('Signature=')) return new Response('', { status: 200 });
      // Only the upload URL is fetched; verify the credential scope made it in.
      expect(target).toContain(`Credential=AKIDEXAMPLE%2F`);
      return new Response('', { status: 200 });
    });
    const publishInput = createImagesStoragePublishInput(
      storageConfig({ secretAccessKey: '$TEST_S3_SECRET' }),
      { fetchImpl }
    );
    expect(publishInput).toBeDefined();
    const url = await publishInput!(asset(), new AbortController().signal);
    expect(url).toContain('X-Amz-Signature');
  });

  it('propagates upload failures with the upstream status', async () => {
    const fetchImpl = vi.fn(async () => new Response('AccessDenied', { status: 403 }));
    const publishInput = createImagesStoragePublishInput(storageConfig({ kind: 'oss' }), {
      fetchImpl,
    });
    await expect(
      publishInput!(asset(), new AbortController().signal)
    ).rejects.toThrow('Object storage upload failed: HTTP 403 AccessDenied');
  });
});
