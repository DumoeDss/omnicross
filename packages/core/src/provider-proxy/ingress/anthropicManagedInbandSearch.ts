/**
 * The Anthropic Messages MANAGED IN-BAND search lane.
 *
 * ## The gap this lane closes
 *
 * The search-only lane (`anthropicManagedSearch`) answers a request whose every
 * tool is a `web_search_*` server tool — the sub-request shape the Elftia
 * reference intercepted (wire baseline A7). Claude Code does not send that
 * shape: its `WebSearch` is an in-band server tool DECLARED alongside the whole
 * client tool array, executed by whichever upstream speaks Anthropic. With
 * `search.modes.anthropic = "managed"`, such a request used to fall through the
 * search-only predicate and relay untouched, so the search ran on the upstream's
 * own engine (or, on an upstream without one, never at all). This lane is the
 * second half: it takes a request that merely DECLARES a search tool and runs
 * the searches on Omnicross's shared `SearchRuntime` instead.
 *
 * ## The mechanism — a selector function tool plus a stream splice
 *
 * Same idea as the Responses hosted-search mediator: the hosted declaration the
 * upstream would execute itself is swapped for an ordinary function tool (the
 * "selector"). The model calls the selector like any client tool; the lane
 * reads the query, runs the search, and reports the results back.
 *
 * Where the Responses mediator stops at ONE upstream turn and defers the prose
 * to the client's next request, this lane CANNOT: a Claude Code turn that ends
 * on `end_turn` with only search blocks is rendered as-is — the harness does
 * not re-prompt itself. So the lane runs the full loop:
 *
 *   upstream turn (streamed) ── selector call ──▶ SearchRuntime ──▶
 *   follow-up upstream turn with the results appended ──▶ … ──▶ final turn
 *
 * All upstream turns stay STREAMED, and no live stream is ever cut: a turn that
 * calls a client tool ends by itself with `stop_reason: "tool_use"`, which is
 * exactly the lane's cue to search and re-call. The client sees ONE message:
 * `server_tool_use` + `web_search_tool_result` blocks spliced in native order,
 * then the final turn's blocks reindexed on top.
 *
 * ## Verified vs. ours
 *
 * VERIFIED, from the same four captures as the search-only lane (§3.3): the
 * client-facing block order `server_tool_use` → `input_json_delta` →
 * `content_block_stop` → `web_search_tool_result` `content_block_start`, and
 * the result item field set (`url`, `title`, `encrypted_content`, `page_age`).
 * UNVERIFIED, ours, documented as such: the multi-turn splice (one
 * `message_start`, reindexed continuation, merged usage). No Anthropic capture
 * has ever shown a gateway doing this; it is field-compatible, not
 * byte-equivalent.
 *
 * ## Standing down
 *
 * Subscription-auth routes and factory-delegated hosts keep their existing
 * behavior (the delegated handler owns its own interception; this module is
 * wired into the BYO path only). `native` mode never reaches here, and `off`
 * has already been answered by the ingress. An upstream failure on the FIRST
 * turn is relayed verbatim; after the client stream has started, a follow-up
 * failure surfaces as an in-band SSE `error` event — the only honest frame for
 * a stream already begun.
 *
 * @module provider-proxy/ingress/anthropicManagedInbandSearch
 */

import type http from 'node:http';
import { randomUUID } from 'node:crypto';

import type { SearchResult } from '@omnicross/contracts/search-types';
import { toSearchErrorShape } from '@omnicross/contracts/search-types';

import type { SearchRuntime } from '../../search/runtime';

import {
  anthropicSearchSummaryText,
  toAnthropicSearchResultItems,
} from './anthropicManagedSearch';
import type { AnthropicRunResult } from './anthropicSubscriptionPlan';
import { relayResponse } from './providerProxyShared';

/** Upper bound on searches executed for one client request. Parity with the
 * Responses lane's `MAX_SELECTED_SEARCH_CALLS`. */
export const MAX_MANAGED_INBAND_SEARCH_ROUNDS = 8;
/** Results requested per search — the search-only lane's value. */
const MANAGED_INBAND_SEARCH_MAX_RESULTS = 5;
/** Longest query honored, mirroring the codex search route's cap. */
const MAX_QUERY_LENGTH = 4096;
/** Hard ceiling on upstream turns for one client request, so a misbehaving
 * upstream that keeps calling the (stripped) selector cannot loop forever. */
const MAX_UPSTREAM_TURNS = MAX_MANAGED_INBAND_SEARCH_ROUNDS + 2;

/**
 * The selector's client-visible name is always the Anthropic server-tool name;
 * this is the INTERNAL function name the upstream sees. `web_search` is used
 * whenever it does not collide with a caller-declared function tool, so the
 * tool name stays stable across a conversation's turns.
 */
const PREFERRED_SELECTOR_NAME = 'web_search';

const SELECTOR_DESCRIPTION =
  'Search the web for current information. Call this with a short search query; ' +
  'the results are returned to you as a tool result.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The A7 search-tool predicate family: version-prefixed type, or the bare name. */
function isWebSearchServerTool(tool: Record<string, unknown>): boolean {
  const type = typeof tool['type'] === 'string' ? tool['type'] : '';
  const name = typeof tool['name'] === 'string' ? tool['name'] : '';
  return type.startsWith('web_search') || (name === 'web_search' && type !== 'custom');
}

/**
 * Whether this body declares a `web_search_*` server tool among its tools — the
 * in-band shape this lane exists for. (A SEARCH-ONLY body also declares one,
 * but the ingress answers those before the BYO path is reached.)
 */
export function hasManagedInbandSearchWork(body: unknown): boolean {
  if (!isRecord(body) || !Array.isArray(body['tools'])) return false;
  return body['tools'].some((tool) => isRecord(tool) && isWebSearchServerTool(tool));
}

/** What the lane needs between preparing and running. */
export interface ManagedInbandSearchPreparation {
  /** The rewritten body every upstream turn is derived from. */
  readonly upstreamBody: Record<string, unknown>;
  /** The function-tool name standing in for the hosted declaration. */
  readonly selectorName: string;
}

function selectorToolDeclaration(name: string): Record<string, unknown> {
  return {
    name,
    description: SELECTOR_DESCRIPTION,
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query. Short and specific beats long and vague.',
        },
      },
      required: ['query'],
    },
  };
}

function mintSelectorName(tools: readonly unknown[]): string {
  const collision = tools.some(
    (tool) => isRecord(tool) && tool['name'] === PREFERRED_SELECTOR_NAME && !isWebSearchServerTool(tool),
  );
  return collision
    ? `__omnicross_search_${randomUUID().replaceAll('-', '')}`
    : PREFERRED_SELECTOR_NAME;
}

/** Render a client-history `web_search_tool_result`'s items as tool-result text. */
function renderHistoryResultItems(items: readonly unknown[]): string {
  const lines: string[] = [];
  for (const item of items) {
    if (!isRecord(item) || item['type'] !== 'web_search_result') continue;
    const title = typeof item['title'] === 'string' ? item['title'] : '';
    const url = typeof item['url'] === 'string' ? item['url'] : '';
    const snippet = typeof item['encrypted_content'] === 'string' ? item['encrypted_content'] : '';
    lines.push(`${lines.length + 1}. ${title}\n   URL: ${url}\n   ${snippet}`);
  }
  return lines.join('\n');
}

/**
 * Rewrite history produced by the server-tool protocol into the function-tool
 * protocol the upstream will see. Each assistant `server_tool_use(web_search)`
 * becomes a `tool_use` of the selector; its `web_search_tool_result` leaves the
 * assistant message and re-enters as a `user` `tool_result` block — merged into
 * a following user message when one exists, so roles stay alternating.
 */
function rewriteHistoryMessages(
  messages: readonly unknown[],
  selectorName: string,
): unknown[] {
  const rewritten: unknown[] = [];
  let pendingResults: Array<{ tool_use_id: string; content: string }> = [];
  const flushResults = (next?: unknown): unknown => {
    if (pendingResults.length === 0) return next ?? null;
    const blocks = pendingResults.map((result) => ({
      type: 'tool_result',
      tool_use_id: result.tool_use_id,
      content: result.content,
    }));
    pendingResults = [];
    if (isRecord(next) && next['role'] === 'user' && Array.isArray(next['content'])) {
      return { ...next, content: [...blocks, ...next['content']] };
    }
    if (next !== undefined) rewritten.push(next);
    return { role: 'user', content: blocks };
  };

  for (const message of messages) {
    if (!isRecord(message) || message['role'] !== 'assistant' || !Array.isArray(message['content'])) {
      const flushed = flushResults(message);
      if (flushed !== null) rewritten.push(flushed);
      continue;
    }
    const content: unknown[] = [];
    for (const block of message['content']) {
      if (!isRecord(block)) {
        content.push(block);
        continue;
      }
      if (block['type'] === 'server_tool_use' && block['name'] === 'web_search') {
        content.push({
          type: 'tool_use',
          id: block['id'],
          name: selectorName,
          input: isRecord(block['input']) ? block['input'] : {},
        });
        continue;
      }
      if (block['type'] === 'web_search_tool_result') {
        const items = Array.isArray(block['content']) ? block['content'] : [];
        pendingResults.push({
          tool_use_id: typeof block['tool_use_id'] === 'string' ? block['tool_use_id'] : '',
          content: renderHistoryResultItems(items) || '(no results)',
        });
        continue;
      }
      content.push(block);
    }
    rewritten.push({ ...message, content });
  }
  const tail = flushResults();
  if (tail !== null) rewritten.push(tail);
  return rewritten;
}

/**
 * Rewrite a declaring request for managed execution.
 *
 * Four changes and no others: hosted search declarations become the selector
 * function; `tool_choice` naming the hosted tool follows the swap; history
 * server-tool blocks become function-tool blocks (see
 * {@link rewriteHistoryMessages}); and `stream` is forced ON — the lane needs
 * the upstream turn's event sequence to drive the splice, and a non-streaming
 * client is aggregated from the synthesized stream at the end.
 */
export function prepareManagedInbandSearch(
  body: Record<string, unknown>,
): ManagedInbandSearchPreparation {
  const tools = (Array.isArray(body['tools']) ? body['tools'] : [])
    .filter((tool) => !(isRecord(tool) && isWebSearchServerTool(tool)));
  const selectorName = mintSelectorName(tools);
  tools.push(selectorToolDeclaration(selectorName));

  const upstreamBody: Record<string, unknown> = {
    ...body,
    tools,
    stream: true,
    messages: rewriteHistoryMessages(
      Array.isArray(body['messages']) ? body['messages'] : [],
      selectorName,
    ),
  };
  const choice = body['tool_choice'];
  if (isRecord(choice) && choice['type'] === 'tool' && choice['name'] === 'web_search') {
    upstreamBody['tool_choice'] = { ...choice, name: selectorName };
  }
  return { upstreamBody, selectorName };
}

// ─────────────────────────────────────────────────────────────────────────────
// Upstream SSE reading
// ─────────────────────────────────────────────────────────────────────────────

/** One parsed upstream SSE event, in arrival order. */
async function* upstreamSseEvents(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  const body = response.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  let cancelPromise: Promise<void> | undefined;
  const cancel = (): void => {
    cancelPromise ??= reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    const flush = (): Record<string, unknown> | null => {
      if (data.length === 0) return null;
      const payload = data.join('\n');
      data = [];
      if (payload === '[DONE]') return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        return null;
      }
      return isRecord(parsed) ? parsed : null;
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (signal?.aborted) break;
      buffer += decoder.decode(value, { stream: true });
      let nlIndex: number;
      while ((nlIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nlIndex).replace(/\r$/, '');
        buffer = buffer.slice(nlIndex + 1);
        if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''));
        } else if (line === '' && data.length) {
          const event = flush();
          if (event) yield event;
        }
      }
    }
    const tail = flush();
    if (tail) yield tail;
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (cancelPromise) await cancelPromise;
    reader.releaseLock();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Client sinks: an SSE writer and a message aggregator over the same events
// ─────────────────────────────────────────────────────────────────────────────

/** The stream-usage tap shape the BYO handler already builds (`relayResponse`). */
export interface ManagedInbandUsageTap {
  extractUsage(event: Record<string, unknown>): Record<string, unknown> | null | undefined;
  onUsage(rawUsage: Record<string, unknown>): void;
}

interface ClientEventSink {
  emit(event: Record<string, unknown>): void;
  /** Flush side effects (usage tap); called once, at stream end. */
  finish(): void;
  /** Whether response headers have been written (only the SSE sink writes any). */
  readonly headersSent: boolean;
}

function sseSink(res: http.ServerResponse, usageTap?: ManagedInbandUsageTap): ClientEventSink {
  let headersSent = false;
  let capturedUsage: Record<string, unknown> | null = null;
  return {
    get headersSent(): boolean {
      return headersSent || res.headersSent;
    },
    emit(event: Record<string, unknown>): void {
      if (!headersSent && !res.headersSent) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        headersSent = true;
      }
      if (res.writableEnded || res.destroyed) return;
      res.write(`event: ${String(event['type'] ?? 'unknown')}\ndata: ${JSON.stringify(event)}\n\n`);
      if (usageTap) {
        const raw = usageTap.extractUsage(event);
        if (raw) capturedUsage = raw;
      }
    },
    finish(): void {
      if (usageTap && capturedUsage) usageTap.onUsage(capturedUsage);
      if (!res.writableEnded && !res.destroyed) res.end();
    },
  };
}

interface AggregatedMessage {
  readonly message: Record<string, unknown>;
}

function aggregatorSink(): ClientEventSink & AggregatedMessage {
  const message: Record<string, unknown> = {
    id: 'msg_managed_search',
    type: 'message',
    role: 'assistant',
    model: 'unknown',
    content: [],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {},
  };
  const blocks = new Map<number, Record<string, unknown>>();
  const textAcc = new Map<number, string>();
  const jsonAcc = new Map<number, string>();
  const thinkingAcc = new Map<number, { thinking: string; signature: string }>();
  return {
    get headersSent(): boolean {
      return false;
    },
    get message(): Record<string, unknown> {
      return message;
    },
    emit(event: Record<string, unknown>): void {
      switch (event['type']) {
        case 'message_start': {
          const start = isRecord(event['message']) ? event['message'] : {};
          message['id'] = start['id'] ?? message['id'];
          message['model'] = start['model'] ?? message['model'];
          message['usage'] = start['usage'] ?? {};
          break;
        }
        case 'content_block_start': {
          const index = Number(event['index']);
          const block = isRecord(event['content_block']) ? { ...event['content_block'] } : {};
          blocks.set(index, block);
          textAcc.set(index, '');
          jsonAcc.set(index, '');
          thinkingAcc.set(index, { thinking: '', signature: '' });
          break;
        }
        case 'content_block_delta': {
          const index = Number(event['index']);
          const delta = isRecord(event['delta']) ? event['delta'] : {};
          if (delta['type'] === 'text_delta' && typeof delta['text'] === 'string') {
            textAcc.set(index, (textAcc.get(index) ?? '') + delta['text']);
          } else if (delta['type'] === 'input_json_delta' && typeof delta['partial_json'] === 'string') {
            jsonAcc.set(index, (jsonAcc.get(index) ?? '') + delta['partial_json']);
          } else if (delta['type'] === 'thinking_delta' && typeof delta['thinking'] === 'string') {
            const acc = thinkingAcc.get(index) ?? { thinking: '', signature: '' };
            acc.thinking += delta['thinking'];
            thinkingAcc.set(index, acc);
          } else if (delta['type'] === 'signature_delta' && typeof delta['signature'] === 'string') {
            const acc = thinkingAcc.get(index) ?? { thinking: '', signature: '' };
            acc.signature += delta['signature'];
            thinkingAcc.set(index, acc);
          }
          break;
        }
        case 'content_block_stop': {
          const index = Number(event['index']);
          const block = blocks.get(index);
          if (!block) break;
          if (block['type'] === 'text') {
            block['text'] = textAcc.get(index) ?? '';
          } else if (block['type'] === 'tool_use' || block['type'] === 'server_tool_use') {
            try {
              block['input'] = jsonAcc.get(index) ? JSON.parse(jsonAcc.get(index) as string) : {};
            } catch {
              block['input'] = {};
            }
          } else if (block['type'] === 'thinking') {
            block['thinking'] = thinkingAcc.get(index)?.thinking ?? '';
            block['signature'] = thinkingAcc.get(index)?.signature ?? '';
          }
          break;
        }
        case 'message_delta': {
          const delta = isRecord(event['delta']) ? event['delta'] : {};
          if (typeof delta['stop_reason'] === 'string') message['stop_reason'] = delta['stop_reason'];
          if (typeof delta['stop_sequence'] === 'string' || delta['stop_sequence'] === null) {
            message['stop_sequence'] = delta['stop_sequence'];
          }
          if (isRecord(event['usage'])) {
            const prior = isRecord(message['usage']) ? message['usage'] : {};
            message['usage'] = { ...prior, ...event['usage'] };
          }
          break;
        }
        default:
          break;
      }
    },
    finish(): void {
      message['content'] = [...blocks.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, block]) => block);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The engine
// ─────────────────────────────────────────────────────────────────────────────

/** Everything the engine needs beyond the preparation. Injected for tests. */
export interface ManagedInbandSearchOptions {
  readonly runtime: SearchRuntime;
  /** Whether the CLIENT asked for a stream (the upstream always is). */
  readonly isClientStream: boolean;
  /** Rewritten into every client-facing `model` field (design D4 passthrough). */
  readonly requestedModel?: string | null;
  readonly resolvedModel: string;
  readonly signal?: AbortSignal;
  readonly createMessageId?: () => string;
  readonly usageTap?: ManagedInbandUsageTap | null;
}

/** One upstream call, as the BYO handler would have made it sans this lane. */
export type ManagedInbandUpstreamCall = (
  body: Record<string, unknown>,
) => Promise<AnthropicRunResult>;

interface OpenBlockState {
  /** Client-facing index this block was assigned. */
  readonly clientIndex: number;
  /** Slot in `TurnState.capturedContent` this block owns, or -1 when none. */
  readonly capturedIndex: number;
  /** The upstream `tool_use` id for selector blocks; undefined otherwise. */
  readonly toolUseId?: string;
  /** Selector open blocks additionally accumulate their input JSON. */
  json: string;
}

interface ExecutedSearch {
  readonly toolUseId: string;
  readonly query: string;
  /** The `tool_result` content the FOLLOW-UP upstream turn receives. */
  readonly modelResult: string;
}

/** One upstream turn's bookkeeping. */
interface TurnState {
  /** Completed assistant blocks, for the follow-up call's history. */
  readonly capturedContent: Record<string, unknown>[];
  /** Searches finalized this turn (query + model-facing result). */
  readonly executed: ExecutedSearch[];
  /** Any non-selector `tool_use` the model issued (client-owned round trip). */
  sawClientToolUse: boolean;
  stopReason: string | null;
}

function isUpstreamSseResponse(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').includes('text/event-stream');
}

/**
 * Serve one in-band managed search exchange.
 *
 * Runs upstream turns through `callUpstream` (the BYO handler's pool-reporting
 * wrapper) until the conversation stops calling the selector, then finishes the
 * client response. Returns the client body text for a NON-streaming client
 * (so the caller's usage tap keeps working), `null` for a streamed one.
 */
export async function runManagedInbandSearch(
  res: http.ServerResponse,
  preparation: ManagedInbandSearchPreparation,
  callUpstream: ManagedInbandUpstreamCall,
  options: ManagedInbandSearchOptions,
): Promise<string | null> {
  const aggregate = options.isClientStream ? null : aggregatorSink();
  const sink: ClientEventSink = aggregate ?? sseSink(res, options.usageTap ?? undefined);
  const messageId =
    options.createMessageId?.() ?? `msg_managed_search_${randomUUID().replaceAll('-', '')}`;
  const clientModel = options.requestedModel?.trim() || options.resolvedModel;

  let totalSearches = 0;
  let clientIndex = 0;
  let inputUsage: Record<string, unknown> | undefined;
  let outputTokens = 0;
  let body: Record<string, unknown> = preparation.upstreamBody;

  const emitFinalDelta = (stopReason: string | null): void => {
    sink.emit({
      type: 'message_delta',
      delta: { stop_reason: stopReason ?? 'end_turn', stop_sequence: null },
      usage: {
        ...(inputUsage ?? {}),
        ...(Number.isFinite(outputTokens) ? { output_tokens: outputTokens } : {}),
      },
    });
    sink.emit({ type: 'message_stop' });
  };

  for (let turn = 0; ; turn += 1) {
    const run = await callUpstream(body);
    const response = run.response;
    const status = response.status;

    if (status < 200 || status >= 300) {
      // FIRST turn: the lane has written nothing; relay the upstream's own
      // failure verbatim, exactly as the non-lane path would have.
      if (turn === 0) {
        return await relayResponse(
          res,
          response,
          options.isClientStream,
          options.requestedModel ?? undefined,
          undefined,
          undefined,
          options.signal,
        ) ?? null;
      }
      // A FOLLOW-UP failed. A streaming client already has its headers; the
      // only honest terminal is an in-band error event. A non-streaming client
      // has received nothing yet, so it gets the upstream error as-is.
      if (options.isClientStream) {
        sink.emit({
          type: 'error',
          error: {
            type: 'api_error',
            message: `Managed search follow-up failed upstream (HTTP ${status})`,
          },
        });
        sink.finish();
        return null;
      }
      return await relayResponse(
        res,
        response,
        false,
        options.requestedModel ?? undefined,
        undefined,
        undefined,
        options.signal,
      ) ?? null;
    }

    if (!isUpstreamSseResponse(response)) {
      // 2xx but not SSE on the first turn: the upstream ignored `stream` (or a
      // relay in between reframed it). This lane splices EVENTS; stand down and
      // relay the body verbatim rather than guessing at a JSON turn's shape.
      if (turn === 0) {
        return await relayResponse(
          res,
          response,
          options.isClientStream,
          options.requestedModel ?? undefined,
          undefined,
          undefined,
          options.signal,
        ) ?? null;
      }
      if (options.isClientStream) {
        sink.emit({
          type: 'error',
          error: { type: 'api_error', message: 'Managed search follow-up returned a non-streaming body' },
        });
        sink.finish();
        return null;
      }
      throw new Error('Managed search follow-up returned a non-streaming body');
    }

    const open = new Map<number, OpenBlockState>();
    const turnState: TurnState = { capturedContent: [], executed: [], sawClientToolUse: false, stopReason: null };
    // Text accumulation for the follow-up history (by upstream index; tool_use
    // input JSON lives on the open-block state itself).
    const textByIndex = new Map<number, string>();

    for await (const event of upstreamSseEvents(response, options.signal)) {
      const type = event['type'];
      if (type === 'message_start') {
        if (turn === 0) {
          const startMessage = isRecord(event['message']) ? event['message'] : {};
          const usage = isRecord(startMessage['usage']) ? startMessage['usage'] : {};
          inputUsage = usage;
          sink.emit({
            type: 'message_start',
            message: {
              id: messageId,
              type: 'message',
              role: 'assistant',
              model: clientModel,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { ...usage },
            },
          });
        }
        continue;
      }
      if (type === 'ping') {
        sink.emit(event);
        continue;
      }
      if (type === 'content_block_start') {
        const index = Number(event['index']);
        const block = isRecord(event['content_block']) ? event['content_block'] : {};
        const isSelector = block['type'] === 'tool_use' && block['name'] === preparation.selectorName;
        const clientIndexForBlock = clientIndex++;
        textByIndex.set(index, '');
        if (isSelector) {
          const toolUseId = typeof block['id'] === 'string' ? block['id'] : `toolu_search_${randomUUID().replaceAll('-', '')}`;
          turnState.capturedContent.push({
            type: 'tool_use',
            id: toolUseId,
            name: preparation.selectorName,
            input: {},
          });
          open.set(index, {
            clientIndex: clientIndexForBlock,
            capturedIndex: turnState.capturedContent.length - 1,
            toolUseId,
            json: '',
          });
          sink.emit({
            type: 'content_block_start',
            index: clientIndexForBlock,
            content_block: {
              type: 'server_tool_use',
              id: toolUseId,
              name: 'web_search',
              input: {},
            },
          });
        } else if (block['type'] === 'tool_use') {
          turnState.sawClientToolUse = true;
          turnState.capturedContent.push({
            type: 'tool_use',
            id: block['id'],
            name: block['name'],
            input: {},
          });
          open.set(index, {
            clientIndex: clientIndexForBlock,
            capturedIndex: turnState.capturedContent.length - 1,
            json: '',
          });
          sink.emit({
            type: 'content_block_start',
            index: clientIndexForBlock,
            content_block: { ...block },
          });
        } else {
          const captured = { ...block };
          turnState.capturedContent.push(captured);
          open.set(index, {
            clientIndex: clientIndexForBlock,
            capturedIndex: turnState.capturedContent.length - 1,
            json: '',
          });
          sink.emit({
            type: 'content_block_start',
            index: clientIndexForBlock,
            content_block: { ...block },
          });
        }
        continue;
      }
      if (type === 'content_block_delta') {
        const index = Number(event['index']);
        const state = open.get(index);
        const delta = isRecord(event['delta']) ? event['delta'] : {};
        if (state) {
          if (delta['type'] === 'input_json_delta' && typeof delta['partial_json'] === 'string') {
            state.json += delta['partial_json'];
          } else if (delta['type'] === 'text_delta' && typeof delta['text'] === 'string') {
            textByIndex.set(index, (textByIndex.get(index) ?? '') + delta['text']);
          }
        }
        sink.emit({ ...event, index: state ? state.clientIndex : index });
        continue;
      }
      if (type === 'content_block_stop') {
        const index = Number(event['index']);
        const state = open.get(index);
        open.delete(index);
        if (state) {
          sink.emit({ type: 'content_block_stop', index: state.clientIndex });
          const captured = turnState.capturedContent[state.capturedIndex];
          if (captured) {
            if (captured['type'] === 'text') {
              captured['text'] = textByIndex.get(index) ?? '';
            } else if (captured['type'] === 'tool_use') {
              try {
                captured['input'] = state.json ? (JSON.parse(state.json) as Record<string, unknown>) : {};
              } catch {
                captured['input'] = {};
              }
            }
          }
        }
        if (state?.toolUseId !== undefined) {
          // The query is complete: run the search NOW, then splice the result
          // block in native order. Reading the upstream pauses while this runs
          // (sequential for-await), which is exactly the desired backpressure.
          const query = parseSelectorQuery(state.json);
          const executed = await executeSearch(options.runtime, query, state.toolUseId, options.signal);
          totalSearches += 1;
          turnState.executed.push(executed);
          const captured = turnState.capturedContent[state.capturedIndex];
          if (captured) captured['input'] = { query: executed.query };
          sink.emit({
            type: 'content_block_start',
            index: clientIndex++,
            content_block: {
              type: 'web_search_tool_result',
              tool_use_id: state.toolUseId,
              content: executed.clientItems,
            },
          });
          sink.emit({ type: 'content_block_stop', index: clientIndex - 1 });
        }
        continue;
      }
      if (type === 'message_delta') {
        const delta = isRecord(event['delta']) ? event['delta'] : {};
        if (typeof delta['stop_reason'] === 'string') turnState.stopReason = delta['stop_reason'];
        const usage = isRecord(event['usage']) ? event['usage'] : {};
        if (typeof usage['output_tokens'] === 'number') outputTokens += usage['output_tokens'];
        continue;
      }
      if (type === 'message_stop') {
        continue;
      }
      if (type === 'error') {
        // An upstream in-band error: forward it. For a non-streaming client
        // nothing has been written yet, so surface it as the request failure.
        if (options.isClientStream) {
          sink.emit(event);
          sink.finish();
          return null;
        }
        throw new Error(`Upstream stream failed during managed search: ${JSON.stringify(event['error'] ?? event)}`);
      }
      // Unknown event types pass through untouched.
      sink.emit(event);
    }

    const followUp =
      turnState.stopReason === 'tool_use' &&
      turnState.executed.length > 0 &&
      !turnState.sawClientToolUse &&
      turn < MAX_UPSTREAM_TURNS - 1;

    if (!followUp) {
      emitFinalDelta(turnState.stopReason);
      sink.finish();
      if (aggregate) {
        const bodyText = JSON.stringify(aggregate.message);
        if (!res.headersSent) {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(bodyText, 'utf8')),
          });
        }
        res.end(bodyText);
        return bodyText;
      }
      return null;
    }

    // The model's turn called ONLY our selector: it is waiting for results we
    // already hold. Continue the conversation upstream with the results
    // appended as a normal function-tool round trip.
    const messages = [
      ...(Array.isArray(body['messages']) ? body['messages'] : []),
      { role: 'assistant', content: turnState.capturedContent },
      {
        role: 'user',
        content: turnState.executed.map((search) => ({
          type: 'tool_result',
          tool_use_id: search.toolUseId,
          content: search.modelResult,
        })),
      },
    ];
    const capReached = totalSearches >= MAX_MANAGED_INBAND_SEARCH_ROUNDS;
    body = {
      ...body,
      messages,
      ...(capReached
        ? {
            tools: (Array.isArray(body['tools']) ? body['tools'] : []).filter(
              (tool) => !(isRecord(tool) && tool['name'] === preparation.selectorName),
            ),
          }
        : {}),
    };
  }
}

function parseSelectorQuery(json: string): string {
  try {
    const parsed: unknown = json ? JSON.parse(json) : null;
    if (isRecord(parsed) && typeof parsed['query'] === 'string') {
      return parsed['query'].slice(0, MAX_QUERY_LENGTH);
    }
  } catch {
    // A malformed call still searches with whatever arrived.
  }
  return '';
}

interface ExecutedSearchOutcome {
  readonly toolUseId: string;
  readonly query: string;
  readonly modelResult: string;
  readonly clientItems: ReadonlyArray<Record<string, unknown>>;
}

async function executeSearch(
  runtime: SearchRuntime,
  query: string,
  toolUseId: string,
  signal?: AbortSignal,
): Promise<ExecutedSearchOutcome> {
  try {
    const response = await runtime.search({
      query,
      options: {
        maxResults: MANAGED_INBAND_SEARCH_MAX_RESULTS,
        ...(signal ? { signal } : {}),
      },
    });
    return {
      toolUseId,
      query: response.query || query,
      modelResult: anthropicSearchSummaryText(response.query || query, response.results, response.providerId),
      clientItems: toAnthropicSearchResultItems(response.results) as unknown as ReadonlyArray<Record<string, unknown>>,
    };
  } catch (error) {
    const shape = toSearchErrorShape(error);
    const failure = `Web search for "${query}" failed: ${shape.message} (${shape.code})`;
    return { toolUseId, query, modelResult: failure, clientItems: [] };
  }
}
