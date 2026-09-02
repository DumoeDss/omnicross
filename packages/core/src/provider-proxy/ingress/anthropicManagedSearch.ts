/**
 * The Anthropic Messages MANAGED search lane (plan 阶段5 / §8.4).
 *
 * ## When it engages
 *
 * Only when the Anthropic frontend's mode is not `native`, and only for a
 * **search-only sub-request**: a `/v1/messages` body whose every tool is a
 * `web_search_*` server tool and which either forces that tool through
 * `tool_choice` or declares exactly one. That is not an arbitrary narrowing —
 * it is how an Anthropic client actually surfaces a `web_search` invocation to
 * a gateway, and it is the same predicate Elftia's `proxySearchIntercept` has
 * used in production (wire baseline A7). A general chat request that merely
 * DECLARES a search tool is relayed untouched: the upstream, or the client's
 * own next sub-request, decides whether a search happens, and intercepting it
 * here would be the gateway guessing.
 *
 * Detection uses the PORTED rule, `type.startsWith('web_search')` (wire baseline
 * A7), not core's own `isServerSideTool` rule, `type.startsWith('web_search_')`
 * (A2). The difference is one underscore and it is deliberate: this lane's job
 * is to answer the requests Elftia's interception answered, so it matches what
 * that predicate matches — including a bare `web_search` type. Either spelling
 * keeps a new tool VERSION as data rather than a code branch, which is the
 * property that actually matters.
 *
 * ## What it synthesizes, and how much of that is verified
 *
 * VERIFIED, from four real upstream SSE captures (wire baseline §3.3):
 *
 * - the block order `message_start` -> `server_tool_use` -> `input_json_delta`
 *   xN -> `content_block_stop` -> `web_search_tool_result` `content_block_start`;
 * - the result item field set: exactly `url`, `title`, `encrypted_content`,
 *   `page_age`.
 *
 * UNVERIFIED, because every capture was truncated at the audit body cap of
 * ~8 KB immediately after the result block started: the stream TAIL. The
 * closing `content_block_stop`, any trailing text block, `message_delta` and
 * `message_stop` are documented best-effort here — they follow Anthropic's own
 * SSE framing, which `sse-parser.ts` already handles, and nothing asserts them
 * as upstream-verified.
 *
 * `encrypted_content` carries the result SNIPPET. Upstream that field is opaque
 * provider data; here it is plain text, exactly as the Elftia reference does it
 * (wire baseline A9). It is field-compatible, not byte-equivalent, and the
 * comparison report says so.
 *
 * ## What it is not
 *
 * It shares no emission code with the native passthrough lane. A request
 * resolves its mode once, before this module is reached, and a request in
 * `native` mode never enters here at all — that is hard constraint 6 made
 * structural rather than conventional.
 *
 * @module provider-proxy/ingress/anthropicManagedSearch
 */

import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import type { SearchResult } from '@omnicross/contracts/search-types';
import { toSearchErrorShape } from '@omnicross/contracts/search-types';

import type { SearchFrontendMode } from '../../search/frontends';
import {
  SEARCH_UNSUPPORTED_CAPABILITY_CODE,
  searchErrorHttpStatus,
} from '../../search/frontends';
import type { SearchRuntime } from '../../search/runtime';
import { searchRuntimeAsWebSearchBackend } from '../../search/webSearchBackendCompat';
import type { WebSearchBackend } from '../../ports/web-search-backend';

import { writeAnthropicError } from './anthropicErrorEnvelope';

/**
 * Adapter instances, one per runtime.
 *
 * `searchRuntimeAsWebSearchBackend` returns a fresh object each call, and the
 * hint slot is filled on every delegated request; memoizing keeps the hint a
 * STABLE reference so a host can compare or cache against it.
 */
const hintBackends = new WeakMap<SearchRuntime, WebSearchBackend>();

/**
 * The `webSearchService` hint a delegated Anthropic handler should receive.
 *
 * This is where `searchRuntimeAsWebSearchBackend` — exported but unwired since
 * 阶段3 — gets its first production consumer: a host handler that reads the
 * legacy hint now reaches the shared runtime through it, instead of the `null`
 * the slot has carried since it was introduced.
 *
 * Precedence is the EXISTING hint contract, unchanged: a backend the ROUTE
 * supplies outranks the gateway's own runtime and is passed through untouched.
 */
export function resolveAnthropicSearchHintBackend(
  routeSupplied: WebSearchBackend | null | undefined,
  runtime: SearchRuntime | null | undefined,
): WebSearchBackend | null {
  if (routeSupplied) return routeSupplied;
  if (!runtime) return null;
  const existing = hintBackends.get(runtime);
  if (existing) return existing;
  const created = searchRuntimeAsWebSearchBackend(runtime);
  hintBackends.set(runtime, created);
  return created;
}

/**
 * The ported detection prefix (wire baseline A7). Note the ABSENT trailing
 * underscore: core's own `isServerSideTool` uses `web_search_`, and this rule
 * is deliberately the wider one Elftia's interception used. See the module doc.
 */
const WEB_SEARCH_TOOL_PREFIX = 'web_search';

/** Results requested per managed search — the Elftia reference's value (A10). */
const MANAGED_SEARCH_MAX_RESULTS = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toolList(body: Record<string, unknown>): Record<string, unknown>[] {
  const tools = body['tools'];
  return Array.isArray(tools) ? tools.filter(isRecord) : [];
}

/**
 * Whether this body is a search-only sub-request.
 *
 * Ported from the Elftia reference (`isSearchOnlySubRequest`, wire baseline A7)
 * and kept behaviorally identical: every tool must be a search tool, and either
 * `tool_choice` forces `web_search` or there is exactly one tool.
 */
export function isAnthropicSearchOnlyRequest(body: unknown): boolean {
  if (!isRecord(body)) return false;
  const tools = toolList(body);
  if (tools.length === 0) return false;
  const allSearch = tools.every((tool) => {
    const type = typeof tool['type'] === 'string' ? tool['type'] : '';
    const name = typeof tool['name'] === 'string' ? tool['name'] : '';
    return type.startsWith(WEB_SEARCH_TOOL_PREFIX) || name === 'web_search';
  });
  if (!allSearch) return false;

  const choice = body['tool_choice'];
  if (isRecord(choice) && choice['type'] === 'tool' && choice['name'] === 'web_search') return true;
  return tools.length === 1;
}

/** Whether the body declares any `web_search_*` server tool at all. */
export function declaresAnthropicSearchTool(body: unknown): boolean {
  if (!isRecord(body)) return false;
  return toolList(body).some((tool) => {
    const type = typeof tool['type'] === 'string' ? tool['type'] : '';
    return type.startsWith(WEB_SEARCH_TOOL_PREFIX);
  });
}

/** Flatten Anthropic message content to text. */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  for (const block of content) {
    if (isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string') {
      return block['text'];
    }
  }
  return '';
}

/**
 * Pull the query out of a search-only sub-request.
 *
 * The Anthropic SDK phrases it as `Perform a web search for the query: <q>`, so
 * the prefix is stripped when present; otherwise the last user message is the
 * query. Both branches are the Elftia reference's behavior.
 */
export function extractAnthropicSearchQuery(body: Record<string, unknown>): string {
  const messages = Array.isArray(body['messages']) ? body['messages'].filter(isRecord) : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || message['role'] !== 'user') continue;
    const text = messageText(message['content']).trim();
    if (!text) continue;
    const prefixed = /(?:search\s+for(?:\s+the\s+query)?:\s*)([\s\S]*)/i.exec(text);
    const candidate = (prefixed?.[1] ?? text).trim();
    return candidate.replace(/^["']|["']$/g, '').trim();
  }
  return '';
}

/** One synthesized `web_search_result` item — exactly the verified field set. */
export interface AnthropicWebSearchResultItem {
  readonly type: 'web_search_result';
  readonly url: string;
  readonly title: string;
  /** The result snippet. Upstream this field is opaque; here it is plain text. */
  readonly encrypted_content: string;
  readonly page_age: null;
}

/** Project runtime results onto the verified item shape. */
export function toAnthropicSearchResultItems(
  results: readonly SearchResult[],
): AnthropicWebSearchResultItem[] {
  return results.map((result) => ({
    type: 'web_search_result' as const,
    url: result.url,
    title: result.title,
    encrypted_content: result.content,
    page_age: null,
  }));
}

/**
 * The human-readable summary block.
 *
 * Format preserved verbatim from the Elftia reference: it is the part a model
 * actually reads, so changing its wording would change model behavior for no
 * reason. `Provider used:` is where search provenance stays visible.
 */
export function anthropicSearchSummaryText(
  query: string,
  results: readonly SearchResult[],
  providerId: string,
): string {
  const body = results
    .map((result, index) =>
      `${index + 1}. ${result.title}\n   URL: ${result.url}\n   ${result.content || ''}\n`)
    .join('\n');
  return `Web search results for query: "${query}"\nProvider used: ${providerId}\n\n${body}`;
}

/** The three synthesized content blocks, in the verified order. */
export function buildAnthropicManagedSearchBlocks(input: {
  readonly query: string;
  readonly results: readonly SearchResult[];
  readonly providerId: string;
  readonly toolUseId: string;
}): Record<string, unknown>[] {
  return [
    {
      type: 'server_tool_use',
      id: input.toolUseId,
      name: 'web_search',
      input: { query: input.query },
    },
    {
      type: 'web_search_tool_result',
      tool_use_id: input.toolUseId,
      content: toAnthropicSearchResultItems(input.results),
    },
    {
      type: 'text',
      text: anthropicSearchSummaryText(input.query, input.results, input.providerId),
    },
  ];
}

/** Everything the lane needs. Injected so it is testable without a proxy. */
export interface AnthropicManagedSearchDeps {
  /** Resolved ONCE per request, before this module is reached. */
  readonly mode: SearchFrontendMode;
  /**
   * The one shared runtime — the lane's execution seam.
   *
   * The lane executes through the RUNTIME rather than through the legacy
   * `WebSearchBackend` hint, and that is the documented choice: the port's
   * `search` takes a concrete `WebSearchProviderId` and has no `auto`
   * selector, so driving managed search through it would either pin one
   * provider (losing fallback) or rebuild a candidate walk here — the second
   * fallback order the whole extraction exists to remove. The hint keeps its
   * own job, which is to let a HOST supply its own backend; see
   * {@link resolveAnthropicSearchHintBackend}, and note that this lane stands
   * down entirely when a route supplies one.
   */
  readonly runtime?: SearchRuntime | null;
  /** Cancellation tied to the client connection. */
  readonly signal?: AbortSignal;
  /** Id seams, so goldens are stable. */
  readonly createToolUseId?: () => string;
  readonly createMessageId?: () => string;
}

/**
 * An abort signal that fires when the client goes away.
 *
 * Re-exported rather than reimplemented: the Codex route needs the identical
 * behavior at the ROUTER seam, where no signal is inherited either, so the
 * implementation moved to `pipeline/requestLifecycleSignal`. This name stays
 * because it is what this lane's call sites and tests already use.
 */
export { requestLifecycleSignal as requestAbortSignal } from '../../pipeline/requestLifecycleSignal';

/**
 * Replay an already-consumed request body to the branches downstream.
 *
 * Same mechanism (and same reason) as the outbound router's replay: the shared
 * ingress consumers re-read the body through `data`/`end`, and the original
 * stream is at EOF once the managed lane has looked at it.
 */
export function replayAnthropicRequest(
  req: http.IncomingMessage,
  rawBody: string,
): http.IncomingMessage {
  const buffer = Buffer.from(rawBody, 'utf8');
  const readable = Readable.from(
    buffer.length > 0 ? [buffer] : [],
  ) as unknown as http.IncomingMessage;
  readable.method = req.method;
  readable.url = req.url;
  readable.headers = req.headers;
  readable.httpVersion = req.httpVersion;
  // The original stream reached `end` before this replay existed, so its
  // buffered body is truthfully complete. Downstream consumers read
  // `complete`/`aborted` to tell a finished request from a disconnect.
  readable.complete = true;
  readable.aborted = false;
  (readable as unknown as { socket: unknown }).socket = req.socket;
  return readable;
}

/** SSE frame writer, shared by the streaming path. */
function writeEvent(res: http.ServerResponse, type: string, data: unknown): void {
  if (res.writableEnded) return;
  res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Serve one managed Anthropic search, streaming or not.
 *
 * Returns `true` when this lane answered the request (including with an error),
 * `false` when the request is not ours and the caller should relay it.
 */
export async function handleAnthropicManagedSearch(
  res: http.ServerResponse,
  parsedBody: unknown,
  deps: AnthropicManagedSearchDeps,
): Promise<boolean> {
  if (deps.mode === 'native') return false;
  if (!isRecord(parsedBody)) return false;

  if (deps.mode === 'off') {
    // `off` refuses only what it is actually being asked to execute. A request
    // that declares no search tool has nothing to refuse and is relayed.
    if (!declaresAnthropicSearchTool(parsedBody)) return false;
    writeAnthropicError(
      res,
      400,
      'Omnicross-managed web search is disabled for the Anthropic frontend',
      {},
      { code: SEARCH_UNSUPPORTED_CAPABILITY_CODE },
    );
    return true;
  }

  if (!isAnthropicSearchOnlyRequest(parsedBody)) return false;
  const runtime = deps.runtime ?? null;
  if (!runtime) {
    writeAnthropicError(
      res,
      503,
      'Omnicross-managed web search has no configured search runtime',
      {},
      { code: SEARCH_UNSUPPORTED_CAPABILITY_CODE },
    );
    return true;
  }

  const query = extractAnthropicSearchQuery(parsedBody);
  if (!query) {
    writeAnthropicError(res, 400, 'Managed web search found no query in the request messages');
    return true;
  }

  const model = typeof parsedBody['model'] === 'string' && parsedBody['model'].trim()
    ? parsedBody['model']
    : 'omnicross-managed-search';
  const stream = parsedBody['stream'] === true;

  let results: readonly SearchResult[];
  let providerId: string;
  try {
    const response = await runtime.search({
      query,
      options: {
        maxResults: MANAGED_SEARCH_MAX_RESULTS,
        ...(deps.signal ? { signal: deps.signal } : {}),
      },
    });
    results = response.results;
    providerId = response.providerId;
  } catch (error) {
    // Every failure lands BEFORE any byte is written, so it is a plain HTTP
    // error in the Anthropic envelope rather than a mid-stream `error` event.
    // That is deliberate: an SSE error frame is only correct once a stream has
    // started, and this lane never starts one it cannot finish.
    const shape = toSearchErrorShape(error);
    writeAnthropicError(
      res,
      searchErrorHttpStatus(shape.code),
      shape.message,
      {},
      { code: shape.code },
    );
    return true;
  }

  if (res.writableEnded || deps.signal?.aborted) return true;

  const toolUseId = deps.createToolUseId?.() ?? `toolu_search_${randomUUID().replaceAll('-', '')}`;
  const messageId = deps.createMessageId?.() ?? `msg_search_${randomUUID().replaceAll('-', '')}`;
  const blocks = buildAnthropicManagedSearchBlocks({ query, results, providerId, toolUseId });

  if (!stream) {
    const body = JSON.stringify({
      id: messageId,
      type: 'message',
      role: 'assistant',
      model,
      content: blocks,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body, 'utf8')),
    });
    res.end(body);
    return true;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // ── VERIFIED prefix (wire baseline §3.3): message_start, the server_tool_use
  //    block with its input_json_delta, and the result block's start. ──────────
  writeEvent(res, 'message_start', {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  writeEvent(res, 'content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'server_tool_use', id: toolUseId, name: 'web_search', input: {} },
  });
  writeEvent(res, 'ping', { type: 'ping' });
  writeEvent(res, 'content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query }) },
  });
  writeEvent(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  writeEvent(res, 'content_block_start', {
    type: 'content_block_start',
    index: 1,
    content_block: blocks[1],
  });

  // ── Beyond the ~8 KB capture boundary: documented best-effort. Anthropic's
  //    own SSE framing, which `sse-parser.ts` already parses; NOT asserted
  //    anywhere as upstream-verified. ─────────────────────────────────────────
  writeEvent(res, 'content_block_stop', { type: 'content_block_stop', index: 1 });
  writeEvent(res, 'content_block_start', {
    type: 'content_block_start',
    index: 2,
    content_block: { type: 'text', text: '' },
  });
  writeEvent(res, 'content_block_delta', {
    type: 'content_block_delta',
    index: 2,
    delta: { type: 'text_delta', text: (blocks[2] as { text: string }).text },
  });
  writeEvent(res, 'content_block_stop', { type: 'content_block_stop', index: 2 });
  writeEvent(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 0 },
  });
  writeEvent(res, 'message_stop', { type: 'message_stop' });
  res.end();
  return true;
}
