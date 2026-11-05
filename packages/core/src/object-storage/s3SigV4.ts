/**
 * AWS SigV4 presigning for S3-compatible object storage (AWS S3, Cloudflare R2,
 * Backblaze B2, Wasabi, MinIO). Ported verbatim from Elftia's desktop
 * `public-assets/signatures/s3SigV4.ts` — signature bytes must stay identical
 * across hosts.
 *
 * @module core/object-storage/s3SigV4
 */

import { createHash, createHmac } from 'node:crypto';

import type { ObjectStorageCredentials, ObjectStorageTarget } from './types';

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';

function encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function encodeKey(key: string): string {
  return key.split('/').map(encode).join('/');
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function dateParts(now: Date): { amzDate: string; dateStamp: string } {
  return {
    amzDate: now.toISOString().replace(/[:-]|\.\d{3}/gu, ''),
    dateStamp: now.toISOString().slice(0, 10).replace(/-/gu, ''),
  };
}

function canonicalQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encode(key)}=${encode(value)}`)
    .join('&');
}

function signingKey(secret: string, dateStamp: string, region: string): Buffer {
  const dateKey = hmac(`AWS4${secret}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, SERVICE);
  return hmac(serviceKey, 'aws4_request');
}

function validatedEndpoint(raw: string): URL {
  const endpoint = new URL(raw);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.search || endpoint.hash) {
    throw new Error('Object storage endpoint must be an HTTP(S) origin without query or fragment');
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/u, '');
  return endpoint;
}

export function resolveS3Endpoint(config: ObjectStorageTarget): string {
  if (config.endpoint?.trim()) return config.endpoint.trim();
  const region = config.region?.trim() || 'us-east-1';
  return region === 'us-east-1' ? 'https://s3.amazonaws.com' : `https://s3.${region}.amazonaws.com`;
}

export function buildS3ObjectUrl(config: ObjectStorageTarget, key: string): URL {
  const url = validatedEndpoint(resolveS3Endpoint(config));
  const encodedKey = encodeKey(key);
  const basePath = url.pathname.replace(/\/+$/u, '');
  if (config.forcePathStyle) {
    url.pathname = `${basePath}/${encode(config.bucket)}/${encodedKey}`;
  } else {
    url.hostname = `${config.bucket}.${url.hostname}`;
    url.pathname = `${basePath}/${encodedKey}`;
  }
  return url;
}

export function presignS3Object(input: {
  config: ObjectStorageTarget;
  credentials: ObjectStorageCredentials;
  key: string;
  method: 'GET' | 'PUT';
  expiresInSeconds: number;
  now?: Date;
}): string {
  const url = buildS3ObjectUrl(input.config, input.key);
  const now = input.now ?? new Date();
  const { amzDate, dateStamp } = dateParts(now);
  const region = input.config.region?.trim() || 'us-east-1';
  const scope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;
  const query: Record<string, string> = {
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${input.credentials.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(input.expiresInSeconds),
    'X-Amz-SignedHeaders': 'host',
  };
  if (input.credentials.sessionToken) {
    query['X-Amz-Security-Token'] = input.credentials.sessionToken;
  }
  const canonical = canonicalQuery(query);
  const canonicalRequest = [
    input.method,
    url.pathname,
    canonical,
    `host:${url.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = [ALGORITHM, amzDate, scope, sha256(canonicalRequest)].join('\n');
  const signature = createHmac(
    'sha256',
    signingKey(input.credentials.secretAccessKey, dateStamp, region)
  )
    .update(stringToSign, 'utf8')
    .digest('hex');
  url.search = `${canonical}&X-Amz-Signature=${signature}`;
  return url.toString();
}
