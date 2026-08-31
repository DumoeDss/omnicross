/**
 * auditCapture — the outbound server's post-response audit capture hook
 * (request-audit-log, design D1/D3/D5).
 *
 * {@link beginAuditCapture} is called at the TOP of `handleOutboundRequest`. It
 * reads the active capture config from the core slot; when audit is DISABLED it
 * returns `null` immediately (one slot read — no assembly, no listener, zero
 * regression). When enabled it:
 *  - registers a one-shot `res.on('close')` listener that, at response end,
 *    assembles the {@link AuditRecord} from the http `req` (IP via the socket, or
 *    a trusted `X-Forwarded-For` only when configured — LEAD OQ1 anti-spoof; UA;
 *    method; path with the query string DROPPED), the response `statusCode`, the
 *    elapsed ms, and the fields the handler fills in (keyId / model / provider /
 *    error / bodies) — then hands it to the fire-and-forget `recordAudit`;
 *  - when `captureBodies` is ALSO on, wraps `res.write`/`res.end` to accumulate
 *    the response body, including a streaming `text/event-stream`. The default
 *    `maxBodyBytes:-1` captures the full body; a non-negative limit retains only
 *    a bounded UTF-8 prefix.
 *
 * Request HEADERS are NEVER read into a record (Authorization / x-api-key live
 * there). Every stored body passes through {@link redactAuditText}. The assembly
 * is wrapped so a capture failure can never surface into the relay path.
 *
 * @module @omnicross/core/outbound-api/auditCapture
 */

import { randomUUID } from 'node:crypto';
import type http from 'node:http';

import type { AuditConfig, AuditRecord } from '@omnicross/contracts/audit-types';

import { getAuditCaptureConfig, recordAudit } from '../pipeline/auditSink';
import { readAuditUsage } from '../pipeline/auditUsageStash';

import { redactAuditText } from './auditRedact';
import { compactSseBody } from './auditSseCompact';

/** Return the largest prefix ending on a complete UTF-8 code point. */
function completeUtf8PrefixLength(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let leadIndex = buf.length - 1;
  while (leadIndex >= 0 && (buf[leadIndex]! & 0xc0) === 0x80) leadIndex -= 1;
  if (leadIndex < 0) return 0;

  const lead = buf[leadIndex]!;
  let expectedLength = 1;
  if ((lead & 0xe0) === 0xc0) expectedLength = 2;
  else if ((lead & 0xf0) === 0xe0) expectedLength = 3;
  else if ((lead & 0xf8) === 0xf0) expectedLength = 4;
  return buf.length - leadIndex < expectedLength ? leadIndex : buf.length;
}

/** Truncate a UTF-8 string without emitting a replacement character at the cut. */
function truncateToBytes(text: string, maxBytes: number): string {
  if (maxBytes < 0) return text;
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  const head = buf.subarray(0, maxBytes);
  return head.subarray(0, completeUtf8PrefixLength(head)).toString('utf8');
}

/** Decode a captured byte prefix, dropping only an incomplete truncated tail. */
function decodeCapturedBody(body: Buffer, truncated: boolean): string {
  if (!truncated) return body.toString('utf8');
  return body.subarray(0, completeUtf8PrefixLength(body)).toString('utf8');
}

/**
 * The mutable context the request handler enriches as it progresses. `null` is
 * returned by {@link beginAuditCapture} when audit is disabled — the handler
 * guards every write with `if (audit)`.
 */
export interface AuditCaptureContext {
  /** Outbound key id (set after auth). NEVER the key material. */
  keyId?: string | null;
  /** Resolved upstream model (set after route resolution). */
  model?: string;
  /** Upstream provider id (set after route resolution). */
  provider?: string;
  /** Sanitized error message (set on a relay/dispatch failure). */
  error?: string;
  /**
   * Derived conversation-session key (set by the router once the request body is
   * parsed). Shards the audit body store and anchors its per-turn delta chain.
   * A truncated digest — NEVER a raw client id.
   */
  sessionKey?: string;
  /** Stash the raw request body for capture (a no-op unless `captureBodies`). */
  setRequestBody(raw: string): void;
  /**
   * Permanently discard and disable request/response body capture for this
   * request while retaining metadata and usage attribution. Idempotent and
   * intentionally one-way: a later caller cannot re-enable body persistence.
   */
  suppressBodies(): void;
}

/** Per-request capture policy selected before any response wrapper is installed. */
export interface AuditCaptureOptions {
  /** Preserve metadata while structurally preventing request/response body capture. */
  suppressBodies?: boolean;
}

/** Resolve the client IP: socket by default; a trusted `X-Forwarded-For` only when configured. */
function resolveClientIp(req: http.IncomingMessage, trustForwardedFor: boolean): string | undefined {
  if (trustForwardedFor) {
    const xff = req.headers['x-forwarded-for'];
    const raw = Array.isArray(xff) ? xff[0] : xff;
    if (typeof raw === 'string' && raw.trim()) {
      // The left-most hop is the original client (only trusted behind a proxy).
      const first = raw.split(',')[0]?.trim();
      if (first) return first;
    }
  }
  return req.socket?.remoteAddress ?? undefined;
}

/**
 * Begin audit capture for one request. Returns a mutable context the handler
 * enriches, or `null` when audit is disabled (zero-cost path). The record is
 * emitted on response `close` via the fire-and-forget sink.
 */
export function beginAuditCapture(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  now: number,
  options?: AuditCaptureOptions,
): AuditCaptureContext | null {
  const config: AuditConfig | null = getAuditCaptureConfig();
  if (!config) return null;
  const captureBodies = config.captureBodies;

  let requestBody: string | undefined;
  const responseChunks: Buffer[] = [];
  let responseBytes = 0;
  let responseTruncated = false;
  let bodiesSuppressed = options?.suppressBodies === true;
  let finished = false;

  const ctx: AuditCaptureContext = {
    setRequestBody(raw: string): void {
      if (captureBodies && !bodiesSuppressed) {
        requestBody = truncateToBytes(redactAuditText(raw), config.maxBodyBytes);
      }
    },
    suppressBodies(): void {
      if (bodiesSuppressed) return;
      bodiesSuppressed = true;
      requestBody = undefined;
      responseChunks.length = 0;
      responseBytes = 0;
      responseTruncated = false;
    },
  };

  // Response-body capture is installed ONLY when bodies are opted in. It records
  // streaming responses too. A non-negative limit bounds the retained prefix;
  // `-1` deliberately retains the full response. The original response is always
  // delegated verbatim.
  if (captureBodies && !bodiesSuppressed) {
    installResponseCapture(res, {
      push(chunk: Buffer): void {
        if (bodiesSuppressed) return;
        if (config.maxBodyBytes < 0) {
          responseChunks.push(chunk);
          responseBytes += chunk.length;
          return;
        }
        const remaining = config.maxBodyBytes - responseBytes;
        if (remaining <= 0) {
          responseTruncated = true;
          return;
        }
        if (chunk.length > remaining) {
          responseChunks.push(chunk.subarray(0, remaining));
          responseBytes += remaining;
          responseTruncated = true;
          return;
        }
        responseChunks.push(chunk);
        responseBytes += chunk.length;
      },
    });
  }

  const finalize = (): void => {
    if (finished) return;
    finished = true;
    try {
      const record: AuditRecord = {
        id: randomUUID(),
        ts: now,
        method: req.method ?? '',
        path: (req.url ?? '').split('?')[0] ?? '',
        status: res.statusCode,
        latencyMs: Math.max(0, Date.now() - now),
      };
      if (ctx.keyId != null) record.keyId = ctx.keyId;
      const ip = resolveClientIp(req, config.trustForwardedFor);
      if (ip) record.ip = ip;
      const ua = req.headers['user-agent'];
      if (typeof ua === 'string' && ua) record.ua = ua;
      if (ctx.model) record.model = ctx.model;
      if (ctx.provider) record.provider = ctx.provider;
      // Usage correlation (request-audit-log): the downstream usage tap stashed
      // this request's token counts (synchronously ⇒ reliably present) + cost (on
      // the deferred pricing tick ⇒ best-effort) keyed by this same `res`. Enrich
      // the record so it is self-contained (no join with usage-events.jsonl).
      const usage = readAuditUsage(res);
      if (usage) {
        if (typeof usage.inputTokens === 'number') record.inputTokens = usage.inputTokens;
        if (typeof usage.outputTokens === 'number') record.outputTokens = usage.outputTokens;
        if (typeof usage.costUsd === 'number') record.costUsd = usage.costUsd;
        // Fall back to the usage tap's resolved model when the route did not set one.
        if (!record.model && usage.model) record.model = usage.model;
        if (!record.provider && usage.provider) record.provider = usage.provider;
      }
      if (ctx.error) record.error = redactAuditText(ctx.error);
      if (ctx.sessionKey) record.sessionKey = ctx.sessionKey;
      if (captureBodies && !bodiesSuppressed) {
        if (requestBody != null && requestBody.length > 0) {
          record.requestBody = requestBody;
        }
        if (responseChunks.length > 0) {
          const captured = Buffer.concat(responseChunks, responseBytes);
          const decoded = decodeCapturedBody(captured, responseTruncated);
          // Compaction (opt-in) runs BEFORE redaction so every frame it retains
          // still passes through the secret scan.
          const body = config.compactStreamingBodies ? compactSseBody(decoded) : decoded;
          record.responseBody = truncateToBytes(redactAuditText(body), config.maxBodyBytes);
        }
        // The sink persists bodies to the per-session store rather than inline on
        // the metadata line; this flag is how a query knows one exists.
        if (record.requestBody !== undefined || record.responseBody !== undefined) {
          record.hasBody = true;
        }
      }
      recordAudit(record);
    } catch {
      // A capture failure must NEVER surface into the relay path.
    }
  };

  res.once('close', finalize);
  return ctx;
}

/** The accumulator the response-capture wrapper feeds. */
interface ResponseCaptureSink {
  push(chunk: Buffer): void;
}

/**
 * Wrap `res.write`/`res.end` to capture the response body (streaming responses
 * included). The sink applies the configured bound. Every original call is
 * delegated verbatim so the client response is unaffected.
 */
function installResponseCapture(res: http.ServerResponse, sink: ResponseCaptureSink): void {
  const capture = (chunk: unknown): void => {
    let buf: Buffer | null = null;
    if (Buffer.isBuffer(chunk)) buf = chunk;
    else if (typeof chunk === 'string') buf = Buffer.from(chunk, 'utf8');
    if (!buf || buf.length === 0) return;
    sink.push(buf);
  };

  const originalWrite = res.write.bind(res) as http.ServerResponse['write'];
  const originalEnd = res.end.bind(res) as http.ServerResponse['end'];

  res.write = ((chunk: unknown, ...args: unknown[]) => {
    if (chunk != null) capture(chunk);
    return (originalWrite as (...a: unknown[]) => boolean)(chunk, ...args);
  }) as http.ServerResponse['write'];

  res.end = ((chunk?: unknown, ...args: unknown[]) => {
    if (chunk != null && typeof chunk !== 'function') capture(chunk);
    return (originalEnd as (...a: unknown[]) => http.ServerResponse)(chunk, ...args);
  }) as http.ServerResponse['end'];
}
