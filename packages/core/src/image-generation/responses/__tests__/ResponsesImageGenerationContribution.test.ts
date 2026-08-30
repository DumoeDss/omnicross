import { describe, expect, it, vi } from 'vitest';

import type {
  ImageCapabilities,
  ImageProviderEvent,
  ImageReferenceId,
} from '@omnicross/contracts/image-generation-types';

import { ImageGenerationError, serializeImageGenerationError } from '../../errors';
import { ImageOrchestrator } from '../../ImageOrchestrator';
import type { ImageJob, ImageProvider, ImageProviderRequest } from '../../ImageProvider';
import { ImageProviderRegistry } from '../../ImageProviderRegistry';
import {
  InMemoryImageAsset,
  InMemoryImageReferenceStore,
  type ImageAsset,
  type ImageReferenceStore,
} from '../../ports';
import { createResponsesImageGenerationContribution } from '../ResponsesImageGenerationContribution';
import {
  InMemoryResponsesImageStateStore,
  type ResponsesImageStateStore,
} from '../ResponsesImageStateStore';
import type {
  ResponsesImageCallId,
  ResponsesImageEventAllocator,
  ResponsesImageExecutionEvent,
  ResponsesImageGenerationContribution,
  ResponsesImagePartialEvent,
  ResponsesImageTrustedRuntime,
} from '../types';

const supported: ImageCapabilities = {
  available: true,
  models: ['trusted-image-model'],
  generate: true,
  edit: true,
  maskEdit: false,
  maxInputImages: 16,
  maxOutputImages: 1,
  streaming: true,
  maxPartialImages: 3,
  transparentBackground: true,
  flexibleSizes: true,
  outputFormats: ['png', 'jpeg', 'webp'],
  qualityLevels: ['auto', 'low', 'medium', 'high'],
  moderationModes: ['auto'],
  outputCompression: { supported: true, formats: ['jpeg', 'webp'], min: 0, max: 100 },
  responsesTool: true,
  multiTurnEdit: true,
  supportsFileId: true,
  supportsImageUrl: false,
  resolvedAt: 1,
};

function asset(bytes: readonly number[], mimeType: 'image/png' | 'image/jpeg' | 'image/webp' = 'image/png') {
  return new InMemoryImageAsset(Uint8Array.from(bytes), {
    mimeType,
    width: 1,
    height: 1,
    hasAlpha: mimeType !== 'image/jpeg',
  });
}

async function* events(...values: ImageProviderEvent<ImageAsset>[]) {
  for (const value of values) yield value;
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const output: T[] = [];
  for await (const value of iterable) output.push(value);
  return output;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function stateStoreWith(
  base: ResponsesImageStateStore,
  overrides: Partial<ResponsesImageStateStore>,
): ResponsesImageStateStore {
  return {
    commit: (input) => base.commit(input),
    resolveCall: (tenantId, callId) => base.resolveCall(tenantId, callId),
    resolveResponse: (tenantId, responseId) => base.resolveResponse(tenantId, responseId),
    deleteCall: (tenantId, callId) => base.deleteCall(tenantId, callId),
    deleteResponse: (tenantId, responseId) => base.deleteResponse(tenantId, responseId),
    cleanup: (now) => base.cleanup(now),
    ...overrides,
  };
}

function referenceStoreWith(
  base: ImageReferenceStore,
  overrides: Partial<ImageReferenceStore>,
): ImageReferenceStore {
  return {
    save: (input) => base.save(input),
    resolve: (tenantId, referenceId) => base.resolve(tenantId, referenceId),
    delete: (tenantId, referenceId) => base.delete(tenantId, referenceId),
    cleanup: (now) => base.cleanup(now),
    ...overrides,
  };
}

function allocator(outputStart = 2, sequenceStart = 10): ResponsesImageEventAllocator {
  let output = outputStart;
  let sequence = sequenceStart;
  return {
    reserveOutputIndex: () => output++,
    nextSequenceNumber: () => sequence++,
  };
}

interface HarnessOptions {
  readonly capabilities?: ImageCapabilities;
  readonly createCallId?: () => ResponsesImageCallId;
  readonly referenceStore?: ImageReferenceStore;
  readonly stateStore?: ResponsesImageStateStore;
  readonly now?: () => number;
  readonly eventFactory?: (
    request: ImageProviderRequest,
    callIndex: number,
  ) => AsyncIterable<ImageProviderEvent<ImageAsset>>;
}

function createHarness(options: HarnessOptions = {}) {
  const requests: ImageProviderRequest[] = [];
  const output = asset([1, 2, 3, 4]);
  const cancel = vi.fn(async () => undefined);
  const start = vi.fn((request: ImageProviderRequest): ImageJob => {
    requests.push(request);
    const index = requests.length - 1;
    return {
      events: options.eventFactory?.(request, index) ?? events(
        { type: 'accepted', acceptedAt: index + 1 },
        { type: 'completed', images: [{ artifact: output, revisedPrompt: `revised-${index}` }] },
      ),
      cancel,
    };
  });
  const acquire = vi.fn(async () => ({
    providerId: 'fake-images',
    capabilities: options.capabilities ?? supported,
    start,
    release: vi.fn(async () => undefined),
  }));
  const provider: ImageProvider = { id: 'fake-images', acquire };
  const referenceStore = options.referenceStore ?? new InMemoryImageReferenceStore(options.now);
  const stateStore = options.stateStore ?? new InMemoryResponsesImageStateStore({ now: options.now });
  const orchestrator = new ImageOrchestrator({
    registry: new ImageProviderRegistry([provider]),
    referenceStore,
    now: options.now,
  });
  let callNumber = 0;
  const contribution = createResponsesImageGenerationContribution({
    orchestrator,
    referenceStore,
    stateStore,
    now: options.now,
    createCallId: options.createCallId
      ?? (() => `ig_testcall${String(++callNumber).padStart(8, '0')}` as ResponsesImageCallId),
  });
  return {
    contribution,
    referenceStore,
    stateStore,
    output,
    requests,
    acquire,
    start,
    cancel,
  };
}

function runtime(
  controller = new AbortController(),
  override: Partial<ResponsesImageTrustedRuntime> = {},
): ResponsesImageTrustedRuntime {
  return {
    tenantId: 'tenant-a',
    requestId: 'request-safe',
    providerId: 'fake-images',
    imageModel: 'trusted-image-model',
    referenceTtlMs: 1_000,
    maxOutputBytes: 64,
    maxTotalOutputBytes: 256,
    signal: controller.signal,
    sessionKey: 'session-safe',
    preferredAccountGroup: 'group-safe',
    ...override,
  };
}

function admission(
  contribution: ResponsesImageGenerationContribution,
  declaration: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) {
  const result = contribution.inspectRequest({
    tools: [{ type: 'image_generation', ...declaration }],
    ...extra,
  });
  contribution.validateSelection(result, {
    imageCalls: [{ prompt: 'selected image prompt' }],
    otherToolCount: 0,
    otherTools: [],
  });
  return result;
}

function completed(events: readonly ResponsesImageExecutionEvent[]) {
  const result = events.find((event) => 'kind' in event && event.kind === 'completed');
  if (!result || !('kind' in result) || result.kind !== 'completed') {
    throw new Error('expected completed image record');
  }
  return result;
}

async function seedCommittedImage(
  harness: ReturnType<typeof createHarness>,
  responseId: string,
): Promise<ResponsesImageCallId> {
  const scope = await harness.contribution.createRequestScope({
    admission: admission(harness.contribution),
    runtime: runtime(),
  });
  const done = completed(await collect(scope.executeSelectedCall({ prompt: 'seed' }, allocator())));
  await scope.commit(responseId);
  await scope.dispose();
  return done.item.id;
}

function expectStableCancellation(error: unknown): void {
  expect(error).toBeInstanceOf(ImageGenerationError);
  expect(serializeImageGenerationError(error as ImageGenerationError)).toEqual({
    type: 'image_generation_error',
    code: 'request_cancelled',
    message: 'The image request was cancelled.',
    httpStatus: 499,
  });
}

function executionRecordType(event: ResponsesImageExecutionEvent): string {
  return 'kind' in event ? event.kind : event.type;
}

describe('Responses image contribution execution and integration contract', () => {
  it('uses the trusted image model, exact bytes, mixed output index, and truthful revised prompt', async () => {
    const harness = createHarness();
    const inspected = admission(harness.contribution);
    const scope = await harness.contribution.createRequestScope({ admission: inspected, runtime: runtime() });
    const result = await collect(scope.executeSelectedCall(
      { prompt: 'selected image prompt' },
      allocator(4, 20),
    ));
    const done = completed(result);
    expect(done.outputIndex).toBe(4);
    expect(done.item).toMatchObject({
      id: 'ig_testcall00000001',
      type: 'image_generation_call',
      status: 'completed',
      revised_prompt: 'revised-0',
    });
    expect(Buffer.from(done.item.result, 'base64')).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(harness.requests[0]).toMatchObject({
      action: 'generate',
      model: 'trusted-image-model',
      prompt: 'selected image prompt',
      n: 1,
      moderation: 'auto',
      stream: false,
    });
    expect(JSON.stringify(done)).not.toContain('usage');
    expect(result.map(executionRecordType)).toEqual(['completed']);
    await scope.commit('resp_generated');
    await scope.commit('resp_generated');
    await scope.dispose();
    const stored = await harness.stateStore.resolveCall('tenant-a', done.item.id);
    expect(stored.status).toBe('found');
    if (stored.status === 'found') await stored.lease.release();
    expect(harness.cancel).not.toHaveBeenCalled();
  });

  it('executes multiple selected calls serially with distinct ids and allocator-owned indexes', async () => {
    const harness = createHarness();
    const inspected = admission(harness.contribution);
    const scope = await harness.contribution.createRequestScope({ admission: inspected, runtime: runtime() });
    const mixedAllocator = {
      indexes: [3, 8],
      reserveOutputIndex() { return this.indexes.shift()!; },
      nextSequenceNumber() { return 100; },
    };
    const first = completed(await collect(scope.executeSelectedCall({ prompt: 'one' }, mixedAllocator)));
    const second = completed(await collect(scope.executeSelectedCall({ prompt: 'two' }, mixedAllocator)));
    expect([first.outputIndex, second.outputIndex]).toEqual([3, 8]);
    expect(first.item.id).not.toBe(second.item.id);
    await scope.commit('resp_multiple');
    await scope.dispose();
    const response = await harness.stateStore.resolveResponse('tenant-a', 'resp_multiple');
    expect(response.status).toBe('found');
    if (response.status === 'found') {
      expect(response.lease.callIds).toEqual([first.item.id, second.item.id]);
      await response.lease.release();
    }
  });

  it('maps only real partial bytes with globally allocated monotonic identities', async () => {
    const partial0 = asset([9, 8]);
    const partial1 = asset([7, 6]);
    const harness = createHarness({
      eventFactory: () => events(
        { type: 'accepted', acceptedAt: 1 },
        { type: 'partial_image', outputIndex: 0, partialImageIndex: 0, image: { artifact: partial0 } },
        { type: 'partial_image', outputIndex: 0, partialImageIndex: 1, image: { artifact: partial1 } },
        { type: 'completed', images: [{ artifact: asset([1, 2, 3, 4]) }] },
      ),
    });
    const inspected = admission(harness.contribution, { partial_images: 2 }, { stream: true });
    const scope = await harness.contribution.createRequestScope({ admission: inspected, runtime: runtime() });
    let sequence = 10;
    const result = await collect(scope.executeSelectedCall({ prompt: 'partials' }, {
      reserveOutputIndex: () => 6,
      nextSequenceNumber: () => (sequence += 3),
    }));
    const partials = result.filter((event): event is ResponsesImagePartialEvent =>
      'type' in event && event.type === 'response.image_generation_call.partial_image');
    expect(partials).toHaveLength(2);
    expect(partials.map((event) => event.sequence_number)).toEqual([13, 16]);
    expect(partials.map((event) => event.output_index)).toEqual([6, 6]);
    expect(partials.map((event) => Buffer.from(event.partial_image_b64, 'base64')))
      .toEqual([Buffer.from([9, 8]), Buffer.from([7, 6])]);
    expect(JSON.stringify(partials)).not.toContain('result');
    expect(completed(result).item.result).toBeTruthy();
    await scope.dispose();
  });

  it('shares mixed-output allocation across multiple calls without fabricating terminal sequence events', async () => {
    const harness = createHarness({
      eventFactory: (_request, callIndex) => events(
        { type: 'accepted', acceptedAt: callIndex + 1 },
        {
          type: 'partial_image',
          outputIndex: 0,
          partialImageIndex: 0,
          image: { artifact: asset([callIndex + 5]) },
        },
        { type: 'completed', images: [{ artifact: asset([callIndex + 1]) }] },
      ),
    });
    const scope = await harness.contribution.createRequestScope({
      admission: admission(harness.contribution, { partial_images: 1 }, { stream: true }),
      runtime: runtime(),
    });
    const outputIndexes = [3, 8];
    let globalSequence = 20;
    const sharedAllocator: ResponsesImageEventAllocator = {
      reserveOutputIndex: () => outputIndexes.shift()!,
      nextSequenceNumber: () => ++globalSequence,
    };
    const first = await collect(scope.executeSelectedCall({ prompt: 'first partial' }, sharedAllocator));
    expect(sharedAllocator.nextSequenceNumber()).toBe(22); // mixed non-image event
    const second = await collect(scope.executeSelectedCall({ prompt: 'second partial' }, sharedAllocator));
    const records = [...first, ...second];
    const partials = records.filter((event): event is ResponsesImagePartialEvent =>
      'type' in event && event.type === 'response.image_generation_call.partial_image');
    expect(partials.map((event) => [event.output_index, event.sequence_number]))
      .toEqual([[3, 21], [8, 23]]);
    const terminals = records.filter((event) => 'kind' in event && event.kind === 'completed');
    expect(terminals).toHaveLength(2);
    expect(terminals.every((event) => !('sequence_number' in event) && !('type' in event))).toBe(true);
    expect(completed(first).item.result).toBe(Buffer.from([1]).toString('base64'));
    expect(completed(second).item.result).toBe(Buffer.from([2]).toString('base64'));
    await scope.dispose();
  });

  it('fails closed for malformed allocators before provider start or after real partials', async () => {
    const harness = createHarness();
    const inspected = admission(harness.contribution);
    const scope = await harness.contribution.createRequestScope({ admission: inspected, runtime: runtime() });
    const invalid = await collect(scope.executeSelectedCall({ prompt: 'bad allocation' }, {
      reserveOutputIndex: () => -1,
      nextSequenceNumber: () => 0,
    }));
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toMatchObject({
      kind: 'failed',
      error: { code: 'image_generation_failed' },
    });
    expect(harness.start).not.toHaveBeenCalled();
    await scope.dispose();
  });

  it('never reuses a call id exposed by a pre-provider allocation failure', async () => {
    const repeated = 'ig_repeatedcall000001' as ResponsesImageCallId;
    const harness = createHarness({ createCallId: () => repeated });
    const inspected = admission(harness.contribution);
    const scope = await harness.contribution.createRequestScope({ admission: inspected, runtime: runtime() });

    const first = await collect(scope.executeSelectedCall({ prompt: 'bad allocation' }, {
      reserveOutputIndex: () => -1,
      nextSequenceNumber: () => 0,
    }));
    expect(first[0]).toMatchObject({ callId: repeated, error: { code: 'image_generation_failed' } });

    const second = await collect(scope.executeSelectedCall({ prompt: 'must not reuse' }, allocator()));
    expect(second[0]).toMatchObject({ error: { code: 'image_generation_failed' } });
    expect(second[0]).not.toHaveProperty('callId');
    expect(harness.start).not.toHaveBeenCalled();
    await scope.dispose();
  });

  it('requires the Responses capability from the same provider lease and preserves fail-closed evidence', async () => {
    const harness = createHarness({
      capabilities: {
        ...supported,
        available: false,
        reason: 'missing_evidence',
        models: [],
        generate: false,
        edit: false,
        streaming: false,
        responsesTool: false,
      },
    });
    const inspected = admission(harness.contribution);
    const scope = await harness.contribution.createRequestScope({ admission: inspected, runtime: runtime() });
    const result = await collect(scope.executeSelectedCall({ prompt: 'must stay unavailable' }, allocator()));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ error: { code: 'unsupported_capability' } });
    expect(harness.acquire).toHaveBeenCalledOnce();
    expect(harness.start).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('entitlement');
    await scope.dispose();
  });

  it('rejects unsupported models and declaration capabilities without starting a provider job', async () => {
    const wrongModel = createHarness({ capabilities: { ...supported, models: ['other-model'] } });
    const modelAdmission = admission(wrongModel.contribution);
    const modelScope = await wrongModel.contribution.createRequestScope({
      admission: modelAdmission,
      runtime: runtime(),
    });
    expect((await collect(modelScope.executeSelectedCall({ prompt: 'model' }, allocator()))).at(-1))
      .toMatchObject({ error: { code: 'unsupported_model', param: 'model' } });
    expect(wrongModel.start).not.toHaveBeenCalled();
    await modelScope.dispose();

    const noTransparency = createHarness({
      capabilities: { ...supported, transparentBackground: false },
    });
    const optionAdmission = admission(noTransparency.contribution, { background: 'transparent' });
    const optionScope = await noTransparency.contribution.createRequestScope({
      admission: optionAdmission,
      runtime: runtime(),
    });
    expect((await collect(optionScope.executeSelectedCall({ prompt: 'transparent' }, allocator()))).at(-1))
      .toMatchObject({ error: { code: 'unsupported_capability', param: 'background' } });
    expect(noTransparency.start).not.toHaveBeenCalled();
    await optionScope.dispose();
  });

  it('rejects edit without retained input before provider acquisition', async () => {
    const harness = createHarness();
    const inspected = admission(harness.contribution, { action: 'edit' });
    const scope = await harness.contribution.createRequestScope({ admission: inspected, runtime: runtime() });
    const result = await collect(scope.executeSelectedCall({ prompt: 'edit' }, allocator()));
    expect(result[0]).toMatchObject({ error: { code: 'invalid_image_request', param: 'input' } });
    expect(harness.acquire).not.toHaveBeenCalled();
    await scope.dispose();
  });

  it('supports previous-response and direct-call edits, explicit-first dedupe, and generate override', async () => {
    const harness = createHarness();
    const firstAdmission = admission(harness.contribution);
    const firstScope = await harness.contribution.createRequestScope({
      admission: firstAdmission,
      runtime: runtime(),
    });
    const first = completed(await collect(firstScope.executeSelectedCall({ prompt: 'seed' }, allocator())));
    await firstScope.commit('resp_seed');
    await firstScope.dispose();

    const editAdmission = admission(harness.contribution, { action: 'auto' }, {
      previous_response_id: 'resp_seed',
      input: [{ type: 'image_generation_call', id: first.item.id }],
    });
    const editScope = await harness.contribution.createRequestScope({
      admission: editAdmission,
      authorizedPreviousResponseId: 'resp_seed',
      runtime: runtime(),
    });
    await collect(editScope.executeSelectedCall({ prompt: 'edit seed' }, allocator(5)));
    expect(harness.requests[1]).toMatchObject({ action: 'edit', model: 'trusted-image-model' });
    if (harness.requests[1]?.action === 'edit') expect(harness.requests[1].images).toHaveLength(1);
    await editScope.dispose();

    const generateAdmission = admission(harness.contribution, { action: 'generate' }, {
      input: [{ type: 'image_generation_call', id: first.item.id }],
    });
    const generateScope = await harness.contribution.createRequestScope({
      admission: generateAdmission,
      runtime: runtime(),
    });
    await collect(generateScope.executeSelectedCall({ prompt: 'new image' }, allocator(7)));
    expect(harness.requests[2]?.action).toBe('generate');
    await generateScope.dispose();
  });

  it('carries inherited calls through a text-only middle response', async () => {
    const harness = createHarness();
    const seedAdmission = admission(harness.contribution);
    const seed = await harness.contribution.createRequestScope({ admission: seedAdmission, runtime: runtime() });
    const first = completed(await collect(seed.executeSelectedCall({ prompt: 'seed' }, allocator())));
    await seed.commit('resp_first_turn');
    await seed.dispose();

    const middleAdmission = harness.contribution.inspectRequest({
      previous_response_id: 'resp_first_turn',
      tools: [],
    });
    harness.contribution.validateSelection(middleAdmission, {
      imageCalls: [],
      otherToolCount: 0,
      otherTools: [],
    });
    const middle = await harness.contribution.createRequestScope({
      admission: middleAdmission,
      authorizedPreviousResponseId: 'resp_first_turn',
      runtime: runtime(),
    });
    await middle.commit('resp_text_middle');
    await middle.dispose();

    const laterAdmission = admission(harness.contribution, { action: 'edit' }, {
      previous_response_id: 'resp_text_middle',
    });
    const later = await harness.contribution.createRequestScope({
      admission: laterAdmission,
      authorizedPreviousResponseId: 'resp_text_middle',
      runtime: runtime(),
    });
    await collect(later.executeSelectedCall({ prompt: 'edit later' }, allocator(9)));
    expect(harness.requests.at(-1)?.action).toBe('edit');
    await later.dispose();
    expect(first.item.id).toMatch(/^ig_/);
  });

  it('distinguishes authorized known-empty text chains from missing image state', async () => {
    const harness = createHarness();
    const noImage = harness.contribution.inspectRequest({ tools: [] });
    harness.contribution.validateSelection(noImage, {
      imageCalls: [], otherToolCount: 0, otherTools: [],
    });
    const first = await harness.contribution.createRequestScope({
      admission: noImage,
      runtime: runtime(),
    });
    await first.commit('resp_text_first');
    await first.dispose();

    const middleAdmission = harness.contribution.inspectRequest({
      tools: [],
      previous_response_id: 'resp_text_first',
    });
    harness.contribution.validateSelection(middleAdmission, {
      imageCalls: [], otherToolCount: 0, otherTools: [],
    });
    const middle = await harness.contribution.createRequestScope({
      admission: middleAdmission,
      authorizedPreviousResponseId: 'resp_text_first',
      runtime: runtime(),
    });
    await middle.commit('resp_text_middle_empty');
    await middle.dispose();

    const automatic = admission(harness.contribution, { action: 'auto' }, {
      previous_response_id: 'resp_text_middle_empty',
    });
    const generate = await harness.contribution.createRequestScope({
      admission: automatic,
      authorizedPreviousResponseId: 'resp_text_middle_empty',
      runtime: runtime(),
    });
    expect(completed(await collect(generate.executeSelectedCall(
      { prompt: 'generate after text' }, allocator(),
    ))).item.status).toBe('completed');
    expect(harness.requests.at(-1)?.action).toBe('generate');
    await generate.dispose();

    const forcedEdit = admission(harness.contribution, { action: 'edit' }, {
      previous_response_id: 'resp_text_first',
    });
    const edit = await harness.contribution.createRequestScope({
      admission: forcedEdit,
      authorizedPreviousResponseId: 'resp_text_first',
      runtime: runtime(),
    });
    expect((await collect(edit.executeSelectedCall(
      { prompt: 'must not degrade to generate' }, allocator(8),
    ))).at(-1)).toMatchObject({ kind: 'failed', error: { code: 'invalid_image_request' } });
    expect(harness.requests).toHaveLength(1);
    await edit.dispose();

    await expect(harness.contribution.createRequestScope({
      admission: automatic,
      authorizedPreviousResponseId: 'resp_text_middle_empty',
      runtime: runtime(undefined, { tenantId: 'tenant-b' }),
    })).rejects.toMatchObject({ code: 'image_reference_not_found' });
    const missing = admission(harness.contribution, { action: 'auto' }, {
      previous_response_id: 'resp_not_recorded',
    });
    await expect(harness.contribution.createRequestScope({
      admission: missing,
      authorizedPreviousResponseId: 'resp_not_recorded',
      runtime: runtime(),
    })).rejects.toMatchObject({ code: 'image_reference_not_found' });
  });

  it('does not reinterpret a capacity-evicted known-empty marker as fresh generation context', async () => {
    const stateStore = new InMemoryResponsesImageStateStore({ maxResponses: 1 });
    const harness = createHarness({ stateStore });
    const noImage = harness.contribution.inspectRequest({ tools: [] });
    for (const responseId of ['resp_evict_empty', 'resp_replace_empty']) {
      const scope = await harness.contribution.createRequestScope({ admission: noImage, runtime: runtime() });
      await scope.commit(responseId);
      await scope.dispose();
    }
    const automatic = admission(harness.contribution, { action: 'auto' }, {
      previous_response_id: 'resp_evict_empty',
    });
    await expect(harness.contribution.createRequestScope({
      admission: automatic,
      authorizedPreviousResponseId: 'resp_evict_empty',
      runtime: runtime(),
    })).rejects.toMatchObject({ code: 'image_reference_not_found' });
    expect(harness.start).not.toHaveBeenCalled();
  });

  it('hides cross-tenant call ids and exposes owner expiry without starting a provider', async () => {
    let now = 100;
    const harness = createHarness({ now: () => now });
    const seedAdmission = admission(harness.contribution);
    const seed = await harness.contribution.createRequestScope({
      admission: seedAdmission,
      runtime: runtime(undefined, { referenceTtlMs: 10 }),
    });
    const first = completed(await collect(seed.executeSelectedCall({ prompt: 'seed' }, allocator())));
    await seed.commit('resp_expiring');
    await seed.dispose();

    const direct = admission(harness.contribution, { action: 'edit' }, {
      input: [{ type: 'image_generation_call', id: first.item.id }],
    });
    await expect(harness.contribution.createRequestScope({
      admission: direct,
      runtime: runtime(undefined, { tenantId: 'tenant-b' }),
    })).rejects.toMatchObject({ code: 'image_reference_not_found' });
    now = 111;
    await expect(harness.contribution.createRequestScope({
      admission: direct,
      runtime: runtime(undefined, { referenceTtlMs: 10 }),
    })).rejects.toMatchObject({ code: 'image_reference_expired' });
    expect(harness.start).toHaveBeenCalledOnce();
  });

  it('rolls back uncommitted retained references and survives double disposal', async () => {
    const harness = createHarness();
    const remove = vi.spyOn(harness.referenceStore, 'delete');
    const inspected = admission(harness.contribution);
    const scope = await harness.contribution.createRequestScope({ admission: inspected, runtime: runtime() });
    const done = completed(await collect(scope.executeSelectedCall({ prompt: 'rollback' }, allocator())));
    await scope.dispose();
    await scope.dispose();
    expect(remove).toHaveBeenCalledOnce();
    const removedReference = remove.mock.calls[0]![1];
    expect(remove).toHaveBeenCalledWith('tenant-a', removedReference);
    expect(await harness.referenceStore.resolve('tenant-a', removedReference))
      .toEqual({ status: 'not_found' });
    expect(await harness.stateStore.resolveCall('tenant-a', done.item.id))
      .toEqual({ status: 'not_found' });
  });

  it('serializes delayed commit against concurrent idempotent dispose without deleting committed bytes', async () => {
    const baseState = new InMemoryResponsesImageStateStore();
    const commitEntered = deferred();
    const releaseCommit = deferred();
    const stateStore: ResponsesImageStateStore = {
      commit: async (input) => {
        commitEntered.resolve();
        await releaseCommit.promise;
        return baseState.commit(input);
      },
      resolveCall: (...args) => baseState.resolveCall(...args),
      resolveResponse: (...args) => baseState.resolveResponse(...args),
      deleteCall: (...args) => baseState.deleteCall(...args),
      deleteResponse: (...args) => baseState.deleteResponse(...args),
      cleanup: (...args) => baseState.cleanup(...args),
    };
    const harness = createHarness({ stateStore });
    const remove = vi.spyOn(harness.referenceStore, 'delete');
    const inspected = admission(harness.contribution);
    const scope = await harness.contribution.createRequestScope({ admission: inspected, runtime: runtime() });
    const done = completed(await collect(scope.executeSelectedCall({ prompt: 'commit race' }, allocator())));

    const committing = scope.commit('resp_commit_dispose_race');
    await commitEntered.promise;
    const firstDispose = scope.dispose();
    const secondDispose = scope.dispose();
    expect(firstDispose).toBe(secondDispose);
    expect(remove).not.toHaveBeenCalled();

    releaseCommit.resolve();
    await expect(committing).resolves.toBeUndefined();
    await expect(firstDispose).resolves.toBeUndefined();
    expect(remove).not.toHaveBeenCalled();
    const binding = await stateStore.resolveCall('tenant-a', done.item.id);
    expect(binding.status).toBe('found');
    if (binding.status === 'found') {
      const retained = await harness.referenceStore.resolve('tenant-a', binding.lease.binding.referenceId);
      expect(retained.status).toBe('found');
      if (retained.status === 'found') await retained.lease.release();
      await binding.lease.release();
    }
  });

  it('rejects execution while commit is published and rolls back after delayed commit failure plus dispose', async () => {
    const baseState = new InMemoryResponsesImageStateStore();
    const commitEntered = deferred();
    const releaseCommit = deferred();
    let failCommit = false;
    const stateStore: ResponsesImageStateStore = {
      commit: async (input) => {
        commitEntered.resolve();
        await releaseCommit.promise;
        if (failCommit) throw new Error('delayed atomic commit failure');
        return baseState.commit(input);
      },
      resolveCall: (...args) => baseState.resolveCall(...args),
      resolveResponse: (...args) => baseState.resolveResponse(...args),
      deleteCall: (...args) => baseState.deleteCall(...args),
      deleteResponse: (...args) => baseState.deleteResponse(...args),
      cleanup: (...args) => baseState.cleanup(...args),
    };
    const harness = createHarness({ stateStore });
    const remove = vi.spyOn(harness.referenceStore, 'delete');
    const scope = await harness.contribution.createRequestScope({
      admission: admission(harness.contribution),
      runtime: runtime(),
    });
    const first = completed(await collect(scope.executeSelectedCall({ prompt: 'before commit' }, allocator())));
    failCommit = true;
    const committing = scope.commit('resp_delayed_failure');
    await commitEntered.promise;
    const rejectedExecution = await collect(scope.executeSelectedCall(
      { prompt: 'must not start during commit' }, allocator(5),
    ));
    expect(rejectedExecution).toHaveLength(1);
    expect(rejectedExecution[0]).toMatchObject({
      kind: 'failed', error: { code: 'invalid_image_request' },
    });
    expect(harness.start).toHaveBeenCalledOnce();
    const disposing = scope.dispose();
    releaseCommit.resolve();
    await expect(committing).rejects.toMatchObject({ code: 'image_generation_failed' });
    await expect(disposing).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledOnce();
    expect(await stateStore.resolveCall('tenant-a', first.item.id)).toEqual({ status: 'not_found' });
  });

  it('rolls back a locally completed first call when a later selected call fails', async () => {
    let callIndex = 0;
    const harness = createHarness({
      eventFactory: () => {
        callIndex += 1;
        return callIndex === 1
          ? events(
              { type: 'accepted', acceptedAt: 1 },
              { type: 'completed', images: [{ artifact: asset([1, 2]) }] },
            )
          : events(
              { type: 'accepted', acceptedAt: 2 },
              { type: 'failed', error: serializeImageGenerationError(new ImageGenerationError('moderation_blocked')) },
            );
      },
    });
    const remove = vi.spyOn(harness.referenceStore, 'delete');
    const inspected = admission(harness.contribution);
    const scope = await harness.contribution.createRequestScope({ admission: inspected, runtime: runtime() });
    const first = completed(await collect(scope.executeSelectedCall({ prompt: 'first' }, allocator())));
    const second = await collect(scope.executeSelectedCall({ prompt: 'second' }, allocator(4)));
    expect(second.at(-1)).toMatchObject({ error: { code: 'moderation_blocked' } });
    await scope.dispose();
    expect(remove).toHaveBeenCalledOnce();
    expect(await harness.stateStore.resolveCall('tenant-a', first.item.id))
      .toEqual({ status: 'not_found' });
  });

  it('validates trusted scope inputs and commits a bounded known-empty response marker', async () => {
    const harness = createHarness();
    const stateResolve = vi.spyOn(harness.stateStore, 'resolveCall');
    const inspected = admission(harness.contribution);
    await expect(harness.contribution.createRequestScope({
      admission: inspected,
      runtime: runtime(undefined, { providerId: '' }),
    })).rejects.toMatchObject({ code: 'invalid_image_request', param: 'provider' });
    await expect(harness.contribution.createRequestScope({
      admission: inspected,
      runtime: runtime(undefined, { maxOutputBytes: 0 }),
    })).rejects.toMatchObject({ code: 'invalid_image_request' });
    expect(stateResolve).not.toHaveBeenCalled();
    expect(harness.acquire).not.toHaveBeenCalled();

    const emptyAdmission = harness.contribution.inspectRequest({ tools: [] });
    harness.contribution.validateSelection(emptyAdmission, {
      imageCalls: [],
      otherToolCount: 0,
      otherTools: [],
    });
    const commit = vi.spyOn(harness.stateStore, 'commit');
    const empty = await harness.contribution.createRequestScope({
      admission: emptyAdmission,
      runtime: runtime(),
    });
    await empty.commit('resp_text_only');
    await empty.dispose();
    expect(commit).toHaveBeenCalledOnce();
    const knownEmpty = await harness.stateStore.resolveResponse('tenant-a', 'resp_text_only');
    expect(knownEmpty.status).toBe('found');
    if (knownEmpty.status === 'found') {
      expect(knownEmpty.lease.callIds).toEqual([]);
      await knownEmpty.lease.release();
    }
  });

  it('requires the affinity-authorized previous response id before state lookup', async () => {
    const harness = createHarness();
    const inspected = harness.contribution.inspectRequest({
      tools: [{ type: 'image_generation' }],
      previous_response_id: 'resp_requires_affinity',
    });
    const responseLookup = vi.spyOn(harness.stateStore, 'resolveResponse');
    await expect(harness.contribution.createRequestScope({
      admission: inspected,
      runtime: runtime(),
    })).rejects.toMatchObject({ code: 'image_reference_not_found' });
    expect(responseLookup).not.toHaveBeenCalled();
  });

  it('rolls back after atomic commit failure and redacts the dependency cause', async () => {
    const baseState = new InMemoryResponsesImageStateStore({ now: () => 100 });
    const stateStore: ResponsesImageStateStore = {
      ...baseState,
      commit: async () => { throw new Error('Bearer SECRET_TOKEN Cookie=SECRET Base64=AAAA'); },
      resolveCall: (...args) => baseState.resolveCall(...args),
      resolveResponse: (...args) => baseState.resolveResponse(...args),
      deleteCall: (...args) => baseState.deleteCall(...args),
      deleteResponse: (...args) => baseState.deleteResponse(...args),
      cleanup: (...args) => baseState.cleanup(...args),
    };
    const harness = createHarness({ stateStore, now: () => 100 });
    const remove = vi.spyOn(harness.referenceStore, 'delete');
    const inspected = admission(harness.contribution);
    const scope = await harness.contribution.createRequestScope({ admission: inspected, runtime: runtime() });
    completed(await collect(scope.executeSelectedCall({ prompt: 'commit failure' }, allocator())));
    await expect(scope.commit('resp_commit_failure')).rejects.toMatchObject({ code: 'image_generation_failed' });
    await scope.dispose();
    expect(remove).toHaveBeenCalledOnce();
    await expect(scope.commit('resp_after_dispose')).rejects.not.toThrowError(/SECRET/);
  });

  it('maps provider failed/throw terminals to one sanitized failure without an empty completion', async () => {
    let invocation = 0;
    const harness = createHarness({
      eventFactory: () => {
        invocation += 1;
        if (invocation === 1) return events(
          { type: 'accepted', acceptedAt: 1 },
          { type: 'failed', error: serializeImageGenerationError(new ImageGenerationError('upstream_rate_limited')) },
        );
        return (async function* () {
          yield { type: 'accepted' as const, acceptedAt: 2 };
          throw new Error('prompt/path/token SECRET_SENTINEL');
        })();
      },
    });
    const inspected = admission(harness.contribution);
    const scope = await harness.contribution.createRequestScope({ admission: inspected, runtime: runtime() });
    const failed = await collect(scope.executeSelectedCall({ prompt: 'one' }, allocator()));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ error: { code: 'upstream_rate_limited' } });
    const thrown = await collect(scope.executeSelectedCall({ prompt: 'two' }, allocator(4)));
    expect(thrown.at(-1)).toMatchObject({ error: { code: 'image_generation_failed' } });
    expect(JSON.stringify(thrown)).not.toContain('SECRET_SENTINEL');
    expect(thrown.some((event) => 'kind' in event && event.kind === 'completed')).toBe(false);
    await scope.dispose();
  });

  it('enforces one aggregate decoded-byte budget across real partial and final assets', async () => {
    const harness = createHarness({
      eventFactory: () => events(
        { type: 'accepted', acceptedAt: 1 },
        { type: 'partial_image', outputIndex: 0, partialImageIndex: 0, image: { artifact: asset([9, 9, 9]) } },
        { type: 'completed', images: [{ artifact: asset([1, 2, 3, 4]) }] },
      ),
    });
    const inspected = admission(harness.contribution, { partial_images: 1 }, { stream: true });
    const scope = await harness.contribution.createRequestScope({
      admission: inspected,
      runtime: runtime(undefined, { maxOutputBytes: 4, maxTotalOutputBytes: 6 }),
    });
    const result = await collect(scope.executeSelectedCall({ prompt: 'bounded' }, allocator()));
    expect(result.map(executionRecordType)).toEqual([
      'response.image_generation_call.partial_image',
      'failed',
    ]);
    expect(result.at(-1)).toMatchObject({ error: { code: 'image_too_large' } });
    await scope.dispose();
  });

  it('enforces the per-artifact budget and provider partial order without synthesizing recovery data', async () => {
    const oversized = createHarness();
    const oversizedAdmission = admission(oversized.contribution);
    const oversizedScope = await oversized.contribution.createRequestScope({
      admission: oversizedAdmission,
      runtime: runtime(undefined, { maxOutputBytes: 3, maxTotalOutputBytes: 6 }),
    });
    const tooLarge = await collect(oversizedScope.executeSelectedCall({ prompt: 'large' }, allocator()));
    expect(tooLarge).toHaveLength(1);
    expect(tooLarge[0]).toMatchObject({ error: { code: 'image_too_large' } });
    await oversizedScope.dispose();

    const duplicatePartial = createHarness({
      eventFactory: () => events(
        { type: 'accepted', acceptedAt: 1 },
        { type: 'partial_image', outputIndex: 0, partialImageIndex: 0, image: { artifact: asset([1]) } },
        { type: 'partial_image', outputIndex: 0, partialImageIndex: 0, image: { artifact: asset([2]) } },
      ),
    });
    const partialAdmission = admission(duplicatePartial.contribution, { partial_images: 2 }, { stream: true });
    const partialScope = await duplicatePartial.contribution.createRequestScope({
      admission: partialAdmission,
      runtime: runtime(),
    });
    const malformed = await collect(partialScope.executeSelectedCall({ prompt: 'order' }, allocator()));
    expect(malformed.map(executionRecordType)).toEqual([
      'response.image_generation_call.partial_image',
      'failed',
    ]);
    expect(malformed.at(-1)).toMatchObject({ error: { code: 'upstream_protocol_changed' } });
    expect(duplicatePartial.cancel).toHaveBeenCalledOnce();
    await partialScope.dispose();
  });

  it('detects retention-store disagreement and deletes the unusable retained reference', async () => {
    const base = new InMemoryImageReferenceStore(() => 100);
    const remove = vi.spyOn(base, 'delete');
    const mismatch: ImageReferenceStore = {
      save: (input) => base.save(input),
      async resolve(tenantId, referenceId) {
        const resolved = await base.resolve(tenantId, referenceId);
        if (resolved.status !== 'found') return resolved;
        return {
          status: 'found' as const,
          lease: {
            ...resolved.lease,
            metadata: { ...resolved.lease.metadata, width: resolved.lease.metadata.width + 1 },
          },
        };
      },
      delete: (...args) => base.delete(...args),
      cleanup: (...args) => base.cleanup(...args),
    };
    const harness = createHarness({ referenceStore: mismatch, now: () => 100 });
    const inspected = admission(harness.contribution);
    const scope = await harness.contribution.createRequestScope({ admission: inspected, runtime: runtime() });
    const result = await collect(scope.executeSelectedCall({ prompt: 'mismatch' }, allocator()));
    expect(result.at(-1)).toMatchObject({ error: { code: 'upstream_protocol_changed' } });
    await scope.dispose();
    expect(remove).toHaveBeenCalled();
  });

  it('rejects cancellation during delayed previous-response resolution and releases its lease', async () => {
    const seeded = createHarness();
    const responseId = 'resp_abort_response_lookup';
    await seedCommittedImage(seeded, responseId);
    const entered = deferred();
    const releaseLookup = deferred();
    let responseLeaseReleases = 0;
    const resolveCall = vi.fn((tenantId: string, callId: ResponsesImageCallId) => (
      seeded.stateStore.resolveCall(tenantId, callId)
    ));
    const delayedState = stateStoreWith(seeded.stateStore, {
      resolveCall,
      resolveResponse: async (tenantId, requestedResponseId) => {
        const result = await seeded.stateStore.resolveResponse(tenantId, requestedResponseId);
        if (result.status !== 'found') return result;
        const lease = result.lease;
        entered.resolve();
        await releaseLookup.promise;
        return {
          status: 'found' as const,
          lease: {
            responseId: lease.responseId,
            callIds: lease.callIds,
            expiresAt: lease.expiresAt,
            release: async () => {
              responseLeaseReleases += 1;
              await lease.release();
            },
          },
        };
      },
    });
    const harness = createHarness({
      stateStore: delayedState,
      referenceStore: seeded.referenceStore,
    });
    const inspected = admission(harness.contribution, { action: 'edit' }, {
      previous_response_id: responseId,
    });
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const creating = harness.contribution.createRequestScope({
      admission: inspected,
      authorizedPreviousResponseId: responseId,
      runtime: runtime(controller),
    });

    await entered.promise;
    controller.abort(new Error('disconnect during response lookup'));
    releaseLookup.resolve();
    const failure = await creating.then(
      () => new Error('scope creation unexpectedly succeeded'),
      (error: unknown) => error,
    );

    expectStableCancellation(failure);
    expect(responseLeaseReleases).toBe(1);
    expect(resolveCall).not.toHaveBeenCalled();
    expect(removeListener).toHaveBeenCalledOnce();
    expect(harness.acquire).not.toHaveBeenCalled();
    expect(harness.start).not.toHaveBeenCalled();
  });

  it('rejects cancellation during delayed call-state resolution and releases its lease', async () => {
    const seeded = createHarness();
    const callId = await seedCommittedImage(seeded, 'resp_abort_call_lookup');
    const entered = deferred();
    const releaseLookup = deferred();
    let stateLeaseReleases = 0;
    const delayedState = stateStoreWith(seeded.stateStore, {
      resolveCall: async (tenantId, requestedCallId) => {
        const result = await seeded.stateStore.resolveCall(tenantId, requestedCallId);
        if (result.status !== 'found') return result;
        const lease = result.lease;
        entered.resolve();
        await releaseLookup.promise;
        return {
          status: 'found' as const,
          lease: {
            binding: lease.binding,
            release: async () => {
              stateLeaseReleases += 1;
              await lease.release();
            },
          },
        };
      },
    });
    const referenceResolve = vi.spyOn(seeded.referenceStore, 'resolve');
    const harness = createHarness({
      stateStore: delayedState,
      referenceStore: seeded.referenceStore,
    });
    const inspected = admission(harness.contribution, { action: 'edit' }, {
      input: [{ type: 'image_generation_call', id: callId }],
    });
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const creating = harness.contribution.createRequestScope({
      admission: inspected,
      runtime: runtime(controller),
    });

    await entered.promise;
    controller.abort(new Error('disconnect during call lookup'));
    releaseLookup.resolve();
    const failure = await creating.then(
      () => new Error('scope creation unexpectedly succeeded'),
      (error: unknown) => error,
    );

    expectStableCancellation(failure);
    expect(stateLeaseReleases).toBe(1);
    expect(referenceResolve).not.toHaveBeenCalled();
    expect(removeListener).toHaveBeenCalledOnce();
    expect(harness.acquire).not.toHaveBeenCalled();
    expect(harness.start).not.toHaveBeenCalled();
  });

  it('rejects cancellation during delayed image-reference resolution and releases both leases', async () => {
    const seeded = createHarness();
    const callId = await seedCommittedImage(seeded, 'resp_abort_reference_lookup');
    const entered = deferred();
    const releaseLookup = deferred();
    let stateLeaseReleases = 0;
    let imageLeaseReleases = 0;
    const trackingState = stateStoreWith(seeded.stateStore, {
      resolveCall: async (tenantId, requestedCallId) => {
        const result = await seeded.stateStore.resolveCall(tenantId, requestedCallId);
        if (result.status !== 'found') return result;
        const lease = result.lease;
        return {
          status: 'found' as const,
          lease: {
            binding: lease.binding,
            release: async () => {
              stateLeaseReleases += 1;
              await lease.release();
            },
          },
        };
      },
    });
    const delayedReferences = referenceStoreWith(seeded.referenceStore, {
      resolve: async (tenantId, referenceId) => {
        const result = await seeded.referenceStore.resolve(tenantId, referenceId);
        if (result.status !== 'found') return result;
        const lease = result.lease;
        entered.resolve();
        await releaseLookup.promise;
        return {
          status: 'found' as const,
          lease: {
            metadata: lease.metadata,
            value: lease.value,
            release: async () => {
              imageLeaseReleases += 1;
              await lease.release();
            },
          },
        };
      },
    });
    const harness = createHarness({
      stateStore: trackingState,
      referenceStore: delayedReferences,
    });
    const inspected = admission(harness.contribution, { action: 'edit' }, {
      input: [{ type: 'image_generation_call', id: callId }],
    });
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const creating = harness.contribution.createRequestScope({
      admission: inspected,
      runtime: runtime(controller),
    });

    await entered.promise;
    controller.abort(new Error('disconnect during reference lookup'));
    releaseLookup.resolve();
    const failure = await creating.then(
      () => new Error('scope creation unexpectedly succeeded'),
      (error: unknown) => error,
    );

    expectStableCancellation(failure);
    expect(stateLeaseReleases).toBe(1);
    expect(imageLeaseReleases).toBe(1);
    expect(removeListener).toHaveBeenCalledOnce();
    expect(harness.acquire).not.toHaveBeenCalled();
    expect(harness.start).not.toHaveBeenCalled();
  });

  it('propagates abort before acquisition and during nonterminal provider work exactly once', async () => {
    const before = createHarness();
    const beforeController = new AbortController();
    beforeController.abort(new Error('before acquisition'));
    const inspected = admission(before.contribution);
    await expect(before.contribution.createRequestScope({
      admission: inspected,
      runtime: runtime(beforeController),
    })).rejects.toMatchObject({ code: 'request_cancelled' });
    expect(before.acquire).not.toHaveBeenCalled();

    let accepted!: () => void;
    const acceptedPromise = new Promise<void>((resolve) => { accepted = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const controller = new AbortController();
    const during = createHarness({
      eventFactory: () => (async function* () {
        yield { type: 'accepted' as const, acceptedAt: 1 };
        accepted();
        await held;
        yield { type: 'completed' as const, images: [{ artifact: asset([1]) }] };
      })(),
    });
    during.cancel.mockImplementation(async () => { release(); });
    const duringAdmission = admission(during.contribution);
    const scope = await during.contribution.createRequestScope({
      admission: duringAdmission,
      runtime: runtime(controller),
    });
    const running = collect(scope.executeSelectedCall({ prompt: 'abort' }, allocator()));
    await acceptedPromise;
    controller.abort(new Error('disconnect'));
    const result = await running;
    expect(result.at(-1)).toMatchObject({ error: { code: 'request_cancelled' } });
    expect(during.cancel).toHaveBeenCalledOnce();
    await scope.waitForIdle();
    await scope.dispose();
  });

  it('cancels exactly once after job creation but before provider acceptance', async () => {
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const controller = new AbortController();
    const harness = createHarness({
      eventFactory: () => (async function* () {
        entered();
        await held;
        yield { type: 'accepted' as const, acceptedAt: 1 };
      })(),
    });
    harness.cancel.mockImplementation(async () => { release(); });
    const inspected = admission(harness.contribution);
    const scope = await harness.contribution.createRequestScope({
      admission: inspected,
      runtime: runtime(controller),
    });
    const running = collect(scope.executeSelectedCall({ prompt: 'pre-accept abort' }, allocator()));
    await enteredPromise;
    controller.abort(new Error('disconnect before acceptance'));
    expect((await running).at(-1)).toMatchObject({ error: { code: 'request_cancelled' } });
    expect(harness.cancel).toHaveBeenCalledOnce();
    await scope.dispose();
  });

  it('scope disposal closes and cancels provider work during pre-accept and accepted waits', async () => {
    for (const stage of ['preaccept', 'accepted'] as const) {
      const reached = deferred();
      const release = deferred();
      const harness = createHarness({
        eventFactory: () => (async function* () {
          if (stage === 'accepted') yield { type: 'accepted' as const, acceptedAt: 1 };
          reached.resolve();
          await release.promise;
          if (stage === 'preaccept') yield { type: 'accepted' as const, acceptedAt: 1 };
          yield { type: 'completed' as const, images: [{ artifact: asset([1]) }] };
        })(),
      });
      harness.cancel.mockImplementation(async () => { release.resolve(); });
      const scope = await harness.contribution.createRequestScope({
        admission: admission(harness.contribution),
        runtime: runtime(),
      });
      const running = collect(scope.executeSelectedCall({ prompt: `dispose ${stage}` }, allocator()));
      await reached.promise;
      await expect(scope.commit(`resp_${stage}_while_executing`))
        .rejects.toMatchObject({ code: 'image_generation_failed' });
      const disposeOne = scope.dispose();
      const disposeTwo = scope.dispose();
      expect(disposeOne).toBe(disposeTwo);
      await expect(disposeOne).resolves.toBeUndefined();
      await expect(running).resolves.toEqual(expect.any(Array));
      expect(harness.cancel).toHaveBeenCalledOnce();
      const afterDispose = await collect(scope.executeSelectedCall(
        { prompt: 'cannot restart' }, allocator(7),
      ));
      expect(afterDispose.at(-1)).toMatchObject({
        kind: 'failed',
        error: { code: 'request_cancelled' },
      });
      expect(harness.start).toHaveBeenCalledOnce();
    }
  });

  it('stops Base64 mapping when aborted during a partial asset read', async () => {
    let opened!: () => void;
    const openedPromise = new Promise<void>((resolve) => { opened = resolve; });
    const slowAsset = {
      artifactId: 'slow-partial' as never,
      mimeType: 'image/png' as const,
      byteLength: 2,
      width: 1,
      height: 1,
      hasAlpha: true,
      independentlyDecodable: true as const,
      async open(options: { readonly signal?: AbortSignal } = {}) {
        return new ReadableStream<Uint8Array>({
          start(controller) {
            opened();
            options.signal?.addEventListener('abort', () => controller.error(options.signal?.reason), { once: true });
          },
        });
      },
    } satisfies ImageAsset;
    const controller = new AbortController();
    const harness = createHarness({
      eventFactory: () => events(
        { type: 'accepted', acceptedAt: 1 },
        { type: 'partial_image', outputIndex: 0, partialImageIndex: 0, image: { artifact: slowAsset } },
      ),
    });
    const inspected = admission(harness.contribution, { partial_images: 1 }, { stream: true });
    const scope = await harness.contribution.createRequestScope({
      admission: inspected,
      runtime: runtime(controller),
    });
    const running = collect(scope.executeSelectedCall({ prompt: 'abort read' }, allocator()));
    await openedPromise;
    controller.abort(new Error('disconnect during read'));
    const result = await running;
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ error: { code: 'request_cancelled' } });
    expect(JSON.stringify(result)).not.toContain(Buffer.from([1, 2]).toString('base64'));
    expect(harness.cancel).toHaveBeenCalledOnce();
    await scope.dispose();
  });

  it('scope disposal aborts an active asset read, closes iteration, and awaits cancellation', async () => {
    const opened = deferred();
    const slowAsset = {
      artifactId: 'dispose-slow-partial' as never,
      mimeType: 'image/png' as const,
      byteLength: 2,
      width: 1,
      height: 1,
      hasAlpha: true,
      independentlyDecodable: true as const,
      async open(options: { readonly signal?: AbortSignal } = {}) {
        return new ReadableStream<Uint8Array>({
          start(controller) {
            opened.resolve();
            options.signal?.addEventListener(
              'abort',
              () => controller.error(options.signal?.reason),
              { once: true },
            );
          },
        });
      },
    } satisfies ImageAsset;
    const harness = createHarness({
      eventFactory: () => events(
        { type: 'accepted', acceptedAt: 1 },
        { type: 'partial_image', outputIndex: 0, partialImageIndex: 0, image: { artifact: slowAsset } },
      ),
    });
    const scope = await harness.contribution.createRequestScope({
      admission: admission(harness.contribution, { partial_images: 1 }, { stream: true }),
      runtime: runtime(),
    });
    const running = collect(scope.executeSelectedCall({ prompt: 'dispose read' }, allocator()));
    await opened.promise;
    await expect(scope.dispose()).resolves.toBeUndefined();
    await expect(running).resolves.toEqual(expect.any(Array));
    expect(harness.cancel).toHaveBeenCalledOnce();
  });

  it('does not cancel provider-terminal work when the outer response later aborts', async () => {
    const controller = new AbortController();
    const harness = createHarness();
    const inspected = admission(harness.contribution);
    const scope = await harness.contribution.createRequestScope({
      admission: inspected,
      runtime: runtime(controller),
    });
    expect(completed(await collect(scope.executeSelectedCall({ prompt: 'terminal' }, allocator()))).item.status)
      .toBe('completed');
    controller.abort(new Error('containing response failed'));
    await scope.dispose();
    expect(harness.cancel).not.toHaveBeenCalled();
  });

  it('cancels once when the consumer returns after a real partial and never emits later Base64', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const harness = createHarness({
      eventFactory: () => (async function* () {
        yield { type: 'accepted' as const, acceptedAt: 1 };
        yield {
          type: 'partial_image' as const,
          outputIndex: 0,
          partialImageIndex: 0,
          image: { artifact: asset([5, 5]) },
        };
        await held;
        yield { type: 'completed' as const, images: [{ artifact: asset([1]) }] };
      })(),
    });
    harness.cancel.mockImplementation(async () => { release(); });
    const inspected = admission(harness.contribution, { partial_images: 1 }, { stream: true });
    const scope = await harness.contribution.createRequestScope({ admission: inspected, runtime: runtime() });
    const seen: ResponsesImageExecutionEvent[] = [];
    for await (const event of scope.executeSelectedCall({ prompt: 'early return' }, allocator())) {
      seen.push(event);
      break;
    }
    await scope.waitForIdle();
    expect(seen).toHaveLength(1);
    expect(executionRecordType(seen[0]!)).toBe('response.image_generation_call.partial_image');
    expect(harness.cancel).toHaveBeenCalledOnce();
    await scope.dispose();
  });

  it('keeps active state/image leases usable through expiry cleanup', async () => {
    let now = 100;
    const harness = createHarness({ now: () => now });
    const seedAdmission = admission(harness.contribution);
    const seed = await harness.contribution.createRequestScope({
      admission: seedAdmission,
      runtime: runtime(undefined, { referenceTtlMs: 10 }),
    });
    const first = completed(await collect(seed.executeSelectedCall({ prompt: 'seed' }, allocator())));
    await seed.commit('resp_pinned');
    await seed.dispose();

    const editAdmission = admission(harness.contribution, { action: 'edit' }, {
      input: [{ type: 'image_generation_call', id: first.item.id }],
    });
    const edit = await harness.contribution.createRequestScope({
      admission: editAdmission,
      runtime: runtime(undefined, { referenceTtlMs: 10 }),
    });
    now = 111;
    expect(await harness.stateStore.cleanup(now)).toEqual([]);
    expect(await harness.referenceStore.cleanup(now)).toBe(0);
    const result = await collect(edit.executeSelectedCall({ prompt: 'pinned edit' }, allocator(8)));
    expect(completed(result).item.status).toBe('completed');
    await edit.dispose();
    expect((await harness.stateStore.cleanup(now)).map((item) => item.callId)).toContain(first.item.id);
    expect(await harness.referenceStore.cleanup(now)).toBeGreaterThanOrEqual(1);
  });
});
