/**
 * Object-storage publishing primitives — shared by every host that must hand
 * providers inputs at public URLs (WaveSpeed image edit and the URL-only video
 * APIs). Pure data + pure functions only: no host config store, no secret
 * vault, no provider registry. Hosts own WHERE credentials live and WHEN
 * publishing runs; this module only knows HOW to sign and upload.
 *
 * Ported from Elftia's desktop `public-assets` implementation (signatures and
 * key layout are byte-compatible so both hosts produce interchangeable URLs).
 *
 * @module core/object-storage/types
 */

/** Storage families with distinct request-signing schemes. */
export type ObjectStorageKind = 's3' | 'oss';

/** How download URLs handed to providers are produced. */
export type ObjectStorageUrlMode = 'signed' | 'public';

/** The non-secret half of a storage target — everything except credentials. */
export interface ObjectStorageTarget {
  bucket: string;
  region?: string;
  /** S3-compatible base endpoint; omitted for AWS default addressing. */
  endpoint?: string;
  /** Key prefix; segments are sanitized by `normalizeObjectPrefix`. */
  prefix?: string;
  /** Public CDN origin used instead of bucket URLs in `public` mode. */
  publicBaseUrl?: string;
  urlMode: ObjectStorageUrlMode;
  /** Signed-URL lifetime in seconds (`signed` mode). */
  expiresInSeconds?: number;
  /** Path-style (`bucket/key`) vs virtual-host (`bucket.host`) addressing. */
  forcePathStyle?: boolean;
}

/** S3-style credentials; OSS ignores `sessionToken` semantics via its own wire. */
export interface ObjectStorageCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** Purpose labels keep per-channel key namespaces tidy (`image-input/...`). */
export interface ObjectStoragePublishHints {
  purpose?: 'image-input' | 'video-input' | 'audio-input' | 'upscale-input';
  fileName?: string;
  contentType?: string;
}

export interface PublishObjectInput {
  /** Fully-buffered bytes; streaming bodies are the host's concern. */
  bytes: Uint8Array;
  contentType: string;
  fileName: string;
  hints?: ObjectStoragePublishHints;
}

export interface PublishedObject {
  key: string;
  /** Provider-ready URL (signed or public per the target's `urlMode`). */
  url: string;
}
