import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ImageApiContributions,
  ResponsesImageGenerationContribution,
} from '@omnicross/core/image-generation';
import {
  getOpenAIOperation,
  type OpenAIOperationDispatchContext,
} from '@omnicross/core/openai-operation';
import { getProviderProxy } from '@omnicross/core/provider-proxy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildDaemon,
  type Daemon,
  resetDaemonSingletonsForTests,
} from '../bootstrap';
import { loadConfig } from '../config';
import {
  ImageRuntimeManager,
  type PreparedImageRuntimeGeneration,
} from '../image-generation/ImageRuntimeManager';

let daemon: Daemon | undefined;
let tempHome: string;
let configPath: string;

function buildFixture(): Daemon {
  const built = buildDaemon(loadConfig(configPath), {
    configPath,
    keysPath: join(tempHome, 'keys.json'),
    tokensPath: join(tempHome, 'tokens.json'),
    masterKeyFilePath: join(tempHome, 'master.key'),
  });
  daemon = built;
  return built;
}

function hostedContribution(): ResponsesImageGenerationContribution {
  return {
    toolType: 'image_generation',
    inspectRequest: () => { throw new Error('not used'); },
    validateSelection: () => undefined,
    createRequestScope: async () => { throw new Error('not used'); },
  };
}

function enabledGeneration(
  id: string,
  generate: ReturnType<typeof vi.fn>,
  edit: ReturnType<typeof vi.fn>,
  dispose: ReturnType<typeof vi.fn> = vi.fn(async () => undefined),
): PreparedImageRuntimeGeneration & { readonly enabled: true } {
  const generateContribution = Object.freeze({
    operationId: 'images.generate' as const,
    handler: generate,
  });
  const editContribution = Object.freeze({
    operationId: 'images.edit' as const,
    handler: edit,
  });
  const imageApi: ImageApiContributions = Object.freeze({
    generate: generateContribution,
    edit: editContribution,
    all: Object.freeze([generateContribution, editContribution]),
  });
  return {
    id,
    enabled: true,
    imageApi,
    hosted: hostedContribution(),
    dispose,
  };
}

function dispatchContext(
  target: Daemon,
  operationId: 'images.generate' | 'images.edit',
): OpenAIOperationDispatchContext {
  const request = Object.assign(new EventEmitter(), {
    aborted: false,
    complete: true,
  }) as unknown as IncomingMessage;
  const response = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
  }) as unknown as ServerResponse;
  return {
    operation: getOpenAIOperation(operationId),
    request,
    response,
    route: {} as OpenAIOperationDispatchContext['route'],
    deps: target.providerProxy.getDeps(),
  };
}

beforeEach(() => {
  resetDaemonSingletonsForTests();
  tempHome = mkdtempSync(join(tmpdir(), 'omnicross-image-runtime-bootstrap-'));
  configPath = join(tempHome, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    providers: [],
    server: { enabled: false, networkBinding: false, port: 0, endpoints: [] },
    admin: { port: 0 },
  }, null, 2), 'utf8');
});

afterEach(async () => {
  if (daemon) {
    await daemon.providerProxy.stop();
    daemon.apiKeyPool.dispose();
  }
  daemon = undefined;
  resetDaemonSingletonsForTests();
  vi.restoreAllMocks();
  rmSync(tempHome, { recursive: true, force: true });
});

describe('daemon Images runtime bootstrap', () => {
  it('constructs the first proxy with the same registry and stable manager forwarders', async () => {
    expect(() => getProviderProxy()).toThrow(/deps are required on first construction/);
    const built = buildFixture();

    expect(built.providerProxy.getDeps().openAIOperationRegistry)
      .toBe(built.openAIOperationRegistry);
    expect(built.openAIOperationRegistry.has('images.generate')).toBe(true);
    expect(built.openAIOperationRegistry.has('images.edit')).toBe(true);
    expect(built.openAIOperationRegistry.has('responses.compact')).toBe(false);
    expect(built.imageRuntimeManager.status().current.enabled).toBe(false);
    expect(built.hostedImageContributionFactory).toEqual({ acquire: expect.any(Function) });

    const stableContributions = built.imageRuntimeManager.contributions;
    const generate = vi.fn(async () => undefined);
    const edit = vi.fn(async () => undefined);
    const prepared = built.imageRuntimeManager.prepare(enabledGeneration(
      'bootstrap-forwarding',
      generate,
      edit,
    ));
    prepared.publish();

    await expect(built.openAIOperationRegistry.dispatch(
      dispatchContext(built, 'images.generate'),
    )).resolves.toBe(true);
    await expect(built.openAIOperationRegistry.dispatch(
      dispatchContext(built, 'images.edit'),
    )).resolves.toBe(true);
    expect(generate).toHaveBeenCalledOnce();
    expect(edit).toHaveBeenCalledOnce();
    expect(built.imageRuntimeManager.contributions).toBe(stableContributions);
  });

  it('unregisters both handlers before disposing the manager exactly once on stop', async () => {
    const built = buildFixture();
    const generationDispose = vi.fn(async () => undefined);
    const prepared = built.imageRuntimeManager.prepare(enabledGeneration(
      'stop-cleanup',
      vi.fn(async () => undefined),
      vi.fn(async () => undefined),
      generationDispose,
    ));
    prepared.publish();
    const managerDispose = vi.spyOn(built.imageRuntimeManager, 'dispose');

    await built.providerProxy.stop();
    expect(built.openAIOperationRegistry.has('images.generate')).toBe(false);
    expect(built.openAIOperationRegistry.has('images.edit')).toBe(false);
    expect(built.imageRuntimeManager.status().disposed).toBe(true);
    expect(managerDispose).toHaveBeenCalledOnce();
    expect(generationDispose).toHaveBeenCalledOnce();

    await built.providerProxy.stop();
    resetDaemonSingletonsForTests();
    expect(managerDispose).toHaveBeenCalledOnce();
    expect(generationDispose).toHaveBeenCalledOnce();
  });

  it('synchronously retires a prior image session across repeated reset and rebuild', async () => {
    const first = buildFixture();
    const firstRegistry = first.openAIOperationRegistry;
    const generationDispose = vi.fn(async () => undefined);
    const resources = {
      storeHandle: true,
      timer: true,
      scope: true,
      provider: true,
      queueWaiter: true,
    };
    generationDispose.mockImplementation(async () => {
      resources.storeHandle = false;
      resources.timer = false;
      resources.scope = false;
      resources.provider = false;
      resources.queueWaiter = false;
    });
    const prepared = first.imageRuntimeManager.prepare(enabledGeneration(
      'reset-cleanup',
      vi.fn(async () => undefined),
      vi.fn(async () => undefined),
      generationDispose,
    ));
    prepared.publish();

    first.apiKeyPool.dispose();
    resetDaemonSingletonsForTests();
    expect(firstRegistry.has('images.generate')).toBe(false);
    expect(firstRegistry.has('images.edit')).toBe(false);
    expect(first.imageRuntimeManager.status().disposed).toBe(true);

    daemon = undefined;
    const rebuilt = buildFixture();
    expect(rebuilt.openAIOperationRegistry).not.toBe(firstRegistry);
    expect(rebuilt.imageRuntimeManager).not.toBe(first.imageRuntimeManager);
    expect(rebuilt.providerProxy.getDeps().openAIOperationRegistry)
      .toBe(rebuilt.openAIOperationRegistry);
    expect(rebuilt.openAIOperationRegistry.has('images.generate')).toBe(true);
    expect(rebuilt.openAIOperationRegistry.has('images.edit')).toBe(true);

    await first.imageRuntimeManager.dispose();
    expect(generationDispose).toHaveBeenCalledOnce();
    expect(resources).toEqual({
      storeHandle: false,
      timer: false,
      scope: false,
      provider: false,
      queueWaiter: false,
    });
  });

  it('fails and cleans the partial image session when a stale proxy predates bootstrap', () => {
    const disposeSpy = vi.spyOn(ImageRuntimeManager.prototype, 'dispose');
    getProviderProxy({ llmConfig: {} as never });

    expect(() => buildFixture()).toThrow(/without this app-session operation registry/);
    expect(disposeSpy).toHaveBeenCalledOnce();

    resetDaemonSingletonsForTests();
    expect(disposeSpy).toHaveBeenCalledOnce();
    const rebuilt = buildFixture();
    expect(rebuilt.providerProxy.getDeps().openAIOperationRegistry)
      .toBe(rebuilt.openAIOperationRegistry);
  });
});
