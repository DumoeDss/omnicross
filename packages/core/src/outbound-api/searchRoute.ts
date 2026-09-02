/**
 * The Codex search route — `POST /v1/alpha/search`.
 *
 * ## Compatibility source
 *
 * From `docs/design/search-baseline/wire-baseline.md` §1, over 11 real audit
 * records produced by `codex-tui` 0.151.0 and 0.152.0:
 *
 * The request and response contracts are pinned from the Codex 0.152.0 typed
 * API definitions and standalone-search integration fixtures. Codex sends text
 * queries under `commands.search_query[].q` and requires a string `output` in
 * the JSON response; structured `results` are optional opaque DTOs.
 *
 * ## What this route does about that
 *
 * The default mode is `off`, and `off` answers with a structured
 * `unsupported_capability` error instead of the generic 404 (plan §15). That is
 * strictly more informative than today's behavior and claims nothing.
 *
 * Enabling `managed` accepts Codex text-search commands plus the legacy flat
 * query spellings used by early Omnicross clients. Other Codex command kinds
 * are rejected because the shared runtime currently exposes text search only.
 *
 * ## The designed side effect
 *
 * A dispatched request reaches route resolution and is given a `sessionKey`, so
 * the audit body store finally persists `/v1/alpha/search` exchanges. The
 * capture that 阶段0 proved impossible becomes possible when a real client talks
 * to an enabled route.
 *
 * @module outbound-api/searchRoute
 */

import type http from 'node:http';

import type { OrchestratedSearchResponse } from '@omnicross/contracts/search-types';
import { toSearchErrorShape } from '@omnicross/contracts/search-types';

import {
  OpenAIOperationError,
  writeOpenAIOperationError,
} from '../openai-operation';
import type { SearchFrontendMode } from '../search/frontends';
import {
  SEARCH_UNSUPPORTED_CAPABILITY_CODE,
  searchErrorHttpStatus,
} from '../search/frontends';
import type { SearchRuntime } from '../search/runtime';

/** The path observed on every one of the 11 baselined records. */
export const codexSearchRoutePath = '/v1/alpha/search';

/** Path suffix, so a deployment under a base path still matches. */
const ROUTE_SUFFIX: readonly string[] = ['alpha', 'search'];

/**
 * Request-body field spellings accepted as "the query".
 *
 * Codex uses `commands.search_query[].q`; these flat spellings remain as a
 * backwards-compatible tolerance for early Omnicross clients.
 */
export const TOLERATED_QUERY_FIELDS: readonly string[] = Object.freeze([
  'query',
  'q',
  'search_query',
]);

/** Longest request body this route will read, in bytes. */
const MAX_REQUEST_BYTES = 256 * 1024;
/** Longest query string accepted. Beyond this it is not a query. */
const MAX_QUERY_LENGTH = 4096;

/** Everything the handler needs, injected so it is testable without a daemon. */
export interface CodexSearchRouteDeps {
  /** Resolved ONCE per request by the caller, before any wire bytes. */
  readonly mode: SearchFrontendMode;
  /**
   * The single shared runtime. Absent behaves exactly like mode `off`.
   *
   * Selection and fallback policy live INSIDE it (阶段3): this route never
   * builds a candidate list, and adding a per-request policy override here
   * would be the second fallback order the extraction exists to prevent.
   */
  readonly runtime?: SearchRuntime | null;
  /** Cancellation, wired to the client connection by the caller. */
  readonly signal?: AbortSignal;
  /**
   * Audit hook. The route calls this with the raw body and the parsed object so
   * the caller can stash the body and derive the session key — the mechanism
   * that unblocks `/v1/alpha/search` body capture (see the module note).
   */
  readonly onRequestBody?: (raw: string, parsed: Record<string, unknown>) => void;
}

/** `POST` + a path ending in `/alpha/search`. Nothing else is this route. */
export function isCodexSearchRequest(
  method: string | undefined,
  url: string | undefined,
): boolean {
  if (method !== 'POST' || !url) return false;
  const path = url.split('?')[0] ?? '';
  const segments = path.split('/').filter(Boolean);
  if (segments.length < ROUTE_SUFFIX.length) return false;
  const offset = segments.length - ROUTE_SUFFIX.length;
  return ROUTE_SUFFIX.every((segment, index) => segments[offset + index] === segment);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The `unsupported_capability` error mode `off` answers with. */
export function searchCapabilityOffError(): OpenAIOperationError {
  return new OpenAIOperationError({
    // A 4xx, deliberately not 404: the route EXISTS and is understood, it is
    // just not enabled here, and a client that treats 404 as "no such gateway"
    // would draw the wrong conclusion. Plan §15 forbids the bare 404; the code
    // below is the part clients and operators are meant to read.
    status: 400,
    code: SEARCH_UNSUPPORTED_CAPABILITY_CODE,
    message:
      `Omnicross-managed search is not enabled for the Codex frontend ` +
      `(set search.modes.codex to 'managed' to enable it)`,
  });
}

/**
 * Read the body with a hard byte cap; oversize is a protocol error, not an OOM.
 *
 * On overflow the stream is PAUSED, never destroyed. Destroying `req` tears
 * down the socket it shares with `res`, so the structured 413 the handler is
 * about to write would land on a dead connection and the client would see a
 * reset instead of an error it can read. The caller destroys the request only
 * after the response is out.
 */
function readBoundedBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      req.pause();
      reject(error);
    };
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        fail(oversizeBodyError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', fail);
  });
}

/** The 413 an oversize body produces. Its status is the caller's cleanup cue. */
function oversizeBodyError(): OpenAIOperationError {
  return new OpenAIOperationError({
    status: 413,
    code: 'invalid_request',
    message: `Search request body exceeds ${MAX_REQUEST_BYTES} bytes`,
  });
}

/**
 * Pull the query out of a parsed body, or explain what was missing.
 *
 * Deliberately total and deliberately small — see {@link TOLERATED_QUERY_FIELDS}.
 */
export function parseCodexSearchQuery(parsed: unknown): string {
  if (!isRecord(parsed)) {
    throw new OpenAIOperationError({
      status: 400,
      code: 'invalid_request',
      message: 'Search request body must be a JSON object',
    });
  }

  const commands = parsed.commands;
  if (isRecord(commands) && Array.isArray(commands.search_query)) {
    for (const operation of commands.search_query) {
      if (!isRecord(operation)) continue;
      const query = validatedQuery(operation.q);
      if (query) return query;
    }
  }

  for (const field of TOLERATED_QUERY_FIELDS) {
    const query = validatedQuery(parsed[field]);
    if (query) return query;
  }
  throw new OpenAIOperationError({
    status: 400,
    code: 'invalid_request',
    message:
      `Search request carries no query string; expected a non-empty ` +
      `'commands.search_query[].q' or ` +
      `${TOLERATED_QUERY_FIELDS.map((field) => `'${field}'`).join(' / ')} field`,
  });
}

function validatedQuery(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const query = value.trim();
  if (!query) return null;
  if (query.length > MAX_QUERY_LENGTH) {
    throw new OpenAIOperationError({
      status: 400,
      code: 'invalid_request',
      message: `Search query exceeds ${MAX_QUERY_LENGTH} characters`,
    });
  }
  return query;
}

/**
 * Codex-compatible response with additional Omnicross provenance fields.
 * Codex ignores unknown fields and consumes `output` plus opaque `results`.
 */
export interface CodexSearchResponseBody {
  readonly object: 'omnicross.search.results';
  readonly query: string;
  readonly provider: string;
  readonly output: string;
  readonly results: ReadonlyArray<{
    type: 'text_result';
    ref_id: string;
    title: string;
    url: string;
    snippet: string;
  }>;
}

/** Project an orchestrated response onto the documented response shape. */
export function toCodexSearchResponseBody(
  response: OrchestratedSearchResponse,
): CodexSearchResponseBody {
  const results = response.results.map((result, index) => ({
    type: 'text_result' as const,
    ref_id: `turn0search${index}`,
    title: result.title,
    url: result.url,
    snippet: result.content,
  }));
  return {
    object: 'omnicross.search.results',
    query: response.query,
    provider: response.providerId,
    output: formatCodexSearchOutput(response),
    results,
  };
}

function formatCodexSearchOutput(response: OrchestratedSearchResponse): string {
  if (response.results.length === 0) {
    return `No search results found for "${response.query}".`;
  }
  const rendered = response.results.map(
    (result, index) => `[${index + 1}] ${result.title}\nURL: ${result.url}\n${result.content}`,
  );
  return `Search results for "${response.query}":\n\n${rendered.join('\n\n')}`;
}

/** Map a runtime failure onto the local error envelope. */
function searchFailureError(error: unknown): OpenAIOperationError {
  if (error instanceof OpenAIOperationError) return error;
  const shape = toSearchErrorShape(error);
  const status = searchErrorHttpStatus(shape.code);
  return new OpenAIOperationError({
    status,
    code: shape.code,
    message: shape.message,
    retryable: shape.retryable === true,
  });
}

/**
 * Serve one `POST /v1/alpha/search`.
 *
 * Always answers: a structured JSON error or a structured JSON result, never a
 * hang, never a bare 404. The caller has already authenticated the request and
 * resolved `deps.mode`.
 */
export async function handleCodexSearchRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: CodexSearchRouteDeps,
): Promise<void> {
  const runtime = deps.runtime ?? null;
  // `off`, `native` and a missing runtime all land here. `native` is included
  // deliberately: there is no upstream passthrough for this route — Codex is
  // asking OMNICROSS to search — so claiming a native lane would be a lie. The
  // mode model still carries `native` for the other two frontends.
  if (deps.mode !== 'managed' || !runtime) {
    writeOpenAIOperationError(res, searchCapabilityOffError());
    return;
  }

  try {
    const raw = await readBoundedBody(req);
    let parsed: unknown;
    let parseFailed = false;
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      parseFailed = true;
    }
    // The hook fires for EVERY body that was read, whatever shape it turned out
    // to be — including one that is not JSON at all. A real codex-tui body we
    // cannot parse is the single most informative capture this route could
    // produce, since the request schema is UNVERIFIED; dropping it because it
    // failed our guess would discard exactly the evidence that would correct
    // the guess. The second argument is what the session key is derived from,
    // so a non-object body still gets a key (from the route-scoped fallback).
    deps.onRequestBody?.(raw, isRecord(parsed) ? parsed : {});
    if (parseFailed) {
      throw new OpenAIOperationError({
        status: 400,
        code: 'invalid_request',
        message: 'Search request body is not valid JSON',
      });
    }

    const query = parseCodexSearchQuery(parsed);
    const response = await runtime.search({
      query,
      options: { ...(deps.signal ? { signal: deps.signal } : {}) },
    });
    if (res.writableEnded || res.headersSent) return;
    const body = JSON.stringify(toCodexSearchResponseBody(response));
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body, 'utf8')),
    });
    res.end(body);
  } catch (error) {
    const failure = searchFailureError(error);
    writeOpenAIOperationError(res, failure);
    // The response is out; only now is it safe to abandon a body we refused to
    // finish reading. Draining it instead would be unbounded work on a request
    // that already exceeded its cap.
    if (failure.status === 413 && !req.destroyed) req.destroy();
  }
}
