/**
 * Aliyun OSS URL signing. Ported verbatim from Elftia's desktop
 * `public-assets/signatures/ossSignature.ts` — signature bytes must stay
 * identical across hosts.
 *
 * @module core/object-storage/ossSignature
 */

import { createHmac } from 'node:crypto';

import type { ObjectStorageCredentials, ObjectStorageTarget } from './types';

function encodeKey(key: string): string {
  return key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function endpointUrl(config: ObjectStorageTarget): URL {
  const region = config.region?.trim() || 'cn-hangzhou';
  const raw = config.endpoint?.trim() || `https://oss-${region}.aliyuncs.com`;
  const endpoint = new URL(raw);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.search || endpoint.hash) {
    throw new Error('OSS endpoint must be an HTTP(S) origin without query or fragment');
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/u, '');
  return endpoint;
}

export function buildOssObjectUrl(config: ObjectStorageTarget, key: string): URL {
  const url = endpointUrl(config);
  url.hostname = `${config.bucket}.${url.hostname}`;
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/${encodeKey(key)}`;
  return url;
}

export function presignOssObject(input: {
  config: ObjectStorageTarget;
  credentials: ObjectStorageCredentials;
  key: string;
  method: 'GET' | 'PUT';
  expiresInSeconds: number;
  contentType?: string;
  now?: Date;
}): string {
  const url = buildOssObjectUrl(input.config, input.key);
  const expires = Math.floor((input.now ?? new Date()).getTime() / 1000) + input.expiresInSeconds;
  const contentType = input.method === 'PUT' ? (input.contentType ?? '') : '';
  const canonicalResource = `/${input.config.bucket}/${input.key}`;
  const stringToSign = [input.method, '', contentType, String(expires), canonicalResource].join(
    '\n'
  );
  const signature = createHmac('sha1', input.credentials.secretAccessKey)
    .update(stringToSign, 'utf8')
    .digest('base64');
  url.searchParams.set('OSSAccessKeyId', input.credentials.accessKeyId);
  url.searchParams.set('Expires', String(expires));
  url.searchParams.set('Signature', signature);
  if (input.credentials.sessionToken) {
    url.searchParams.set('security-token', input.credentials.sessionToken);
  }
  return url.toString();
}
