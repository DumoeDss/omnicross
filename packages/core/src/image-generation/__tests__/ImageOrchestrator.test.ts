import { describe, expect, it, vi } from 'vitest';

import type {
  ImageCapabilities,
  ImageProviderEvent,
  ImageReferenceId,
  NormalizedImageEditRequest,
  NormalizedImageGenerateRequest,
} from '@omnicross/contracts/image-generation-types';

import { ImageGenerationError, serializeImageGenerationError } from '../errors';
import { ImageOrchestrator } from '../ImageOrchestrator';
import type {
  ImageJob,
  ImageProvider,
  ImageProviderContext,
  ImageProviderLease,
} from '../ImageProvider';
import { ImageProviderRegistry } from '../ImageProviderRegistry';
import {
  InMemoryImageAsset,
  InMemoryImageReferenceStore,
  type ImageTelemetryRecord,
} from '../ports';

const capabilities: ImageCapabilities = {
  available: true,
  models: ['image-test'],
  generate: true,
  edit: true,
  maskEdit: true,
  maxInputImages: 4,
  maxOutputImages: 2,
  streaming: true,
  maxPartialImages: 3,
  transparentBackground: true,
  flexibleSizes: true,
  outputFormats: ['png', 'webp'],
  qualityLevels: ['auto', 'low', 'medium', 'high'],
  moderationModes: ['auto', 'low'],
  outputCompression: { supported: true, formats: ['webp'], min: 0, max: 100 },
  responsesTool: false,
  multiTurnEdit: true,
  supportsFileId: true,
  supportsImageUrl: false,
  resolvedAt: 1,
  oldestEvidenceAt: 1,
};

const request: NormalizedImageGenerateRequest = {
  action: 'generate',
  model: 'image-test',
  prompt: 'SECRET_PROMPT_SENTINEL',
  n: 1,
  quality: 'auto',
  size: { kind: 'auto' },
  background: 'auto',
  outputFormat: 'png',
  moderation: 'auto',
  stream: true,
  partialImages: 1,
};

function asset(bytes = [137, 80, 78, 71]) {
  return new InMemoryImageAsset(new Uint8Array(bytes), {
    mimeType: 'image/png', width: 1, height: 1, hasAlpha: true,
  });
}

function context(controller = new AbortController()): ImageProviderContext {
  return { requestId: 'request-safe', tenantId: 'tenant-a', signal: controller.signal };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function delayedTelemetry() {
  const entered = deferred();
  const release = deferred();
  const records: ImageTelemetryRecord[] = [];
  const sink = {
    record: vi.fn(async (record: ImageTelemetryRecord) => {
      entered.resolve();
      await release.promise;
      records.push(record);
    }),
  };
  return { entered, release, records, sink };
}

function setup(events: AsyncIterable<ImageProviderEvent<ReturnType<typeof asset>>>, caps = capabilities) {
  const cancel = vi.fn(async () => undefined);
  const start = vi.fn((): ImageJob => ({ events, cancel }));
  const release = vi.fn(async () => undefined);
  const acquire = vi.fn(async (): Promise<ImageProviderLease> => ({
    providerId: 'fake', capabilities: caps, start, release,
  }));
  const provider: ImageProvider = { id: 'fake', acquire };
  const registry = new ImageProviderRegistry([provider]);
  return { registry, acquire, start, release, cancel };
}

async function* eventStream(...events: ImageProviderEvent<ReturnType<typeof asset>>[]) {
  for (const event of events) yield event;
}

function heldAfterEvents(...events: ImageProviderEvent<ReturnType<typeof asset>>[]) {
  type Event = ImageProviderEvent<ReturnType<typeof asset>>;
  let nextIndex = 0;
  let resolveHeldRead: ((result: IteratorResult<Event>) => void) | undefined;
  let markHeld: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    markHeld = resolve;
  });
  const returnIterator = vi.fn(async (): Promise<IteratorResult<Event>> => {
    resolveHeldRead?.({ done: true, value: undefined });
    return { done: true, value: undefined };
  });
  const iterator: AsyncIterator<Event> = {
    next: vi.fn((): Promise<IteratorResult<Event>> => {
      if (nextIndex < events.length) {
        return Promise.resolve({ done: false, value: events[nextIndex++]! });
      }
      markHeld?.();
      return new Promise((resolve) => {
        resolveHeldRead = resolve;
      });
    }),
    return: returnIterator,
  };
  const iterable: AsyncIterable<Event> = {
    [Symbol.asyncIterator]: () => iterator,
  };
  return { events: iterable, held, returnIterator };
}

describe('ImageOrchestrator lifecycle', () => {
  it('forwards accepted/partial/completed in order and releases exactly once', async () => {
    const partial = asset([1, 2]);
    const final = asset([3, 4]);
    const fake = setup(eventStream(
      { type: 'accepted', acceptedAt: 10 },
      { type: 'partial_image', outputIndex: 0, partialImageIndex: 0, image: { artifact: partial } },
      { type: 'completed', images: [{ artifact: final }] },
    ));
    const orchestrator = new ImageOrchestrator({ registry: fake.registry });
    const result = await collect(orchestrator.run(request, context(), { providerId: 'fake' }));
    expect(result.map((event) => event.type)).toEqual(['accepted', 'partial_image', 'completed']);
    expect(fake.start).toHaveBeenCalledOnce();
    expect(fake.cancel).not.toHaveBeenCalled();
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it('cancels and releases exactly once when a consumer returns before a provider terminal', async () => {
    const fake = setup(eventStream(
      { type: 'accepted', acceptedAt: 10 },
      { type: 'partial_image', outputIndex: 0, partialImageIndex: 0, image: { artifact: asset() } },
      { type: 'completed', images: [{ artifact: asset() }] },
    ));
    const orchestrator = new ImageOrchestrator({ registry: fake.registry });
    for await (const event of orchestrator.run(request, context(), { providerId: 'fake' })) {
      expect(event.type).toBe('accepted');
      break;
    }
    expect(fake.cancel).toHaveBeenCalledOnce();
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it('does not cancel a provider that has already completed or failed', async () => {
    const completed = setup(eventStream(
      { type: 'accepted', acceptedAt: 1 },
      { type: 'completed', images: [{ artifact: asset() }] },
    ));
    await collect(new ImageOrchestrator({ registry: completed.registry }).run(
      request, context(), { providerId: 'fake' },
    ));
    expect(completed.cancel).not.toHaveBeenCalled();
    expect(completed.release).toHaveBeenCalledOnce();

    const failed = setup(eventStream(
      { type: 'accepted', acceptedAt: 1 },
      { type: 'failed', error: serializeImageGenerationError(new ImageGenerationError('image_generation_failed')) },
    ));
    await collect(new ImageOrchestrator({ registry: failed.registry }).run(
      request, context(), { providerId: 'fake' },
    ));
    expect(failed.cancel).not.toHaveBeenCalled();
    expect(failed.release).toHaveBeenCalledOnce();
  });

  it('rebuilds provider events and drops non-contract runtime fields', async () => {
    const hidden = 'SECRET_PROVIDER_RUNTIME_FIELD';
    const fake = setup(eventStream(
      { type: 'accepted', acceptedAt: 10, hidden } as ImageProviderEvent<ReturnType<typeof asset>>,
      {
        type: 'completed',
        images: [{ artifact: asset(), hidden }],
        hidden,
      } as unknown as ImageProviderEvent<ReturnType<typeof asset>>,
    ));
    const result = await collect(new ImageOrchestrator({ registry: fake.registry }).run(
      request, context(), { providerId: 'fake' },
    ));
    expect(JSON.stringify(result)).not.toContain(hidden);
  });

  it.each([
    ['partial before accepted', eventStream(
      { type: 'partial_image', outputIndex: 0, partialImageIndex: 0, image: { artifact: asset() } },
      { type: 'completed', images: [{ artifact: asset() }] },
    )],
    ['non-monotonic partial indexes', eventStream(
      { type: 'accepted', acceptedAt: 1 },
      { type: 'partial_image', outputIndex: 0, partialImageIndex: 1, image: { artifact: asset() } },
      { type: 'partial_image', outputIndex: 0, partialImageIndex: 1, image: { artifact: asset() } },
      { type: 'completed', images: [{ artifact: asset() }] },
    )],
    ['missing terminal', eventStream({ type: 'accepted', acceptedAt: 1 })],
    ['duplicate terminal', eventStream(
      { type: 'accepted', acceptedAt: 1 },
      { type: 'completed', images: [{ artifact: asset() }] },
      { type: 'failed', error: serializeImageGenerationError(new ImageGenerationError('image_generation_failed')) },
    )],
    ['wrong final count', eventStream(
      { type: 'accepted', acceptedAt: 1 },
      { type: 'completed', images: [] },
    )],
  ])('rejects %s without forwarding a successful terminal', async (_name, events) => {
    const fake = setup(events);
    const orchestrator = new ImageOrchestrator({ registry: fake.registry });
    await expect(collect(orchestrator.run(request, context(), { providerId: 'fake' })))
      .rejects.toMatchObject({ code: 'upstream_protocol_changed' });
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it('normalizes iterator throws with the acceptance retry boundary and never retries', async () => {
    async function* throwing() {
      yield { type: 'accepted' as const, acceptedAt: 1 };
      throw new Error('transport body SECRET_SENTINEL');
    }
    const fake = setup(throwing());
    const orchestrator = new ImageOrchestrator({ registry: fake.registry });
    await expect(collect(orchestrator.run(request, context(), { providerId: 'fake' })))
      .rejects.toMatchObject({ code: 'image_generation_failed', retrySafety: 'after_acceptance' });
    expect(fake.acquire).toHaveBeenCalledOnce();
    expect(fake.start).toHaveBeenCalledOnce();
    expect(fake.cancel).toHaveBeenCalledOnce();
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it('keeps pre-accept transport failure retry-unknown and does not retry it', async () => {
    async function* throwing() {
      throw new Error('transport before acceptance SECRET_SENTINEL');
      yield { type: 'accepted' as const, acceptedAt: 1 };
    }
    const fake = setup(throwing());
    const orchestrator = new ImageOrchestrator({ registry: fake.registry });
    await expect(collect(orchestrator.run(request, context(), { providerId: 'fake' })))
      .rejects.toMatchObject({ code: 'image_generation_failed', retrySafety: 'unknown' });
    expect(fake.acquire).toHaveBeenCalledOnce();
    expect(fake.start).toHaveBeenCalledOnce();
    expect(fake.cancel).toHaveBeenCalledOnce();
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it('keeps an unknown start failure retry-unknown', async () => {
    const fake = setup(eventStream());
    fake.start.mockImplementationOnce(() => {
      throw new Error('start failure before any acceptance evidence');
    });
    const orchestrator = new ImageOrchestrator({ registry: fake.registry });
    await expect(collect(orchestrator.run(request, context(), { providerId: 'fake' })))
      .rejects.toMatchObject({ code: 'image_generation_failed', retrySafety: 'unknown' });
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it.each([
    ['action', { generate: false }],
    ['model', { models: ['other'] }],
    ['format', { outputFormats: ['webp'] }],
    ['count', { maxOutputImages: 0 }],
    ['stream', { streaming: false }],
    ['partial', { maxPartialImages: 0 }],
    ['transparency', { transparentBackground: false }],
    ['quality', { qualityLevels: ['low'] }],
    ['moderation', { moderationModes: ['low'] }],
  ])('does not start for unsupported %s requirements', async (name, override) => {
    const fake = setup(eventStream(), { ...capabilities, ...override } as ImageCapabilities);
    const orchestrator = new ImageOrchestrator({ registry: fake.registry });
    const changed = name === 'transparency' ? { ...request, background: 'transparent' as const } : request;
    await expect(collect(orchestrator.run(changed, context(), { providerId: 'fake' }))).rejects.toBeInstanceOf(ImageGenerationError);
    expect(fake.start).not.toHaveBeenCalled();
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it('requires affirmative output-compression semantics before start', async () => {
    const unsupportedCompression = setup(eventStream(), {
      ...capabilities,
      outputCompression: { supported: false },
    });
    const compressed = { ...request, outputFormat: 'webp' as const, outputCompression: 75 };
    await expect(collect(new ImageOrchestrator({ registry: unsupportedCompression.registry }).run(
      compressed, context(), { providerId: 'fake' },
    ))).rejects.toMatchObject({ code: 'unsupported_capability', param: 'output_compression' });
    expect(unsupportedCompression.start).not.toHaveBeenCalled();

    const supportedCompression = setup(eventStream(
      { type: 'accepted', acceptedAt: 1 },
      { type: 'completed', images: [{ artifact: new InMemoryImageAsset(Uint8Array.of(1), {
        mimeType: 'image/webp', width: 1, height: 1, hasAlpha: true,
      }) }] },
    ));
    await expect(collect(new ImageOrchestrator({ registry: supportedCompression.registry }).run(
      compressed, context(), { providerId: 'fake' },
    ))).resolves.toHaveLength(2);
    expect(supportedCompression.start).toHaveBeenCalledOnce();
  });

  it.each([
    ['format', { outputFormat: 'webp' as const }, asset()],
    ['width', { size: { kind: 'pixels' as const, width: 2, height: 1 } }, asset()],
    ['height', { size: { kind: 'pixels' as const, width: 1, height: 2 } }, asset()],
    ['alpha', { background: 'transparent' as const }, new InMemoryImageAsset(Uint8Array.of(1), {
      mimeType: 'image/png', width: 1, height: 1, hasAlpha: false,
    })],
  ])('rejects final artifact %s drift before completion', async (_name, override, final) => {
    const fake = setup(eventStream(
      { type: 'accepted', acceptedAt: 1 },
      { type: 'completed', images: [{ artifact: final }] },
    ));
    const store = new InMemoryImageReferenceStore();
    const save = vi.spyOn(store, 'save');
    await expect(collect(new ImageOrchestrator({ registry: fake.registry, referenceStore: store }).run(
      { ...request, ...override }, context(), {
        providerId: 'fake',
        retention: { enabled: true, ttlMs: 1_000 },
      },
    ))).rejects.toMatchObject({ code: 'upstream_protocol_changed' });
    expect(save).not.toHaveBeenCalled();
    expect(fake.cancel).toHaveBeenCalledOnce();
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it('validates every final artifact in a multi-output completion', async () => {
    const fake = setup(eventStream(
      { type: 'accepted', acceptedAt: 1 },
      { type: 'completed', images: [
        { artifact: asset() },
        { artifact: new InMemoryImageAsset(Uint8Array.of(2), {
          mimeType: 'image/webp', width: 1, height: 1, hasAlpha: true,
        }) },
      ] },
    ));
    await expect(collect(new ImageOrchestrator({ registry: fake.registry }).run(
      { ...request, n: 2 }, context(), { providerId: 'fake' },
    ))).rejects.toMatchObject({ code: 'upstream_protocol_changed' });
    expect(fake.cancel).toHaveBeenCalledOnce();
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it('enforces the requested partial budget independently for each output', async () => {
    const exact = setup(eventStream(
      { type: 'accepted', acceptedAt: 1 },
      { type: 'partial_image', outputIndex: 0, partialImageIndex: 0, image: { artifact: asset() } },
      { type: 'partial_image', outputIndex: 1, partialImageIndex: 0, image: { artifact: asset() } },
      { type: 'partial_image', outputIndex: 0, partialImageIndex: 1, image: { artifact: asset() } },
      { type: 'partial_image', outputIndex: 1, partialImageIndex: 1, image: { artifact: asset() } },
      { type: 'completed', images: [{ artifact: asset() }, { artifact: asset() }] },
    ));
    await expect(collect(new ImageOrchestrator({ registry: exact.registry }).run(
      { ...request, n: 2, partialImages: 2 }, context(), { providerId: 'fake' },
    ))).resolves.toHaveLength(6);
    expect(exact.cancel).not.toHaveBeenCalled();

    const exceeded = setup(eventStream(
      { type: 'accepted', acceptedAt: 1 },
      { type: 'partial_image', outputIndex: 0, partialImageIndex: 0, image: { artifact: asset() } },
      { type: 'partial_image', outputIndex: 1, partialImageIndex: 0, image: { artifact: asset() } },
      { type: 'partial_image', outputIndex: 0, partialImageIndex: 1, image: { artifact: asset() } },
    ));
    await expect(collect(new ImageOrchestrator({ registry: exceeded.registry }).run(
      { ...request, n: 2, partialImages: 1 }, context(), { providerId: 'fake' },
    ))).rejects.toMatchObject({ code: 'upstream_protocol_changed' });
    expect(exceeded.cancel).toHaveBeenCalledOnce();
    expect(exceeded.release).toHaveBeenCalledOnce();
  });

  it('rejects every partial when the requested budget is zero and cancels the nonterminal job', async () => {
    const fake = setup(eventStream(
      { type: 'accepted', acceptedAt: 1 },
      { type: 'partial_image', outputIndex: 0, partialImageIndex: 0, image: { artifact: asset() } },
    ));
    await expect(collect(new ImageOrchestrator({ registry: fake.registry }).run(
      { ...request, partialImages: 0 }, context(), { providerId: 'fake' },
    ))).rejects.toMatchObject({ code: 'upstream_protocol_changed' });
    expect(fake.cancel).toHaveBeenCalledOnce();
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it('does not start unsupported edit or mask requirements', async () => {
    const input = asset();
    const edit: NormalizedImageEditRequest<typeof input> = {
      ...request,
      action: 'edit',
      images: [input],
      mask: input,
    };
    const fake = setup(eventStream(), { ...capabilities, maskEdit: false });
    const orchestrator = new ImageOrchestrator({ registry: fake.registry });
    await expect(collect(orchestrator.run(edit, context(), { providerId: 'fake' })))
      .rejects.toMatchObject({ code: 'unsupported_capability', param: 'mask' });
    expect(fake.start).not.toHaveBeenCalled();

    const noEdit = setup(eventStream(), { ...capabilities, edit: false });
    await expect(collect(new ImageOrchestrator({ registry: noEdit.registry }).run(
      { ...edit, mask: undefined }, context(), { providerId: 'fake' },
    ))).rejects.toMatchObject({ code: 'unsupported_capability', param: 'action' });
    expect(noEdit.start).not.toHaveBeenCalled();
  });

  it('acquires and releases once for non-consuming capability discovery', async () => {
    const fake = setup(eventStream());
    const orchestrator = new ImageOrchestrator({ registry: fake.registry });
    await expect(orchestrator.getCapabilities('fake', context())).resolves.toBe(capabilities);
    expect(fake.acquire).toHaveBeenCalledOnce();
    expect(fake.start).not.toHaveBeenCalled();
    expect(fake.release).toHaveBeenCalledOnce();
  });
});

describe('ImageOrchestrator cancellation, retention, and telemetry', () => {
  it('surfaces an abort during acquisition without starting or cancelling a job', async () => {
    const controller = new AbortController();
    const cancel = vi.fn(async () => undefined);
    const start = vi.fn((): ImageJob => ({ events: eventStream(), cancel }));
    const provider: ImageProvider = {
      id: 'acquire-abort',
      acquire: vi.fn((providerContext) => new Promise((_resolve, reject) => {
        providerContext.signal.addEventListener('abort', () => reject(providerContext.signal.reason), { once: true });
      })),
    };
    const orchestrator = new ImageOrchestrator({ registry: new ImageProviderRegistry([provider]) });
    const running = collect(orchestrator.run(request, context(controller), { providerId: 'acquire-abort' }));
    controller.abort(new Error('client cancelled acquisition'));
    await expect(running).rejects.toMatchObject({ code: 'request_cancelled' });
    expect(start).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('cancels an active job at most once and forwards no later binary output', async () => {
    const controller = new AbortController();
    async function* slowEvents() {
      yield { type: 'accepted' as const, acceptedAt: 1 };
      await new Promise((resolve) => setTimeout(resolve, 100));
      yield {
        type: 'partial_image' as const,
        outputIndex: 0,
        partialImageIndex: 0,
        image: { artifact: asset() },
      };
    }
    const fake = setup(slowEvents());
    const orchestrator = new ImageOrchestrator({ registry: fake.registry });
    const seen: string[] = [];
    const running = (async () => {
      for await (const event of orchestrator.run(request, context(controller), { providerId: 'fake' })) {
        seen.push(event.type);
        if (event.type === 'accepted') controller.abort(new Error('client disconnected'));
      }
    })();
    await expect(running).rejects.toMatchObject({ code: 'request_cancelled' });
    expect(seen).toEqual(['accepted']);
    expect(fake.cancel).toHaveBeenCalledOnce();
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it('does not cancel after receiving a valid completed terminal before iterator teardown', async () => {
    const controller = new AbortController();
    const controlled = heldAfterEvents(
      { type: 'accepted', acceptedAt: 1 },
      { type: 'completed', images: [{ artifact: asset() }] },
    );
    const fake = setup(controlled.events);
    const running = collect(new ImageOrchestrator({ registry: fake.registry }).run(
      request, context(controller), { providerId: 'fake' },
    ));
    await controlled.held;
    controller.abort(new Error('client disconnected after completion'));

    await expect(running).rejects.toMatchObject({ code: 'request_cancelled' });
    expect(fake.cancel).not.toHaveBeenCalled();
    expect(controlled.returnIterator).toHaveBeenCalledOnce();
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it('does not cancel after receiving a valid failed terminal before iterator teardown', async () => {
    const controller = new AbortController();
    const controlled = heldAfterEvents(
      { type: 'accepted', acceptedAt: 1 },
      { type: 'failed', error: serializeImageGenerationError(new ImageGenerationError('image_generation_failed')) },
    );
    const fake = setup(controlled.events);
    const running = collect(new ImageOrchestrator({ registry: fake.registry }).run(
      request, context(controller), { providerId: 'fake' },
    ));
    await controlled.held;
    controller.abort(new Error('client disconnected after failure'));

    await expect(running).rejects.toMatchObject({ code: 'request_cancelled' });
    expect(fake.cancel).not.toHaveBeenCalled();
    expect(controlled.returnIterator).toHaveBeenCalledOnce();
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it('cancels started pre-accept work exactly once before iterator teardown', async () => {
    const controller = new AbortController();
    const controlled = heldAfterEvents();
    const fake = setup(controlled.events);
    const running = collect(new ImageOrchestrator({ registry: fake.registry }).run(
      request, context(controller), { providerId: 'fake' },
    ));
    await controlled.held;
    controller.abort(new Error('client disconnected before acceptance'));

    await expect(running).rejects.toMatchObject({ code: 'request_cancelled' });
    expect(fake.cancel).toHaveBeenCalledOnce();
    expect(controlled.returnIterator).toHaveBeenCalledOnce();
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it('cancels accepted nonterminal work exactly once before iterator teardown', async () => {
    const controller = new AbortController();
    const controlled = heldAfterEvents({ type: 'accepted', acceptedAt: 1 });
    const fake = setup(controlled.events);
    const running = collect(new ImageOrchestrator({ registry: fake.registry }).run(
      request, context(controller), { providerId: 'fake' },
    ));
    await controlled.held;
    controller.abort(new Error('client disconnected during generation'));

    await expect(running).rejects.toMatchObject({ code: 'request_cancelled' });
    expect(fake.cancel).toHaveBeenCalledOnce();
    expect(controlled.returnIterator).toHaveBeenCalledOnce();
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it('rolls back a reference saved after aborting delayed post-terminal retention', async () => {
    const controller = new AbortController();
    const fake = setup(eventStream(
      { type: 'accepted', acceptedAt: 1 },
      { type: 'completed', images: [{ artifact: asset() }] },
    ));
    const store = new InMemoryImageReferenceStore();
    const saveEntered = deferred();
    const releaseSave = deferred();
    const originalSave = store.save.bind(store);
    let savedReferenceId: ImageReferenceId | undefined;
    vi.spyOn(store, 'save').mockImplementation(async (input) => {
      const metadata = await originalSave(input);
      savedReferenceId = metadata.referenceId;
      saveEntered.resolve();
      await releaseSave.promise;
      return metadata;
    });
    const remove = vi.spyOn(store, 'delete');
    const sink = { record: vi.fn(async () => undefined) };
    const running = collect(new ImageOrchestrator({
      registry: fake.registry,
      referenceStore: store,
      telemetrySink: sink,
    }).run(request, context(controller), {
      providerId: 'fake',
      retention: { enabled: true, ttlMs: 1_000 },
    }));

    await saveEntered.promise;
    controller.abort(new Error('client disconnected during retention'));
    releaseSave.resolve();

    await expect(running).rejects.toMatchObject({ code: 'request_cancelled' });
    expect(savedReferenceId).toBeDefined();
    expect(await store.resolve('tenant-a', savedReferenceId!)).toEqual({ status: 'not_found' });
    expect(remove).toHaveBeenCalledOnce();
    expect(sink.record).toHaveBeenCalledOnce();
    expect(sink.record.mock.calls[0]![0]).toMatchObject({
      terminal: 'cancelled',
      errorCode: 'request_cancelled',
    });
    expect(sink.record.mock.calls[0]![0]).not.toHaveProperty('retentionRollbackFailures');
    const audit = JSON.stringify(sink.record.mock.calls[0]![0]);
    expect(audit).not.toContain(request.prompt);
    expect(audit).not.toContain('tenant-a');
    expect(audit).not.toContain(savedReferenceId!);
    expect(fake.cancel).not.toHaveBeenCalled();
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it('preserves a normally completed reference after delayed retention', async () => {
    const fake = setup(eventStream(
      { type: 'accepted', acceptedAt: 1 },
      { type: 'completed', images: [{ artifact: asset() }] },
    ));
    const store = new InMemoryImageReferenceStore();
    const saveEntered = deferred();
    const releaseSave = deferred();
    const originalSave = store.save.bind(store);
    vi.spyOn(store, 'save').mockImplementation(async (input) => {
      const metadata = await originalSave(input);
      saveEntered.resolve();
      await releaseSave.promise;
      return metadata;
    });
    const remove = vi.spyOn(store, 'delete');
    const running = collect(new ImageOrchestrator({
      registry: fake.registry,
      referenceStore: store,
    }).run(request, context(), {
      providerId: 'fake',
      retention: { enabled: true, ttlMs: 1_000 },
    }));

    await saveEntered.promise;
    releaseSave.resolve();
    const result = await running;
    const completed = result.at(-1);
    expect(completed?.type).toBe('completed');
    if (completed?.type !== 'completed') throw new Error('expected completion');
    const retained = await store.resolve('tenant-a', completed.references![0]!.referenceId);
    expect(retained.status).toBe('found');
    if (retained.status === 'found') await retained.lease.release();
    expect(remove).not.toHaveBeenCalled();
    expect(fake.cancel).not.toHaveBeenCalled();
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it('exposes normal completion before awaiting one delayed completed audit', async () => {
    const fake = setup(eventStream(
      { type: 'accepted', acceptedAt: 1 },
      { type: 'completed', images: [{ artifact: asset() }] },
    ));
    const store = new InMemoryImageReferenceStore();
    const remove = vi.spyOn(store, 'delete');
    const telemetry = delayedTelemetry();
    const iterator = new ImageOrchestrator({
      registry: fake.registry,
      referenceStore: store,
      telemetrySink: telemetry.sink,
    }).run(request, context(), {
      providerId: 'fake',
      retention: { enabled: true, ttlMs: 1_000 },
    })[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toMatchObject({ type: 'accepted' });
    const exposed = await iterator.next();
    expect(exposed.done).toBe(false);
    expect(exposed.value).toMatchObject({ type: 'completed' });
    if (exposed.done || exposed.value.type !== 'completed') throw new Error('expected completion');
    const referenceId = exposed.value.references![0]!.referenceId;
    expect(telemetry.sink.record).not.toHaveBeenCalled();

    const finishing = iterator.next();
    await telemetry.entered.promise;
    expect(telemetry.records).toEqual([]);
    telemetry.release.resolve();
    await expect(finishing).resolves.toEqual({ done: true, value: undefined });

    expect(telemetry.sink.record).toHaveBeenCalledOnce();
    expect(telemetry.records).toHaveLength(1);
    expect(telemetry.records[0]).toMatchObject({ terminal: 'completed' });
    expect(telemetry.records[0]!.errorCode).toBeUndefined();
    expect(JSON.stringify(telemetry.records[0])).not.toContain(referenceId);
    const retained = await store.resolve('tenant-a', referenceId);
    expect(retained.status).toBe('found');
    if (retained.status === 'found') await retained.lease.release();
    expect(remove).not.toHaveBeenCalled();
    expect(fake.cancel).not.toHaveBeenCalled();
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it.each(['immediately after exposure', 'during delayed telemetry'] as const)(
    'does not reclassify an exposed completion when aborted %s',
    async (abortTiming) => {
      const controller = new AbortController();
      const fake = setup(eventStream(
        { type: 'accepted', acceptedAt: 1 },
        { type: 'completed', images: [{ artifact: asset() }] },
      ));
      const store = new InMemoryImageReferenceStore();
      const remove = vi.spyOn(store, 'delete');
      const telemetry = delayedTelemetry();
      const iterator = new ImageOrchestrator({
        registry: fake.registry,
        referenceStore: store,
        telemetrySink: telemetry.sink,
      }).run(request, context(controller), {
        providerId: 'fake',
        retention: { enabled: true, ttlMs: 1_000 },
      })[Symbol.asyncIterator]();

      expect((await iterator.next()).value).toMatchObject({ type: 'accepted' });
      const exposed = await iterator.next();
      expect(exposed.done).toBe(false);
      expect(exposed.value).toMatchObject({ type: 'completed' });
      if (exposed.done || exposed.value.type !== 'completed') throw new Error('expected completion');
      const referenceId = exposed.value.references![0]!.referenceId;
      if (abortTiming === 'immediately after exposure') {
        controller.abort(new Error('disconnect immediately after exposure'));
      }

      const finishing = iterator.next();
      await telemetry.entered.promise;
      if (abortTiming === 'during delayed telemetry') {
        controller.abort(new Error('disconnect during completed audit'));
      }
      telemetry.release.resolve();
      await expect(finishing).resolves.toEqual({ done: true, value: undefined });

      expect(telemetry.sink.record).toHaveBeenCalledOnce();
      expect(telemetry.records).toHaveLength(1);
      expect(telemetry.records[0]).toMatchObject({ terminal: 'completed' });
      expect(telemetry.records[0]!.errorCode).toBeUndefined();
      expect(JSON.stringify(telemetry.records[0])).not.toContain(referenceId);
      const retained = await store.resolve('tenant-a', referenceId);
      expect(retained.status).toBe('found');
      if (retained.status === 'found') await retained.lease.release();
      expect(remove).not.toHaveBeenCalled();
      expect(fake.cancel).not.toHaveBeenCalled();
      expect(fake.release).toHaveBeenCalledOnce();
    },
  );

  it('keeps cancellation stable and reports only a count when retention rollback fails', async () => {
    const controller = new AbortController();
    const fake = setup(eventStream(
      { type: 'accepted', acceptedAt: 1 },
      { type: 'completed', images: [{ artifact: asset() }] },
    ));
    const store = new InMemoryImageReferenceStore();
    const saveEntered = deferred();
    const releaseSave = deferred();
    const originalSave = store.save.bind(store);
    let savedReferenceId: ImageReferenceId | undefined;
    vi.spyOn(store, 'save').mockImplementation(async (input) => {
      const metadata = await originalSave(input);
      savedReferenceId = metadata.referenceId;
      saveEntered.resolve();
      await releaseSave.promise;
      return metadata;
    });
    const remove = vi.spyOn(store, 'delete').mockRejectedValue(new Error('delete failed'));
    const sink = { record: vi.fn(async () => undefined) };
    const running = collect(new ImageOrchestrator({
      registry: fake.registry,
      referenceStore: store,
      telemetrySink: sink,
    }).run(request, context(controller), {
      providerId: 'fake',
      retention: { enabled: true, ttlMs: 1_000 },
    }));

    await saveEntered.promise;
    controller.abort(new Error('client disconnected during retention'));
    releaseSave.resolve();

    await expect(running).rejects.toMatchObject({ code: 'request_cancelled' });
    expect(remove).toHaveBeenCalledOnce();
    expect(sink.record).toHaveBeenCalledOnce();
    const telemetry = sink.record.mock.calls[0]![0];
    expect(telemetry).toMatchObject({
      terminal: 'cancelled',
      errorCode: 'request_cancelled',
      retentionRollbackFailures: 1,
    });
    const serialized = JSON.stringify(telemetry);
    expect(serialized).not.toContain(request.prompt);
    expect(serialized).not.toContain('tenant-a');
    expect(serialized).not.toContain(savedReferenceId!);
    expect(fake.cancel).not.toHaveBeenCalled();
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it('retains final artifacts and sends content-free telemetry with unavailable usage omitted', async () => {
    let now = 100;
    const final = asset();
    const fake = setup(eventStream(
      { type: 'accepted', acceptedAt: 101 },
      { type: 'completed', images: [{ artifact: final }] },
    ));
    const store = new InMemoryImageReferenceStore(() => now);
    const sink = { record: vi.fn(async () => undefined) };
    const orchestrator = new ImageOrchestrator({
      registry: fake.registry,
      referenceStore: store,
      telemetrySink: sink,
      now: () => ++now,
    });
    const result = await collect(orchestrator.run(request, context(), {
      providerId: 'fake',
      retention: { enabled: true, ttlMs: 50 },
    }));
    const completed = result.at(-1);
    expect(completed?.type).toBe('completed');
    if (completed?.type !== 'completed') throw new Error('expected completion');
    expect(completed.references).toHaveLength(1);
    expect(completed).not.toHaveProperty('usage');
    expect(sink.record).toHaveBeenCalledOnce();
    const telemetry = sink.record.mock.calls[0]![0];
    expect(telemetry).toMatchObject({ usageUnavailable: true, inputCount: 0, terminal: 'completed' });
    expect(JSON.stringify(telemetry)).not.toContain(request.prompt);
    expect(JSON.stringify(telemetry)).not.toContain('tenant-a');
    expect(JSON.stringify(telemetry)).not.toContain('base64');
  });

  it('does not fail a successful generation when the telemetry sink throws', async () => {
    const fake = setup(eventStream(
      { type: 'accepted', acceptedAt: 1 },
      { type: 'completed', images: [{ artifact: asset() }] },
    ));
    const orchestrator = new ImageOrchestrator({
      registry: fake.registry,
      telemetrySink: { record: async () => { throw new Error('sink failed'); } },
    });
    await expect(collect(orchestrator.run(request, context(), { providerId: 'fake' })))
      .resolves.toHaveLength(2);
  });
});
