import {
  type ImageCapabilities,
  type ImageCapabilityUnavailableReason,
} from '@omnicross/contracts/image-generation-types';
import {
  ImageGenerationError,
  type ImageApiContributions,
  type ImageOpenAIOperationContribution,
  type ResponsesImageGenerationContribution,
} from '@omnicross/core/image-generation';
import {
  type OpenAIOperationHandlerContext,
  unsupportedOpenAIOperation,
} from '@omnicross/core/openai-operation';

const GENERATION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

export type PreparedImageRuntimeGeneration =
  | {
      readonly id: string;
      readonly enabled: true;
      readonly imageApi: ImageApiContributions;
      readonly hosted: ResponsesImageGenerationContribution;
      readonly inspectCapability?: (
        apiKeyId: string,
      ) => Promise<Omit<ImageRuntimeCapabilityInspection, 'generationId'>>;
      readonly readRuntimeStatus?: () => ImageRuntimeResourceStatus;
      dispose(): void | Promise<void>;
    }
  | {
      readonly id: string;
      readonly enabled: false;
      dispose(): void | Promise<void>;
    };

export interface HostedImageRuntimeGenerationLease {
  readonly generationId: string;
  readonly contribution: ResponsesImageGenerationContribution;
  release(): Promise<void>;
}

/** Dormant integration seam for a later Native Responses owner. */
export interface HostedImageContributionFactory {
  acquire(): Promise<HostedImageRuntimeGenerationLease>;
}

/** Bind a stable factory to one app-session runtime manager without acquiring. */
export function createHostedImageContributionFactory(
  manager: ImageRuntimeManager,
): HostedImageContributionFactory {
  return Object.freeze({
    acquire: (): Promise<HostedImageRuntimeGenerationLease> => manager.acquireHosted(),
  });
}

export interface ImageRuntimeGenerationStatus {
  readonly generationId: string;
  readonly enabled: boolean;
  readonly httpLeases: number;
  readonly hostedLeases: number;
}

export interface ImageRuntimeManagerStatus {
  readonly disposed: boolean;
  readonly current: ImageRuntimeGenerationStatus;
  readonly draining: readonly ImageRuntimeGenerationStatus[];
}

export type ImageRuntimeSafeUnavailableReason =
  | ImageCapabilityUnavailableReason
  | 'disabled'
  | 'runtime_unavailable';

export interface ImageRuntimeCapabilityInspection {
  readonly generationId: string;
  readonly enabled: boolean;
  readonly available: boolean;
  readonly providerId?: 'codex-subscription';
  readonly model?: string;
  readonly reason?: ImageRuntimeSafeUnavailableReason;
  readonly capabilities?: ImageCapabilities;
}

export interface ImageRuntimeResourceStatus {
  readonly queue: Readonly<{
    activeJobs: number;
    waitingJobs: number;
    activeAccounts: number;
    waitingAccounts: number;
    waitingTenants: number;
    maxConcurrentJobsPerAccount: number;
    maxQueuedJobs: number;
    accepting: boolean;
    shuttingDown: boolean;
  }>;
  readonly temporary: Readonly<{
    activeScopes: number;
    totalBytes: number;
    tenantCount: number;
    maxActiveScopes: number;
    maxTotalBytes: number;
    maxTenantBytes: number;
  }>;
  readonly storage: Readonly<{
    mounts: number;
    retiredMounts: number;
    referenceEntries: number;
    referenceBytes: number;
    referenceTombstones: number;
    stateCalls: number;
    stateResponses: number;
    stateTombstones: number;
    pendingReferenceDeletes: number;
    maxReferenceEntries: number;
    maxReferenceBytes: number;
    maxTenantReferenceBytes: number;
    maxStateCalls: number;
    maxStateResponses: number;
  }>;
}

type GenerationPhase = 'prepared' | 'current' | 'draining' | 'disposing' | 'disposed';

interface GenerationRecord {
  readonly generation: PreparedImageRuntimeGeneration;
  phase: GenerationPhase;
  httpLeases: number;
  hostedLeases: number;
  disposeStarted: boolean;
  readonly disposed: Promise<void>;
  readonly resolveDisposed: () => void;
  readonly rejectDisposed: (error: unknown) => void;
}

type PreparedState = 'prepared' | 'published' | 'rolled_back' | 'disposed';

export interface PreparedImageRuntimeChange {
  readonly generationId: string;
  publish(): void;
  rollback(): void;
  dispose(): Promise<void>;
}

function deferredRecord(
  generation: PreparedImageRuntimeGeneration,
  phase: GenerationPhase,
): GenerationRecord {
  let resolveDisposed!: () => void;
  let rejectDisposed!: (error: unknown) => void;
  const disposed = new Promise<void>((resolve, reject) => {
    resolveDisposed = resolve;
    rejectDisposed = reject;
  });
  void disposed.catch(() => undefined);
  return {
    generation,
    phase,
    httpLeases: 0,
    hostedLeases: 0,
    disposeStarted: false,
    disposed,
    resolveDisposed,
    rejectDisposed,
  };
}

function disabledGeneration(id: string): PreparedImageRuntimeGeneration {
  return Object.freeze({
    id,
    enabled: false as const,
    dispose: () => undefined,
  });
}

function validateGeneration(generation: PreparedImageRuntimeGeneration): void {
  if (!generation || typeof generation !== 'object' || !GENERATION_ID.test(generation.id)) {
    throw new TypeError('image runtime generation is invalid');
  }
  if (typeof generation.dispose !== 'function') {
    throw new TypeError('image runtime generation requires disposal');
  }
  if (generation.enabled) {
    if (
      !generation.imageApi || !generation.hosted ||
      generation.imageApi.generate.operationId !== 'images.generate' ||
      generation.imageApi.edit.operationId !== 'images.edit' ||
      typeof generation.imageApi.generate.handler !== 'function' ||
      typeof generation.imageApi.edit.handler !== 'function' ||
      generation.hosted.toolType !== 'image_generation'
    ) {
      throw new TypeError('enabled image runtime generation is incomplete');
    }
  }
}

/** App-session owner for stable forwarders and generation-pinned work. */
export class ImageRuntimeManager {
  readonly contributions: ImageApiContributions;
  readonly #records = new Set<GenerationRecord>();
  readonly #knownGenerations = new WeakSet<object>();
  readonly #draining = new Set<GenerationRecord>();
  readonly #deferredDisposals = new Map<GenerationRecord, ReturnType<typeof setTimeout>>();
  #current: GenerationRecord;
  #disposed = false;
  #disposePromise: Promise<void> | undefined;

  constructor(initial: PreparedImageRuntimeGeneration = disabledGeneration('disabled-initial')) {
    validateGeneration(initial);
    const current = deferredRecord(initial, 'current');
    this.#current = current;
    this.#records.add(current);
    this.#knownGenerations.add(initial);

    const generate = Object.freeze({
      operationId: 'images.generate' as const,
      handler: (context: OpenAIOperationHandlerContext) => this.#forward('generate', context),
    });
    const edit = Object.freeze({
      operationId: 'images.edit' as const,
      handler: (context: OpenAIOperationHandlerContext) => this.#forward('edit', context),
    });
    this.contributions = Object.freeze({
      generate,
      edit,
      all: Object.freeze([generate, edit]),
    });
  }

  prepare(generation: PreparedImageRuntimeGeneration): PreparedImageRuntimeChange {
    if (this.#disposed) throw new ImageGenerationError('unsupported_capability');
    validateGeneration(generation);
    if (this.#knownGenerations.has(generation)) {
      throw new TypeError('image runtime generation cannot be reused');
    }
    for (const record of this.#records) {
      if (record.phase !== 'disposed' && record.generation.id === generation.id) {
        throw new TypeError('image runtime generation id is already active');
      }
    }
    this.#knownGenerations.add(generation);
    const candidate = deferredRecord(generation, 'prepared');
    this.#records.add(candidate);
    let previous: GenerationRecord | undefined;
    let state: PreparedState = 'prepared';

    return Object.freeze({
      generationId: generation.id,
      publish: (): void => {
        if (state === 'published') return;
        if (state !== 'prepared' || this.#disposed) {
          throw new TypeError('prepared image runtime change cannot be published');
        }
        previous = this.#current;
        previous.phase = 'draining';
        this.#draining.add(previous);
        candidate.phase = 'current';
        this.#current = candidate;
        state = 'published';
        this.#scheduleDrainedDisposal(previous);
      },
      rollback: (): void => {
        if (state === 'rolled_back') return;
        if (state !== 'published' || !previous || this.#disposed) return;
        if (this.#current !== candidate || previous.phase === 'disposed') {
          throw new TypeError('published image runtime change cannot be rolled back');
        }
        this.#cancelDeferredDisposal(previous);
        this.#draining.delete(previous);
        previous.phase = 'current';
        candidate.phase = 'draining';
        this.#draining.add(candidate);
        this.#current = previous;
        state = 'rolled_back';
        this.#scheduleDrainedDisposal(candidate);
      },
      dispose: async (): Promise<void> => {
        if (state === 'disposed') return candidate.disposed;
        if (state === 'published') return;
        if (state === 'prepared') {
          candidate.phase = 'draining';
          this.#draining.add(candidate);
        }
        state = 'disposed';
        this.#disposeIfDrained(candidate);
        return candidate.disposed;
      },
    });
  }

  async acquireHosted(): Promise<HostedImageRuntimeGenerationLease> {
    const record = this.#acquireCurrent('hosted');
    if (!record.generation.enabled) {
      await this.#release(record, 'hosted');
      throw new ImageGenerationError('unsupported_capability');
    }
    let released = false;
    return Object.freeze({
      generationId: record.generation.id,
      contribution: record.generation.hosted,
      release: async (): Promise<void> => {
        if (released) return;
        released = true;
        await this.#release(record, 'hosted');
      },
    });
  }

  async inspectCapability(apiKeyId: string): Promise<ImageRuntimeCapabilityInspection> {
    if (typeof apiKeyId !== 'string' || !apiKeyId.trim() || apiKeyId.length > 256) {
      throw new TypeError('image capability inspection key id is invalid');
    }
    if (this.#disposed) {
      return Object.freeze({
        generationId: this.#current.generation.id,
        enabled: false,
        available: false,
        reason: 'runtime_unavailable',
      });
    }
    const record = this.#acquireCurrent('http');
    try {
      if (!record.generation.enabled) {
        return Object.freeze({
          generationId: record.generation.id,
          enabled: false,
          available: false,
          reason: 'disabled',
        });
      }
      if (!record.generation.inspectCapability) {
        return Object.freeze({
          generationId: record.generation.id,
          enabled: true,
          available: false,
          reason: 'runtime_unavailable',
        });
      }
      const inspection = await record.generation.inspectCapability(apiKeyId);
      return Object.freeze({ generationId: record.generation.id, ...inspection });
    } catch {
      return Object.freeze({
        generationId: record.generation.id,
        enabled: true,
        available: false,
        reason: 'runtime_unavailable',
      });
    } finally {
      await this.#release(record, 'http');
    }
  }

  async listAvailableModels(apiKeyId: string): Promise<readonly string[]> {
    const inspection = await this.inspectCapability(apiKeyId);
    return inspection.available && inspection.model === 'gpt-image-2'
      ? Object.freeze([inspection.model])
      : Object.freeze([]);
  }

  resourceStatus(): ImageRuntimeResourceStatus | undefined {
    const generation = this.#current.generation;
    if (!generation.enabled || !generation.readRuntimeStatus) return undefined;
    return generation.readRuntimeStatus();
  }

  status(): ImageRuntimeManagerStatus {
    return Object.freeze({
      disposed: this.#disposed,
      current: this.#recordStatus(this.#current),
      draining: Object.freeze([...this.#draining]
        .filter((record) => record.phase !== 'disposed')
        .map((record) => this.#recordStatus(record))),
    });
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposed = true;
    for (const timer of this.#deferredDisposals.values()) clearTimeout(timer);
    this.#deferredDisposals.clear();
    for (const record of this.#records) {
      if (record.phase !== 'disposed' && record.phase !== 'disposing') {
        record.phase = 'draining';
        this.#draining.add(record);
        this.#disposeIfDrained(record);
      }
    }
    this.#disposePromise = (async () => {
      const results = await Promise.allSettled([...this.#records].map((record) => record.disposed));
      const failures = results.filter((result) => result.status === 'rejected');
      if (failures.length > 0) throw new AggregateError(failures, 'image runtime disposal failed');
    })();
    return this.#disposePromise;
  }

  async #forward(
    kind: 'generate' | 'edit',
    context: OpenAIOperationHandlerContext,
  ): Promise<void> {
    const record = this.#acquireCurrent('http');
    try {
      if (!record.generation.enabled) throw unsupportedOpenAIOperation(context.operation);
      const contribution: ImageOpenAIOperationContribution = record.generation.imageApi[kind];
      await contribution.handler(context);
    } finally {
      await this.#release(record, 'http');
    }
  }

  #acquireCurrent(kind: 'http' | 'hosted'): GenerationRecord {
    if (this.#disposed) throw new ImageGenerationError('unsupported_capability');
    const record = this.#current;
    if (kind === 'http') record.httpLeases += 1;
    else record.hostedLeases += 1;
    return record;
  }

  async #release(record: GenerationRecord, kind: 'http' | 'hosted'): Promise<void> {
    if (kind === 'http') record.httpLeases = Math.max(0, record.httpLeases - 1);
    else record.hostedLeases = Math.max(0, record.hostedLeases - 1);
    this.#disposeIfDrained(record);
    if (record.phase === 'disposing' || record.phase === 'disposed') await record.disposed;
  }

  #recordStatus(record: GenerationRecord): ImageRuntimeGenerationStatus {
    return Object.freeze({
      generationId: record.generation.id,
      enabled: record.generation.enabled,
      httpLeases: record.httpLeases,
      hostedLeases: record.hostedLeases,
    });
  }

  #totalLeases(record: GenerationRecord): number {
    return record.httpLeases + record.hostedLeases;
  }

  #scheduleDrainedDisposal(record: GenerationRecord): void {
    if (this.#totalLeases(record) > 0) return;
    this.#cancelDeferredDisposal(record);
    const timer = setTimeout(() => {
      this.#deferredDisposals.delete(record);
      this.#disposeIfDrained(record);
    }, 0);
    timer.unref();
    this.#deferredDisposals.set(record, timer);
  }

  #cancelDeferredDisposal(record: GenerationRecord): void {
    const timer = this.#deferredDisposals.get(record);
    if (!timer) return;
    clearTimeout(timer);
    this.#deferredDisposals.delete(record);
  }

  #disposeIfDrained(record: GenerationRecord): void {
    if (
      this.#totalLeases(record) !== 0 ||
      (record.phase !== 'draining' && !this.#disposed) ||
      record.disposeStarted
    ) return;
    this.#cancelDeferredDisposal(record);
    record.disposeStarted = true;
    record.phase = 'disposing';
    this.#draining.delete(record);
    Promise.resolve()
      .then(() => record.generation.dispose())
      .then(
        () => {
          record.phase = 'disposed';
          record.resolveDisposed();
        },
        (error: unknown) => {
          record.phase = 'disposed';
          record.rejectDisposed(error);
        },
      );
  }
}
