import { describe, expect, it, vi } from 'vitest';

import {
  InMemoryImageReferenceStore,
  type RemoteImageAssetResolver,
} from '@omnicross/core/image-generation';
import type { OpenAIOperationHandlerContext } from '@omnicross/core/openai-operation';
import {
  DEFAULT_IMAGES_SERVER_CONFIG,
  type ImagesServerConfig,
} from '@omnicross/core/outbound-api';

import { createTrustedImageApiRuntimeResolver } from '../ImageApiRuntimeResolver';

function config(overrides: Partial<ImagesServerConfig> = {}): ImagesServerConfig {
  return {
    ...DEFAULT_IMAGES_SERVER_CONFIG,
    enabled: true,
    modelAliases: { latest: 'gpt-image-2' },
    account: { id: 'configured-account', fallback: 'pool' },
    queue: { ...DEFAULT_IMAGES_SERVER_CONFIG.queue },
    temporary: { ...DEFAULT_IMAGES_SERVER_CONFIG.temporary },
    limits: { ...DEFAULT_IMAGES_SERVER_CONFIG.limits },
    references: { ...DEFAULT_IMAGES_SERVER_CONFIG.references },
    remote: { ...DEFAULT_IMAGES_SERVER_CONFIG.remote },
    ...overrides,
  };
}

function context(
  apiKeyId: string | undefined,
  bearer = 'Bearer RAW_INBOUND_BEARER_SENTINEL',
  routeLeaseId?: string,
): OpenAIOperationHandlerContext {
  return {
    route: {
      apiKeyId,
      ...(routeLeaseId ? { routeLease: { leaseId: routeLeaseId, consumer: 'test-consumer' } } : {}),
      preferredAccountId: 'UNTRUSTED_ROUTE_ACCOUNT_SENTINEL',
      preferredAccountGroup: 'UNTRUSTED_ROUTE_GROUP_SENTINEL',
      boundAccountFallbackPolicy: 'strict',
    } as OpenAIOperationHandlerContext['route'],
    request: {
      headers: { authorization: bearer, 'x-tenant': 'UNTRUSTED_HEADER_TENANT_SENTINEL' },
    } as OpenAIOperationHandlerContext['request'],
  } as OpenAIOperationHandlerContext;
}

describe('trusted Images API runtime resolver', () => {
  it('uses only apiKeyId for tenant identity and applies configured account/model policy', async () => {
    const referenceStore = new InMemoryImageReferenceStore();
    const resolver = createTrustedImageApiRuntimeResolver({
      config: config(),
      referenceStore,
      hmacKey: Buffer.alloc(32, 7),
    });
    const runtime = await resolver.resolve(context('trusted-key-id'));

    expect(runtime).toMatchObject({
      tenantId: 'trusted-key-id',
      providerId: 'codex-subscription',
      defaultModel: 'gpt-image-2',
      preferredAccountId: 'configured-account',
      boundAccountFallbackPolicy: 'pool',
      referenceStore,
      retention: { enabled: true, ttlMs: DEFAULT_IMAGES_SERVER_CONFIG.references.ttlMs },
    });
    expect(runtime).not.toHaveProperty('preferredAccountGroup');
    expect(runtime.modelAliases.get('latest')).toBe('gpt-image-2');
    expect(runtime.remoteResolver).toBeUndefined();
    const serialized = JSON.stringify(runtime);
    expect(serialized).not.toContain('RAW_INBOUND_BEARER_SENTINEL');
    expect(serialized).not.toContain('UNTRUSTED_ROUTE_ACCOUNT_SENTINEL');
    expect(serialized).not.toContain('UNTRUSTED_HEADER_TENANT_SENTINEL');
    resolver.dispose();
  });

  it('uses the authenticated Route Lease id when no outbound key id exists', async () => {
    const resolver = createTrustedImageApiRuntimeResolver({
      config: config(),
      referenceStore: new InMemoryImageReferenceStore(),
      hmacKey: Buffer.alloc(32, 9),
    });
    const runtime = await resolver.resolve(context(
      undefined,
      'Bearer UNTRUSTED_ROUTE_TOKEN_SENTINEL',
      '12345678-1234-4234-8234-123456789abc',
    ));

    expect(runtime.tenantId).toBe('route-lease:12345678-1234-4234-8234-123456789abc');
    expect(JSON.stringify(runtime)).not.toContain('UNTRUSTED_ROUTE_TOKEN_SENTINEL');
    resolver.dispose();
  });

  it('creates tenant-scoped keyed fingerprints without retaining the raw user', async () => {
    const resolver = createTrustedImageApiRuntimeResolver({
      config: config(),
      referenceStore: new InMemoryImageReferenceStore(),
      hmacKey: Buffer.alloc(32, 11),
    });
    const first = await resolver.resolve(context('tenant-a'));
    const second = await resolver.resolve(context('tenant-b'));
    const rawUser = 'RAW_USER_FINGERPRINT_SENTINEL';
    const firstFingerprint = first.fingerprintUser?.(rawUser);

    expect(firstFingerprint).toMatch(/^hmac:[a-f0-9]{64}$/u);
    expect(first.fingerprintUser?.(rawUser)).toBe(firstFingerprint);
    expect(second.fingerprintUser?.(rawUser)).not.toBe(firstFingerprint);
    expect(firstFingerprint).not.toContain(rawUser);
    resolver.dispose();
    await expect(Promise.resolve().then(() => resolver.resolve(context('tenant-a'))))
      .rejects.toMatchObject({ code: 'unsupported_capability' });
  });

  it.each([undefined, '', '   ', 'x'.repeat(257)])(
    'rejects a missing or invalid trusted tenant identity',
    async (apiKeyId) => {
      const resolver = createTrustedImageApiRuntimeResolver({
        config: config(),
        referenceStore: new InMemoryImageReferenceStore(),
        hmacKey: Buffer.alloc(32, 13),
      });
      await expect(Promise.resolve().then(() => resolver.resolve(context(apiKeyId))))
        .rejects.toMatchObject({ code: 'invalid_api_key' });
      resolver.dispose();
    },
  );

  it('exposes remote resolution only behind the explicit proven-resolver gate', async () => {
    const remoteResolver: RemoteImageAssetResolver = { resolve: vi.fn() };
    expect(() => createTrustedImageApiRuntimeResolver({
      config: config({ remote: { enabled: true } }),
      referenceStore: new InMemoryImageReferenceStore(),
      hmacKey: Buffer.alloc(32, 17),
    })).toThrow(/proven resolver/u);

    const resolver = createTrustedImageApiRuntimeResolver({
      config: config({ remote: { enabled: true } }),
      referenceStore: new InMemoryImageReferenceStore(),
      hmacKey: Buffer.alloc(32, 17),
      provenRemoteResolver: remoteResolver,
    });
    expect((await resolver.resolve(context('tenant-safe'))).remoteResolver).toBe(remoteResolver);
    resolver.dispose();
  });
});
