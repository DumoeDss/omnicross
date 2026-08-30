import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OpenAIOperationHandlerContext } from '@omnicross/core/openai-operation';
import {
  DEFAULT_IMAGES_SERVER_CONFIG,
  type ImagesServerConfig,
} from '@omnicross/core/outbound-api';
import type { AuthStrategy } from '@omnicross/subscriptions';

import type { FileImageReferenceStoreLimits } from '../FileImageReferenceStore';
import type { FileResponsesImageStateStoreLimits } from '../FileResponsesImageStateStore';
import { createImageRuntimeGeneration } from '../ImageRuntimeGenerationFactory';
import {
  ImageStorageMountCatalog,
  MountedImageReferenceStore,
  MountedResponsesImageStateStore,
} from '../ImageStorageMountCatalog';

const sandboxes: string[] = [];

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'omnicross-image-runtime-factory-'));
  sandboxes.push(root);
  return root;
}

afterEach(() => {
  const temporaryRoot = resolve(tmpdir());
  for (const root of sandboxes.splice(0)) {
    const absolute = resolve(root);
    const rel = relative(temporaryRoot, absolute);
    if (!isAbsolute(absolute) || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('refusing to clean an unverified image-runtime sandbox');
    }
    rmSync(absolute, { recursive: true, force: true });
  }
});

function config(enabled = true): ImagesServerConfig {
  return {
    ...DEFAULT_IMAGES_SERVER_CONFIG,
    enabled,
    modelAliases: { latest: 'gpt-image-2' },
    account: { group: 'configured-group', fallback: 'pool' },
    queue: { ...DEFAULT_IMAGES_SERVER_CONFIG.queue },
    temporary: { ...DEFAULT_IMAGES_SERVER_CONFIG.temporary },
    limits: { ...DEFAULT_IMAGES_SERVER_CONFIG.limits },
    references: { ...DEFAULT_IMAGES_SERVER_CONFIG.references },
    remote: { enabled: false },
  };
}

function storage(root: string) {
  const applicationData = join(root, 'private-data');
  const workspace = join(root, 'workspace');
  const home = join(root, 'home');
  const systemTemporary = join(root, 'system-temporary');
  for (const path of [applicationData, workspace, home, systemTemporary]) {
    mkdirSync(path, { recursive: true });
  }
  const referenceLimits: FileImageReferenceStoreLimits = {
    ttlMs: 10_000,
    maxArtifactBytes: 1024,
    maxTotalBytes: 4096,
    maxTenantBytes: 2048,
    maxEntries: 32,
    maxTombstones: 32,
    tombstoneTtlMs: 10_000,
  };
  const responsesStateLimits: FileResponsesImageStateStoreLimits = {
    maxCalls: 32,
    maxResponses: 32,
    maxTombstones: 32,
    tombstoneTtlMs: 10_000,
  };
  const catalog = new ImageStorageMountCatalog({
    pathOptions: {
      configPath: join(applicationData, 'config.json'),
      processDirectory: workspace,
      userHome: home,
      temporaryDirectory: systemTemporary,
    },
    activeStorageRoot: join(root, 'durable-storage'),
    referenceLimits,
    responsesStateLimits,
    now: () => 1_000,
  });
  return {
    catalog,
    paths: catalog.active().resolver,
    referenceStore: new MountedImageReferenceStore(catalog),
    stateStore: new MountedResponsesImageStateStore(catalog),
  };
}

function authStrategy() {
  const applyHeaders = vi.fn(async (
    headers: Record<string, string>,
    hints?: Parameters<AuthStrategy['applyHeaders']>[1],
  ) => {
    headers.Authorization = 'Bearer SUBSCRIPTION_CREDENTIAL_SENTINEL';
    hints?.reportSelection?.('RAW_ACCOUNT_ID_SENTINEL', true);
  });
  const strategy: AuthStrategy = {
    kind: 'oauth-bearer',
    providerId: 'codex',
    applyHeaders,
    async onUnauthorized() { return false; },
    async describeStatus() { return { providerId: 'codex', ok: true }; },
  };
  return { strategy, applyHeaders };
}

function handlerContext(apiKeyId: string): OpenAIOperationHandlerContext {
  return {
    route: { apiKeyId } as OpenAIOperationHandlerContext['route'],
    request: { headers: { authorization: 'Bearer RAW_INBOUND_SENTINEL' } },
  } as OpenAIOperationHandlerContext;
}

describe('production image runtime generation factory', () => {
  it('composes one provider/orchestrator and shared mounted stores for HTTP and hosted use', async () => {
    const sharedStorage = storage(sandbox());
    const auth = authStrategy();
    const getStrategy = vi.fn(() => auth.strategy);
    const activeMountId = sharedStorage.catalog.active().id;
    const generation = createImageRuntimeGeneration({
      generationId: 'generation-1',
      config: config(),
      subscriptionAccounts: { getStrategy },
      storage: sharedStorage,
      privateHmacKey: Buffer.alloc(32, 19),
      now: () => 1_000,
    });
    if (!generation.enabled || !generation.components) throw new Error('expected enabled generation');

    expect(getStrategy).toHaveBeenCalledOnce();
    expect(getStrategy).toHaveBeenCalledWith('codex');
    expect(generation.imageApi.all.map((entry) => entry.operationId))
      .toEqual(['images.generate', 'images.edit']);
    expect(generation.hosted.toolType).toBe('image_generation');
    expect(generation.components.providerRegistry.list().map((provider) => provider.id))
      .toEqual(['codex-subscription']);
    expect(generation.components.referenceStore).toBe(sharedStorage.referenceStore);
    expect(generation.components.stateStore).toBe(sharedStorage.stateStore);
    expect(sharedStorage.catalog.active().id).toBe(activeMountId);
    expect(generation.components.evidenceSource.status()).toMatchObject({ entries: 0, freshEntries: 0 });
    expect(generation.components.scheduler.status()).toMatchObject({
      activeJobs: 0,
      waitingJobs: 0,
      accepting: true,
    });

    const runtime = await generation.components.runtimeResolver.resolve(handlerContext('trusted-key'));
    expect(runtime).toMatchObject({
      tenantId: 'trusted-key',
      preferredAccountGroup: 'configured-group',
      boundAccountFallbackPolicy: 'pool',
      referenceStore: sharedStorage.referenceStore,
    });
    expect(runtime.modelAliases.get('latest')).toBe('gpt-image-2');

    await generation.components.orchestrator.getCapabilities('codex-subscription', {
      requestId: 'request-safe',
      tenantId: runtime.tenantId,
      signal: new AbortController().signal,
      preferredAccountGroup: runtime.preferredAccountGroup,
      boundAccountFallbackPolicy: runtime.boundAccountFallbackPolicy,
    });
    expect(auth.applyHeaders).toHaveBeenCalledOnce();
    expect(auth.applyHeaders.mock.calls[0]?.[1]).toMatchObject({
      preferredAccountGroup: 'configured-group',
      boundAccountFallbackPolicy: 'pool',
    });

    await generation.dispose();
    await generation.dispose();
    expect(generation.components.scheduler.status()).toMatchObject({
      accepting: false,
      shuttingDown: true,
    });
    await expect(Promise.resolve().then(() =>
      generation.components!.runtimeResolver.resolve(handlerContext('trusted-key'))))
      .rejects.toMatchObject({ code: 'unsupported_capability' });
  });

  it('keeps disabled generations dormant and never resolves a subscription strategy', () => {
    const sharedStorage = storage(sandbox());
    const getStrategy = vi.fn(() => null);
    const generation = createImageRuntimeGeneration({
      generationId: 'generation-disabled',
      config: config(false),
      subscriptionAccounts: { getStrategy },
      storage: sharedStorage,
      privateHmacKey: Buffer.alloc(32, 23),
    });

    expect(generation).toMatchObject({ enabled: false, id: 'generation-disabled' });
    expect(getStrategy).not.toHaveBeenCalled();
  });

  it('inspects cached account-bound evidence without dispatching an image', async () => {
    let now = 1_000;
    const sharedStorage = storage(sandbox());
    const auth = authStrategy();
    const generation = createImageRuntimeGeneration({
      generationId: 'generation-capability',
      config: config(),
      subscriptionAccounts: { getStrategy: () => auth.strategy },
      storage: sharedStorage,
      privateHmacKey: Buffer.alloc(32, 27),
      now: () => now,
    });
    if (!generation.enabled || !generation.components || !generation.inspectCapability) {
      throw new Error('expected inspectable enabled generation');
    }

    await expect(generation.inspectCapability('images-key')).resolves.toMatchObject({
      enabled: true,
      available: false,
      providerId: 'codex-subscription',
      model: 'gpt-image-2',
      reason: 'account_unverified',
    });
    await generation.components.evidenceSource.recordSuccessfulVerification({
      accountId: 'RAW_ACCOUNT_ID_SENTINEL',
      model: 'gpt-image-2',
      request: {
        action: 'generate',
        n: 1,
        quality: 'low',
        size: 'auto',
        background: 'auto',
        outputFormat: 'png',
        moderation: 'auto',
        stream: false,
        partialImages: 0,
      },
    });
    await expect(generation.inspectCapability('images-key')).resolves.toMatchObject({
      enabled: true,
      available: true,
      providerId: 'codex-subscription',
      model: 'gpt-image-2',
    });

    now += config().evidenceTtlMs + 1;
    await expect(generation.inspectCapability('images-key')).resolves.toMatchObject({
      enabled: true,
      available: false,
      reason: 'account_unverified',
    });
    expect(auth.applyHeaders).toHaveBeenCalledTimes(3);
    await generation.dispose();
  });

  it('fails construction closed when auth or remote policy is not composed', () => {
    const sharedStorage = storage(sandbox());
    expect(() => createImageRuntimeGeneration({
      generationId: 'generation-no-auth',
      config: config(),
      subscriptionAccounts: { getStrategy: () => null },
      storage: sharedStorage,
      privateHmacKey: Buffer.alloc(32, 29),
    })).toThrow(/Codex subscription strategy/u);

    expect(() => createImageRuntimeGeneration({
      generationId: 'generation-no-remote-proof',
      config: { ...config(), remote: { enabled: true } },
      subscriptionAccounts: { getStrategy: () => authStrategy().strategy },
      storage: sharedStorage,
      privateHmacKey: Buffer.alloc(32, 31),
    })).toThrow(/proven resolver/u);
  });
});
