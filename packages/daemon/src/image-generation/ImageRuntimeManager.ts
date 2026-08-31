import {
  type ImageCapabilities,
  type ImageCapabilityUnavailableReason,
} from '@omnicross/contracts/image-generation-types';
import {
  ImageGenerationError,
  type ImageApiContributions,
  type ImageOpenAIOperationContribution,
  type ResponsesHostedToolSelection,
  type ResponsesImageAdmission,
  type ResponsesImageGenerationContribution,
  type ResponsesImageInspectionInput,
  type ResponsesImageRequestScope,
  type ResponsesImageTrustedRuntime,
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
      readonly hostedRuntime: HostedImageRuntimePolicy;
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
  /** Compatibility/debug view; callers should prefer the deep methods below. */
  readonly contribution: ResponsesImageGenerationContribution;
  inspectRequest(input: ResponsesImageInspectionInput): ResponsesImageAdmission;
  validateSelection(
    admission: ResponsesImageAdmission,
    selection: ResponsesHostedToolSelection,
  ): void;
  openRequest(input: HostedImageOpenRequestInput): Promise<ResponsesImageRequestScope>;
  release(): Promise<void>;
}

export interface HostedImageRuntimePolicy {
  readonly providerId: string;
  readonly imageModel: string;
  readonly referenceTtlMs: number;
  readonly maxOutputBytes: number;
  readonly maxTotalOutputBytes: number;
  readonly preferredAccountId?: string;
  readonly preferredAccountGroup?: string;
  readonly boundAccountFallbackPolicy?: 'strict' | 'pool';
}

export interface HostedImageOpenRequestInput {
  readonly admission: ResponsesImageAdmission;
  readonly tenantId: string;
  readonly requestId: string;
  readonly sessionKey: string;
  readonly signal: AbortSignal;
  readonly authorizedPreviousResponseId?: string;
  /** Trusted affinity fact forwarded unchanged into the contribution scope. */
  readonly authorizedPreviousResponseKnownEmpty?: boolean;
  readonly mainProviderId: string;
  readonly selectedMainAccountId?: string;
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
  readonly hostedRuntime?: HostedImageRuntimePolicy;
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
    ...(generation.enabled
      ? { hostedRuntime: snapshotHostedRuntimePolicy(generation.hostedRuntime) }
      : {}),
    phase,
    httpLeases: 0,
    hostedLeases: 0,
    disposeStarted: false,
    disposed,
    resolveDisposed,
    rejectDisposed,
  };
}

function boundedText(value: unknown, max = 128): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function snapshotHostedRuntimePolicy(value: HostedImageRuntimePolicy): HostedImageRuntimePolicy {
  if (
    !value ||
    typeof value !== 'object' ||
    !boundedText(value.providerId) ||
    !boundedText(value.imageModel) ||
    !positiveInteger(value.referenceTtlMs) ||
    !positiveInteger(value.maxOutputBytes) ||
    !positiveInteger(value.maxTotalOutputBytes) ||
    value.maxTotalOutputBytes < value.maxOutputBytes ||
    (value.preferredAccountId !== undefined && !boundedText(value.preferredAccountId, 512)) ||
    (value.preferredAccountGroup !== undefined && !boundedText(value.preferredAccountGroup, 512)) ||
    (value.boundAccountFallbackPolicy !== undefined &&
      value.boundAccountFallbackPolicy !== 'strict' &&
      value.boundAccountFallbackPolicy !== 'pool')
  ) {
    throw new TypeError('enabled image runtime hosted policy is invalid');
  }
  return Object.freeze({
    providerId: value.providerId,
    imageModel: value.imageModel,
    referenceTtlMs: value.referenceTtlMs,
    maxOutputBytes: value.maxOutputBytes,
    maxTotalOutputBytes: value.maxTotalOutputBytes,
    ...(value.preferredAccountId !== undefined
      ? { preferredAccountId: value.preferredAccountId }
      : {}),
    ...(value.preferredAccountGroup !== undefined
      ? { preferredAccountGroup: value.preferredAccountGroup }
      : {}),
    ...(value.boundAccountFallbackPolicy !== undefined
      ? { boundAccountFallbackPolicy: value.boundAccountFallbackPolicy }
      : {}),
  });
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
      generation.hosted.toolType !== 'image_generation' ||
      !generation.hostedRuntime
    ) {
      throw new TypeError('enabled image runtime generation is incomplete');
    }
    snapshotHostedRuntimePolicy(generation.hostedRuntime);
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
    const contribution = record.generation.hosted;
    const hostedRuntime = record.hostedRuntime!;
    const scopes = new Set<ResponsesImageRequestScope>();
    const openings = new Set<Promise<ResponsesImageRequestScope>>();
    let released = false;
    let releasePromise: Promise<void> | undefined;
    const wrapScope = (scope: ResponsesImageRequestScope): ResponsesImageRequestScope => {
      let disposePromise: Promise<void> | undefined;
      let wrapped!: ResponsesImageRequestScope;
      wrapped = Object.freeze({
        executeSelectedCall: (
          call: Parameters<ResponsesImageRequestScope['executeSelectedCall']>[0],
          allocator: Parameters<ResponsesImageRequestScope['executeSelectedCall']>[1],
        ) => scope.executeSelectedCall(call, allocator),
        commit: (responseId: string) => scope.commit(responseId),
        waitForIdle: () => scope.waitForIdle(),
        dispose: (): Promise<void> => {
          if (disposePromise) return disposePromise;
          disposePromise = (async () => {
            try {
              await scope.waitForIdle();
              await scope.dispose();
            } finally {
              scopes.delete(wrapped);
            }
          })();
          return disposePromise;
        },
      });
      scopes.add(wrapped);
      return wrapped;
    };
    return Object.freeze({
      generationId: record.generation.id,
      contribution,
      inspectRequest: (input: ResponsesImageInspectionInput): ResponsesImageAdmission =>
        contribution.inspectRequest(input),
      validateSelection: (
        admission: ResponsesImageAdmission,
        selection: ResponsesHostedToolSelection,
      ): void => contribution.validateSelection(admission, selection),
      openRequest: async (input: HostedImageOpenRequestInput): Promise<ResponsesImageRequestScope> => {
        if (released) throw new ImageGenerationError('unsupported_capability');
        if (!boundedText(input.mainProviderId)) {
          throw new ImageGenerationError('invalid_image_request', { param: 'provider' });
        }
        if (
          input.selectedMainAccountId !== undefined &&
          !boundedText(input.selectedMainAccountId, 512)
        ) {
          throw new ImageGenerationError('invalid_image_request');
        }
        const selectedCodexAccount =
          input.mainProviderId === 'codex' &&
          hostedRuntime.providerId === 'codex-subscription' &&
          input.selectedMainAccountId !== undefined
            ? input.selectedMainAccountId
            : undefined;
        const runtime: ResponsesImageTrustedRuntime = Object.freeze({
          tenantId: input.tenantId,
          requestId: input.requestId,
          providerId: hostedRuntime.providerId,
          imageModel: hostedRuntime.imageModel,
          referenceTtlMs: hostedRuntime.referenceTtlMs,
          maxOutputBytes: hostedRuntime.maxOutputBytes,
          maxTotalOutputBytes: hostedRuntime.maxTotalOutputBytes,
          signal: input.signal,
          sessionKey: input.sessionKey,
          ...(selectedCodexAccount !== undefined
            ? {
                preferredAccountId: selectedCodexAccount,
                boundAccountFallbackPolicy: 'strict' as const,
              }
            : {
                ...(hostedRuntime.preferredAccountId !== undefined
                  ? { preferredAccountId: hostedRuntime.preferredAccountId }
                  : {}),
                ...(hostedRuntime.preferredAccountGroup !== undefined
                  ? { preferredAccountGroup: hostedRuntime.preferredAccountGroup }
                  : {}),
                ...(hostedRuntime.boundAccountFallbackPolicy !== undefined
                  ? { boundAccountFallbackPolicy: hostedRuntime.boundAccountFallbackPolicy }
                  : {}),
              }),
        });
        const opening = contribution.createRequestScope({
          admission: input.admission,
          runtime,
          ...(input.authorizedPreviousResponseId !== undefined
            ? { authorizedPreviousResponseId: input.authorizedPreviousResponseId }
            : {}),
          ...(input.authorizedPreviousResponseKnownEmpty !== undefined
            ? { authorizedPreviousResponseKnownEmpty: input.authorizedPreviousResponseKnownEmpty }
            : {}),
        }).then(wrapScope);
        openings.add(opening);
        let scope: ResponsesImageRequestScope;
        try {
          scope = await opening;
        } finally {
          openings.delete(opening);
        }
        if (released) throw new ImageGenerationError('unsupported_capability');
        return scope;
      },
      release: (): Promise<void> => {
        if (releasePromise) return releasePromise;
        released = true;
        releasePromise = (async () => {
          await Promise.allSettled([...openings]);
          const disposals = await Promise.allSettled(
            [...scopes].map((scope) => scope.dispose()),
          );
          let releaseFailure: unknown;
          try {
            await this.#release(record, 'hosted');
          } catch (error) {
            releaseFailure = error;
          }
          const failures = disposals
            .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
            .map((result) => result.reason);
          if (releaseFailure !== undefined) failures.push(releaseFailure);
          if (failures.length > 0) {
            throw new AggregateError(failures, 'hosted image request disposal failed');
          }
        })();
        return releasePromise;
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
