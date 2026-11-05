/**
 * One-shot publisher: buffer in → presigned PUT → provider-ready download URL.
 * The upload/download URL derivation is ported verbatim from Elftia's
 * `PublicAssetStorageService` (`presignUpload` / `resolveDownloadUrl` / `put`);
 * only the credential/state plumbing around it is host-specific and therefore
 * absent here.
 *
 * @module core/object-storage/publisher
 */

import { buildObjectKey } from './objectKey';
import { buildOssObjectUrl, presignOssObject } from './ossSignature';
import { buildS3ObjectUrl, presignS3Object, resolveS3Endpoint } from './s3SigV4';
import type {
  ObjectStorageCredentials,
  ObjectStorageKind,
  ObjectStorageTarget,
  PublishedObject,
  PublishObjectInput,
} from './types';

/** Upload presigns live just long enough for the immediate PUT. */
const DEFAULT_UPLOAD_TTL = 60 * 60;

export interface ObjectStoragePublisher {
  publish(input: PublishObjectInput, signal?: AbortSignal): Promise<PublishedObject>;
}

export interface CreateObjectStoragePublisherInput {
  kind: ObjectStorageKind;
  target: ObjectStorageTarget;
  credentials: ObjectStorageCredentials;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => Date;
}

function joinPublicUrl(base: string, key: string): string {
  return `${base.replace(/\/+$/u, '')}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

function s3Target(target: ObjectStorageTarget): ObjectStorageTarget {
  return { ...target, endpoint: resolveS3Endpoint(target) };
}

export function createObjectStoragePublisher(
  input: CreateObjectStoragePublisherInput
): ObjectStoragePublisher {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const now = input.now ?? (() => new Date());
  return {
    publish: async (object, signal) => {
      signal?.throwIfAborted();
      const key = buildObjectKey(
        input.target.prefix,
        object.fileName,
        object.hints ?? {},
        now()
      );
      const uploadUrl =
        input.kind === 'oss'
          ? presignOssObject({
              config: input.target,
              credentials: input.credentials,
              key,
              method: 'PUT',
              expiresInSeconds: DEFAULT_UPLOAD_TTL,
              contentType: object.contentType,
              now: now(),
            })
          : presignS3Object({
              config: s3Target(input.target),
              credentials: input.credentials,
              key,
              method: 'PUT',
              expiresInSeconds: DEFAULT_UPLOAD_TTL,
              now: now(),
            });
      const response = await fetchImpl(uploadUrl, {
        method: 'PUT',
        body: object.bytes as unknown as BodyInit,
        headers: { 'Content-Type': object.contentType },
        signal,
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        throw new Error(
          `Object storage upload failed: HTTP ${response.status}${detail ? ` ${detail}` : ''}`
        );
      }
      const expiresInSeconds = input.target.expiresInSeconds ?? 3600;
      const url =
        input.target.urlMode === 'public'
          ? input.target.publicBaseUrl
            ? joinPublicUrl(input.target.publicBaseUrl, key)
            : input.kind === 'oss'
              ? buildOssObjectUrl(input.target, key).toString()
              : buildS3ObjectUrl(s3Target(input.target), key).toString()
          : input.kind === 'oss'
            ? presignOssObject({
                config: input.target,
                credentials: input.credentials,
                key,
                method: 'GET',
                expiresInSeconds,
                now: now(),
              })
            : presignS3Object({
                config: s3Target(input.target),
                credentials: input.credentials,
                key,
                method: 'GET',
                expiresInSeconds,
                now: now(),
              });
      return { key, url };
    },
  };
}
