import {
  ImageGenerationError,
  imageGenerationErrorFromPublic,
  normalizeImageGenerationError,
} from '../../../image-generation/errors';
import type {
  ResponsesHostedToolSelection,
  ResponsesImageCompletedRecord,
  ResponsesImageExecutionEvent,
  ResponsesImageGenerationCallItem,
  ResponsesImagePartialEvent,
  ResponsesImageRequestScope,
} from '../../../image-generation/responses';
import type { ResponsesAffinityHostedImageState } from '../responsesAffinity';
import type {
  NativeResponsesImageSelectionPreparation,
  NativeResponsesImageSelectionResult,
  NativeResponsesSelectedImageCall,
} from './nativeResponsesImageSelection';

const RESPONSE_ID_PATTERN = /^resp_[A-Za-z0-9_-]{1,240}$/;
const WIRE_ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$/;
const UPSTREAM_CALL_ID_PATTERN = /^call_[A-Za-z0-9_-]{1,240}$/;
const PUBLIC_IMAGE_CALL_ID_PATTERN = /^ig_[A-Za-z0-9_-]{16,128}$/;
const MAX_SELECTED_IMAGE_CALLS = 16;
const TERMINAL_TYPES = new Set([
  'response.completed',
  'response.failed',
  'response.incomplete',
]);
const PARTIAL_KEYS = new Set([
  'type',
  'output_index',
  'item_id',
  'sequence_number',
  'partial_image_index',
  'partial_image_b64',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function protocolFailure(): never {
  throw new ImageGenerationError('upstream_protocol_changed');
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function copyPublicRequestValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => isRecord(item) ? { ...item } : item);
  }
  return isRecord(value) ? { ...value } : value;
}

interface SseFrame {
  readonly eventName?: string;
  readonly data: string;
}

/** Strict UTF-8, CRLF/LF-aware, bounded SSE frame decoder. */
class BoundedSseFrameDecoder {
  readonly #decoder = new TextDecoder('utf-8', { fatal: true });
  readonly #maxEventBytes: number;
  #lineBuffer = '';
  #eventName: string | undefined;
  #dataLines: string[] = [];
  #eventBytes = 0;

  constructor(maxEventBytes: number) {
    this.#maxEventBytes = maxEventBytes;
  }

  push(chunk: Uint8Array): SseFrame[] {
    let decoded: string;
    try {
      decoded = this.#decoder.decode(chunk, { stream: true });
    } catch {
      protocolFailure();
    }
    return this.#append(decoded, false);
  }

  finish(): SseFrame[] {
    let tail: string;
    try {
      tail = this.#decoder.decode();
    } catch {
      protocolFailure();
    }
    const frames = this.#append(tail, true);
    if (this.#lineBuffer.length > 0) {
      frames.push(...this.#consumeLine(this.#lineBuffer, false));
      this.#lineBuffer = '';
    }
    const final = this.#dispatch();
    if (final) frames.push(final);
    return frames;
  }

  #append(value: string, eof: boolean): SseFrame[] {
    this.#lineBuffer += value;
    const frames: SseFrame[] = [];
    let newlineIndex: number;
    while ((newlineIndex = this.#lineBuffer.indexOf('\n')) !== -1) {
      const rawLine = this.#lineBuffer.slice(0, newlineIndex);
      this.#lineBuffer = this.#lineBuffer.slice(newlineIndex + 1);
      frames.push(...this.#consumeLine(rawLine, true));
    }
    if (!eof && this.#eventBytes + byteLength(this.#lineBuffer) > this.#maxEventBytes) {
      protocolFailure();
    }
    return frames;
  }

  #consumeLine(rawLine: string, hadLf: boolean): SseFrame[] {
    const hadCr = rawLine.endsWith('\r');
    const line = hadCr ? rawLine.slice(0, -1) : rawLine;
    this.#eventBytes += byteLength(line) + (hadCr ? 1 : 0) + (hadLf ? 1 : 0);
    if (this.#eventBytes > this.#maxEventBytes) protocolFailure();
    if (line.length === 0) {
      const frame = this.#dispatch();
      return frame ? [frame] : [];
    }
    if (line.startsWith(':')) return [];
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let fieldValue = colon === -1 ? '' : line.slice(colon + 1);
    if (fieldValue.startsWith(' ')) fieldValue = fieldValue.slice(1);
    if (field === 'data') this.#dataLines.push(fieldValue);
    if (field === 'event') this.#eventName = fieldValue;
    return [];
  }

  #dispatch(): SseFrame | undefined {
    const dataLines = this.#dataLines;
    const eventName = this.#eventName;
    this.#dataLines = [];
    this.#eventName = undefined;
    this.#eventBytes = 0;
    if (dataLines.length === 0) return undefined;
    return {
      ...(eventName ? { eventName } : {}),
      data: dataLines.join('\n'),
    };
  }
}

interface HiddenSelectorItem {
  readonly itemId: string;
  readonly callId: string;
  readonly outputIndex: number;
  done: boolean;
}

type BufferedAction =
  | { readonly kind: 'event'; readonly event: Record<string, unknown>; readonly bytes: number }
  | { readonly kind: 'selector'; readonly itemId: string; readonly bytes: number };

interface TerminalEvent {
  readonly type: 'response.completed' | 'response.failed' | 'response.incomplete';
  readonly event: Record<string, unknown>;
  readonly response: Record<string, unknown>;
}

export interface NativeResponsesHostedImageSseOptions {
  readonly upstream: Response;
  readonly signal: AbortSignal;
  readonly maxEventBytes: number;
  readonly selection: NativeResponsesImageSelectionPreparation;
  readonly requestBody: Readonly<Record<string, unknown>>;
  readonly hasInheritedContext: boolean;
  readonly explicitCallCount: number;
  readonly validateSelection: (selection: ResponsesHostedToolSelection) => void;
  readonly openScope: () => Promise<ResponsesImageRequestScope>;
  readonly onScope: (scope: ResponsesImageRequestScope) => void;
  readonly onTerminalSuccess: (
    responseId: string,
    state: ResponsesAffinityHostedImageState,
  ) => void | Promise<void>;
  readonly onCancel: () => Promise<void>;
}

class HostedImageSsePipeline {
  readonly #options: NativeResponsesHostedImageSseOptions;
  readonly #decoder: BoundedSseFrameDecoder;
  readonly #hiddenItems = new Map<string, HiddenSelectorItem>();
  readonly #hiddenCallIds = new Set<string>();
  readonly #hiddenIndexes = new Set<number>();
  readonly #visibleFunctionItems = new Set<string>();
  readonly #bufferedActions: BufferedAction[] = [];
  #bufferedBytes = 0;
  #buffering = false;
  #sequenceNumber = -1;
  #terminal: TerminalEvent | undefined;
  #responseId: string | undefined;
  #responseModel: string | undefined;
  #responseCreatedAt: number | undefined;
  #reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  #activeImageIterator: AsyncIterator<ResponsesImageExecutionEvent> | undefined;
  #activeImageIteratorClose: Promise<void> | undefined;
  #cancelled = false;
  #cancelPromise: Promise<void> | undefined;
  #successEmitted = false;
  #failureEmitted = false;

  constructor(options: NativeResponsesHostedImageSseOptions) {
    this.#options = options;
    this.#decoder = new BoundedSseFrameDecoder(options.maxEventBytes);
  }

  async *run(): AsyncGenerator<Uint8Array, void, void> {
    const body = this.#options.upstream.body;
    const abort = (): void => { void this.cancel(this.#options.signal.reason); };
    this.#options.signal.addEventListener('abort', abort, { once: true });
    try {
      if (!body) protocolFailure();
      if (this.#options.signal.aborted) {
        await this.cancel(this.#options.signal.reason);
        return;
      }
      this.#reader = body.getReader();
      while (!this.#cancelled) {
        const next = await this.#reader.read();
        if (next.done) break;
        for (const frame of this.#decoder.push(next.value)) {
          const forwarded = this.#acceptFrame(frame);
          if (forwarded) yield this.#encodeForwarded(forwarded);
        }
      }
      if (this.#cancelled) return;
      for (const frame of this.#decoder.finish()) {
        const forwarded = this.#acceptFrame(frame);
        if (forwarded) yield this.#encodeForwarded(forwarded);
      }
      if (this.#cancelled) return;
      yield* this.#finishTerminal();
    } catch (error) {
      if (this.#cancelled || this.#options.signal.aborted || this.#successEmitted) return;
      if (!this.#failureEmitted) {
        this.#failureEmitted = true;
        yield this.#encode(this.#failureEvent(error));
      }
    } finally {
      this.#options.signal.removeEventListener('abort', abort);
      await this.#closeActiveImageIterator();
      if (this.#reader) {
        if (this.#cancelled) await this.#reader.cancel().catch(() => undefined);
        this.#reader.releaseLock();
      }
    }
  }

  cancel(reason?: unknown): Promise<void> {
    if (this.#cancelPromise) return this.#cancelPromise;
    this.#cancelled = true;
    this.#cancelPromise = Promise.allSettled([
      this.#reader?.cancel(reason) ?? Promise.resolve(),
      this.#closeActiveImageIterator(),
      this.#options.onCancel(),
    ]).then(() => undefined);
    return this.#cancelPromise;
  }

  #acceptFrame(frame: SseFrame): Record<string, unknown> | undefined {
    if (frame.data === '[DONE]') {
      if (!this.#terminal) protocolFailure();
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame.data) as unknown;
    } catch {
      protocolFailure();
    }
    if (!isRecord(parsed) || typeof parsed.type !== 'string' || parsed.type.length > 256) {
      protocolFailure();
    }
    if (frame.eventName && frame.eventName !== parsed.type) protocolFailure();
    if (
      parsed.sequence_number !== undefined &&
      (!Number.isSafeInteger(parsed.sequence_number) || (parsed.sequence_number as number) < 0)
    ) {
      protocolFailure();
    }
    if (this.#terminal) protocolFailure();

    const type = parsed.type;
    if (TERMINAL_TYPES.has(type)) {
      if (!isRecord(parsed.response)) protocolFailure();
      this.#captureResponseIdentity(parsed.response);
      this.#terminal = {
        type: type as TerminalEvent['type'],
        event: parsed,
        response: parsed.response,
      };
      return undefined;
    }

    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      return this.#acceptOutputItemEvent(parsed, type === 'response.output_item.done');
    }
    if (type.startsWith('response.function_call_arguments.')) {
      const itemId = parsed.item_id;
      if (typeof itemId !== 'string') protocolFailure();
      const hidden = this.#hiddenItems.get(itemId);
      if (hidden) {
        this.#validateHiddenIndex(parsed, hidden);
        return undefined;
      }
      if (!this.#visibleFunctionItems.has(itemId)) protocolFailure();
    }
    if (typeof parsed.item_id === 'string' && this.#hiddenItems.has(parsed.item_id)) {
      this.#validateHiddenIndex(parsed, this.#hiddenItems.get(parsed.item_id)!);
      return undefined;
    }
    if (typeof parsed.call_id === 'string' && this.#hiddenCallIds.has(parsed.call_id)) {
      return undefined;
    }
    if (
      Number.isSafeInteger(parsed.output_index) &&
      this.#hiddenIndexes.has(parsed.output_index as number)
    ) {
      return undefined;
    }

    const forwarded = this.#publicizeEvent(parsed);
    this.#captureResponseIdentity(isRecord(forwarded.response) ? forwarded.response : undefined);
    return this.#queueOrReturn(forwarded);
  }

  #acceptOutputItemEvent(
    event: Record<string, unknown>,
    done: boolean,
  ): Record<string, unknown> | undefined {
    if (!Number.isSafeInteger(event.output_index) || (event.output_index as number) < 0) {
      protocolFailure();
    }
    if (!isRecord(event.item)) protocolFailure();
    const item = event.item;
    const itemId = item.id;
    if (typeof itemId !== 'string' || !WIRE_ITEM_ID_PATTERN.test(itemId)) protocolFailure();
    const outputIndex = event.output_index as number;
    const selectorName = this.#options.selection.selectorName;
    const isSelector = selectorName !== undefined &&
      item.type === 'function_call' && item.name === selectorName;
    const knownHidden = this.#hiddenItems.get(itemId);
    if (isSelector || knownHidden) {
      if (
        !selectorName || item.type !== 'function_call' || item.name !== selectorName ||
        typeof item.call_id !== 'string' || !UPSTREAM_CALL_ID_PATTERN.test(item.call_id)
      ) {
        protocolFailure();
      }
      const callId = item.call_id as string;
      let hidden = knownHidden;
      if (!hidden) {
        if (done || this.#hiddenCallIds.has(callId) || this.#hiddenIndexes.has(outputIndex)) {
          protocolFailure();
        }
        hidden = { itemId, callId, outputIndex, done: false };
        this.#hiddenItems.set(itemId, hidden);
        this.#hiddenCallIds.add(callId);
        this.#hiddenIndexes.add(outputIndex);
        this.#buffering = true;
      } else if (hidden.callId !== callId || hidden.outputIndex !== outputIndex) {
        protocolFailure();
      }
      if (!hidden) protocolFailure();
      if (done) {
        if (hidden.done || item.status !== 'completed') protocolFailure();
        hidden.done = true;
        this.#pushBuffered({ kind: 'selector', itemId: hidden.itemId, bytes: byteLength(hidden.itemId) });
      } else if (hidden.done) {
        protocolFailure();
      }
      return undefined;
    }
    if (item.type === 'function_call') {
      if (typeof item.name !== 'string' || !item.name || item.name === selectorName) protocolFailure();
      this.#visibleFunctionItems.add(itemId);
    }
    return this.#queueOrReturn(this.#publicizeEvent(event));
  }

  #queueOrReturn(event: Record<string, unknown>): Record<string, unknown> | undefined {
    this.#assertNoPrivate(event);
    if (!this.#buffering) return event;
    const bytes = byteLength(JSON.stringify(event));
    this.#pushBuffered({ kind: 'event', event, bytes });
    return undefined;
  }

  #pushBuffered(action: BufferedAction): void {
    this.#bufferedBytes += action.bytes;
    if (this.#bufferedBytes > this.#options.maxEventBytes) protocolFailure();
    this.#bufferedActions.push(action);
  }

  #publicizeEvent(event: Record<string, unknown>): Record<string, unknown> {
    const copy: Record<string, unknown> = { ...event };
    if (isRecord(event.response)) copy.response = this.#publicizeResponse(event.response);
    return copy;
  }

  #publicizeResponse(response: Record<string, unknown>): Record<string, unknown> {
    const copy: Record<string, unknown> = { ...response };
    if (Object.prototype.hasOwnProperty.call(response, 'tools')) {
      copy.tools = copyPublicRequestValue(this.#options.requestBody.tools);
    }
    if (Object.prototype.hasOwnProperty.call(response, 'tool_choice')) {
      copy.tool_choice = copyPublicRequestValue(this.#options.requestBody.tool_choice);
    }
    return copy;
  }

  #captureResponseIdentity(response: Record<string, unknown> | undefined): void {
    if (!response) return;
    if (typeof response.id === 'string' && RESPONSE_ID_PATTERN.test(response.id)) {
      if (this.#responseId && this.#responseId !== response.id) protocolFailure();
      this.#responseId = response.id;
    }
    if (typeof response.model === 'string' && response.model.length <= 512) {
      this.#responseModel = response.model;
    }
    if (typeof response.created_at === 'number' && Number.isFinite(response.created_at)) {
      this.#responseCreatedAt = response.created_at;
    }
  }

  #validateHiddenIndex(event: Record<string, unknown>, hidden: HiddenSelectorItem): void {
    if (
      event.output_index !== undefined &&
      (!Number.isSafeInteger(event.output_index) || event.output_index !== hidden.outputIndex)
    ) {
      protocolFailure();
    }
  }

  async *#finishTerminal(): AsyncGenerator<Uint8Array, void, void> {
    const terminal = this.#terminal;
    if (!terminal) protocolFailure();
    if (terminal.type !== 'response.completed') {
      if (this.#hiddenItems.size > 0) protocolFailure();
      const publicTerminal = this.#publicizeEvent(terminal.event);
      this.#assertNoPrivate(publicTerminal);
      yield this.#encodeForwarded(publicTerminal);
      return;
    }
    yield* this.#finishCompleted(terminal);
  }

  async *#finishCompleted(terminal: TerminalEvent): AsyncGenerator<Uint8Array, void, void> {
    const response = terminal.response;
    if (
      response.status !== 'completed' ||
      typeof response.id !== 'string' || !RESPONSE_ID_PATTERN.test(response.id) ||
      !Array.isArray(response.output)
    ) {
      protocolFailure();
    }
    if (this.#responseId && this.#responseId !== response.id) protocolFailure();
    const parsed = this.#options.selection.parseOutput(response.output);
    if (parsed.imageCalls.length > MAX_SELECTED_IMAGE_CALLS) protocolFailure();
    this.#options.validateSelection(parsed.selection);
    this.#validateHiddenSelection(parsed);

    const requiresScope = parsed.imageCalls.length > 0 ||
      this.#options.hasInheritedContext || this.#options.explicitCallCount > 0;
    let scope: ResponsesImageRequestScope | undefined;
    if (requiresScope) {
      scope = await this.#options.openScope();
      this.#options.onScope(scope);
    }
    const publicOutput = [...response.output];
    const pendingReceipts: Array<{
      readonly upstreamCallId: string;
      readonly publicImageCallId: string;
    }> = [];
    const selectedByItemId = new Map(
      parsed.imageCalls.map((selected) => [
        (response.output as unknown[])[selected.itemIndex] &&
          isRecord((response.output as unknown[])[selected.itemIndex])
          ? ((response.output as Array<Record<string, unknown>>)[selected.itemIndex]!.id as string)
          : '',
        selected,
      ]),
    );
    const completedIds = new Set<string>();
    for (const action of this.#bufferedActions) {
      if (this.#cancelled) return;
      if (action.kind === 'event') {
        yield this.#encodeForwarded(action.event);
        continue;
      }
      const selected = selectedByItemId.get(action.itemId);
      if (!scope || !selected || completedIds.has(action.itemId)) protocolFailure();
      const item = yield* this.#executeSelected(scope, selected);
      publicOutput[selected.itemIndex] = item;
      completedIds.add(action.itemId);
      pendingReceipts.push(Object.freeze({
        upstreamCallId: selected.upstreamCallId,
        publicImageCallId: item.id,
      }));
    }
    if (completedIds.size !== parsed.imageCalls.length) protocolFailure();
    if (scope) {
      await scope.waitForIdle();
      await scope.commit(response.id);
    }

    const state: ResponsesAffinityHostedImageState = Object.freeze({
      hasImageContext: this.#options.hasInheritedContext ||
        this.#options.explicitCallCount > 0 || pendingReceipts.length > 0,
      pendingReceipts: Object.freeze(pendingReceipts),
    });
    await this.#options.onTerminalSuccess(response.id, state);
    if (this.#cancelled || this.#options.signal.aborted) return;

    const publicResponse = this.#publicizeResponse({ ...response, output: publicOutput });
    const terminalEvent: Record<string, unknown> = {
      type: 'response.completed',
      response: publicResponse,
    };
    this.#assertNoPrivate(terminalEvent, [
      ...parsed.internalItemIds,
      ...parsed.imageCalls.map((call) => call.upstreamCallId),
    ]);
    this.#successEmitted = true;
    yield this.#encodeForwarded(terminalEvent);
  }

  #validateHiddenSelection(parsed: NativeResponsesImageSelectionResult): void {
    if (parsed.imageCalls.length !== this.#hiddenItems.size) protocolFailure();
    const selectedIds = new Set(parsed.internalItemIds);
    if (selectedIds.size !== parsed.imageCalls.length) protocolFailure();
    for (const selected of parsed.imageCalls) {
      const item = (this.#terminal!.response.output as unknown[])[selected.itemIndex];
      if (!isRecord(item) || typeof item.id !== 'string') protocolFailure();
      const hidden = this.#hiddenItems.get(item.id);
      if (
        !hidden || !hidden.done || hidden.callId !== selected.upstreamCallId ||
        hidden.outputIndex !== selected.presentationIndex || !selectedIds.has(hidden.itemId)
      ) {
        protocolFailure();
      }
    }
    for (const hidden of this.#hiddenItems.values()) {
      if (!hidden.done || !selectedIds.has(hidden.itemId)) protocolFailure();
    }
  }

  async *#executeSelected(
    scope: ResponsesImageRequestScope,
    selected: NativeResponsesSelectedImageCall,
  ): AsyncGenerator<Uint8Array, ResponsesImageGenerationCallItem, void> {
    let outputReserved = false;
    let startedId: string | undefined;
    let completed: ResponsesImageGenerationCallItem | undefined;
    const events = scope.executeSelectedCall(selected.call, {
      reserveOutputIndex: () => {
        if (outputReserved) protocolFailure();
        outputReserved = true;
        return selected.presentationIndex;
      },
      nextSequenceNumber: () => this.#nextSequenceNumber(),
    });
    const iterator = events[Symbol.asyncIterator]();
    this.#activeImageIterator = iterator;
    this.#activeImageIteratorClose = undefined;
    try {
      while (!this.#cancelled) {
        const next = await iterator.next();
        if (next.done) break;
        const event = next.value;
        if (!isRecord(event as unknown)) protocolFailure();
        if ('type' in event) {
          if (!startedId || completed) protocolFailure();
          this.#validatePartial(event, selected.presentationIndex, startedId);
          yield this.#encode(event as unknown as Record<string, unknown>);
          continue;
        }
        if (event.kind === 'failed') throw imageGenerationErrorFromPublic(event.error);
        if (event.kind === 'started') {
          const item = event.item as unknown;
          if (
            startedId || completed || event.outputIndex !== selected.presentationIndex ||
            !isRecord(item) ||
            Object.keys(item).some((key) => key !== 'id' && key !== 'type' && key !== 'status') ||
            typeof item.id !== 'string' || !PUBLIC_IMAGE_CALL_ID_PATTERN.test(item.id) ||
            item.type !== 'image_generation_call' || item.status !== 'in_progress'
          ) {
            protocolFailure();
          }
          startedId = item.id;
          yield this.#encodeForwarded({
            type: 'response.output_item.added',
            output_index: selected.presentationIndex,
            item: { ...item },
          });
          continue;
        }
        if (event.kind === 'completed') {
          if (!startedId || completed) protocolFailure();
          completed = this.#validateCompleted(event, selected.presentationIndex, startedId);
          yield this.#encodeForwarded({
            type: 'response.image_generation_call.completed',
            output_index: selected.presentationIndex,
            item_id: completed.id,
          });
          yield this.#encodeForwarded({
            type: 'response.output_item.done',
            output_index: selected.presentationIndex,
            item: completed,
          });
          continue;
        }
        protocolFailure();
      }
    } finally {
      await this.#closeActiveImageIterator();
    }
    if (this.#cancelled) protocolFailure();
    if (!outputReserved || !completed) protocolFailure();
    return completed;
  }

  #validatePartial(
    event: ResponsesImagePartialEvent,
    outputIndex: number,
    startedId: string,
  ): void {
    if (
      event.type !== 'response.image_generation_call.partial_image' ||
      Object.keys(event).some((key) => !PARTIAL_KEYS.has(key)) ||
      event.output_index !== outputIndex || event.item_id !== startedId ||
      event.sequence_number !== this.#sequenceNumber ||
      !Number.isSafeInteger(event.partial_image_index) || event.partial_image_index < 0 ||
      typeof event.partial_image_b64 !== 'string' || !event.partial_image_b64
    ) {
      protocolFailure();
    }
  }

  #validateCompleted(
    record: ResponsesImageCompletedRecord,
    outputIndex: number,
    startedId: string,
  ): ResponsesImageGenerationCallItem {
    const item = record.item as unknown;
    if (
      record.outputIndex !== outputIndex || !isRecord(item) ||
      Object.keys(item).some((key) =>
        key !== 'id' && key !== 'type' && key !== 'status' &&
        key !== 'result' && key !== 'revised_prompt') ||
      item.id !== startedId || typeof item.id !== 'string' ||
      !PUBLIC_IMAGE_CALL_ID_PATTERN.test(item.id) ||
      item.type !== 'image_generation_call' || item.status !== 'completed' ||
      typeof item.result !== 'string' || !item.result ||
      (item.revised_prompt !== undefined && typeof item.revised_prompt !== 'string')
    ) {
      protocolFailure();
    }
    return Object.freeze({ ...item }) as unknown as ResponsesImageGenerationCallItem;
  }

  #encodeForwarded(event: Record<string, unknown>): Uint8Array {
    return this.#encode({ ...event, sequence_number: this.#nextSequenceNumber() });
  }

  #encode(event: Record<string, unknown>): Uint8Array {
    const type = typeof event.type === 'string' ? event.type : protocolFailure();
    return new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  #nextSequenceNumber(): number {
    this.#sequenceNumber += 1;
    return this.#sequenceNumber;
  }

  #assertNoPrivate(value: unknown, extra: readonly string[] = []): void {
    const serialized = JSON.stringify(value);
    if (this.#containsPrivate(serialized, extra)) protocolFailure();
  }

  #containsPrivate(value: string, extra: readonly string[] = []): boolean {
    const forbidden = [
      this.#options.selection.selectorName,
      ...this.#hiddenItems.keys(),
      ...this.#hiddenCallIds,
      ...extra,
    ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);
    return forbidden.some((candidate) => value.includes(candidate));
  }

  #failureEvent(error: unknown): Record<string, unknown> {
    const safe = normalizeImageGenerationError(error);
    const model = this.#responseModel && !this.#containsPrivate(this.#responseModel)
      ? this.#responseModel
      : undefined;
    const response: Record<string, unknown> = {
      ...(this.#responseId ? { id: this.#responseId } : {}),
      object: 'response',
      ...(this.#responseCreatedAt !== undefined ? { created_at: this.#responseCreatedAt } : {}),
      ...(model ? { model } : {}),
      status: 'failed',
      output: [],
      error: { code: safe.code, message: safe.message },
    };
    return {
      type: 'response.failed',
      sequence_number: this.#nextSequenceNumber(),
      response,
    };
  }

  #closeActiveImageIterator(): Promise<void> {
    if (this.#activeImageIteratorClose) return this.#activeImageIteratorClose;
    const iterator = this.#activeImageIterator;
    if (!iterator?.return) return Promise.resolve();
    this.#activeImageIteratorClose = Promise.resolve(iterator.return()).then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      if (this.#activeImageIterator === iterator) this.#activeImageIterator = undefined;
    });
    return this.#activeImageIteratorClose;
  }
}

function transformedResponse(upstream: Response, body: ReadableStream<Uint8Array>): Response {
  const headers = new Headers(upstream.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.delete('transfer-encoding');
  headers.set('content-type', 'text/event-stream; charset=utf-8');
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

export function createNativeResponsesHostedImageSseResponse(
  options: NativeResponsesHostedImageSseOptions,
): Response {
  const pipeline = new HostedImageSsePipeline(options);
  const iterator = pipeline.run()[Symbol.asyncIterator]();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await pipeline.cancel(reason);
      await iterator.return?.();
    },
  });
  return transformedResponse(options.upstream, body);
}
