import { randomUUID } from 'node:crypto';

import type {
  ImageProviderRequest,
  ImageProviderContext,
} from '../ImageProvider';
import { ImageGenerationError, imageGenerationErrorFromPublic, normalizeImageGenerationError, serializeImageGenerationError } from '../errors';
import { readImageAssetBytes, type ImageAsset, type ImageReferenceLease } from '../ports';
import {
  inspectResponsesImageRequest,
  validateResponsesImageSelection,
} from './normalizeResponsesImageTool';
import type {
  ResponsesImageCallStateLease,
  ResponsesImageResponseStateLease,
} from './ResponsesImageStateStore';
import type {
  ResponsesImageAdmission,
  ResponsesImageCallBinding,
  ResponsesImageCallId,
  ResponsesImageEventAllocator,
  ResponsesImageExecutionEvent,
  ResponsesImageGenerationContribution,
  ResponsesImageGenerationContributionDeps,
  ResponsesImageRequestScope,
  ResponsesImageRequestScopeInput,
  ResponsesImageTrustedRuntime,
  ResponsesSelectedImageCall,
} from './types';

const CALL_ID_PATTERN = /^ig_[A-Za-z0-9_-]{16,128}$/;
const RESPONSE_ID_PATTERN = /^resp_[A-Za-z0-9_-]{1,240}$/;

interface ResolvedInput {
  readonly binding: ResponsesImageCallBinding;
  readonly asset: ImageAsset;
  readonly stateLease: ResponsesImageCallStateLease;
  readonly imageLease: ImageReferenceLease;
}

type RequestScopeLifecycle = 'open' | 'executing' | 'committing' | 'committed' | 'disposed';

function nonempty(value: unknown, max = 512): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function cancelled(signal: AbortSignal): never {
  throw new ImageGenerationError('request_cancelled', { cause: signal.reason });
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) cancelled(signal);
}

function stableError(error: unknown, signal: AbortSignal): ImageGenerationError {
  if (signal.aborted) return new ImageGenerationError('request_cancelled', { cause: signal.reason });
  return normalizeImageGenerationError(error);
}

function assertRuntime(runtime: ResponsesImageTrustedRuntime): void {
  if (!runtime || typeof runtime !== 'object') {
    throw new ImageGenerationError('invalid_image_request');
  }
  if (!nonempty(runtime.tenantId) || !nonempty(runtime.requestId)) {
    throw new ImageGenerationError('invalid_image_request');
  }
  if (!nonempty(runtime.providerId, 128)) {
    throw new ImageGenerationError('invalid_image_request', { param: 'provider' });
  }
  if (!nonempty(runtime.imageModel, 128)) {
    throw new ImageGenerationError('invalid_image_request', { param: 'model' });
  }
  if (
    !Number.isSafeInteger(runtime.referenceTtlMs) ||
    runtime.referenceTtlMs <= 0 ||
    !Number.isSafeInteger(runtime.maxOutputBytes) ||
    runtime.maxOutputBytes <= 0 ||
    !Number.isSafeInteger(runtime.maxTotalOutputBytes) ||
    runtime.maxTotalOutputBytes < runtime.maxOutputBytes ||
    !runtime.signal ||
    typeof runtime.signal.aborted !== 'boolean' ||
    typeof runtime.signal.addEventListener !== 'function' ||
    typeof runtime.signal.removeEventListener !== 'function'
  ) {
    throw new ImageGenerationError('invalid_image_request');
  }
  for (const hint of [runtime.sessionKey, runtime.preferredAccountId, runtime.preferredAccountGroup]) {
    if (hint !== undefined && !nonempty(hint)) {
      throw new ImageGenerationError('invalid_image_request');
    }
  }
  if (
    runtime.boundAccountFallbackPolicy !== undefined &&
    runtime.boundAccountFallbackPolicy !== 'strict' &&
    runtime.boundAccountFallbackPolicy !== 'pool'
  ) {
    throw new ImageGenerationError('invalid_image_request');
  }
}

function linkAbortSignal(signal: AbortSignal): {
  readonly controller: AbortController;
  readonly removeListener: () => void;
} {
  const controller = new AbortController();
  const onAbort = (): void => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  return {
    controller,
    removeListener: () => signal.removeEventListener('abort', onAbort),
  };
}

function referenceFailure(status: 'expired' | 'not_found'): never {
  throw new ImageGenerationError(
    status === 'expired' ? 'image_reference_expired' : 'image_reference_not_found',
  );
}

function assertAssetAgreement(lease: ImageReferenceLease): ImageAsset {
  const asset = lease.value.artifact;
  const metadata = lease.metadata;
  if (
    !asset ||
    asset.independentlyDecodable !== true ||
    asset.mimeType !== metadata.mimeType ||
    asset.byteLength !== metadata.byteLength ||
    asset.width !== metadata.width ||
    asset.height !== metadata.height ||
    asset.artifactId.length === 0
  ) {
    throw new ImageGenerationError('upstream_protocol_changed');
  }
  return asset;
}

async function releaseQuietly(leases: readonly { release(): Promise<void> }[]): Promise<void> {
  for (const lease of [...leases].reverse()) {
    try {
      await lease.release();
    } catch {
      // Cleanup is idempotent and must not expose dependency errors.
    }
  }
}

async function createScope(
  deps: ResponsesImageGenerationContributionDeps,
  now: () => number,
  input: ResponsesImageRequestScopeInput,
): Promise<ResponsesImageRequestScope> {
  assertRuntime(input.runtime);
  const { admission, runtime } = input;
  const linked = linkAbortSignal(runtime.signal);
  const responseLeases: ResponsesImageResponseStateLease[] = [];
  const stateLeases: ResponsesImageCallStateLease[] = [];
  const imageLeases: ImageReferenceLease[] = [];
  const callIds: ResponsesImageCallId[] = [];
  const seen = new Set<ResponsesImageCallId>();
  const addCallId = (callId: ResponsesImageCallId): void => {
    if (!seen.has(callId)) {
      seen.add(callId);
      callIds.push(callId);
    }
  };

  try {
    assertNotAborted(linked.controller.signal);
    if (!admission || typeof admission !== 'object') {
      throw new ImageGenerationError('invalid_image_request');
    }
    if (admission.previousResponseId !== undefined) {
      if (input.authorizedPreviousResponseId !== admission.previousResponseId) {
        throw new ImageGenerationError('image_reference_not_found');
      }
    } else if (input.authorizedPreviousResponseId !== undefined) {
      throw new ImageGenerationError('invalid_image_request', { param: 'previous_response_id' });
    }
    if (
      input.authorizedPreviousResponseKnownEmpty !== undefined &&
      (typeof input.authorizedPreviousResponseKnownEmpty !== 'boolean' ||
        input.authorizedPreviousResponseId === undefined)
    ) {
      throw new ImageGenerationError('invalid_image_request', { param: 'previous_response_id' });
    }
    admission.explicitCallIds.forEach(addCallId);

    if (input.authorizedPreviousResponseId !== undefined) {
      const response = await deps.stateStore.resolveResponse(
        runtime.tenantId,
        input.authorizedPreviousResponseId,
      );
      if (response.status === 'found') responseLeases.push(response.lease);
      assertNotAborted(linked.controller.signal);
      if (response.status === 'expired') referenceFailure(response.status);
      if (
        response.status === 'not_found' &&
        input.authorizedPreviousResponseKnownEmpty !== true
      ) {
        referenceFailure(response.status);
      }
      if (response.status === 'found') response.lease.callIds.forEach(addCallId);
    }

    const resolvedInputs: ResolvedInput[] = [];
    for (const callId of callIds) {
      assertNotAborted(linked.controller.signal);
      const state = await deps.stateStore.resolveCall(runtime.tenantId, callId);
      if (state.status === 'found') stateLeases.push(state.lease);
      assertNotAborted(linked.controller.signal);
      if (state.status !== 'found') referenceFailure(state.status);
      const image = await deps.referenceStore.resolve(
        runtime.tenantId,
        state.lease.binding.referenceId,
      );
      if (image.status === 'found') imageLeases.push(image.lease);
      assertNotAborted(linked.controller.signal);
      if (image.status !== 'found') referenceFailure(image.status);
      if (image.lease.metadata.referenceId !== state.lease.binding.referenceId) {
        throw new ImageGenerationError('upstream_protocol_changed');
      }
      resolvedInputs.push({
        binding: state.lease.binding,
        asset: assertAssetAgreement(image.lease),
        stateLease: state.lease,
        imageLease: image.lease,
      });
    }

    assertNotAborted(linked.controller.signal);
    return new RequestScope(
      deps,
      now,
      input,
      resolvedInputs,
      responseLeases,
      linked.controller,
      linked.removeListener,
    );
  } catch (error) {
    await releaseQuietly([...imageLeases, ...stateLeases, ...responseLeases]);
    linked.removeListener();
    throw stableError(error, linked.controller.signal);
  }
}

class RequestScope implements ResponsesImageRequestScope {
  readonly #deps: ResponsesImageGenerationContributionDeps;
  readonly #now: () => number;
  readonly #admission: ResponsesImageAdmission;
  readonly #runtime: ResponsesImageTrustedRuntime;
  readonly #resolvedInputs: readonly ResolvedInput[];
  readonly #responseLeases: readonly ResponsesImageResponseStateLease[];
  readonly #pendingBindings: ResponsesImageCallBinding[] = [];
  readonly #newReferenceIds = new Set<ResponsesImageCallBinding['referenceId']>();
  readonly #newReferenceLeases: ImageReferenceLease[] = [];
  readonly #allocatedCallIds = new Set<ResponsesImageCallId>();
  readonly #scopeController: AbortController;
  readonly #removeRuntimeAbortListener: () => void;
  #usedBytes = 0;
  #lastOutputIndex = -1;
  #lastSequenceNumber = -1;
  #state: RequestScopeLifecycle = 'open';
  #disposeRequested = false;
  #executionDone: Promise<void> | undefined;
  #resolveExecutionDone: (() => void) | undefined;
  #activeExecutionIterator: AsyncIterator<ResponsesImageExecutionEvent> | undefined;
  #activeIteratorClosePromise: Promise<void> | undefined;
  #commitResponseId: string | undefined;
  #commitPromise: Promise<void> | undefined;
  #committedResponseId: string | undefined;
  #disposePromise: Promise<void> | undefined;

  constructor(
    deps: ResponsesImageGenerationContributionDeps,
    now: () => number,
    input: ResponsesImageRequestScopeInput,
    resolvedInputs: readonly ResolvedInput[],
    responseLeases: readonly ResponsesImageResponseStateLease[],
    scopeController: AbortController,
    removeRuntimeAbortListener: () => void,
  ) {
    this.#deps = deps;
    this.#now = now;
    this.#admission = input.admission;
    this.#runtime = input.runtime;
    this.#resolvedInputs = Object.freeze([...resolvedInputs]);
    this.#responseLeases = Object.freeze([...responseLeases]);
    this.#scopeController = scopeController;
    this.#removeRuntimeAbortListener = removeRuntimeAbortListener;
    for (const item of resolvedInputs) this.#allocatedCallIds.add(item.binding.callId);
  }

  executeSelectedCall(
    call: ResponsesSelectedImageCall,
    allocator: ResponsesImageEventAllocator,
  ): AsyncIterable<ResponsesImageExecutionEvent> {
    const generator = this.#executeSelectedCall(call, allocator);
    let tracked!: AsyncIterator<ResponsesImageExecutionEvent>;
    const clearIfCurrent = (): void => {
      if (this.#activeExecutionIterator === tracked) {
        this.#activeExecutionIterator = undefined;
        this.#activeIteratorClosePromise = undefined;
      }
    };
    tracked = {
      next: async () => {
        if (
          this.#activeExecutionIterator === undefined ||
          this.#activeExecutionIterator === tracked
        ) {
          this.#activeExecutionIterator = tracked;
        }
        const result = await generator.next();
        if (result.done) clearIfCurrent();
        return result;
      },
      return: async () => {
        try {
          return await generator.return(undefined);
        } finally {
          clearIfCurrent();
        }
      },
      throw: async (error?: unknown) => {
        try {
          return await generator.throw(error);
        } finally {
          clearIfCurrent();
        }
      },
    };
    return Object.freeze({
      [Symbol.asyncIterator]: () => tracked,
    });
  }

  async *#executeSelectedCall(
    call: ResponsesSelectedImageCall,
    allocator: ResponsesImageEventAllocator,
  ): AsyncGenerator<ResponsesImageExecutionEvent, void, void> {
    let callId: ResponsesImageCallId | undefined;
    let outputIndex: number | undefined;
    let started = false;
    let providerIterator: AsyncIterator<unknown> | undefined;
    try {
      this.#beginExecution();
      started = true;
      if (!this.#admission.declared || !this.#admission.options) {
        throw new ImageGenerationError('upstream_protocol_changed');
      }
      if (!call || typeof call !== 'object' || !nonempty(call.prompt, 32_000)) {
        throw new ImageGenerationError('upstream_protocol_changed');
      }
      if (!allocator || typeof allocator.reserveOutputIndex !== 'function' || typeof allocator.nextSequenceNumber !== 'function') {
        throw new ImageGenerationError('image_generation_failed');
      }
      assertNotAborted(this.#scopeController.signal);
      const candidateCallId = (this.#deps.createCallId
        ?? (() => `ig_${randomUUID().replaceAll('-', '')}` as ResponsesImageCallId))();
      if (!CALL_ID_PATTERN.test(candidateCallId) || this.#allocatedCallIds.has(candidateCallId)) {
        throw new ImageGenerationError('image_generation_failed');
      }
      callId = candidateCallId;
      this.#allocatedCallIds.add(callId);
      outputIndex = allocator.reserveOutputIndex();
      if (
        !Number.isSafeInteger(outputIndex) ||
        outputIndex < 0 ||
        outputIndex <= this.#lastOutputIndex
      ) {
        throw new ImageGenerationError('image_generation_failed');
      }
      this.#lastOutputIndex = outputIndex;

      const request = this.#buildRequest(call);
      const context: ImageProviderContext = {
        requestId: this.#runtime.requestId,
        tenantId: this.#runtime.tenantId,
        signal: this.#scopeController.signal,
        ...(this.#runtime.sessionKey !== undefined ? { sessionKey: this.#runtime.sessionKey } : {}),
        ...(this.#runtime.preferredAccountId !== undefined
          ? { preferredAccountId: this.#runtime.preferredAccountId }
          : {}),
        ...(this.#runtime.preferredAccountGroup !== undefined
          ? { preferredAccountGroup: this.#runtime.preferredAccountGroup }
          : {}),
        ...(this.#runtime.boundAccountFallbackPolicy !== undefined
          ? { boundAccountFallbackPolicy: this.#runtime.boundAccountFallbackPolicy }
          : {}),
      };

      const iterator = this.#deps.orchestrator.run(request, context, {
        providerId: this.#runtime.providerId,
        retention: { enabled: true, ttlMs: this.#runtime.referenceTtlMs },
        requireResponsesTool: true,
      })[Symbol.asyncIterator]();
      providerIterator = iterator;
      while (true) {
        const next = await iterator.next();
        if (
          !next.done &&
          next.value.type === 'completed' &&
          next.value.images.length === 1 &&
          next.value.references?.length === 1
        ) {
          // Producer exposure transfers rollback ownership synchronously. Disposal may
          // already have aborted the scope before this continuation gets to observe it.
          this.#newReferenceIds.add(next.value.references[0]!.referenceId);
        }
        if (next.done) throw new ImageGenerationError('upstream_protocol_changed');
        const event = next.value;
        assertNotAborted(this.#scopeController.signal);
        if (event.type === 'accepted') {
          yield Object.freeze({
            kind: 'started' as const,
            outputIndex,
            item: Object.freeze({
              id: callId,
              type: 'image_generation_call' as const,
              status: 'in_progress' as const,
            }),
          });
          continue;
        }
        if (event.type === 'partial_image') {
          const sequence = allocator.nextSequenceNumber();
          if (
            !Number.isSafeInteger(sequence) ||
            sequence < 0 ||
            sequence <= this.#lastSequenceNumber
          ) {
            throw new ImageGenerationError('image_generation_failed');
          }
          this.#lastSequenceNumber = sequence;
          const partial = await this.#readBase64(event.image.artifact);
          assertNotAborted(this.#scopeController.signal);
          yield Object.freeze({
            type: 'response.image_generation_call.partial_image' as const,
            output_index: outputIndex,
            item_id: callId,
            sequence_number: sequence,
            partial_image_index: event.partialImageIndex,
            partial_image_b64: partial,
          });
          continue;
        }
        if (event.type === 'failed') {
          yield Object.freeze({
            kind: 'failed' as const,
            outputIndex,
            callId,
            error: serializeImageGenerationError(imageGenerationErrorFromPublic(event.error)),
          });
          return;
        }
        if (
          event.images.length !== 1 ||
          !event.references ||
          event.references.length !== 1
        ) {
          throw new ImageGenerationError('upstream_protocol_changed');
        }
        const image = event.images[0]!;
        const reference = event.references[0]!;
        const retained = await this.#deps.referenceStore.resolve(
          this.#runtime.tenantId,
          reference.referenceId,
        );
        if (retained.status !== 'found') throw new ImageGenerationError('upstream_protocol_changed');
        this.#newReferenceLeases.push(retained.lease);
        const retainedAsset = assertAssetAgreement(retained.lease);
        if (
          retained.lease.metadata.referenceId !== reference.referenceId ||
          retainedAsset.artifactId !== image.artifact.artifactId ||
          reference.mimeType !== image.artifact.mimeType ||
          reference.byteLength !== image.artifact.byteLength ||
          reference.width !== image.artifact.width ||
          reference.height !== image.artifact.height
        ) {
          throw new ImageGenerationError('upstream_protocol_changed');
        }
        const result = await this.#readBase64(image.artifact);
        assertNotAborted(this.#scopeController.signal);
        const binding: ResponsesImageCallBinding = Object.freeze({
          callId,
          referenceId: reference.referenceId,
          expiresAt: reference.expiresAt,
        });
        this.#pendingBindings.push(binding);
        yield Object.freeze({
          kind: 'completed' as const,
          outputIndex,
          item: Object.freeze({
            id: callId,
            type: 'image_generation_call' as const,
            status: 'completed' as const,
            result,
            ...(image.revisedPrompt !== undefined
              ? { revised_prompt: image.revisedPrompt }
              : {}),
          }),
        });
        return;
      }
    } catch (error) {
      const safe = stableError(error, this.#scopeController.signal);
      yield Object.freeze({
        kind: 'failed' as const,
        ...(outputIndex !== undefined ? { outputIndex } : {}),
        ...(callId !== undefined ? { callId } : {}),
        error: serializeImageGenerationError(safe),
      });
    } finally {
      try {
        await providerIterator?.return?.();
      } catch {
        // Iterator cleanup must not replace the stable terminal record.
      }
      if (started) this.#finishExecution();
    }
  }

  commit(responseId: string): Promise<void> {
    if (!RESPONSE_ID_PATTERN.test(responseId)) return this.#commitFailure();
    if (this.#state === 'committing') {
      return this.#commitResponseId === responseId
        ? this.#commitPromise!
        : this.#commitFailure();
    }
    if (this.#state === 'committed') {
      return this.#committedResponseId === responseId
        ? (this.#commitPromise ?? Promise.resolve())
        : this.#commitFailure();
    }
    if (this.#state !== 'open' || this.#disposeRequested) return this.#commitFailure();
    try {
      assertNotAborted(this.#scopeController.signal);
    } catch (error) {
      return Promise.reject(error);
    }
    this.#state = 'committing';
    this.#commitResponseId = responseId;
    this.#commitPromise = Promise.resolve().then(() => this.#performCommit(responseId));
    return this.#commitPromise;
  }

  async #performCommit(responseId: string): Promise<void> {
    const bindings = [...this.#resolvedInputs.map((item) => item.binding), ...this.#pendingBindings];
    try {
      const evicted = await this.#deps.stateStore.commit({
        tenantId: this.#runtime.tenantId,
        responseId,
        bindings,
        responseExpiresAt: this.#now() + this.#runtime.referenceTtlMs,
      });
      this.#committedResponseId = responseId;
      this.#state = 'committed';
      for (const binding of evicted) {
        try {
          await this.#deps.referenceStore.delete(this.#runtime.tenantId, binding.referenceId);
        } catch {
          // Persistent cleanup is best effort and can be retried by production wiring.
        }
      }
    } catch (error) {
      if (this.#state === 'committing') this.#state = 'open';
      this.#commitResponseId = undefined;
      throw stableError(error, this.#scopeController.signal);
    }
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposeRequested = true;
    this.#disposePromise = this.#performDispose();
    return this.#disposePromise;
  }

  async waitForIdle(): Promise<void> {
    const operations = [this.#executionDone, this.#commitPromise]
      .filter((value): value is Promise<void> => value !== undefined);
    await Promise.allSettled(operations);
  }

  #buildRequest(call: ResponsesSelectedImageCall): ImageProviderRequest {
    const options = this.#admission.options!;
    const common = {
      model: this.#runtime.imageModel,
      prompt: call.prompt,
      n: 1,
      quality: options.quality,
      size: options.size,
      background: options.background,
      outputFormat: options.outputFormat,
      ...(options.outputCompression !== undefined
        ? { outputCompression: options.outputCompression }
        : {}),
      moderation: 'auto' as const,
      stream: options.partialImages > 0,
      partialImages: options.partialImages,
    };
    const action = options.action === 'auto'
      ? (this.#resolvedInputs.length > 0 ? 'edit' : 'generate')
      : options.action;
    if (action === 'generate') return { action, ...common };
    if (this.#resolvedInputs.length === 0) {
      throw new ImageGenerationError('invalid_image_request', { param: 'input' });
    }
    return { action, ...common, images: this.#resolvedInputs.map((item) => item.asset) };
  }

  async #readBase64(asset: ImageAsset): Promise<string> {
    assertNotAborted(this.#scopeController.signal);
    if (
      !Number.isSafeInteger(asset.byteLength) ||
      asset.byteLength <= 0 ||
      asset.byteLength > this.#runtime.maxOutputBytes ||
      this.#usedBytes > this.#runtime.maxTotalOutputBytes - asset.byteLength
    ) {
      throw new ImageGenerationError('image_too_large');
    }
    this.#usedBytes += asset.byteLength;
    let bytes: Uint8Array;
    try {
      bytes = await readImageAssetBytes(
        asset,
        this.#runtime.maxOutputBytes,
        this.#scopeController.signal,
      );
    } catch (error) {
      if (this.#scopeController.signal.aborted) cancelled(this.#scopeController.signal);
      if (error instanceof RangeError) {
        throw new ImageGenerationError('upstream_protocol_changed');
      }
      throw error;
    }
    assertNotAborted(this.#scopeController.signal);
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  }

  #beginExecution(): void {
    if (this.#state !== 'open' || this.#disposeRequested) {
      throw new ImageGenerationError('invalid_image_request');
    }
    this.#state = 'executing';
    this.#executionDone = new Promise<void>((resolve) => {
      this.#resolveExecutionDone = resolve;
    });
  }

  #finishExecution(): void {
    if (this.#state === 'executing') this.#state = 'open';
    this.#resolveExecutionDone?.();
    this.#resolveExecutionDone = undefined;
  }

  #commitFailure(): Promise<void> {
    return Promise.reject(new ImageGenerationError('image_generation_failed'));
  }

  #closeActiveIterator(): Promise<void> {
    if (this.#activeIteratorClosePromise) return this.#activeIteratorClosePromise;
    const iterator = this.#activeExecutionIterator;
    if (!iterator?.return) return Promise.resolve();
    this.#activeIteratorClosePromise = Promise.resolve(iterator.return()).then(
      () => undefined,
      () => undefined,
    );
    return this.#activeIteratorClosePromise;
  }

  async #performDispose(): Promise<void> {
    if (this.#state === 'executing' && !this.#scopeController.signal.aborted) {
      this.#scopeController.abort(new Error('Responses image request scope disposed.'));
    }
    const executionDone = this.#executionDone;
    await Promise.allSettled([
      this.#closeActiveIterator(),
      ...(executionDone ? [executionDone] : []),
    ]);
    if (this.#commitPromise) {
      await this.#commitPromise.catch(() => undefined);
    }
    if (this.#committedResponseId === undefined) {
      for (const referenceId of this.#newReferenceIds) {
        try {
          await this.#deps.referenceStore.delete(this.#runtime.tenantId, referenceId);
        } catch {
          // Rollback deletion is idempotent and best effort; store cleanup remains available.
        }
      }
    }
    await releaseQuietly([
      ...this.#newReferenceLeases,
      ...this.#resolvedInputs.map((item) => item.imageLease),
      ...this.#resolvedInputs.map((item) => item.stateLease),
      ...this.#responseLeases,
    ]);
    if (!this.#scopeController.signal.aborted) {
      this.#scopeController.abort(new Error('Responses image request scope disposed.'));
    }
    this.#removeRuntimeAbortListener();
    this.#state = 'disposed';
  }
}

export function createResponsesImageGenerationContribution(
  deps: ResponsesImageGenerationContributionDeps,
): ResponsesImageGenerationContribution {
  if (
    !deps ||
    typeof deps !== 'object' ||
    !deps.orchestrator ||
    !deps.stateStore ||
    !deps.referenceStore ||
    (deps.createCallId !== undefined && typeof deps.createCallId !== 'function') ||
    (deps.now !== undefined && typeof deps.now !== 'function')
  ) {
    throw new TypeError('Responses image generation requires orchestrator and state/reference stores.');
  }
  const now = deps.now ?? Date.now;
  return Object.freeze({
    toolType: 'image_generation' as const,
    inspectRequest: inspectResponsesImageRequest,
    validateSelection: validateResponsesImageSelection,
    createRequestScope: (input: ResponsesImageRequestScopeInput) => createScope(deps, now, input),
  });
}
