import { describe, expect, it, vi } from 'vitest';

import type {
  ImageCapabilities,
  ImageProviderEvent,
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
import { InMemoryImageAsset, InMemoryImageReferenceStore } from '../ports';

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
    expect(fake.release).toHaveBeenCalledOnce();
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
  ])('does not start for unsupported %s requirements', async (name, override) => {
    const fake = setup(eventStream(), { ...capabilities, ...override } as ImageCapabilities);
    const orchestrator = new ImageOrchestrator({ registry: fake.registry });
    const changed = name === 'transparency' ? { ...request, background: 'transparent' as const } : request;
    await expect(collect(orchestrator.run(changed, context(), { providerId: 'fake' }))).rejects.toBeInstanceOf(ImageGenerationError);
    expect(fake.start).not.toHaveBeenCalled();
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
  it('passes the caller abort signal into acquisition and cancels before start', async () => {
    const controller = new AbortController();
    const start = vi.fn();
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
