/**
 * Shared helpers for the ProviderProxy ingress parsers.
 *
 * All ingress parsers (Anthropic Messages, OpenAI Responses, OpenAI Chat,
 * Gemini generateContent) read the full request body, share one stateless
 * `TransformerChainExecutor`, and relay an already-wire-shaped `Response` (JSON
 * or SSE) back to the http `res`. This module owns ONLY that common plumbing so
 * each parser stays under the size cap and the relay shape is identical across
 * ingresses (parity with the host's codex relay / stream manager). It also
 * vends the lazy-singleton endpoint transformers
 * (Responses, Gemini, Anthropic) the factory-less BYO paths reuse.
 *
 * @module provider-proxy/ingress/providerProxyShared
 */

import type http from 'node:http';

import type { LLMProvider } from '@omnicross/contracts/llm-config';

import { resolveApiFormat, resolveProviderEndpoint } from '../../completion';
import {
  boundAccountSelectionMessage,
  type BoundAccountSelectionError,
} from '../../pipeline/BoundAccountSelectionError';
import {
  isAnthropicProtocolResponse,
  writeAnthropicError,
} from './anthropicErrorEnvelope';
import { TransformerChainExecutor } from '../../transformer';
import { AnthropicTransformer } from '../../transformer/transformers/AnthropicTransformer';
import { GeminiTransformer } from '../../transformer/transformers/GeminiTransformer';
import { OpenAIResponseTransformer } from '../../transformer/transformers/OpenAIResponseTransformer';
import { OpenAITransformer } from '../../transformer/transformers/OpenAITransformer';
import type { Transformer } from '../../transformer/types';
import type { ProviderProxyDeps } from '../types';

// Singleton executor — stateless, reusable (same pattern as the host's
// request handlers).
let sharedExecutor: TransformerChainExecutor | null = null;
export function getSharedExecutor(): TransformerChainExecutor {
  if (!sharedExecutor) {
    sharedExecutor = new TransformerChainExecutor();
  }
  return sharedExecutor;
}

// Shared endpoint transformer instance (stateless). The Responses one decodes
// the OpenAI Responses wire AND (subscription codex) re-encodes Unified →
// Responses for the chatgpt upstream.
let sharedResponses: Transformer | null = null;
export function getResponsesEndpointTransformer(): Transformer {
  if (!sharedResponses) sharedResponses = new OpenAIResponseTransformer();
  return sharedResponses;
}

let sharedChat: Transformer | null = null;
export function getChatEndpointTransformer(): Transformer {
  if (!sharedChat) sharedChat = new OpenAITransformer();
  return sharedChat;
}

// Shared Anthropic endpoint transformer instance (stateless). As an endpoint
// transformer it decodes the Anthropic `/v1/messages` wire → Unified
// (`transformRequestOut`) on the request side AND re-encodes Unified → Anthropic
// wire (`transformResponseIn`, which auto-detects `text/event-stream` and pipes
// through `convertOpenAIStreamToAnthropic`) on the response side, so a BYO
// `/v1/messages` caller gets an Anthropic-shaped response regardless of the
// target provider's wire format. Used by the built-in factory-less Anthropic BYO
// path (`anthropicMessagesByo.ts`); the factory-PRESENT delegation branch keeps
// using the host handler's own `AnthropicTransformer` instance.
let sharedAnthropic: Transformer | null = null;
export function getAnthropicEndpointTransformer(): Transformer {
  if (!sharedAnthropic) sharedAnthropic = new AnthropicTransformer();
  return sharedAnthropic;
}

// Shared Gemini endpoint transformer instance (stateless). As an endpoint
// transformer it decodes the Gemini `generateContent` wire → Unified
// (`transformRequestOut`) on the request side AND re-encodes Unified → Gemini
// wire (`transformResponseIn`) on the response side, so the gemini-CLI gets a
// Gemini-shaped response regardless of the target provider's wire format.
let sharedGemini: Transformer | null = null;
export function getGeminiEndpointTransformer(): Transformer {
  if (!sharedGemini) sharedGemini = new GeminiTransformer();
  return sharedGemini;
}

/** Read the full request body from an IncomingMessage with deterministic listener cleanup. */
export function readBody(req: http.IncomingMessage, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const cleanup = (): void => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAborted);
      req.removeListener('close', onClose);
      signal?.removeEventListener('abort', onSignalAbort);
    };
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error !== undefined) reject(error);
      else resolve(Buffer.concat(chunks).toString('utf-8'));
    };
    const abortError = (): unknown =>
      signal?.reason instanceof Error
        ? signal.reason
        : new DOMException('The operation was aborted', 'AbortError');
    const onData = (chunk: Buffer | string): void => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    };
    const onEnd = (): void => finish();
    const onError = (error: Error): void => finish(error);
    const onAborted = (): void => finish(abortError());
    const onClose = (): void => {
      if (!req.complete) finish(abortError());
    };
    const onSignalAbort = (): void => finish(abortError());

    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
    req.once('close', onClose);
    signal?.addEventListener('abort', onSignalAbort, { once: true });
    if (signal?.aborted) onSignalAbort();
  });
}

/**
 * Rewrite the response `model` field in a non-stream JSON body (design D4).
 * Sets the top-level `model` (Anthropic message + the top-level Responses object)
 * AND a nested `response.model` (the Responses final-object shape) when present.
 * On any parse failure the original text is returned unchanged (never throws).
 */
function rewriteJsonModel(bodyText: string, rewriteModel: string): string {
  try {
    const obj = JSON.parse(bodyText) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object') return bodyText;
    let changed = false;
    if (typeof obj.model === 'string') {
      obj.model = rewriteModel;
      changed = true;
    }
    const nested = obj.response;
    if (nested && typeof nested === 'object' && typeof (nested as Record<string, unknown>).model === 'string') {
      (nested as Record<string, unknown>).model = rewriteModel;
      changed = true;
    }
    return changed ? JSON.stringify(obj) : bodyText;
  } catch {
    return bodyText;
  }
}

/**
 * Rewrite the response `model` in ONE SSE `data:` line when it carries a
 * model-bearing event (design D4):
 *  - Anthropic `message_start` → `data.message.model`
 *  - Responses `response.created` / `response.in_progress` / `response.completed`
 *    / `response.failed` / `response.incomplete` → `data.response.model`
 * Preserves the `data:` prefix, the optional single leading space, and the exact
 * trailing newline(s). Non-`data:` lines, `[DONE]`, and non-JSON payloads pass
 * through untouched. A cheap `"model"` substring gate keeps non-model events
 * zero-cost (no `JSON.parse`). Returns the (possibly rewritten) line — EVERY
 * model-bearing event is rewritten (the Responses stream carries the model in
 * `response.created` AND every terminal event — `completed`/`failed`/
 * `incomplete` — so a first-hit-only rewrite would leak the upstream name in a
 * later or truncated-stream terminal event).
 */
function rewriteSseLine(line: string, rewriteModel: string): string {
  // Cheap gates first: only `data:` lines that could carry a `model` are parsed.
  if (!line.startsWith('data:') || !line.includes('"model"')) return line;

  const nl = /\r?\n$/.exec(line);
  const newline = nl ? nl[0] : '';
  const withoutNl = newline ? line.slice(0, line.length - newline.length) : line;
  const afterData = withoutNl.slice('data:'.length);
  const leadingSpace = afterData.startsWith(' ') ? ' ' : '';
  const payload = afterData.slice(leadingSpace.length);
  if (payload === '' || payload === '[DONE]') return line;

  try {
    const obj = JSON.parse(payload) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object') return line;
    const type = typeof obj.type === 'string' ? obj.type : '';
    let changed = false;
    if (type === 'message_start') {
      const message = obj.message as Record<string, unknown> | undefined;
      if (message && typeof message === 'object' && typeof message.model === 'string') {
        message.model = rewriteModel;
        changed = true;
      }
    } else if (
      type === 'response.created' ||
      type === 'response.in_progress' ||
      type === 'response.completed' ||
      type === 'response.failed' ||
      type === 'response.incomplete'
    ) {
      const response = obj.response as Record<string, unknown> | undefined;
      if (response && typeof response === 'object' && typeof response.model === 'string') {
        response.model = rewriteModel;
        changed = true;
      }
    }
    if (!changed) return line;
    return `data:${leadingSpace}${JSON.stringify(obj)}${newline}`;
  } catch {
    return line;
  }
}

/**
 * A usage tap for {@link relayResponse}'s stream branch. Streaming responses were
 * previously not metered (only the non-stream branch recorded usage), so Codex
 * — which always streams — produced zero usage/dashboard rows. The tap lets each
 * ingress extract the RAW provider usage object from the SSE events it already
 * knows, and {@link onUsage} fires once at stream end so the recorder charges
 * exactly one event per request. Returning the raw object (not normalized)
 * keeps this tap endpoint-agnostic; each recorder normalizes its own shape.
 */
export interface StreamUsageTap {
  /**
   * Inspect one parsed SSE `data:` JSON event. Return the raw provider usage
   * object it carries (else null/undefined). The LAST non-null return across
   * the whole stream is what {@link onUsage} receives — so for endpoints whose
   * usage arrives piecewise (e.g. Anthropic `message_start`+`message_delta`),
   * merge inside this closure and return the combined value from the terminal
   * event.
   */
  extractUsage(event: Record<string, unknown>): Record<string, unknown> | null | undefined;
  /** Called once at stream end with the last captured usage (only if any). */
  onUsage(rawUsage: Record<string, unknown>): void;
}

/** Best-effort parse of one SSE `data:` line; invokes `onEvent` with the JSON. Never throws. */
function tapSseDataLine(line: string, onEvent: (event: Record<string, unknown>) => void): void {
  const leadingStripped = line.replace(/^\s+/, '');
  if (!leadingStripped.startsWith('data:')) return;
  const payload = leadingStripped.slice(5).trim();
  if (!payload || payload === '[DONE]') return;
  try {
    onEvent(JSON.parse(payload) as Record<string, unknown>);
  } catch {
    // non-JSON data line — ignore
  }
}

/**
 * Stream an SSE body to `res`, optionally rewriting the `model` in every
 * model-bearing event (design D4) AND/OR tapping each parsed `data:` event for
 * usage extraction. SSE events can straddle chunk boundaries, so bytes are
 * decoded through a single streaming `TextDecoder` (multi-byte-safe) and
 * assembled into whole lines before rewriting/tapping; the exact framing
 * (`event:` / `data:` / blank-line separators + newline style) is preserved.
 * A trailing final line WITHOUT a newline is flushed too (terminal-line gap).
 * The usage tap reads the ORIGINAL line (pre-rewrite) — model rewriting never
 * touches usage, so this avoids re-parsing the rewritten JSON. Best-effort: a
 * malformed event is skipped, never thrown. Non-model lines pass through via
 * the cheap gate in `rewriteSseLine` at zero parse cost when neither option
 * touches them.
 */
async function relaySseBody(
  res: http.ServerResponse,
  body: ReadableStream<Uint8Array>,
  options: {
    rewriteModel?: string;
    onSseEvent?: (event: Record<string, unknown>) => void;
    signal?: AbortSignal;
  },
): Promise<void> {
  const { rewriteModel, onSseEvent, signal } = options;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let cancelPromise: Promise<void> | undefined;
  const cancel = (): void => {
    cancelPromise ??= reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (signal?.aborted) break;
      buffer += decoder.decode(value, { stream: true });
      let out = '';
      let nlIndex: number;
      while ((nlIndex = buffer.indexOf('\n')) !== -1) {
        const linePart = buffer.slice(0, nlIndex + 1);
        buffer = buffer.slice(nlIndex + 1);
        if (onSseEvent) tapSseDataLine(linePart, onSseEvent);
        out += rewriteModel ? rewriteSseLine(linePart, rewriteModel) : linePart;
      }
      if (out && !res.destroyed && !res.writableEnded) res.write(out);
    }
    // Flush the trailing incomplete final line (no newline). `decoder.decode()`
    // with no args drains any held bytes — still rewriting/tapping a terminal event.
    const tail = signal?.aborted ? '' : buffer + decoder.decode();
    if (tail && !res.destroyed && !res.writableEnded) {
      if (onSseEvent) tapSseDataLine(tail, onSseEvent);
      res.write(rewriteModel ? rewriteSseLine(tail, rewriteModel) : tail);
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (cancelPromise) await cancelPromise;
    reader.releaseLock();
    if (!res.destroyed && !res.writableEnded) res.end();
  }
}

async function readResponseTextWithSignal(
  response: Response,
  signal?: AbortSignal,
): Promise<string> {
  if (!response.body || !signal) return response.text();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let cancelPromise: Promise<void> | undefined;
  const cancel = (): void => {
    cancelPromise ??= reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (signal.aborted) throw signal.reason;
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    signal.removeEventListener('abort', cancel);
    if (cancelPromise) await cancelPromise;
    reader.releaseLock();
  }
}

/**
 * Release an upstream `Response` this request will NEVER relay — the one
 * discarded by a 401-refresh retry, an ApiKeyPool rebind retry, or a fallback
 * advance.
 *
 * Dropping the reference is NOT enough: an unread body keeps its undici socket
 * (and the whole CONNECT tunnel through any egress proxy) checked out until the
 * GC finalizer eventually reclaims it, so a retry-heavy period accumulates
 * orphan connections against the proxy. Cancelling returns the socket
 * immediately. Awaited so the release is ordered BEFORE the replacement attempt
 * is issued; `cancel()` on an undici body is a local teardown and does no
 * network I/O. Best-effort by construction — an already-locked/consumed body
 * (e.g. one a health sniff read via `clone()`) and a cancel rejection are both
 * no-ops, and a cleanup failure must never break serving.
 */
export async function cancelDiscardedResponse(response: Response | undefined): Promise<void> {
  const body = response?.body;
  if (!body || body.locked) return;
  try {
    await body.cancel();
  } catch {
    /* best-effort release — never break serving on a cleanup failure */
  }
}

const SAFE_RESPONSE_HEADERS = new Set([
  'content-type',
  'retry-after',
  'x-request-id',
  'openai-request-id',
  'openai-processing-ms',
  'openai-version',
  'x-should-retry',
]);

/** Project only explicitly safe end-to-end upstream response metadata. */
export function projectUpstreamResponseHeaders(
  headers: Headers,
  upstreamIsSse: boolean,
): Record<string, string> {
  const projected: Record<string, string> = {};
  headers.forEach((value, rawName) => {
    const name = rawName.toLowerCase();
    if (
      SAFE_RESPONSE_HEADERS.has(name) ||
      name.startsWith('x-ratelimit-') ||
      (upstreamIsSse && name === 'cache-control')
    ) {
      const outputName = name === 'content-type'
        ? 'Content-Type'
        : name === 'retry-after'
          ? 'Retry-After'
          : name === 'cache-control'
            ? 'Cache-Control'
            : name;
      projected[outputName] = value;
    }
  });
  if (upstreamIsSse && projected['Cache-Control'] === undefined) {
    projected['Cache-Control'] = 'no-cache';
  }
  return projected;
}

/**
 * Confirm the compatibility case where Codex omits Content-Type on an SSE
 * response. The clone lets us inspect only the leading frame without consuming
 * the stream relayed to the client; explicit upstream content types never use
 * this heuristic.
 */
async function isHeaderlessSseResponse(
  response: Response,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!response.body) return false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = response.clone().body?.getReader();
    if (!reader) return false;
    const decoder = new TextDecoder();
    let prefix = '';
    while (prefix.length < 4096) {
      if (signal?.aborted) return false;
      const { done, value } = await reader.read();
      if (done) break;
      prefix += decoder.decode(value, { stream: true });
      const candidate = prefix.replace(/^\uFEFF/, '').trimStart();
      if (/^(?::|data:|event:|id:|retry:)/.test(candidate)) return true;
      if (/^[{[]/.test(candidate)) return false;
    }
    return /^(?::|data:|event:|id:|retry:)/.test(prefix.replace(/^\uFEFF/, '').trimStart());
  } catch {
    return false;
  } finally {
    void reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
  }
}

/**
 * Relay an already-wire-shaped `Response` to the http `res`.
 * - explicit `text/event-stream`, or a confirmed headerless SSE compatibility
 *   response: pipe the ReadableStream chunk-by-chunk.
 * - else: read the JSON text and write it once, returning it so the caller can
 *   tap usage. Mirrors the host's codex relay.
 *
 * `rewriteModel` (optional, design D4): when set, the response `model` is
 * rewritten to this id — top-level + nested `response.model` for non-stream JSON,
 * and EVERY model-bearing SSE event for streams — so a kind-mapped outbound
 * caller (Claude Code / Codex) sees its ORIGINAL requested id, not the upstream
 * provider name. When UNSET the relay is byte-identical to before (the resident
 * proxy + `chat`/`gemini` ingresses never pass it → zero regression). The RETURN
 * value stays the UPSTREAM body text (the usage tap must account on the real
 * upstream model), even though the client receives the rewritten body.
 *
 * @returns the (upstream) JSON body text for non-stream responses, else `null`.
 */
export async function relayResponse(
  res: http.ServerResponse,
  providerResponse: Response,
  isStream: boolean,
  rewriteModel?: string,
  usageTap?: StreamUsageTap,
  /**
   * Read-only observer invoked with every parsed SSE `data:` event during a
   * streaming relay. Never affects the relayed bytes (it runs on the ORIGINAL
   * line, independent of the model-rewrite / usage-tap paths). Used to detect
   * in-band errors that arrive AFTER a `200` — e.g. a Codex `response.failed`
   * server-overload event. When present, forces the line-based relay path so
   * events are parsed even without a `rewriteModel`/`usageTap`.
   */
  onSseEvent?: (event: Record<string, unknown>) => void,
  signal?: AbortSignal,
): Promise<string | null> {
  const contentType = providerResponse.headers.get('Content-Type') ?? '';
  const status =
    providerResponse.status && providerResponse.status >= 100 ? providerResponse.status : 200;
  const explicitContentType = contentType.trim().length > 0;
  const upstreamIsSse = contentType.includes('text/event-stream');
  const headerlessIsSse = !explicitContentType && isStream
    ? await isHeaderlessSseResponse(providerResponse, signal)
    : false;
  const relayAsSse = upstreamIsSse || headerlessIsSse;

  // A FAILED response is never a stream, even when the client asked for one:
  // stamping `text/event-stream` onto a JSON error body makes an SSE client read
  // ZERO events and report a truncated stream ("stream closed before
  // response.completed") instead of the actual error — which is how a plain
  // upstream 400 used to reach codex. Errors relay as their real body with their
  // real status; a genuine SSE body still takes the stream branch at any status.
  if (relayAsSse) {
    const responseHeaders = projectUpstreamResponseHeaders(providerResponse.headers, true);
    responseHeaders['Content-Type'] = upstreamIsSse && contentType
      ? contentType
      : 'text/event-stream';
    res.writeHead(status, responseHeaders);
    if (!providerResponse.body) {
      res.end();
      return null;
    }
    if (rewriteModel || usageTap || onSseEvent) {
      // Line-based relay so we can rewrite model AND/OR tap usage / observe
      // events from SSE. The tap captures the LAST non-null usage the extractor
      // returns; onUsage fires once at stream end (only if usage was seen).
      let capturedUsage: Record<string, unknown> | null = null;
      await relaySseBody(res, providerResponse.body, {
        rewriteModel,
        signal,
        onSseEvent:
          onSseEvent || usageTap
            ? (event) => {
                // Observer first (read-only side channel), then usage extraction.
                onSseEvent?.(event);
                if (usageTap) {
                  const raw = usageTap.extractUsage(event);
                  if (raw) capturedUsage = raw;
                }
              }
            : undefined,
      });
      if (capturedUsage) usageTap!.onUsage(capturedUsage);
      return null;
    }
    // No rewrite and no tap: raw byte pipe (byte-identical to pre-tap behavior).
    const reader = providerResponse.body.getReader();
    let cancelPromise: Promise<void> | undefined;
    const cancel = (): void => {
      cancelPromise ??= reader.cancel(signal?.reason).catch(() => undefined);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (signal?.aborted) break;
        if (!res.destroyed && !res.writableEnded) res.write(value);
      }
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (cancelPromise) await cancelPromise;
      reader.releaseLock();
      if (!res.destroyed && !res.writableEnded) res.end();
    }
    return null;
  }

  const bodyText = await readResponseTextWithSignal(providerResponse, signal);
  const clientText = rewriteModel ? rewriteJsonModel(bodyText, rewriteModel) : bodyText;
  const responseHeaders = projectUpstreamResponseHeaders(providerResponse.headers, false);
  responseHeaders['Content-Type'] = contentType || 'application/json';
  res.writeHead(status, responseHeaders);
  res.end(clientText);
  return bodyText;
}

/** Buffered SSE frames still obey the multi-line data-field framing rules. */
function* bufferedSseEvents(text: string): Generator<Record<string, unknown>> {
  let data: string[] = [];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.at(-1) !== '') lines.push('');
  for (const line of lines) {
    if (line.startsWith('data:')) {
      data.push(line.slice(5).replace(/^ /, ''));
    } else if (line === '' && data.length) {
      const payload = data.join('\n');
      data = [];
      if (payload === '[DONE]') continue;
      const event: unknown = JSON.parse(payload);
      if (!event || typeof event !== 'object' || Array.isArray(event)) {
        throw new Error('Invalid upstream SSE event');
      }
      yield event as Record<string, unknown>;
    }
  }
}

function rejectStreamError(event: Record<string, unknown>): void {
  if (event.error !== undefined || event.type === 'error') {
    throw new Error(`Upstream stream failed: ${JSON.stringify(event.error ?? event)}`);
  }
}

function wireRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Opaque provider items are ordered snapshots, not last-wins scalar deltas. */
function mergeWireExtra(previousValue: unknown, nextValue: unknown): Record<string, unknown> | undefined {
  const previous = wireRecord(previousValue);
  const next = wireRecord(nextValue);
  if (!next) return previous;
  const merged = { ...previous, ...next };
  for (const [namespace, field] of [['google', 'parts'], ['responses', 'reasoning']] as const) {
    const before = wireRecord(previous?.[namespace]);
    const after = wireRecord(next[namespace]);
    if (!after) continue;
    const priorItems = before?.[field];
    const nextItems = after[field];
    merged[namespace] = {
      ...before, ...after,
      ...(Array.isArray(nextItems) ? {
        [field]: [...(Array.isArray(priorItems) ? priorItems : []), ...nextItems],
      } : {}),
    };
  }
  return merged;
}

/**
 * Collapse Anthropic SSE without losing opaque blocks or initial block data.
 * Failed or truncated streams must not become successful buffered messages.
 */
export async function aggregateAnthropicSseToJsonBody(
  response: Response,
  rewriteModel?: string,
  signal?: AbortSignal,
): Promise<string> {
  const text = await readResponseTextWithSignal(response, signal);
  const message: Record<string, unknown> = {
    type: 'message', role: 'assistant', content: [], stop_reason: null,
    stop_sequence: null, usage: {},
  };
  const blocks = new Map<number, { block: Record<string, unknown>; inputJson: string }>();
  let completed = false;
  let pendingExtra: Record<string, unknown> | undefined;
  for (const ev of bufferedSseEvents(text)) {
    rejectStreamError(ev);
    switch (ev.type) {
      case 'message_start': {
        const initial = ev.message as Record<string, unknown> | undefined;
        if (initial) {
          Object.assign(message, initial);
          if (Array.isArray(initial.content)) {
            initial.content.forEach((block, index) => {
              blocks.set(index, { block: { ...block }, inputJson: '' });
            });
          }
        }
        break;
      }
      case 'content_block_start': {
        const block = { ...wireRecord(ev.content_block) };
        if (pendingExtra) {
          block.extra_content = mergeWireExtra(pendingExtra, block.extra_content);
          pendingExtra = undefined;
        }
        blocks.set(Number(ev.index), { block, inputJson: '' });
        break;
      }
      case 'content_block_delta': {
        const slot = blocks.get(Number(ev.index));
        if (!slot) throw new Error('Upstream content delta has no block');
        const delta = ev.delta as Record<string, unknown>;
        const field = delta.type === 'text_delta' ? 'text'
          : delta.type === 'thinking_delta' ? 'thinking'
            : delta.type === 'signature_delta' ? 'signature' : undefined;
        if (field && typeof delta[field] === 'string') {
          slot.block[field] = String(slot.block[field] ?? '') + delta[field];
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          slot.inputJson += delta.partial_json;
        } else if (delta.type === 'citations_delta' && delta.citation) {
          const citations = Array.isArray(slot.block.citations) ? slot.block.citations : [];
          citations.push(delta.citation);
          slot.block.citations = citations;
        }
        break;
      }
      case 'message_delta':
        Object.assign(message, ev.delta);
        if (ev.usage) message.usage = { ...(message.usage as object), ...(ev.usage as object) };
        break;
      case 'message_stop':
        completed = true;
        break;
    }
    if (wireRecord(ev.extra_content)) {
      const slot = typeof ev.index === 'number' ? blocks.get(ev.index) : undefined;
      if (slot) slot.block.extra_content = mergeWireExtra(slot.block.extra_content, ev.extra_content);
      else pendingExtra = mergeWireExtra(pendingExtra, ev.extra_content);
    }
  }
  if (!completed) throw new Error('Upstream Anthropic stream ended before message_stop');
  const orderedBlocks = [...blocks.entries()].sort(([a], [b]) => a - b);
  if (pendingExtra) {
    const last = orderedBlocks.at(-1)?.[1].block;
    if (last) last.extra_content = mergeWireExtra(last.extra_content, pendingExtra);
    else message.extra_content = pendingExtra;
  }
  message.content = orderedBlocks.map(([, slot]) => {
    if (slot.inputJson) slot.block.input = JSON.parse(slot.inputJson);
    return slot.block;
  });
  if (rewriteModel) message.model = rewriteModel;
  return JSON.stringify(message);
}

/**
 * Collapse an OpenAI Responses SSE stream into the single `response` JSON a
 * NON-streaming client expects. The Responses wire carries the complete final
 * response object on its terminal event, so aggregation = keep the LAST
 * `response.completed` / `response.failed` / `response.incomplete` payload
 * (`response.failed`/`incomplete` surface the upstream's own error state —
 * relayed verbatim, not rewritten into an error envelope). `rewriteModel`
 * overrides `model` to mirror `relayResponse`'s non-stream branch.
 *
 * Serves stream-only backends without losing failed/incomplete terminal state.
 * No terminal event found → null (the caller surfaces its own 502).
 */
export async function aggregateResponsesSseToJsonBody(
  response: Response,
  rewriteModel?: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const text = await readResponseTextWithSignal(response, signal);
  let terminal: Record<string, unknown> | null = null;
  for (const ev of bufferedSseEvents(text)) {
    rejectStreamError(ev);
    if (
      ev.type === 'response.completed' ||
      ev.type === 'response.failed' ||
      ev.type === 'response.incomplete'
    ) {
      const resp = ev.response;
      if (resp && typeof resp === 'object') terminal = resp as Record<string, unknown>;
    }
  }
  if (!terminal) return null;
  if (rewriteModel && typeof terminal['model'] === 'string') terminal['model'] = rewriteModel;
  return JSON.stringify(terminal);
}

/**
 * Collapse Chat SSE by choice and tool index. A missing finish reason is a
 * truncated response, not an implicit successful stop.
 */
export async function aggregateOpenAIChatChunksToJsonBody(
  response: Response,
  rewriteModel?: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const text = await readResponseTextWithSignal(response, signal);
  const completion: Record<string, unknown> = { object: 'chat.completion' };
  const choices = new Map<number, {
    message: Record<string, unknown>;
    finishReason: string | null;
    tools: Map<number, Record<string, unknown>>;
    thinkingBlocks: Map<number, Record<string, unknown>>;
  }>();
  for (const ev of bufferedSseEvents(text)) {
    rejectStreamError(ev);
    for (const key of ['id', 'created', 'model', 'system_fingerprint', 'service_tier']) {
      if (ev[key] !== undefined && completion[key] === undefined) completion[key] = ev[key];
    }
    if (ev.usage) completion.usage = ev.usage;
    if (!Array.isArray(ev.choices)) continue;
    for (const choice of ev.choices as Array<Record<string, unknown>>) {
      const index = typeof choice.index === 'number' ? choice.index : 0;
      let slot = choices.get(index);
      if (!slot) {
        slot = {
          message: { role: 'assistant', content: null }, finishReason: null,
          tools: new Map(), thinkingBlocks: new Map(),
        };
        choices.set(index, slot);
      }
      if (typeof choice.finish_reason === 'string') slot.finishReason = choice.finish_reason;
      const delta = choice.delta as Record<string, unknown> | undefined;
      if (!delta) continue;
      for (const field of ['content', 'refusal', 'reasoning_content']) {
        if (typeof delta[field] === 'string') {
          slot.message[field] = String(slot.message[field] ?? '') + delta[field];
        }
      }
      if (delta.reasoning_content === undefined && delta.thinking) {
        const thinking = typeof delta.thinking === 'string' ? delta.thinking
          : (delta.thinking as Record<string, unknown>).content;
        if (typeof thinking === 'string') {
          slot.message.reasoning_content = String(slot.message.reasoning_content ?? '') + thinking;
        }
      }
      const nextExtra = wireRecord(delta.extra_content);
      if (nextExtra) slot.message.extra_content = mergeWireExtra(slot.message.extra_content, nextExtra);
      const thinking = wireRecord(wireRecord(nextExtra?.omnicross)?.thinking) ?? wireRecord(delta.thinking);
      if (thinking) {
        if (Array.isArray(thinking.blocks)) {
          slot.thinkingBlocks.clear();
          thinking.blocks.forEach((value, blockIndex) => {
            const block = wireRecord(value);
            if (block) slot.thinkingBlocks.set(blockIndex, { ...block });
          });
        } else {
          const blockIndex = typeof thinking.index === 'number' ? thinking.index : 0;
          const block = slot.thinkingBlocks.get(blockIndex) ?? { type: 'thinking', thinking: '' };
          if (thinking.type === 'redacted_thinking') {
            slot.thinkingBlocks.set(blockIndex, { type: 'redacted_thinking', data: thinking.data });
          } else {
            if (typeof thinking.content === 'string') block.thinking = String(block.thinking ?? '') + thinking.content;
            if (typeof thinking.signature === 'string') block.signature = String(block.signature ?? '') + thinking.signature;
            slot.thinkingBlocks.set(blockIndex, block);
          }
        }
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tool of delta.tool_calls as Array<Record<string, unknown>>) {
          const index = typeof tool.index === 'number' ? tool.index : 0;
          const previous = slot.tools.get(index) ?? { type: 'function', function: { name: '', arguments: '' } };
          const fn = (tool.function ?? {}) as Record<string, unknown>;
          const previousFn = previous.function as Record<string, unknown>;
          const { index: _index, ...fields } = tool;
          slot.tools.set(index, {
            ...previous, ...fields,
            ...(tool.extra_content ? {
              extra_content: mergeWireExtra(previous.extra_content, tool.extra_content),
            } : {}),
            function: {
              ...previousFn, ...fn,
              name: typeof fn.name === 'string' ? String(previousFn.name ?? '') + fn.name : previousFn.name,
              arguments: String(previousFn.arguments ?? '') + (typeof fn.arguments === 'string' ? fn.arguments : ''),
            },
          });
        }
      }
    }
  }
  if (choices.size === 0 || [...choices.values()].some((choice) => !choice.finishReason)) return null;
  completion.choices = [...choices.entries()].sort(([a], [b]) => a - b).map(([index, slot]) => {
    if (slot.thinkingBlocks.size) {
      const extra = wireRecord(slot.message.extra_content);
      slot.message.extra_content = {
        ...extra,
        omnicross: {
          ...wireRecord(extra?.omnicross),
          thinking: {
            content: typeof slot.message.reasoning_content === 'string' ? slot.message.reasoning_content : '',
            blocks: [...slot.thinkingBlocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block),
          },
        },
      };
    }
    if (slot.tools.size) {
      slot.message.tool_calls = [...slot.tools.entries()].sort(([a], [b]) => a - b).map(([, tool]) => tool);
    }
    return { index, message: slot.message, finish_reason: slot.finishReason };
  });
  if (rewriteModel) completion.model = rewriteModel;
  return JSON.stringify(completion);
}

/** Aggregate a converted Gemini stream for a non-streaming generateContent caller. */
export async function aggregateGeminiSseToJsonBody(
  response: Response,
  signal?: AbortSignal,
): Promise<string | null> {
  const text = await readResponseTextWithSignal(response, signal);
  const result: Record<string, unknown> = {};
  const candidates = new Map<number, Record<string, unknown>>();
  for (const event of bufferedSseEvents(text)) {
    rejectStreamError(event);
    for (const key of ['responseId', 'modelVersion', 'usageMetadata', 'promptFeedback']) {
      if (event[key] !== undefined) result[key] = event[key];
    }
    if (!Array.isArray(event.candidates)) continue;
    for (const candidate of event.candidates as Array<Record<string, unknown>>) {
      const index = typeof candidate.index === 'number' ? candidate.index : 0;
      const previous = candidates.get(index);
      const priorContent = previous?.content as { parts?: unknown[] } | undefined;
      const content = candidate.content as { role?: string; parts?: unknown[] } | undefined;
      candidates.set(index, {
        ...previous, ...candidate,
        ...(content ? { content: {
          role: content.role ?? 'model',
          parts: [...(priorContent?.parts ?? []), ...(content.parts ?? [])],
        } } : {}),
      });
    }
  }
  if (!candidates.size) return result.promptFeedback ? JSON.stringify(result) : null;
  if ([...candidates.values()].some((candidate) => !candidate.finishReason)) return null;
  result.candidates = [...candidates.entries()].sort(([a], [b]) => a - b).map(([, candidate]) => candidate);
  return JSON.stringify(result);
}

/**
 * Whether a response body is an SSE stream. The header check is the cheap
 * first pass; ChatGPT's codex backend OMITS Content-Type on its SSE streams
 * (see OpenAIResponseTransformer's twin sniff), so a header-less body is
 * decided by peeking the first chunk for an `event:`/`data:` frame start.
 * The peek clones — the original body is left unread for the consumer.
 */
export async function sniffIsSseResponse(response: Response): Promise<boolean> {
  const contentType = response.headers.get('Content-Type') ?? '';
  if (contentType.includes('text/event-stream')) return true;
  if (!response.body) return false;
  const peek = response.clone();
  try {
    const reader = peek.body!.getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    const head = value ? new TextDecoder().decode(value).trimStart() : '';
    return head.startsWith('event:') || head.startsWith('data:');
  } catch {
    return false;
  }
}

/**
 * Write a JSON error response if the headers have not been sent.
 *
 * On an Anthropic-protocol request (res marked at the pipeline entry — see
 * `anthropicErrorEnvelope`) the body takes the Anthropic error shape so
 * Anthropic SDK clients can type-parse it; every other path keeps the legacy
 * `provider_proxy_error` envelope byte-for-byte.
 */
export function writeError(res: http.ServerResponse, status: number, message: string): void {
  if (isAnthropicProtocolResponse(res)) {
    writeAnthropicError(res, status, message);
    return;
  }
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { type: 'provider_proxy_error', message } }));
}

/**
 * Map a strict bound-account failure to a stable structured response. The body
 * carries only the fixed code/reason/message; account ids, tokens, and upstream
 * error text never cross the wire. On a marked Anthropic-protocol response the
 * stable `code`/`reason` fields fold INTO the Anthropic `error` object and the
 * `Retry-After` header is preserved.
 */
export function writeBoundAccountError(
  res: http.ServerResponse,
  error: BoundAccountSelectionError,
): void {
  if (res.headersSent) return;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (error.status === 429 && error.resumeAt) {
    const resumeMs = Date.parse(error.resumeAt);
    if (Number.isFinite(resumeMs)) {
      headers['Retry-After'] = String(Math.max(1, Math.ceil((resumeMs - Date.now()) / 1000)));
    }
  }
  if (isAnthropicProtocolResponse(res)) {
    // `writeAnthropicError` sets its own Content-Type; keep only Retry-After.
    const { 'Content-Type': _ct, ...anthropicHeaders } = headers;
    writeAnthropicError(res, error.status, boundAccountSelectionMessage(error.reason), anthropicHeaders, {
      code: error.code,
      reason: error.reason,
    });
    return;
  }
  res.writeHead(error.status, headers);
  res.end(
    JSON.stringify({
      error: {
        type: 'provider_proxy_error',
        code: error.code,
        reason: error.reason,
        message: boundAccountSelectionMessage(error.reason),
      },
    }),
  );
}

/** Resolve an `$ENV_VAR` reference or return the literal key. */
function resolveApiKey(apiKey: string | undefined): string {
  if (!apiKey) return '';
  if (apiKey.startsWith('$')) {
    return process.env[apiKey.slice(1)] || '';
  }
  return apiKey;
}

/**
 * Resolve the FIRST-CHOICE BYO request key for a `buildByoPlan`, threading the
 * ApiKeyPool through TWO gates so 429/529/401/403 failover actually fires on the
 * outbound serving path (omnicross-daemon-parity-poolseam, design D2(b)).
 *
 * Matches the host engine adapter's `resolveApiKeyForProvider` contract so pool
 * failover remains inside the provider layer:
 *   - pool present AND a (synthesized outbound) sessionId present →
 *     `getKeyForSession(providerId, sessionId)`. This SEEDS `sessionBindings`
 *     with the chosen key AND returns that same key, so it becomes the first
 *     request's key. WHY both gates matter: `LlmConfigProviderAuth.onResult`
 *     short-circuits on a null sessionId (gate 1); even with a sessionId,
 *     `ApiKeyPoolService.reportError` short-circuits when there is no binding for
 *     that session (gate 2) — and the binding only exists once `getKeyForSession`
 *     has run. The first request MUST use the bound key (not the row's `apiKey`)
 *     so the key the pool cools/rebinds on error === the key actually used.
 *   - otherwise (pool null, no sessionId, or the pool returns empty) → fall back
 *     to `resolveProviderEndpoint(provider).apiKey` with the same `$ENV`
 *     resolution the ingresses' own `resolveApiKey` used → BYTE-IDENTICAL to the
 *     pre-seam path. (Single-key pools also short-circuit inside
 *     `getKeyForSession` → `selectWeightedRoundRobin`'s `length===1`, returning
 *     the one key, so the wire key is unchanged there too.)
 *
 * `$ENV` semantics MUST match the ingresses' original `resolveApiKey`
 * (`$VAR → process.env[VAR] ?? ''`, else literal). The pool returns an
 * already-`resolveKey`-resolved string (its loader passes the host resolver),
 * so the pool branch needs no further `$ENV` expansion.
 */
export async function resolvePoolBoundKey(
  deps: ProviderProxyDeps,
  providerId: string,
  provider: LLMProvider,
  sessionId: string | null,
  preferredKeyId?: string,
  boundKeyFallbackPolicy?: 'strict' | 'pool',
): Promise<string> {
  if (preferredKeyId) {
    const preferred = await deps.apiKeyPool?.getKeyById(providerId, preferredKeyId, sessionId);
    if (preferred) return preferred;
    if (boundKeyFallbackPolicy !== 'pool') return '';
  }
  if (deps.apiKeyPool && sessionId) {
    const poolKey = await deps.apiKeyPool.getKeyForSession(providerId, sessionId);
    if (poolKey) return poolKey;
  }
  return resolveApiKey(resolveProviderEndpoint(provider).apiKey);
}

/**
 * BYO route-activity metadata for one plan — everything the fetch seam needs to
 * record a `provider-key` row, resolved LIVE at fetch time so an ApiKeyPool
 * rebind retry (the rotated-key `runOnce(newKey)` re-run) attributes the SECOND
 * attempt to the NEW key.
 *
 * `providerId` is the provider ROW id (the display identity an operator
 * recognizes) — never the egress proxy key `'byo'`. `resolveKeyId` reads the
 * pool's CURRENT session binding (the same map `resolvePoolBoundKey` seeds and
 * `reportError` rotates), so it is exactly the key this attempt sends whenever
 * the pool is bound; `undefined` for non-pool BYO (static row key) — the store
 * then records the row without a key id and affinity treats it as one identity.
 */
export interface ByoRouteActivityMeta {
  readonly providerId: string;
  readonly resolveKeyId: () => string | undefined;
}

export function buildByoRouteActivityMeta(
  deps: ProviderProxyDeps,
  providerId: string,
  sessionId: string | null | undefined,
): ByoRouteActivityMeta {
  return {
    providerId,
    resolveKeyId: () => {
      if (!sessionId) return undefined;
      const pool = deps.apiKeyPool;
      if (!pool || typeof pool.getKeyIdForSession !== 'function') return undefined;
      try {
        return pool.getKeyIdForSession(providerId, sessionId) ?? undefined;
      } catch {
        return undefined;
      }
    },
  };
}

// ── Multi-format fan-out (dual/tri-wire providers, one key) ──────────────────

/** The routable chat wires an ingress may request a variant view for. */
export type FanOutWire = 'openai' | 'anthropic' | 'openai-response';

/**
 * The provider view for ONE request wire: when the row declares a
 * `formatVariants` base for the wire AND the row's primary format differs, the
 * view swaps to that wire (base URL + format) so the ingress takes its
 * VERBATIM relay path — same key, same id, same routing, no transcoding. No
 * variant (or the variant IS the primary) returns the row unchanged, so wires
 * without fan-out behave byte-identically.
 */
/**
 * True when a model id belongs to the Claude family — the family a provider's
 * `formatVariants.anthropic` wire serves (preset contract: "Claude models ride
 * the Anthropic variant automatically"). Mirrors the admin test-model probe's
 * predicate so the connectivity test and the serving path agree.
 */
export function isClaudeFamilyModelId(modelId: string): boolean {
  return /^(?:anthropic[/.]|claude[-_.])/i.test(modelId);
}

export function providerForWire(provider: LLMProvider, wire: FanOutWire): LLMProvider {
  const variant = provider.formatVariants?.[wire];
  if (!variant) return provider;
  // The primary wire already serves natively — the variant entry (if any)
  // would just restate the primary base; keep the row untouched. Compare the
  // RESOLVED format so legacy rows (deprecated apiType fallback) are honored.
  if (resolveApiFormat(provider) === wire) return provider;
  return {
    ...provider,
    apiFormat: wire,
    api_base_url: variant,
    // Clear the deprecated format axes so resolveApiFormat can only see the
    // swapped primary — no legacy fallback may resurrect the stored format.
    chatApiFormat: undefined,
    apiType: undefined,
  };
}
