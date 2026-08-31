import { createHmac } from 'node:crypto';

import {
  ImageGenerationError,
  type ImageApiRuntime,
  type ImageApiRuntimeResolver,
  type ImageReferenceStore,
  type RemoteImageAssetResolver,
} from '@omnicross/core/image-generation';
import type { ImagesServerConfig } from '@omnicross/core/outbound-api';

const USER_FINGERPRINT_DOMAIN = Buffer.from(
  'omnicross:image-api:user-fingerprint:v1\0',
  'utf8',
);

export interface TrustedImageApiRuntimeResolverOptions {
  readonly config: ImagesServerConfig;
  readonly referenceStore: ImageReferenceStore;
  /** Persistent private daemon key material. It is copied on construction. */
  readonly hmacKey: Uint8Array;
  /** Present only when the host has proved the complete remote-fetch policy. */
  readonly provenRemoteResolver?: RemoteImageAssetResolver;
}

export interface TrustedImageApiRuntimeResolver {
  readonly resolve: ImageApiRuntimeResolver;
  dispose(): void;
}

function trustedTenantId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) {
    throw new ImageGenerationError('invalid_api_key');
  }
  return value;
}

function trustedRouteTenantId(
  route: Parameters<ImageApiRuntimeResolver>[0]['route'],
): string {
  if (route.apiKeyId) return trustedTenantId(route.apiKeyId);
  const leaseId = route.routeLease?.leaseId;
  return trustedTenantId(leaseId ? `route-lease:${leaseId}` : undefined);
}

/**
 * Resolves only daemon-authenticated route state. Named outbound keys retain
 * their stable key-id tenant; ephemeral Route Lease traffic falls back to the
 * authenticated lease id and remains isolated from other leases. Request
 * headers, including an inbound bearer, are deliberately outside the resolver's
 * identity inputs.
 */
export function createTrustedImageApiRuntimeResolver(
  options: TrustedImageApiRuntimeResolverOptions,
): TrustedImageApiRuntimeResolver {
  if (options.hmacKey.byteLength !== 32) {
    throw new TypeError('image user-fingerprint HMAC key is invalid');
  }
  if (options.config.remote.enabled && !options.provenRemoteResolver) {
    throw new TypeError('enabled image remote loading requires a proven resolver');
  }

  const hmacKey = Buffer.from(options.hmacKey);
  const modelAliases = new Map(Object.entries(options.config.modelAliases));
  const limits = Object.freeze({ ...options.config.limits });
  const providerId = options.config.provider;
  const defaultModel = options.config.defaultModel;
  const referenceStore = options.referenceStore;
  const retention = Object.freeze({
    enabled: true as const,
    ttlMs: options.config.references.ttlMs,
  });
  const preferredAccountId = options.config.account.id;
  const preferredAccountGroup = options.config.account.group;
  const boundAccountFallbackPolicy = options.config.account.fallback;
  const remoteResolver = options.config.remote.enabled
    ? options.provenRemoteResolver
    : undefined;
  let disposed = false;

  return Object.freeze({
    resolve: (context: Parameters<ImageApiRuntimeResolver>[0]): ImageApiRuntime => {
      if (disposed) throw new ImageGenerationError('unsupported_capability');
      const tenantId = trustedRouteTenantId(context.route);
      const fingerprintUser = (value: string): string => `hmac:${createHmac('sha256', hmacKey)
        .update(USER_FINGERPRINT_DOMAIN)
        .update(tenantId, 'utf8')
        .update('\0', 'utf8')
        .update(value, 'utf8')
        .digest('hex')}`;

      return Object.freeze({
        tenantId,
        providerId,
        defaultModel,
        modelAliases,
        limits,
        ...(preferredAccountId ? { preferredAccountId } : {}),
        ...(preferredAccountGroup ? { preferredAccountGroup } : {}),
        boundAccountFallbackPolicy,
        referenceStore,
        ...(remoteResolver ? { remoteResolver } : {}),
        fingerprintUser,
        retention,
      });
    },
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      hmacKey.fill(0);
    },
  });
}
