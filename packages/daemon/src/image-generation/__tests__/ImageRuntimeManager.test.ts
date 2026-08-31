import { describe, expect, it, vi } from 'vitest';

import type {
  ImageApiContributions,
  ResponsesImageGenerationContribution,
  ResponsesImageRequestScope,
} from '@omnicross/core/image-generation';
import {
  getOpenAIOperation,
  type OpenAIOperationHandler,
  type OpenAIOperationHandlerContext,
} from '@omnicross/core/openai-operation';

import {
  ImageRuntimeManager,
  type HostedImageRuntimePolicy,
  type PreparedImageRuntimeGeneration,
} from '../ImageRuntimeManager';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function context(
  operationId: 'images.generate' | 'images.edit' = 'images.generate',
): OpenAIOperationHandlerContext {
  return {
    operation: getOpenAIOperation(operationId),
    request: {} as OpenAIOperationHandlerContext['request'],
    response: {} as OpenAIOperationHandlerContext['response'],
    route: {} as OpenAIOperationHandlerContext['route'],
    deps: {} as OpenAIOperationHandlerContext['deps'],
    signal: new AbortController().signal,
  };
}

function hosted(): ResponsesImageGenerationContribution {
  return {
    toolType: 'image_generation',
    inspectRequest: vi.fn(() => { throw new Error('not used'); }),
    validateSelection: vi.fn(),
    createRequestScope: vi.fn(async () => { throw new Error('not used'); }),
  };
}

function enabledGeneration(
  id: string,
  options: {
    generate?: OpenAIOperationHandler;
    edit?: OpenAIOperationHandler;
    dispose?: ReturnType<typeof vi.fn>;
    hosted?: ResponsesImageGenerationContribution;
    hostedRuntime?: HostedImageRuntimePolicy;
    inspectCapability?: NonNullable<
      Extract<PreparedImageRuntimeGeneration, { enabled: true }>['inspectCapability']
    >;
  } = {},
): PreparedImageRuntimeGeneration & { enabled: true } {
  const generate = Object.freeze({
    operationId: 'images.generate' as const,
    handler: options.generate ?? vi.fn(async () => undefined),
  });
  const edit = Object.freeze({
    operationId: 'images.edit' as const,
    handler: options.edit ?? vi.fn(async () => undefined),
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
    hosted: options.hosted ?? hosted(),
    hostedRuntime: options.hostedRuntime ?? {
      providerId: 'codex-subscription',
      imageModel: 'gpt-image-2',
      referenceTtlMs: 60_000,
      maxOutputBytes: 1_024,
      maxTotalOutputBytes: 2_048,
      preferredAccountGroup: 'configured-group',
      boundAccountFallbackPolicy: 'pool',
    },
    ...(options.inspectCapability ? { inspectCapability: options.inspectCapability } : {}),
    dispose: options.dispose ?? vi.fn(async () => undefined),
  };
}

function disabledGeneration(
  id: string,
  dispose = vi.fn(async () => undefined),
): PreparedImageRuntimeGeneration & { enabled: false } {
  return { id, enabled: false, dispose };
}

describe('ImageRuntimeManager', () => {
  it('starts disabled and fails both stable entry points closed', async () => {
    const manager = new ImageRuntimeManager();
    await expect(manager.contributions.generate.handler(context()))
      .rejects.toMatchObject({ code: 'unsupported_capability', status: 501 });
    await expect(manager.acquireHosted())
      .rejects.toMatchObject({ code: 'unsupported_capability' });
    await expect(manager.listAvailableModels('key-disabled')).resolves.toEqual([]);
    expect(manager.status()).toMatchObject({
      disposed: false,
      current: { enabled: false, httpLeases: 0, hostedLeases: 0 },
      draining: [],
    });
    await manager.dispose();
  });

  it('keeps stable HTTP forwarders while an old generation drains', async () => {
    const entered = deferred();
    const finish = deferred();
    const firstDispose = vi.fn(async () => undefined);
    const firstGenerate = vi.fn(async () => {
      entered.resolve();
      await finish.promise;
    });
    const first = enabledGeneration('generation-1', {
      generate: firstGenerate,
      dispose: firstDispose,
    });
    const secondGenerate = vi.fn(async () => undefined);
    const secondDispose = vi.fn(async () => undefined);
    const second = enabledGeneration('generation-2', {
      generate: secondGenerate,
      dispose: secondDispose,
    });
    const manager = new ImageRuntimeManager(first);
    const stableHandler = manager.contributions.generate.handler;
    const running = stableHandler(context());
    await entered.promise;

    const replacement = manager.prepare(second);
    replacement.publish();
    expect(manager.contributions.generate.handler).toBe(stableHandler);
    expect(manager.status()).toMatchObject({
      current: { generationId: 'generation-2', httpLeases: 0 },
      draining: [{ generationId: 'generation-1', httpLeases: 1 }],
    });
    await stableHandler(context());
    expect(secondGenerate).toHaveBeenCalledOnce();
    expect(firstDispose).not.toHaveBeenCalled();

    finish.resolve();
    await running;
    expect(firstGenerate).toHaveBeenCalledOnce();
    expect(firstDispose).toHaveBeenCalledOnce();
    expect(manager.status().draining).toEqual([]);
    await manager.dispose();
    expect(secondDispose).toHaveBeenCalledOnce();
  });

  it('lists only an effective configured model and pins its inspection generation', async () => {
    const entered = deferred();
    const finish = deferred();
    const firstDispose = vi.fn(async () => undefined);
    const firstInspect = vi.fn(async () => {
      entered.resolve();
      await finish.promise;
      return {
        enabled: true as const,
        available: true,
        providerId: 'codex-subscription' as const,
        model: 'gpt-image-2',
      };
    });
    const manager = new ImageRuntimeManager(enabledGeneration('inspect-old', {
      inspectCapability: firstInspect,
      dispose: firstDispose,
    }));
    const listing = manager.listAvailableModels('key-images');
    await entered.promise;

    const replacement = manager.prepare(enabledGeneration('inspect-new', {
      inspectCapability: async () => ({
        enabled: true,
        available: false,
        providerId: 'codex-subscription',
        model: 'gpt-image-2',
        reason: 'stale_evidence',
      }),
    }));
    replacement.publish();
    expect(manager.status()).toMatchObject({
      current: { generationId: 'inspect-new' },
      draining: [{ generationId: 'inspect-old', httpLeases: 1 }],
    });
    await expect(manager.listAvailableModels('key-images')).resolves.toEqual([]);
    expect(firstDispose).not.toHaveBeenCalled();

    finish.resolve();
    await expect(listing).resolves.toEqual(['gpt-image-2']);
    expect(firstInspect).toHaveBeenCalledWith('key-images');
    expect(firstDispose).toHaveBeenCalledOnce();
    await manager.dispose();
  });

  it('pins hosted leases to their acquired generations across publication', async () => {
    const firstDispose = vi.fn(async () => undefined);
    const secondDispose = vi.fn(async () => undefined);
    const scope = (): ResponsesImageRequestScope => ({
      executeSelectedCall: vi.fn(),
      commit: vi.fn(async () => undefined),
      waitForIdle: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
    } as unknown as ResponsesImageRequestScope);
    const firstCreateRequestScope = vi.fn(async () => scope());
    const secondCreateRequestScope = vi.fn(async () => scope());
    const firstHosted = { ...hosted(), createRequestScope: firstCreateRequestScope };
    const secondHosted = { ...hosted(), createRequestScope: secondCreateRequestScope };
    const manager = new ImageRuntimeManager(enabledGeneration('generation-a', {
      hosted: firstHosted,
      hostedRuntime: {
        providerId: 'codex-subscription',
        imageModel: 'gpt-image-old',
        referenceTtlMs: 10_000,
        maxOutputBytes: 1_000,
        maxTotalOutputBytes: 2_000,
        preferredAccountGroup: 'old-group',
        boundAccountFallbackPolicy: 'pool',
      },
      dispose: firstDispose,
    }));
    const firstLease = await manager.acquireHosted();
    const replacement = manager.prepare(enabledGeneration('generation-b', {
      hosted: secondHosted,
      hostedRuntime: {
        providerId: 'codex-subscription',
        imageModel: 'gpt-image-new',
        referenceTtlMs: 20_000,
        maxOutputBytes: 3_000,
        maxTotalOutputBytes: 4_000,
        preferredAccountGroup: 'new-group',
        boundAccountFallbackPolicy: 'strict',
      },
      dispose: secondDispose,
    }));
    replacement.publish();
    const secondLease = await manager.acquireHosted();

    const openInput = {
      admission: {} as never,
      tenantId: 'tenant-safe',
      requestId: 'request-old',
      sessionKey: 'session-safe',
      signal: new AbortController().signal,
      mainProviderId: 'anthropic',
    };
    await firstLease.openRequest(openInput);
    await secondLease.openRequest({ ...openInput, requestId: 'request-new' });

    expect(firstLease).toMatchObject({ generationId: 'generation-a', contribution: firstHosted });
    expect(secondLease).toMatchObject({ generationId: 'generation-b', contribution: secondHosted });
    expect(firstCreateRequestScope.mock.calls[0]?.[0].runtime).toMatchObject({
      imageModel: 'gpt-image-old',
      referenceTtlMs: 10_000,
      maxOutputBytes: 1_000,
      maxTotalOutputBytes: 2_000,
      preferredAccountGroup: 'old-group',
      boundAccountFallbackPolicy: 'pool',
    });
    expect(secondCreateRequestScope.mock.calls[0]?.[0].runtime).toMatchObject({
      imageModel: 'gpt-image-new',
      referenceTtlMs: 20_000,
      maxOutputBytes: 3_000,
      maxTotalOutputBytes: 4_000,
      preferredAccountGroup: 'new-group',
      boundAccountFallbackPolicy: 'strict',
    });
    expect(firstDispose).not.toHaveBeenCalled();
    await secondLease.release();
    expect(secondDispose).not.toHaveBeenCalled();
    await firstLease.release();
    await firstLease.release();
    expect(firstDispose).toHaveBeenCalledOnce();
    await manager.dispose();
    expect(secondDispose).toHaveBeenCalledOnce();
  });

  it('rolls publication back and drains only leases already pinned to the replacement', async () => {
    const firstDispose = vi.fn(async () => undefined);
    const secondDispose = vi.fn(async () => undefined);
    const firstHosted = hosted();
    const secondHosted = hosted();
    const manager = new ImageRuntimeManager(enabledGeneration('generation-before', {
      hosted: firstHosted,
      dispose: firstDispose,
    }));
    const change = manager.prepare(enabledGeneration('generation-candidate', {
      hosted: secondHosted,
      dispose: secondDispose,
    }));
    change.publish();
    const candidateLease = await manager.acquireHosted();
    change.rollback();
    change.rollback();
    const restoredLease = await manager.acquireHosted();
    expect(restoredLease.contribution).toBe(firstHosted);
    expect(candidateLease.contribution).toBe(secondHosted);
    expect(manager.status()).toMatchObject({
      current: { generationId: 'generation-before', hostedLeases: 1 },
      draining: [{ generationId: 'generation-candidate', hostedLeases: 1 }],
    });

    let disposed = false;
    const disposing = change.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);
    await candidateLease.release();
    await disposing;
    expect(secondDispose).toHaveBeenCalledOnce();
    expect(firstDispose).not.toHaveBeenCalled();
    await restoredLease.release();
    await manager.dispose();
    expect(firstDispose).toHaveBeenCalledOnce();
  });

  it('disposes unpublished replacements once without changing the current generation', async () => {
    const firstDispose = vi.fn(async () => undefined);
    const candidateDispose = vi.fn(async () => undefined);
    const manager = new ImageRuntimeManager(enabledGeneration('generation-current', {
      dispose: firstDispose,
    }));
    const change = manager.prepare(enabledGeneration('generation-unpublished', {
      dispose: candidateDispose,
    }));
    await change.dispose();
    await change.dispose();
    expect(candidateDispose).toHaveBeenCalledOnce();
    expect(manager.status().current.generationId).toBe('generation-current');
    await manager.dispose();
    expect(firstDispose).toHaveBeenCalledOnce();
  });

  it('publishes a disabled generation without invoking the previous handlers', async () => {
    const generate = vi.fn(async () => undefined);
    const firstDispose = vi.fn(async () => undefined);
    const disabledDispose = vi.fn(async () => undefined);
    const manager = new ImageRuntimeManager(enabledGeneration('generation-enabled', {
      generate,
      dispose: firstDispose,
    }));
    const change = manager.prepare(disabledGeneration('generation-disabled', disabledDispose));
    change.publish();
    await expect(manager.contributions.generate.handler(context()))
      .rejects.toMatchObject({ code: 'unsupported_capability' });
    await expect(manager.acquireHosted())
      .rejects.toMatchObject({ code: 'unsupported_capability' });
    expect(generate).not.toHaveBeenCalled();
    await manager.dispose();
    expect(disabledDispose).toHaveBeenCalledOnce();
  });

  it('stops acquisitions on disposal and waits for active leases exactly once', async () => {
    const generationDispose = vi.fn(async () => undefined);
    const manager = new ImageRuntimeManager(enabledGeneration('generation-final', {
      dispose: generationDispose,
    }));
    const lease = await manager.acquireHosted();
    let finished = false;
    const firstDispose = manager.dispose().then(() => { finished = true; });
    const secondDispose = manager.dispose();
    expect(secondDispose).toBe(manager.dispose());
    await Promise.resolve();
    expect(finished).toBe(false);
    await expect(manager.acquireHosted()).rejects.toMatchObject({ code: 'unsupported_capability' });

    await lease.release();
    await lease.release();
    await firstDispose;
    await secondDispose;
    expect(generationDispose).toHaveBeenCalledOnce();
    expect(manager.status().disposed).toBe(true);
  });
});
