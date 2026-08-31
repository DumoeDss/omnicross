import { describe, expect, it, vi } from 'vitest';

import type {
  ImageApiContributions,
  ResponsesImageGenerationContribution,
  ResponsesImageRequestScope,
} from '@omnicross/core/image-generation';

import {
  createHostedImageContributionFactory,
  ImageRuntimeManager,
  type HostedImageContributionFactory,
  type PreparedImageRuntimeGeneration,
} from '../ImageRuntimeManager';

function imageApi(): ImageApiContributions {
  const generate = Object.freeze({
    operationId: 'images.generate' as const,
    handler: vi.fn(async () => undefined),
  });
  const edit = Object.freeze({
    operationId: 'images.edit' as const,
    handler: vi.fn(async () => undefined),
  });
  return Object.freeze({ generate, edit, all: Object.freeze([generate, edit]) });
}

function generation(
  id: string,
  hosted: ResponsesImageGenerationContribution,
  dispose = vi.fn(async () => undefined),
): PreparedImageRuntimeGeneration & { readonly enabled: true } {
  return {
    id,
    enabled: true,
    imageApi: imageApi(),
    hosted,
    hostedRuntime: {
      providerId: 'codex-subscription',
      imageModel: 'gpt-image-2',
      referenceTtlMs: 60_000,
      maxOutputBytes: 1_024,
      maxTotalOutputBytes: 4_096,
      preferredAccountId: 'configured-account',
      preferredAccountGroup: 'configured-group',
      boundAccountFallbackPolicy: 'pool',
    },
    dispose,
  } as unknown as PreparedImageRuntimeGeneration & { readonly enabled: true };
}

function inertHosted(): ResponsesImageGenerationContribution {
  return {
    toolType: 'image_generation',
    inspectRequest: vi.fn(() => { throw new Error('not used'); }),
    validateSelection: vi.fn(),
    createRequestScope: vi.fn(async () => { throw new Error('not used'); }),
  };
}

describe('HostedImageContributionFactory', () => {
  it('is dormant until acquisition and exposes no registration or execution side effect', async () => {
    const hosted = inertHosted();
    const manager = new ImageRuntimeManager(generation('dormant', hosted));
    const acquire = vi.spyOn(manager, 'acquireHosted');

    const factory = createHostedImageContributionFactory(manager);
    expect(factory).toEqual({ acquire: expect.any(Function) });
    expect(acquire).not.toHaveBeenCalled();
    expect(hosted.inspectRequest).not.toHaveBeenCalled();
    expect(hosted.createRequestScope).not.toHaveBeenCalled();
    expect(manager.status().current.hostedLeases).toBe(0);
    await manager.dispose();
  });

  it('pins each acquired contribution to its real generation across publication', async () => {
    const firstHosted = inertHosted();
    const secondHosted = inertHosted();
    const firstDispose = vi.fn(async () => undefined);
    const secondDispose = vi.fn(async () => undefined);
    const manager = new ImageRuntimeManager(generation('hosted-a', firstHosted, firstDispose));
    const factory = createHostedImageContributionFactory(manager);
    const first = await factory.acquire();

    const replacement = manager.prepare(generation('hosted-b', secondHosted, secondDispose));
    replacement.publish();
    const second = await factory.acquire();

    expect(first).toMatchObject({ generationId: 'hosted-a', contribution: firstHosted });
    expect(second).toMatchObject({ generationId: 'hosted-b', contribution: secondHosted });
    expect(firstDispose).not.toHaveBeenCalled();
    await second.release();
    expect(secondDispose).not.toHaveBeenCalled();
    await first.release();
    expect(firstDispose).toHaveBeenCalledOnce();
    await manager.dispose();
    expect(secondDispose).toHaveBeenCalledOnce();
  });

  it('opens requests from immutable policy and only binds a selected account for Codex', async () => {
    const openedScope = {
      executeSelectedCall: vi.fn(),
      commit: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
      waitForIdle: vi.fn(async () => undefined),
    } as unknown as ResponsesImageRequestScope;
    const hosted: ResponsesImageGenerationContribution = {
      toolType: 'image_generation',
      inspectRequest: vi.fn(() => ({ declared: true }) as never),
      validateSelection: vi.fn(),
      createRequestScope: vi.fn(async () => openedScope),
    };
    const prepared = generation('deep-lease', hosted);
    const mutablePolicy = (prepared as unknown as {
      hostedRuntime: { imageModel: string };
    }).hostedRuntime;
    const manager = new ImageRuntimeManager(prepared);
    mutablePolicy.imageModel = 'mutated-after-publication';
    const lease = await createHostedImageContributionFactory(manager).acquire();

    const inspected = lease.inspectRequest({ tools: [{ type: 'image_generation' }] });
    const selection = {
      imageCalls: [{ prompt: 'selected by the main model' }],
      otherToolCount: 0,
      otherTools: [],
    } as const;
    lease.validateSelection(inspected, selection);
    const controller = new AbortController();
    const scope = await lease.openRequest({
      admission: inspected,
      tenantId: 'tenant-a',
      requestId: 'request-a',
      sessionKey: 'session-a',
      signal: controller.signal,
      authorizedPreviousResponseId: 'resp_previous',
      authorizedPreviousResponseKnownEmpty: false,
      mainProviderId: 'codex',
      selectedMainAccountId: 'selected-main-account',
    });

    expect(hosted.inspectRequest).toHaveBeenCalledOnce();
    expect(hosted.validateSelection).toHaveBeenCalledWith(inspected, selection);
    expect(hosted.createRequestScope).toHaveBeenCalledWith({
      admission: inspected,
      authorizedPreviousResponseId: 'resp_previous',
      authorizedPreviousResponseKnownEmpty: false,
      runtime: {
        tenantId: 'tenant-a',
        requestId: 'request-a',
        providerId: 'codex-subscription',
        imageModel: 'gpt-image-2',
        referenceTtlMs: 60_000,
        maxOutputBytes: 1_024,
        maxTotalOutputBytes: 4_096,
        signal: controller.signal,
        sessionKey: 'session-a',
        preferredAccountId: 'selected-main-account',
        boundAccountFallbackPolicy: 'strict',
      },
    });
    const configuredScope = await lease.openRequest({
      admission: inspected,
      tenantId: 'tenant-a',
      requestId: 'request-configured',
      sessionKey: 'session-a',
      signal: controller.signal,
      mainProviderId: 'anthropic',
      selectedMainAccountId: 'incompatible-main-account',
    });
    expect(hosted.createRequestScope).toHaveBeenLastCalledWith({
      admission: inspected,
      runtime: {
        tenantId: 'tenant-a',
        requestId: 'request-configured',
        providerId: 'codex-subscription',
        imageModel: 'gpt-image-2',
        referenceTtlMs: 60_000,
        maxOutputBytes: 1_024,
        maxTotalOutputBytes: 4_096,
        signal: controller.signal,
        sessionKey: 'session-a',
        preferredAccountId: 'configured-account',
        preferredAccountGroup: 'configured-group',
        boundAccountFallbackPolicy: 'pool',
      },
    });
    expect(scope).toBeDefined();
    await scope.dispose();
    await configuredScope.dispose();
    await lease.release();
    await manager.dispose();
  });

  it('disposes every opened request scope before releasing a draining generation', async () => {
    const order: string[] = [];
    const scope: ResponsesImageRequestScope = {
      executeSelectedCall: vi.fn(),
      commit: vi.fn(async () => undefined),
      waitForIdle: vi.fn(async () => { order.push('idle'); }),
      dispose: vi.fn(async () => { order.push('scope-dispose'); }),
    };
    const hosted: ResponsesImageGenerationContribution = {
      toolType: 'image_generation',
      inspectRequest: vi.fn(() => ({ declared: false }) as never),
      validateSelection: vi.fn(),
      createRequestScope: vi.fn(async () => scope),
    };
    const manager = new ImageRuntimeManager(generation(
      'dispose-order',
      hosted,
      vi.fn(async () => { order.push('generation-dispose'); }),
    ));
    const lease = await createHostedImageContributionFactory(manager).acquire();
    await lease.openRequest({
      admission: { declared: false } as never,
      tenantId: 'tenant-a',
      requestId: 'request-a',
      sessionKey: 'session-a',
      signal: new AbortController().signal,
      mainProviderId: 'byo',
    });
    manager.prepare({
      id: 'replacement-disabled',
      enabled: false,
      dispose: vi.fn(async () => undefined),
    }).publish();

    await lease.release();
    await lease.release();
    expect(order).toEqual(['idle', 'scope-dispose', 'generation-dispose']);
    expect(scope.dispose).toHaveBeenCalledOnce();
    await manager.dispose();
  });

  it('waits for in-flight scope construction before releasing its generation', async () => {
    const order: string[] = [];
    let resolveScope!: (scope: ResponsesImageRequestScope) => void;
    const scopePromise = new Promise<ResponsesImageRequestScope>((resolve) => {
      resolveScope = resolve;
    });
    const scope: ResponsesImageRequestScope = {
      executeSelectedCall: vi.fn(),
      commit: vi.fn(async () => undefined),
      waitForIdle: vi.fn(async () => { order.push('idle'); }),
      dispose: vi.fn(async () => { order.push('scope-dispose'); }),
    };
    const hosted: ResponsesImageGenerationContribution = {
      toolType: 'image_generation',
      inspectRequest: vi.fn(() => ({ declared: true }) as never),
      validateSelection: vi.fn(),
      createRequestScope: vi.fn(() => scopePromise),
    };
    const manager = new ImageRuntimeManager(generation(
      'constructing-scope',
      hosted,
      vi.fn(async () => { order.push('generation-dispose'); }),
    ));
    const lease = await manager.acquireHosted();
    const opening = lease.openRequest({
      admission: { declared: true } as never,
      tenantId: 'tenant-safe',
      requestId: 'request-safe',
      sessionKey: 'session-safe',
      signal: new AbortController().signal,
      mainProviderId: 'codex',
      selectedMainAccountId: 'selected-account',
    });
    manager.prepare({
      id: 'replacement-disabled',
      enabled: false,
      dispose: vi.fn(async () => undefined),
    }).publish();
    const releasing = lease.release();
    await Promise.resolve();
    expect(order).toEqual([]);

    resolveScope(scope);
    await expect(opening).rejects.toMatchObject({ code: 'unsupported_capability' });
    await releasing;
    expect(order).toEqual(['idle', 'scope-dispose', 'generation-dispose']);
    await manager.dispose();
  });

  it('fails closed against the default unavailable generation without executing a provider', async () => {
    const manager = new ImageRuntimeManager();
    const factory = createHostedImageContributionFactory(manager);

    await expect(factory.acquire()).rejects.toMatchObject({ code: 'unsupported_capability' });
    expect(manager.status().current).toMatchObject({
      enabled: false,
      hostedLeases: 0,
    });
    await manager.dispose();
  });

  it('releases a draining generation exactly once when scope construction fails', async () => {
    const hosted: ResponsesImageGenerationContribution = {
      toolType: 'image_generation',
      inspectRequest: vi.fn(() => ({ declared: true }) as never),
      validateSelection: vi.fn(),
      createRequestScope: vi.fn(async () => { throw new Error('construction failed'); }),
    };
    const generationDispose = vi.fn(async () => undefined);
    const manager = new ImageRuntimeManager(generation('construction-failure', hosted, generationDispose));
    const factory = createHostedImageContributionFactory(manager);
    const lease = await factory.acquire();
    manager.prepare({
      id: 'construction-replacement',
      enabled: false,
      dispose: vi.fn(async () => undefined),
    }).publish();

    await expect((async () => {
      try {
        await lease.openRequest({
          admission: { declared: true } as never,
          tenantId: 'tenant-safe',
          requestId: 'request-safe',
          sessionKey: 'session-safe',
          signal: new AbortController().signal,
          mainProviderId: 'codex',
          selectedMainAccountId: 'selected-account',
        });
      } finally {
        await lease.release();
        await lease.release();
      }
    })()).rejects.toThrow('construction failed');
    expect(generationDispose).toHaveBeenCalledOnce();
    expect(manager.status().draining).toEqual([]);
    await manager.dispose();
  });

  it('follows the final-integrator order and releases on execution failure', async () => {
    const order: string[] = [];
    const scope: ResponsesImageRequestScope = {
      executeSelectedCall: () => ({
        async *[Symbol.asyncIterator]() {
          order.push('execute');
          throw new Error('execution failed');
        },
      }),
      commit: vi.fn(async () => { order.push('commit'); }),
      dispose: vi.fn(async () => { order.push('dispose'); }),
      waitForIdle: vi.fn(async () => undefined),
    };
    const hosted: ResponsesImageGenerationContribution = {
      toolType: 'image_generation',
      inspectRequest: vi.fn(() => {
        order.push('inspect');
        return { declared: true } as never;
      }),
      validateSelection: vi.fn(() => { order.push('validate'); }),
      createRequestScope: vi.fn(async () => {
        order.push('create-scope');
        return scope;
      }),
    };
    const generationDispose = vi.fn(async () => undefined);
    const manager = new ImageRuntimeManager(generation('execution-failure', hosted, generationDispose));
    const factory = createHostedImageContributionFactory(manager);

    await expect(runSyntheticFinalIntegrator(factory, order)).rejects.toThrow('execution failed');
    expect(order).toEqual([
      'affinity-authorize',
      'acquire',
      'inspect',
      'validate',
      'create-scope',
      'execute',
      'dispose',
      'release',
    ]);
    expect(scope.commit).not.toHaveBeenCalled();
    expect(scope.dispose).toHaveBeenCalledOnce();
    expect(manager.status().current.hostedLeases).toBe(0);
    await manager.dispose();
    expect(generationDispose).toHaveBeenCalledOnce();
  });

  it('commits before terminal assembly on the synthetic successful handoff', async () => {
    const order: string[] = [];
    const scope: ResponsesImageRequestScope = {
      executeSelectedCall: () => ({
        async *[Symbol.asyncIterator]() {
          order.push('execute');
          yield { kind: 'completed' } as never;
        },
      }),
      commit: vi.fn(async () => { order.push('commit'); }),
      dispose: vi.fn(async () => { order.push('dispose'); }),
      waitForIdle: vi.fn(async () => undefined),
    };
    const hosted: ResponsesImageGenerationContribution = {
      toolType: 'image_generation',
      inspectRequest: () => {
        order.push('inspect');
        return { declared: true } as never;
      },
      validateSelection: () => { order.push('validate'); },
      createRequestScope: async () => {
        order.push('create-scope');
        return scope;
      },
    };
    const manager = new ImageRuntimeManager(generation('handoff-order', hosted));
    const factory = createHostedImageContributionFactory(manager);

    await runSyntheticFinalIntegrator(factory, order);
    expect(order).toEqual([
      'affinity-authorize',
      'acquire',
      'inspect',
      'validate',
      'create-scope',
      'execute',
      'commit',
      'terminal',
      'dispose',
      'release',
    ]);
    await manager.dispose();
  });
});

async function runSyntheticFinalIntegrator(
  factory: HostedImageContributionFactory,
  order: string[],
): Promise<void> {
  order.push('affinity-authorize');
  const lease = await factory.acquire();
  order.push('acquire');
  let scope: ResponsesImageRequestScope | undefined;
  try {
    const admission = lease.inspectRequest({});
    const selection = { imageCalls: [{ prompt: 'synthetic' }], otherToolCount: 0, otherTools: [] };
    lease.validateSelection(admission, selection);
    scope = await lease.openRequest({
      admission,
      tenantId: 'tenant-safe',
      requestId: 'request-safe',
      sessionKey: 'session-safe',
      signal: new AbortController().signal,
      mainProviderId: 'codex',
      selectedMainAccountId: 'selected-account',
    });
    for await (const _event of scope.executeSelectedCall(
      selection.imageCalls[0],
      { reserveOutputIndex: () => 0, nextSequenceNumber: () => 0 },
    )) {
      // The real integrator forwards partial/internal records through its allocator.
    }
    await scope.commit('resp_synthetic');
    order.push('terminal');
  } finally {
    await scope?.dispose();
    await lease.release();
    order.push('release');
  }
}
