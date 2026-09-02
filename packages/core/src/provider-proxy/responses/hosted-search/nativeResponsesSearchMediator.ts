/**
 * The managed Responses search mediator (plan 阶段5 / §8.3).
 *
 * ## The shape of the lane
 *
 * Structurally the hosted-image mediator: `prepare` swaps the hosted
 * declaration for a function-tool selector and hands back a lease;
 * `wrapUpstreamResponse` reads the upstream turn, executes ONE
 * `SearchRuntime` search per selector call, and splices Omnicross-shaped items
 * into the response the client sees.
 *
 * ## Two deliberate departures, both documented
 *
 * 1. **The upstream turn is never streamed** (`prepare` forces `stream: false`),
 *    and a client that asked for a stream gets a SYNTHESIZED one. Transforming a
 *    live upstream stream would mean guessing where our items belong inside an
 *    event sequence nobody has ever captured (wire baseline §2.2: zero
 *    `web_search_call` payloads in 444 shards). Synthesizing from a completed
 *    turn is deterministic, fully testable offline, and honest about being ours.
 *    The native lane is untouched by this and keeps streaming normally.
 *
 * 2. **The search REPORT is part of this turn, not the next one.** Where the
 *    hosted-image lane defers its receipt to the following request, search
 *    results are small text, so the lane emits the `web_search_call` item
 *    followed by a `message` item carrying the results. The model's own prose
 *    answer for the turn is therefore not produced here; the client continues
 *    the conversation and the next turn sees the results in its `input`. That
 *    differs from what a native hosted search does in one round, and it is
 *    recorded as such — the mode is opt-in and its wire is UNVERIFIED anyway.
 *
 * Nothing in this module may be described as verified against OpenAI.
 *
 * @module provider-proxy/responses/hosted-search/nativeResponsesSearchMediator
 */

import { randomUUID } from 'node:crypto';

import type { SearchResult } from '@omnicross/contracts/search-types';
import { toSearchErrorShape } from '@omnicross/contracts/search-types';

import { OpenAIOperationError } from '../../../openai-operation';
import { searchErrorHttpStatus } from '../../../search/frontends';
import type { SearchRuntime } from '../../../search/runtime';
import type {
  ResponsesHostedSearchIngress,
  ResponsesHostedSearchPrepareInput,
  ResponsesHostedSearchRequestLease,
  ResponsesHostedSearchWrapInput,
} from '../responsesHostedSearchIngress';
import { hasResponsesHostedSearchWork } from '../responsesHostedSearchIngress';

import { nativeResponsesSearchSseResponse } from './nativeResponsesSearchSse';
import {
  parseSelectedSearchCalls,
  prepareNativeResponsesSearchSelection,
  type NativeResponsesSearchSelection,
  type SelectedSearchCall,
} from './nativeResponsesSearchSelection';

const DEFAULT_MAX_UPSTREAM_JSON_BYTES = 8 * 1024 * 1024;
/** Results requested per managed search. Matches the Anthropic managed lane. */
const MANAGED_SEARCH_MAX_RESULTS = 5;

export interface NativeResponsesSearchMediatorOptions {
  readonly maxUpstreamJsonBytes?: number;
  readonly createSelectorName?: () => string;
  readonly createCallId?: () => string;
  readonly createMessageId?: () => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new OpenAIOperationError({
          status: 502,
          code: 'upstream_protocol_changed',
          message: 'Upstream Responses body exceeded the managed-search size limit',
        });
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

/**
 * Re-wrap a body with the framing headers stripped.
 *
 * `asJson` is false for a passthrough of something we could NOT parse: stamping
 * `application/json` onto a body that just failed `JSON.parse` would relabel a
 * broken upstream turn as valid JSON, which is a worse lie than whatever the
 * upstream actually sent.
 */
function responseWithBody(upstream: Response, body: string, asJson: boolean): Response {
  const headers = new Headers(upstream.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.delete('transfer-encoding');
  if (asJson) headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

/**
 * The `web_search_call` output item — **Omnicross's documented shape.**
 *
 * `action` mirrors the only structure the hosted-tool mapping tells us about
 * (a search with a query); `results` is ours, because a client that asked
 * Omnicross to run the search needs to be able to read what it found.
 */
export function buildWebSearchCallItem(input: {
  readonly id: string;
  readonly query: string;
  readonly providerId: string;
  readonly results: readonly SearchResult[];
}): Record<string, unknown> {
  return {
    id: input.id,
    type: 'web_search_call',
    status: 'completed',
    action: { type: 'search', query: input.query },
    // Provenance, as the plan requires of every search surface.
    provider: input.providerId,
    results: input.results.map((result) => ({
      title: result.title,
      url: result.url,
      content: result.content,
    })),
  };
}

/** A failed search still produces an item, so the turn stays well-formed. */
export function buildFailedWebSearchCallItem(input: {
  readonly id: string;
  readonly query: string;
  readonly code: string;
  readonly message: string;
}): Record<string, unknown> {
  return {
    id: input.id,
    type: 'web_search_call',
    status: 'failed',
    action: { type: 'search', query: input.query },
    error: { code: input.code, message: input.message },
  };
}

/** The message item carrying the findings back to the client and the model. */
export function buildSearchReportItem(input: {
  readonly id: string;
  readonly text: string;
}): Record<string, unknown> {
  return {
    id: input.id,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: input.text, annotations: [] }],
  };
}

/** Human- and model-readable rendering of one search. */
export function renderSearchReport(
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

class NativeResponsesSearchLease implements ResponsesHostedSearchRequestLease {
  readonly upstreamBody: Record<string, unknown>;
  #wrapped = false;

  constructor(
    private readonly runtime: SearchRuntime,
    private readonly input: ResponsesHostedSearchPrepareInput,
    private readonly selection: NativeResponsesSearchSelection,
    private readonly maxUpstreamJsonBytes: number,
    private readonly createCallId: () => string,
    private readonly createMessageId: () => string,
  ) {
    this.upstreamBody = selection.upstreamBody;
  }

  async wrapUpstreamResponse(input: ResponsesHostedSearchWrapInput): Promise<Response> {
    if (this.#wrapped) {
      throw new OpenAIOperationError({
        status: 500,
        code: 'operation_handler_failed',
        message: 'Managed search response was wrapped twice',
      });
    }
    this.#wrapped = true;

    const status = input.rawStatus ?? input.response.status;
    // An upstream error is relayed verbatim: the managed lane has no better
    // information than the upstream about why the turn failed, and rewriting
    // it would hide the real status behind ours.
    if (status < 200 || status >= 300) return input.response;

    const text = await readBoundedBody(input.response, this.maxUpstreamJsonBytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return responseWithBody(input.response, text, false);
    }
    if (!isRecord(parsed)) return responseWithBody(input.response, text, false);

    const calls = parseSelectedSearchCalls(parsed.output, this.selection.selectorName);
    const output = Array.isArray(parsed.output) ? [...parsed.output] : [];
    if (calls.length === 0) {
      // The model chose not to search. Nothing to splice; hand back the turn as
      // it came, streamed only if the client asked for one.
      return this.#finish(input.response, { ...parsed, output });
    }

    // Replace each selector call, back to front, so earlier indexes stay valid.
    for (const call of [...calls].reverse()) {
      // The client is gone: stop before starting another search rather than
      // finishing a turn nobody will read. With several hosted calls in one
      // turn this is the difference between one abandoned search and N.
      if (this.input.signal.aborted) break;
      const replacement = await this.#executeCall(call);
      output.splice(call.itemIndex, 1, ...replacement);
    }
    return this.#finish(input.response, { ...parsed, output });
  }

  /** One runtime search per hosted call. The runtime owns policy and fallback. */
  async #executeCall(call: SelectedSearchCall): Promise<Record<string, unknown>[]> {
    const callId = this.createCallId();
    try {
      const response = await this.runtime.search({
        query: call.query,
        options: {
          maxResults: MANAGED_SEARCH_MAX_RESULTS,
          signal: this.input.signal,
        },
      });
      return [
        buildWebSearchCallItem({
          id: callId,
          query: call.query,
          providerId: response.providerId,
          results: response.results,
        }),
        buildSearchReportItem({
          id: this.createMessageId(),
          text: renderSearchReport(call.query, response.results, response.providerId),
        }),
      ];
    } catch (error) {
      const shape = toSearchErrorShape(error);
      return [
        buildFailedWebSearchCallItem({
          id: callId,
          query: call.query,
          code: shape.code,
          message: shape.message,
        }),
        buildSearchReportItem({
          id: this.createMessageId(),
          text: `Web search for "${call.query}" failed: ${shape.message} (${shape.code})`,
        }),
      ];
    }
  }

  #finish(upstream: Response, response: Record<string, unknown>): Response {
    if (!this.selection.clientWantsStream) {
      return responseWithBody(upstream, JSON.stringify(response), true);
    }
    return nativeResponsesSearchSseResponse({ response, upstream });
  }
}

/** Compose the shared runtime into the narrow managed-search ingress port. */
export function createNativeResponsesSearchIngress(
  runtime: SearchRuntime,
  options: NativeResponsesSearchMediatorOptions = {},
): ResponsesHostedSearchIngress {
  const maxUpstreamJsonBytes = options.maxUpstreamJsonBytes ?? DEFAULT_MAX_UPSTREAM_JSON_BYTES;
  if (!Number.isSafeInteger(maxUpstreamJsonBytes) || maxUpstreamJsonBytes <= 0) {
    throw new RangeError('Managed Responses search JSON limit is invalid');
  }
  const createCallId = options.createCallId ??
    (() => `ws_${randomUUID().replaceAll('-', '')}`);
  const createMessageId = options.createMessageId ??
    (() => `msg_${randomUUID().replaceAll('-', '')}`);

  return Object.freeze({
    prepare: async (
      input: ResponsesHostedSearchPrepareInput,
    ): Promise<ResponsesHostedSearchRequestLease | null> => {
      // Mode was resolved once by the ingress; this lane only ever sees a
      // request the resolver already routed to it.
      if (input.mode !== 'managed') return null;
      if (input.operation !== 'create') return null;
      if (!hasResponsesHostedSearchWork(input.body)) return null;
      const selection = prepareNativeResponsesSearchSelection({
        body: input.body,
        ...(options.createSelectorName
          ? { createSelectorName: options.createSelectorName }
          : {}),
      });
      return new NativeResponsesSearchLease(
        runtime,
        input,
        selection,
        maxUpstreamJsonBytes,
        createCallId,
        createMessageId,
      );
    },
  });
}

/** The `unsupported_capability` error mode `off` answers a hosted search with. */
export function responsesSearchDisabledError(): OpenAIOperationError {
  return new OpenAIOperationError({
    status: 422,
    code: 'unsupported_capability',
    message: 'Hosted web search is disabled for the Responses frontend',
  });
}

/** Map a search-taxonomy failure onto the Responses local error envelope. */
export function responsesSearchFailureError(error: unknown): OpenAIOperationError {
  if (error instanceof OpenAIOperationError) return error;
  const shape = toSearchErrorShape(error);
  return new OpenAIOperationError({
    status: searchErrorHttpStatus(shape.code),
    code: shape.code,
    message: shape.message,
    retryable: shape.retryable === true,
  });
}
