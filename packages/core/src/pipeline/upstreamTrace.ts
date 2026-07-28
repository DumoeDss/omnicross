/**
 * upstreamTrace — opt-in COMPLETE upstream-exchange capture for debugging
 * (the omnicross → provider leg, e.g. the codex Responses call).
 *
 * The request-audit-log (`auditCapture`) only sees the CLIENT-facing leg
 * (what the client sent to omnicross + what omnicross returned). It can NOT
 * show the actual upstream provider request/response — and for a streaming
 * codex reply it records metadata only. Every protocol-level codex bug
 * (missing `Content-Type`, `store:false`, `input_text`, …) lives in the
 * UPSTREAM exchange, so this module captures it verbatim.
 *
 * {@link fetchUpstream} is the single egress seam for every upstream call.
 * When a trace path is installed it clones the response, reads the FULL body
 * (a `text/event-stream` included — `clone().text()` tees the stream so the
 * relay keeps streaming the original while the clone is buffered for the
 * trace), and appends one {@link UpstreamTraceRecord} JSON line. Relay calls
 * carry an opaque `providerId`; OAuth-refresh / webhook sends do not, so they
 * are skipped (less noise). Tracing is fire-and-forget: a read/write failure
 * is swallowed so the egress path is never affected.
 *
 * The daemon installs the path via {@link setUpstreamTracePath} (gated on the
 * audit segment's `captureBodies`, hot-reloaded like the audit sink). Absent a
 * path the trace is a pure no-op — byte-identical zero regression.
 *
 * Secret discipline: request/response AUTHORIZATION + api-key HEADER values are
 * masked (`***REDACTED***`) — they are OAuth bearer tokens, not the thing under
 * test, and a plaintext trace file must not hold them. Header KEYS stay visible
 * so presence is verifiable. The request/response BODIES are captured VERBATIM
 * (a prompt / a codex SSE stream) — that is the whole point.
 *
 * @module @omnicross/core/pipeline/upstreamTrace
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/** The JSONL file upstream exchanges are appended to, or `null` (trace off). */
let tracePath: string | null = null;

/** Header names whose VALUES are masked (bearer tokens / api keys). */
const SECRET_HEADER_NAMES = new Set([
  'authorization',
  'api-key',
  'x-api-key',
  'x-goog-api-key',
]);

/**
 * Install (or clear, with `null`/blank) the trace file path. Idempotent — last
 * write wins. The path is resolved by the daemon relative to the audit store.
 */
export function setUpstreamTracePath(path: string | null): void {
  tracePath = typeof path === 'string' && path.trim() ? path.trim() : null;
}

/** The active trace file path, or `null` when tracing is disabled. */
export function getUpstreamTracePath(): string | null {
  return tracePath;
}

/**
 * Mask secret header values while keeping the keys. Accepts a web `Headers`
 * (from a fetch response) or a plain `Record<string,string>` (from a relay
 * `buildHeaders`). Never throws.
 */
export function redactHeaders(
  headers:
    | Headers
    | Record<string, string>
    | Array<[string, string]>
    | undefined
    | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  // Branch on the ACTUAL shape: a `Headers`, a flat record, or a `[key,value]`
  // pair array (HeadersInit allows all three). An array also has `.entries()`
  // (index→pair), so the Array check MUST come first or pair-array headers
  // would slip through with secrets unredacted.
  let entries: Array<[string, string]>;
  if (Array.isArray(headers)) {
    entries = headers as Array<[string, string]>;
  } else if (typeof (headers as Headers).entries === 'function') {
    entries = Array.from((headers as Headers).entries());
  } else {
    entries = Object.entries(headers as Record<string, string>);
  }
  for (const [key, value] of entries) {
    out[key] = SECRET_HEADER_NAMES.has(key.toLowerCase())
      ? '***REDACTED***'
      : String(value);
  }
  return out;
}

/** One complete upstream-exchange trace record (appended as one JSON line). */
export interface UpstreamTraceRecord {
  /** Epoch ms the call started (request send time). */
  ts: number;
  /** Round-trip duration in ms (response fully read). */
  durationMs: number;
  /** The opaque relay provider id (`codex`/`claude`/`gemini`/`opencodego`/`byo`). */
  providerId?: string;
  /** The selected pooled account id, when the relay reported one. */
  accountId?: string;
  /** The upstream URL the request was sent to. */
  url: string;
  /** HTTP method. */
  method: string;
  /** Outbound request headers (secret values masked). */
  requestHeaders: Record<string, string>;
  /** Outbound request body verbatim (the codex Responses payload), when a string. */
  requestBody: string | null;
  /** Upstream HTTP status (`0` when the fetch itself failed). */
  status: number;
  /** Upstream HTTP status text. */
  statusText: string;
  /** Upstream response headers. */
  responseHeaders: Record<string, string>;
  /** Upstream response body verbatim — the FULL `text/event-stream` for a stream. */
  responseBody: string;
  /** Response body size in UTF-8 bytes. */
  responseBytes: number;
}

/**
 * Append one trace record to the installed file. A no-op (zero work) when no
 * path is installed. Fire-and-forget safe: any fs error is swallowed — a trace
 * failure must NEVER surface into the egress path. ASYNC so a slow disk / large
 * SSE body never blocks the event loop (the call site does not await it).
 */
export async function writeUpstreamTrace(
  record: UpstreamTraceRecord,
): Promise<void> {
  const path = tracePath;
  if (!path) return;
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(record) + '\n', 'utf8');
  } catch {
    // A trace write failure must never propagate into the relay path.
  }
}

/** TEST SEAM — clear the trace path so a suite starts from the no-trace baseline. */
export function __resetUpstreamTraceForTests(): void {
  tracePath = null;
}
