import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

import type {
  ImageApiContributions,
  ResponsesImageGenerationContribution,
} from '@omnicross/core/image-generation';
import type { OpenAIOperationHandlerContext } from '@omnicross/core/openai-operation';
import {
  DEFAULT_IMAGES_SERVER_CONFIG,
  IMAGE_SERVER_HARD_CEILINGS,
  type ImagesServerConfig,
} from '@omnicross/core/outbound-api';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createImageRuntimeConfigController,
} from '../ImageRuntimeConfigController';
import {
  FileCodexImageCapabilityEvidenceSource,
  FileCodexImageCapabilityEvidenceManifestOwner,
} from '../FileCodexImageCapabilityEvidenceSource';
import type {
  ImageRuntimeGenerationFactoryOptions,
  ProductionImageRuntimeGeneration,
} from '../ImageRuntimeGenerationFactory';
import {
  ImageRuntimeManager,
  type PreparedImageRuntimeGeneration,
} from '../ImageRuntimeManager';
import {
  ImageStorageMountCatalog,
  MountedImageReferenceStore,
  MountedResponsesImageStateStore,
} from '../ImageStorageMountCatalog';

const sandboxes: string[] = [];

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'omnicross-image-runtime-config-'));
  sandboxes.push(root);
  return root;
}

afterEach(() => {
  const temporaryRoot = resolve(tmpdir());
  for (const root of sandboxes.splice(0)) {
    const absolute = resolve(root);
    const rel = relative(temporaryRoot, absolute);
    if (!isAbsolute(absolute) || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('refusing to clean an unverified image-runtime-config sandbox');
    }
    rmSync(absolute, { recursive: true, force: true });
  }
});

function storage(root: string) {
  const applicationData = join(root, 'private-data');
  const workspace = join(root, 'workspace');
  const home = join(root, 'home');
  const systemTemporary = join(root, 'system-temporary');
  for (const path of [applicationData, workspace, home, systemTemporary]) {
    mkdirSync(path, { recursive: true });
  }
  const catalog = new ImageStorageMountCatalog({
    pathOptions: {
      configPath: join(applicationData, 'config.json'),
      processDirectory: workspace,
      userHome: home,
      temporaryDirectory: systemTemporary,
    },
    referenceLimits: {
      ttlMs: DEFAULT_IMAGES_SERVER_CONFIG.references.ttlMs,
      maxArtifactBytes: DEFAULT_IMAGES_SERVER_CONFIG.references.maxArtifactBytes,
      maxTotalBytes: DEFAULT_IMAGES_SERVER_CONFIG.references.maxTotalBytes,
      maxTenantBytes: DEFAULT_IMAGES_SERVER_CONFIG.references.maxTenantBytes,
      maxEntries: DEFAULT_IMAGES_SERVER_CONFIG.references.maxEntries,
      maxTombstones: DEFAULT_IMAGES_SERVER_CONFIG.references.maxTombstones,
      tombstoneTtlMs: DEFAULT_IMAGES_SERVER_CONFIG.references.tombstoneTtlMs,
    },
    responsesStateLimits: {
      maxCalls: DEFAULT_IMAGES_SERVER_CONFIG.references.maxCalls,
      maxResponses: DEFAULT_IMAGES_SERVER_CONFIG.references.maxResponses,
      maxTombstones: DEFAULT_IMAGES_SERVER_CONFIG.references.maxTombstones,
      tombstoneTtlMs: DEFAULT_IMAGES_SERVER_CONFIG.references.tombstoneTtlMs,
    },
  });
  return {
    catalog,
    references: new MountedImageReferenceStore(catalog),
    state: new MountedResponsesImageStateStore(catalog),
  };
}

function config(options: {
  enabled?: boolean;
  model?: string;
  storageRoot?: string;
  remote?: boolean;
  evidenceTtlMs?: number;
} = {}): ImagesServerConfig {
  return {
    ...DEFAULT_IMAGES_SERVER_CONFIG,
    enabled: options.enabled ?? true,
    defaultModel: options.model ?? 'gpt-image-2',
    modelAliases: { latest: options.model ?? 'gpt-image-2' },
    account: { group: 'configured-group', fallback: 'pool' },
    queue: {
      maxConcurrentJobsPerAccount: 2,
      maxQueuedJobs: 7,
      queueTimeoutMs: 12_345,
      generationTimeoutMs: 23_456,
    },
    temporary: { ...DEFAULT_IMAGES_SERVER_CONFIG.temporary, maxActiveScopes: 7 },
    limits: {
      ...DEFAULT_IMAGES_SERVER_CONFIG.limits,
      maxJsonBytes: DEFAULT_IMAGES_SERVER_CONFIG.limits.maxJsonBytes - 1,
    },
    references: {
      ...DEFAULT_IMAGES_SERVER_CONFIG.references,
      ...(options.storageRoot ? { storageRoot: options.storageRoot } : {}),
    },
    remote: { enabled: options.remote ?? false },
    evidenceTtlMs: options.evidenceTtlMs ?? 12_000,
  };
}

function hosted(label: string): ResponsesImageGenerationContribution & { readonly label: string } {
  return {
    label,
    toolType: 'image_generation',
    inspectRequest: vi.fn(() => { throw new Error('not used'); }),
    validateSelection: vi.fn(),
    createRequestScope: vi.fn(async () => { throw new Error('not used'); }),
  };
}

type EvidenceHostedContribution = ResponsesImageGenerationContribution & Readonly<{
  evidenceAvailable(): Promise<boolean>;
}>;

async function evidenceAvailable(
  source: FileCodexImageCapabilityEvidenceSource,
): Promise<boolean> {
  const evidence = await source.resolve({
    accountId: 'generation-account',
    signal: new AbortController().signal,
  });
  return evidence.account.values?.available === true &&
    evidence.upstream.values?.available === true;
}

function evidenceHosted(
  source: FileCodexImageCapabilityEvidenceSource,
): EvidenceHostedContribution {
  return {
    toolType: 'image_generation',
    inspectRequest: vi.fn(() => { throw new Error('not used'); }),
    validateSelection: vi.fn(),
    createRequestScope: vi.fn(async () => { throw new Error('not used'); }),
    evidenceAvailable: () => evidenceAvailable(source),
  };
}

function generation(
  id: string,
  enabled: boolean,
  options: {
    model?: string;
    generate?: (context: OpenAIOperationHandlerContext) => Promise<void>;
    dispose?: ReturnType<typeof vi.fn>;
    hosted?: ResponsesImageGenerationContribution;
  } = {},
): ProductionImageRuntimeGeneration {
  const dispose = options.dispose ?? vi.fn(async () => undefined);
  if (!enabled) return { id, enabled: false, dispose };
  const generate = Object.freeze({
    operationId: 'images.generate' as const,
    handler: options.generate ?? vi.fn(async () => undefined),
  });
  const edit = Object.freeze({
    operationId: 'images.edit' as const,
    handler: vi.fn(async () => undefined),
  });
  const imageApi: ImageApiContributions = Object.freeze({
    generate,
    edit,
    all: Object.freeze([generate, edit]),
  });
  return {
    id,
    enabled: true,
    imageApi,
    hosted: options.hosted ?? hosted(options.model ?? id),
    hostedRuntime: {
      providerId: 'codex-subscription',
      imageModel: options.model ?? id,
      referenceTtlMs: DEFAULT_IMAGES_SERVER_CONFIG.references.ttlMs,
      maxOutputBytes: DEFAULT_IMAGES_SERVER_CONFIG.limits.maxOutputBytes,
      maxTotalOutputBytes: DEFAULT_IMAGES_SERVER_CONFIG.limits.maxTotalOutputBytes,
      preferredAccountGroup: 'configured-group',
      boundAccountFallbackPolicy: 'pool',
    },
    dispose,
  };
}

function controllerHarness(
  manager: ImageRuntimeManager,
  root: string,
  createGeneration: (
    options: ImageRuntimeGenerationFactoryOptions,
  ) => ProductionImageRuntimeGeneration,
) {
  const shared = storage(root);
  const controller = createImageRuntimeConfigController({
    manager,
    subscriptionAccounts: { getStrategy: vi.fn() },
    storageCatalog: shared.catalog,
    referenceStore: shared.references,
    stateStore: shared.state,
    provenRemoteResolver: {} as never,
    createGeneration: createGeneration as never,
  });
  return { ...shared, controller };
}

describe('ImageRuntimeConfigController', () => {
  it('prepares every runtime policy dimension and publishes/rolls back storage atomically', async () => {
    const root = sandbox();
    const manager = new ImageRuntimeManager({
      id: 'initial-disabled',
      enabled: false,
      dispose: vi.fn(async () => undefined),
    });
    let captured: ImageRuntimeGenerationFactoryOptions | undefined;
    const candidateDispose = vi.fn(async () => undefined);
    const targetStorageRoot = join(root, 'replacement-storage');
    const targetConfig = config({
      model: 'gpt-image-2-snapshot',
      storageRoot: targetStorageRoot,
      remote: true,
    });
    const shared = controllerHarness(manager, root, (options) => {
      captured = options;
      return generation(options.generationId, options.config.enabled, {
        model: options.config.defaultModel,
        dispose: candidateDispose,
      });
    });
    const previousRoot = shared.catalog.active().resolver.paths.durableRoot;

    const prepared = await shared.controller.prepareConfig(targetConfig);
    expect(shared.catalog.active().resolver.paths.durableRoot).toBe(previousRoot);
    expect(manager.status().current.generationId).toBe('initial-disabled');
    expect(captured?.config).toMatchObject({
      enabled: true,
      provider: 'codex-subscription',
      defaultModel: 'gpt-image-2-snapshot',
      modelAliases: { latest: 'gpt-image-2-snapshot' },
      account: { group: 'configured-group', fallback: 'pool' },
      queue: { queueTimeoutMs: 12_345, generationTimeoutMs: 23_456 },
      temporary: { maxActiveScopes: 7 },
      limits: { maxJsonBytes: DEFAULT_IMAGES_SERVER_CONFIG.limits.maxJsonBytes - 1 },
      references: { storageRoot: targetStorageRoot },
      remote: { enabled: true },
      evidenceTtlMs: 12_000,
    });

    prepared.publish();
    expect(shared.catalog.active().resolver.paths.durableRoot).toBe(resolve(targetStorageRoot));
    expect(manager.status().current).toMatchObject({ enabled: true, generationId: 'image-runtime-1' });

    prepared.rollback();
    expect(shared.catalog.active().resolver.paths.durableRoot).toBe(previousRoot);
    expect(manager.status().current.generationId).toBe('initial-disabled');
    await prepared.dispose();
    expect(candidateDispose).toHaveBeenCalledOnce();
    await manager.dispose();
  });

  it('keeps the current generation and active mount when replacement construction fails', async () => {
    const root = sandbox();
    const initialDispose = vi.fn(async () => undefined);
    const manager = new ImageRuntimeManager(generation('still-current', true, {
      dispose: initialDispose,
    }));
    const shared = controllerHarness(manager, root, () => {
      throw new Error('injected replacement failure');
    });
    const previousRoot = shared.catalog.active().resolver.paths.durableRoot;

    await expect(shared.controller.prepareConfig(config({
      model: 'failed-model',
      storageRoot: join(root, 'failed-storage'),
    }))).rejects.toThrow('injected replacement failure');
    expect(manager.status().current.generationId).toBe('still-current');
    expect(shared.catalog.active().resolver.paths.durableRoot).toBe(previousRoot);
    expect(initialDispose).not.toHaveBeenCalled();
    await manager.dispose();
    expect(initialDispose).toHaveBeenCalledOnce();
  });

  it('keeps queued/active HTTP and hosted work on the old snapshot until its final lease', async () => {
    const root = sandbox();
    let finishOld!: () => void;
    let enteredOld!: () => void;
    const oldEntered = new Promise<void>((resolveEntered) => { enteredOld = resolveEntered; });
    const oldFinish = new Promise<void>((resolveFinish) => { finishOld = resolveFinish; });
    const seenModels: string[] = [];
    const oldDispose = vi.fn(async () => undefined);
    const oldHosted = hosted('old-model');
    const manager = new ImageRuntimeManager(generation('old-config', true, {
      model: 'old-model',
      hosted: oldHosted,
      dispose: oldDispose,
      generate: async () => {
        seenModels.push('old-model');
        enteredOld();
        await oldFinish;
      },
    }));
    const shared = controllerHarness(manager, root, (options) => generation(
      options.generationId,
      options.config.enabled,
      {
        model: options.config.defaultModel,
        generate: async () => { seenModels.push(options.config.defaultModel); },
      },
    ));
    const stableHandler = manager.contributions.generate.handler;
    const oldHttp = stableHandler({} as OpenAIOperationHandlerContext);
    await oldEntered;
    const oldHostedLease = await manager.acquireHosted();

    const prepared = await shared.controller.prepareConfig(config({ model: 'new-model' }));
    prepared.publish();
    await stableHandler({} as OpenAIOperationHandlerContext);
    const newHostedLease = await manager.acquireHosted();
    expect((oldHostedLease.contribution as ReturnType<typeof hosted>).label).toBe('old-model');
    expect((newHostedLease.contribution as ReturnType<typeof hosted>).label).toBe('new-model');
    expect(seenModels).toEqual(['old-model', 'new-model']);
    expect(oldDispose).not.toHaveBeenCalled();

    await oldHostedLease.release();
    expect(oldDispose).not.toHaveBeenCalled();
    finishOld();
    await oldHttp;
    expect(oldDispose).toHaveBeenCalledOnce();
    await newHostedLease.release();
    await manager.dispose();
  });

  it('pins HTTP and hosted views when an independent doctor creates the first evidence row', async () => {
    const root = sandbox();
    const shared = storage(root);
    let now = 1_000;
    const evidenceOwner = new FileCodexImageCapabilityEvidenceManifestOwner({
      paths: shared.catalog.active().resolver,
      now: () => now,
      hmacSalt: Buffer.alloc(32, 17),
    });
    const generationNSource = evidenceOwner.createSource(12_000);

    let enterGenerationN!: () => void;
    let continueGenerationN!: () => void;
    const generationNEntered = new Promise<void>((resolveEntered) => {
      enterGenerationN = resolveEntered;
    });
    const generationNContinue = new Promise<void>((resolveContinue) => {
      continueGenerationN = resolveContinue;
    });
    let generationNHttpAvailable: boolean | undefined;
    let generationNPlusOneHttpAvailable: boolean | undefined;
    const manager = new ImageRuntimeManager(generation('generation-n', true, {
      hosted: evidenceHosted(generationNSource),
      dispose: vi.fn(() => generationNSource.dispose()),
      generate: async () => {
        enterGenerationN();
        await generationNContinue;
        generationNHttpAvailable = await evidenceAvailable(generationNSource);
      },
    }));
    let generationNPlusOneSource: FileCodexImageCapabilityEvidenceSource | undefined;
    const controller = createImageRuntimeConfigController({
      manager,
      subscriptionAccounts: { getStrategy: vi.fn() },
      storageCatalog: shared.catalog,
      referenceStore: shared.references,
      stateStore: shared.state,
      evidenceOwner,
      createGeneration: ((options: ImageRuntimeGenerationFactoryOptions) => {
        if (!options.evidenceSource) throw new Error('expected generation-scoped evidence view');
        const source = options.evidenceSource;
        generationNPlusOneSource = source;
        return generation(options.generationId, true, {
          hosted: evidenceHosted(source),
          dispose: vi.fn(() => source.dispose()),
          generate: async () => {
            generationNPlusOneHttpAvailable = await evidenceAvailable(source);
          },
        });
      }) as never,
    });
    const stableHandler = manager.contributions.generate.handler;
    const generationNHttp = stableHandler({} as OpenAIOperationHandlerContext);
    await generationNEntered;
    const generationNHosted = await manager.acquireHosted();

    const prepared = await controller.prepareConfig(config({ evidenceTtlMs: 4_000 }));
    prepared.publish();
    if (!generationNPlusOneSource) throw new Error('expected replacement evidence view');
    now = 2_000;
    const independentDoctor = new FileCodexImageCapabilityEvidenceSource({
      paths: shared.catalog.active().resolver,
      ttlMs: 4_000,
      now: () => now,
      hmacSalt: Buffer.alloc(32, 17),
    });
    await independentDoctor.recordSuccessfulVerification({
      accountId: 'generation-account',
      model: 'gpt-image-2',
      request: {
        action: 'generate',
        n: 1,
        quality: 'low',
        size: 'auto',
        background: 'opaque',
        outputFormat: 'png',
        moderation: 'auto',
        stream: false,
        partialImages: 0,
      },
    });
    now = 6_001;
    await expect(evidenceOwner.cleanup(now, 10)).resolves.toEqual({
      entriesRemoved: 0,
      bytesRemoved: 0,
    });
    await expect(generationNSource.resolve({
      accountId: 'generation-account',
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      account: { verifiedAt: 2_000, expiresAt: 14_000, values: { available: true } },
    });
    await expect(generationNPlusOneSource.resolve({
      accountId: 'generation-account',
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      account: { verifiedAt: 2_000, expiresAt: 6_000 },
    });
    await stableHandler({} as OpenAIOperationHandlerContext);
    const generationNPlusOneHosted = await manager.acquireHosted();
    expect(generationNPlusOneHttpAvailable).toBe(false);
    await expect(
      (generationNPlusOneHosted.contribution as EvidenceHostedContribution).evidenceAvailable(),
    ).resolves.toBe(false);

    continueGenerationN();
    await generationNHttp;
    expect(generationNHttpAvailable).toBe(true);
    await expect(
      (generationNHosted.contribution as EvidenceHostedContribution).evidenceAvailable(),
    ).resolves.toBe(true);

    await generationNPlusOneHosted.release();
    prepared.rollback();
    await stableHandler({} as OpenAIOperationHandlerContext);
    const rollbackHosted = await manager.acquireHosted();
    expect(generationNHttpAvailable).toBe(true);
    expect(rollbackHosted.generationId).toBe('generation-n');
    await expect(
      (rollbackHosted.contribution as EvidenceHostedContribution).evidenceAvailable(),
    ).resolves.toBe(true);

    await rollbackHosted.release();
    await generationNHosted.release();
    await prepared.dispose();
    await manager.dispose();
    now = 14_001;
    await expect(evidenceOwner.cleanup(now, 10)).resolves.toMatchObject({ entriesRemoved: 0 });

    const physicalDeadline = 2_000 + IMAGE_SERVER_HARD_CEILINGS.evidenceTtlMs;
    now = physicalDeadline;
    await expect(evidenceOwner.cleanup(now, 10)).resolves.toMatchObject({ entriesRemoved: 1 });
    independentDoctor.dispose();

    const postDisposalShortView = evidenceOwner.createSource(4_000);
    now = physicalDeadline + 1_000;
    await postDisposalShortView.recordSuccessfulVerification({
      accountId: 'generation-account',
      model: 'gpt-image-2',
      request: {
        action: 'generate',
        n: 1,
        quality: 'low',
        size: 'auto',
        background: 'opaque',
        outputFormat: 'png',
        moderation: 'auto',
        stream: false,
        partialImages: 0,
      },
    });
    postDisposalShortView.dispose();
    now += 4_001;
    await expect(evidenceOwner.cleanup(now, 10)).resolves.toMatchObject({ entriesRemoved: 0 });
    now = physicalDeadline + 1_000 + IMAGE_SERVER_HARD_CEILINGS.evidenceTtlMs;
    await expect(evidenceOwner.cleanup(now, 10)).resolves.toMatchObject({ entriesRemoved: 1 });
  });
});
