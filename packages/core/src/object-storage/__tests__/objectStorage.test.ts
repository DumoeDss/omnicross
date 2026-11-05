import { describe, expect, it, vi } from 'vitest';

import { buildObjectKey, normalizeObjectPrefix } from '../objectKey';
import { createObjectStoragePublisher } from '../publisher';
import { presignOssObject } from '../ossSignature';
import { presignS3Object } from '../s3SigV4';

const credentials = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'secret-example',
  sessionToken: 'session-example',
};

describe('object storage URL signatures', () => {
  it('presigns a path-style S3 PUT including temporary credentials', () => {
    const signed = new URL(
      presignS3Object({
        config: {
          bucket: 'media-bucket',
          endpoint: 'https://account.r2.cloudflarestorage.com',
          region: 'auto',
          urlMode: 'signed',
          forcePathStyle: true,
        },
        credentials,
        key: 'omnicross/video input/demo.mp4',
        method: 'PUT',
        expiresInSeconds: 600,
        now: new Date('2026-08-10T12:34:56.000Z'),
      })
    );

    expect(signed.pathname).toBe('/media-bucket/omnicross/video%20input/demo.mp4');
    expect(signed.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(signed.searchParams.get('X-Amz-Date')).toBe('20260810T123456Z');
    expect(signed.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(signed.searchParams.get('X-Amz-Security-Token')).toBe('session-example');
    expect(signed.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('presigns an Aliyun OSS PUT with its exact content type', () => {
    const signed = new URL(
      presignOssObject({
        config: {
          bucket: 'media-bucket',
          endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
          region: 'cn-hangzhou',
          urlMode: 'signed',
        },
        credentials,
        key: 'omnicross/video/demo.mp4',
        method: 'PUT',
        expiresInSeconds: 600,
        contentType: 'video/mp4',
        now: new Date('2026-08-10T12:34:56.000Z'),
      })
    );

    expect(signed.host).toBe('media-bucket.oss-cn-hangzhou.aliyuncs.com');
    expect(signed.pathname).toBe('/omnicross/video/demo.mp4');
    expect(signed.searchParams.get('OSSAccessKeyId')).toBe('AKIDEXAMPLE');
    expect(signed.searchParams.get('Expires')).toBe('1786365896');
    expect(signed.searchParams.get('security-token')).toBe('session-example');
    expect(signed.searchParams.get('Signature')).toBeTruthy();
  });
});

describe('object keys', () => {
  it('rejects unsafe prefixes and builds dated purpose-scoped keys', () => {
    expect(() => normalizeObjectPrefix('../escape')).toThrow('unsafe path segment');
    expect(normalizeObjectPrefix('/elftia media//')).toBe('elftia-media');
    const key = buildObjectKey(
      'elftia media',
      'Harbor Shot.PNG',
      { purpose: 'image-input' },
      new Date('2026-11-05T08:09:10.000Z')
    );
    expect(key).toMatch(
      /^elftia-media\/image-input\/2026\/11\/05\/[0-9a-f-]{36}-Harbor-Shot\.png$/u
    );
  });
});

describe('object storage publisher', () => {
  it('uploads via a presigned PUT and returns a signed GET URL for the same key', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const publisher = createObjectStoragePublisher({
      kind: 's3',
      target: {
        bucket: 'media-bucket',
        endpoint: 'https://account.r2.cloudflarestorage.com',
        region: 'auto',
        prefix: 'omnicross',
        urlMode: 'signed',
        expiresInSeconds: 900,
        forcePathStyle: true,
      },
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret-example' },
      fetchImpl,
      now: () => new Date('2026-11-05T08:09:10.000Z'),
    });

    const published = await publisher.publish({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'image/png',
      fileName: 'input.png',
      hints: { purpose: 'image-input' },
    });

    const [uploadUrl, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(uploadUrl).pathname).toBe(
      `/media-bucket/${published.key.split('/').map(encodeURIComponent).join('/')}`
    );
    expect(new URL(uploadUrl).searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(init.method).toBe('PUT');
    expect(new Headers(init.headers).get('content-type')).toBe('image/png');
    expect(published.url).toMatch(/X-Amz-Expires=900/u);
    expect(new URL(published.url).pathname).toBe(
      `/media-bucket/${published.key.split('/').map(encodeURIComponent).join('/')}`
    );
  });

  it('surfaces the upstream status and body when the upload fails', async () => {
    const fetchImpl = vi.fn(async () => new Response('AccessDenied', { status: 403 }));
    const publisher = createObjectStoragePublisher({
      kind: 'oss',
      target: { bucket: 'media-bucket', urlMode: 'signed' },
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret-example' },
      fetchImpl,
    });
    await expect(
      publisher.publish({ bytes: new Uint8Array([1]), contentType: 'image/png', fileName: 'x.png' })
    ).rejects.toThrow('Object storage upload failed: HTTP 403 AccessDenied');
  });
});
