import { randomUUID } from 'node:crypto';

import {
  ImageGenerationError,
  imageGenerationErrorFromPublic,
  isImageGenerationError,
  normalizeImageGenerationError,
} from '../../../image-generation/errors';
import type {
  ResponsesImageAdmission,
  ResponsesImageCompletedRecord,
  ResponsesImageGenerationCallItem,
  ResponsesImageRequestScope,
} from '../../../image-generation/responses';
import { OpenAIOperationError } from '../../../openai-operation';
import type { ResponsesAffinityHostedImageState } from '../responsesAffinity';
import type {
  ResponsesHostedImageIngress,
  ResponsesHostedImagePrepareInput,
  ResponsesHostedImageRequestLease,
  ResponsesHostedImageRuntimeFactory,
  ResponsesHostedImageRuntimeLease,
  ResponsesHostedImageWrapInput,
} from '../responsesHostedImageIngress';
import {
  hasImageOwnedResponsesInput,
  prepareNativeResponsesImageSelection,
  type NativeResponsesImageSelectionPreparation,
  type NativeResponsesSelectedImageCall,
} from './nativeResponsesImageSelection';
import { createNativeResponsesHostedImageSseResponse } from './nativeResponsesHostedImageSse';

const DEFAULT_MAX_UPSTREAM_JSON_BYTES = 8 * 1024 * 1024;
const MAX_CONFIGURED_UPSTREAM_JSON_BYTES = 64 * 1024 * 1024;
const MAX_SELECTED_IMAGE_CALLS = 16;
const RESPONSE_ID_PATTERN = /^resp_[A-Za-z0-9_-]{1,240}$/;
const UPSTREAM_CALL_ID_PATTERN = /^call_[A-Za-z0-9_-]{1,240}$/;
const PUBLIC_IMAGE_CALL_ID_PATTERN = /^ig_[A-Za-z0-9_-]{16,128}$/;

export interface NativeResponsesHostedImageMediatorOptions {
  readonly maxUpstreamJsonBytes?: number;
  readonly createSelectorName?: () => string;
  readonly createRequestId?: () => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function protocolFailure(): never {
  throw new ImageGenerationError('upstream_protocol_changed');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ImageGenerationError('request_cancelled', { cause: signal.reason });
  }
}

function asOpenAIOperationError(error: unknown, signal: AbortSignal): OpenAIOperationError {
  if (error instanceof OpenAIOperationError) return error;
  const safe = signal.aborted
    ? new ImageGenerationError('request_cancelled', { cause: signal.reason })
    : normalizeImageGenerationError(error);
  return new OpenAIOperationError({
    status: safe.httpStatus,
    code: safe.code,
    message: safe.message,
    retryable: safe.httpStatus === 429 || safe.httpStatus === 503 || safe.httpStatus === 504,
    ...(safe.retryAfterSeconds !== undefined
      ? { headers: { 'Retry-After': String(safe.retryAfterSeconds) } }
      : {}),
  });
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const body = response.body;
  if (!body) protocolFailure();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        protocolFailure();
      }
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  throwIfAborted(signal);
  const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseJsonObject(bytes: Uint8Array): Record<string, unknown> {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    protocolFailure();
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) protocolFailure();
    return parsed;
  } catch (error) {
    if (isImageGenerationError(error)) throw error;
    protocolFailure();
  }
}

function responseWithBody(
  upstream: Response,
  body: BodyInit,
  forceJsonContentType = false,
): Response {
  const headers = new Headers(upstream.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.delete('transfer-encoding');
  if (forceJsonContentType) headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

function validRequestId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 512;
}

function copyPublicRequestValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => isRecord(item) ? { ...item } : item);
  }
  return isRecord(value) ? { ...value } : value;
}

function validateCompletedItem(
  record: ResponsesImageCompletedRecord,
  expectedOutputIndex: number,
  startedId: string | undefined,
): ResponsesImageGenerationCallItem {
  const item = record.item as unknown;
  if (
    record.outputIndex !== expectedOutputIndex ||
    !isRecord(item) ||
    Object.keys(item).some(
      (key) => key !== 'id' && key !== 'type' && key !== 'status' &&
        key !== 'result' && key !== 'revised_prompt',
    ) ||
    typeof item.id !== 'string' ||
    !PUBLIC_IMAGE_CALL_ID_PATTERN.test(item.id) ||
    item.type !== 'image_generation_call' ||
    item.status !== 'completed' ||
    typeof item.result !== 'string' ||
    item.result.length === 0 ||
    (item.revised_prompt !== undefined && typeof item.revised_prompt !== 'string') ||
    (startedId !== undefined && item.id !== startedId)
  ) {
    protocolFailure();
  }
  return Object.freeze({ ...item }) as unknown as ResponsesImageGenerationCallItem;
}

async function executeSelectedImageCall(
  scope: ResponsesImageRequestScope,
  selected: NativeResponsesSelectedImageCall,
): Promise<ResponsesImageGenerationCallItem> {
  let outputReserved = false;
  let sequenceNumber = -1;
  let startedId: string | undefined;
  let completed: ResponsesImageGenerationCallItem | undefined;
  const events = scope.executeSelectedCall(selected.call, {
    reserveOutputIndex: () => {
      if (outputReserved) protocolFailure();
      outputReserved = true;
      return selected.presentationIndex;
    },
    nextSequenceNumber: () => {
      sequenceNumber += 1;
      return sequenceNumber;
    },
  });
  for await (const event of events) {
    if (!isRecord(event as unknown)) protocolFailure();
    if ('type' in event && event.type === 'response.image_generation_call.partial_image') {
      // A non-stream response must never materialize partial-image wire events.
      protocolFailure();
    }
    if (!('kind' in event)) protocolFailure();
    if (event.kind === 'failed') {
      throw imageGenerationErrorFromPublic(event.error);
    }
    if (event.kind === 'started') {
      const item = event.item as unknown;
      if (
        startedId !== undefined || completed !== undefined ||
        event.outputIndex !== selected.presentationIndex ||
        !isRecord(item) ||
        Object.keys(item).some((key) => key !== 'id' && key !== 'type' && key !== 'status') ||
        typeof item.id !== 'string' ||
        !PUBLIC_IMAGE_CALL_ID_PATTERN.test(item.id) ||
        item.type !== 'image_generation_call' ||
        item.status !== 'in_progress'
      ) {
        protocolFailure();
      }
      startedId = item.id;
      continue;
    }
    if (event.kind === 'completed') {
      if (completed !== undefined || startedId === undefined) protocolFailure();
      completed = validateCompletedItem(event, selected.presentationIndex, startedId);
      continue;
    }
    protocolFailure();
  }
  if (!outputReserved || !completed) protocolFailure();
  return completed;
}

function restorePublicResponseWire(
  upstreamBody: Record<string, unknown>,
  output: readonly unknown[],
  requestBody: Readonly<Record<string, unknown>>,
  selection: NativeResponsesImageSelectionPreparation,
  forbiddenIds: readonly string[],
): string {
  const publicBody: Record<string, unknown> = { ...upstreamBody, output: [...output] };
  if (Object.prototype.hasOwnProperty.call(upstreamBody, 'tools')) {
    publicBody.tools = copyPublicRequestValue(requestBody.tools);
  }
  if (Object.prototype.hasOwnProperty.call(upstreamBody, 'tool_choice')) {
    publicBody.tool_choice = copyPublicRequestValue(requestBody.tool_choice);
  }
  const serialized = JSON.stringify(publicBody);
  const forbidden = [selection.selectorName, ...forbiddenIds]
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (forbidden.some((value) => serialized.includes(value))) protocolFailure();
  return serialized;
}

class NativeResponsesHostedImageRequestLease implements ResponsesHostedImageRequestLease {
  readonly upstreamBody: Record<string, unknown>;
  readonly #runtime: ResponsesHostedImageRuntimeLease;
  readonly #releaseRuntime: () => Promise<void>;
  readonly #input: ResponsesHostedImagePrepareInput;
  readonly #admission: ResponsesImageAdmission;
  readonly #selection: NativeResponsesImageSelectionPreparation;
  readonly #maxUpstreamJsonBytes: number;
  readonly #createRequestId: () => string;
  #scope: ResponsesImageRequestScope | undefined;
  #scopeCleanupRequested = false;
  #scopeDisposePromise: Promise<void> | undefined;
  #wrapStarted = false;
  #disposePromise: Promise<void> | undefined;

  constructor(args: {
    runtime: ResponsesHostedImageRuntimeLease;
    releaseRuntime: () => Promise<void>;
    input: ResponsesHostedImagePrepareInput;
    admission: ResponsesImageAdmission;
    selection: NativeResponsesImageSelectionPreparation;
    maxUpstreamJsonBytes: number;
    createRequestId: () => string;
  }) {
    this.#runtime = args.runtime;
    this.#releaseRuntime = args.releaseRuntime;
    this.#input = args.input;
    this.#admission = args.admission;
    this.#selection = args.selection;
    this.#maxUpstreamJsonBytes = args.maxUpstreamJsonBytes;
    this.#createRequestId = args.createRequestId;
    this.upstreamBody = args.selection.upstreamBody;
  }

  async wrapUpstreamResponse(input: ResponsesHostedImageWrapInput): Promise<Response> {
    if (this.#wrapStarted) throw asOpenAIOperationError(
      new ImageGenerationError('upstream_protocol_changed'),
      this.#input.signal,
    );
    this.#wrapStarted = true;
    try {
      return this.#admission.stream
        ? this.#wrapSse(input)
        : await this.#wrapJson(input);
    } catch (error) {
      throw asOpenAIOperationError(error, this.#input.signal);
    }
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposePromise = (async () => {
      let cleanupError: unknown;
      try {
        await this.#disposeScopeOnce();
      } catch (error) {
        cleanupError = error;
      }
      try {
        await this.#releaseRuntime();
      } catch (error) {
        cleanupError ??= error;
      }
      if (cleanupError !== undefined) {
        throw asOpenAIOperationError(cleanupError, this.#input.signal);
      }
    })();
    return this.#disposePromise;
  }

  #setScope(scope: ResponsesImageRequestScope): void {
    if (this.#scope) protocolFailure();
    this.#scope = scope;
    if (this.#scopeCleanupRequested) void this.#disposeScopeOnce();
  }

  #disposeScopeOnce(): Promise<void> {
    this.#scopeCleanupRequested = true;
    if (this.#scopeDisposePromise) return this.#scopeDisposePromise;
    const scope = this.#scope;
    if (!scope) return Promise.resolve();
    this.#scopeDisposePromise = (async () => {
      await scope.waitForIdle();
      await scope.dispose();
    })();
    return this.#scopeDisposePromise;
  }

  #wrapSse(input: ResponsesHostedImageWrapInput): Response {
    const status = input.rawStatus ?? input.response.status;
    if (status < 200 || status >= 300) return input.response;
    const hasInheritedContext = this.#input.previousHostedImageState?.hasImageContext === true;
    return createNativeResponsesHostedImageSseResponse({
      upstream: input.response,
      signal: this.#input.signal,
      maxEventBytes: this.#maxUpstreamJsonBytes,
      selection: this.#selection,
      requestBody: this.#input.body,
      hasInheritedContext,
      explicitCallCount: this.#admission.explicitCallIds.length,
      validateSelection: (selection) => {
        this.#runtime.validateSelection(this.#admission, selection);
      },
      openScope: async () => {
        const requestId = this.#createRequestId();
        if (!validRequestId(requestId)) {
          throw new ImageGenerationError('image_generation_failed');
        }
        throwIfAborted(this.#input.signal);
        return this.#runtime.openRequest({
          admission: this.#admission,
          tenantId: this.#input.tenantId!,
          requestId,
          sessionKey: this.#input.sessionKey,
          signal: this.#input.signal,
          ...(this.#input.authorizedPreviousResponseId
            ? {
                authorizedPreviousResponseId: this.#input.authorizedPreviousResponseId,
                authorizedPreviousResponseKnownEmpty:
                  this.#input.previousHostedImageState?.hasImageContext !== true,
              }
            : {}),
          mainProviderId: this.#input.mainProviderId,
          ...(input.selectedMainAccountId
            ? { selectedMainAccountId: input.selectedMainAccountId }
            : {}),
        });
      },
      onScope: (scope) => this.#setScope(scope),
      onTerminalSuccess: input.onTerminalSuccess,
      onCancel: () => this.#disposeScopeOnce(),
    });
  }

  async #wrapJson(input: ResponsesHostedImageWrapInput): Promise<Response> {
    const status = input.rawStatus ?? input.response.status;
    if (status < 200 || status >= 300) return input.response;

    const bytes = await readBoundedBody(
      input.response,
      this.#maxUpstreamJsonBytes,
      this.#input.signal,
    );
    const upstreamBody = parseJsonObject(bytes);
    if (upstreamBody.status === 'failed' || upstreamBody.status === 'incomplete') {
      if (
        this.#selection.selectorName &&
        new TextDecoder().decode(bytes).includes(this.#selection.selectorName)
      ) {
        protocolFailure();
      }
      return responseWithBody(input.response, bytes);
    }
    if (
      upstreamBody.status !== 'completed' ||
      !RESPONSE_ID_PATTERN.test(upstreamBody.id as string) ||
      !Array.isArray(upstreamBody.output)
    ) {
      protocolFailure();
    }

    const parsedSelection = this.#selection.parseOutput(upstreamBody.output);
    if (parsedSelection.imageCalls.length > MAX_SELECTED_IMAGE_CALLS) protocolFailure();
    for (const selected of parsedSelection.imageCalls) {
      if (!UPSTREAM_CALL_ID_PATTERN.test(selected.upstreamCallId)) protocolFailure();
    }
    this.#runtime.validateSelection(this.#admission, parsedSelection.selection);

    const hasInheritedContext = this.#input.previousHostedImageState?.hasImageContext === true;
    const requiresScope = parsedSelection.imageCalls.length > 0 ||
      hasInheritedContext || this.#admission.explicitCallIds.length > 0;
    const publicOutput = [...upstreamBody.output];
    const pendingReceipts: Array<{
      readonly upstreamCallId: string;
      readonly publicImageCallId: string;
    }> = [];
    if (requiresScope) {
      const requestId = this.#createRequestId();
      if (!validRequestId(requestId)) {
        throw new ImageGenerationError('image_generation_failed');
      }
      this.#scope = await this.#runtime.openRequest({
        admission: this.#admission,
        tenantId: this.#input.tenantId!,
        requestId,
        sessionKey: this.#input.sessionKey,
        signal: this.#input.signal,
        ...(this.#input.authorizedPreviousResponseId
          ? {
              authorizedPreviousResponseId: this.#input.authorizedPreviousResponseId,
              authorizedPreviousResponseKnownEmpty:
                this.#input.previousHostedImageState?.hasImageContext !== true,
            }
          : {}),
        mainProviderId: this.#input.mainProviderId,
        ...(input.selectedMainAccountId
          ? { selectedMainAccountId: input.selectedMainAccountId }
          : {}),
      });
      for (const selected of parsedSelection.imageCalls) {
        const item = await executeSelectedImageCall(this.#scope, selected);
        if (publicOutput[selected.itemIndex] === undefined) protocolFailure();
        publicOutput[selected.itemIndex] = item;
        pendingReceipts.push(Object.freeze({
          upstreamCallId: selected.upstreamCallId,
          publicImageCallId: item.id,
        }));
      }
      await this.#scope.waitForIdle();
      await this.#scope.commit(upstreamBody.id as string);
    }

    const state: ResponsesAffinityHostedImageState = Object.freeze({
      hasImageContext: hasInheritedContext ||
        this.#admission.explicitCallIds.length > 0 ||
        pendingReceipts.length > 0,
      pendingReceipts: Object.freeze(pendingReceipts),
    });
    await input.onTerminalSuccess(upstreamBody.id as string, state);
    const serialized = restorePublicResponseWire(
      upstreamBody,
      publicOutput,
      this.#input.body,
      this.#selection,
      [
        ...parsedSelection.internalItemIds,
        ...parsedSelection.imageCalls.map((call) => call.upstreamCallId),
      ],
    );
    return responseWithBody(input.response, serialized, true);
  }
}

/**
 * Compose the daemon's generation-pinned hosted factory into the narrow Native
 * Responses ingress port. Runtime acquisition remains lazy until `prepare`.
 */
export function createNativeResponsesHostedImageIngress(
  runtimeFactory: ResponsesHostedImageRuntimeFactory,
  options: NativeResponsesHostedImageMediatorOptions = {},
): ResponsesHostedImageIngress {
  if (!runtimeFactory || typeof runtimeFactory.acquire !== 'function') {
    throw new TypeError('Native Responses hosted image runtime factory is invalid');
  }
  const maxUpstreamJsonBytes = options.maxUpstreamJsonBytes ?? DEFAULT_MAX_UPSTREAM_JSON_BYTES;
  if (
    !Number.isSafeInteger(maxUpstreamJsonBytes) || maxUpstreamJsonBytes <= 0 ||
    maxUpstreamJsonBytes > MAX_CONFIGURED_UPSTREAM_JSON_BYTES
  ) {
    throw new RangeError('Native Responses hosted image JSON limit is invalid');
  }
  const createRequestId = options.createRequestId ??
    (() => `hosted-image-${randomUUID()}`);

  return Object.freeze({
    prepare: async (
      input: ResponsesHostedImagePrepareInput,
    ): Promise<ResponsesHostedImageRequestLease | null> => {
      if (
        input.operation !== 'create' || input.profile !== 'native' ||
        (!hasImageOwnedResponsesInput(input.body) &&
          !input.previousHostedImageState?.hasImageContext &&
          !input.previousHostedImageState?.pendingReceipts.length)
      ) {
        return null;
      }
      if (!input.hostedImageGenerationAllowed) {
        throw new OpenAIOperationError({
          status: 403,
          code: 'insufficient_permissions',
          message: 'The API key is not allowed to execute image generation',
        });
      }
      if (!input.tenantId || !input.tenantId.trim()) {
        throw new OpenAIOperationError({
          status: 403,
          code: 'insufficient_permissions',
          message: 'Hosted image generation requires an authenticated outbound key',
        });
      }
      let runtime: ResponsesHostedImageRuntimeLease | undefined;
      let releasePromise: Promise<void> | undefined;
      const releaseRuntime = (): Promise<void> => {
        releasePromise ??= Promise.resolve().then(async () => {
          if (runtime && typeof runtime.release === 'function') await runtime.release();
        });
        return releasePromise;
      };
      try {
        throwIfAborted(input.signal);
        runtime = await runtimeFactory.acquire();
        throwIfAborted(input.signal);
        const admission = runtime.inspectRequest(input.body);
        const selection = prepareNativeResponsesImageSelection({
          body: input.body,
          admission,
          pendingReceipts: input.previousHostedImageState?.pendingReceipts,
          ...(options.createSelectorName
            ? { createSelectorName: options.createSelectorName }
            : {}),
        });
        return new NativeResponsesHostedImageRequestLease({
          runtime,
          releaseRuntime,
          input,
          admission,
          selection,
          maxUpstreamJsonBytes,
          createRequestId,
        });
      } catch (error) {
        await releaseRuntime().catch(() => undefined);
        throw asOpenAIOperationError(error, input.signal);
      }
    },
  });
}

/** Compatibility alias matching this module's implementation-oriented name. */
export const createNativeResponsesHostedImageMediator = createNativeResponsesHostedImageIngress;
