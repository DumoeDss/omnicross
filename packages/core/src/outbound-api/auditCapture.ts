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
 *  - when `captureBodies` is ALSO on, wraps `res.write`/`res.end` to accumulate a
 *    BOUNDED response body (metadata-only for a streaming `text/event-stream`
 *    response — a full stream is unbounded), and truncates+redacts both bodies.
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
  /** Stash the raw request body for capture (a no-op unless `captureBodies`). */
  setRequestBody(raw: string): void;
}

/** Content-types treated as streaming (response body recorded as metadata only). */
function isStreamingContentType(res: http.ServerResponse): boolean {
  const ct = res.getHeader('content-type');
  const value = Array.isArray(ct) ? ct.join(';') : String(ct ?? '');
  return value.toLowerCase().includes('text/event-stream');
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

/** Truncate a UTF-8 string to at most `maxBytes` bytes (may cut a multibyte tail). */
function truncateToBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  return buf.subarray(0, maxBytes).toString('utf8');
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
): AuditCaptureContext | null {
  const config: AuditConfig | null = getAuditCaptureConfig();
  if (!config) return null;

  let rawRequestBody: string | undefined;
  const responseChunks: Buffer[] = [];
  let responseBytes = 0;
  let streamDetected = false;
  let finished = false;

  const ctx: AuditCaptureContext = {
    setRequestBody(raw: string): void {
      if (config.captureBodies) rawRequestBody = raw;
    },
  };

  // Response-body capture is installed ONLY when bodies are opted in. It records
  // a BOUNDED head and drops entirely once a streaming response is detected.
  if (config.captureBodies) {
    installResponseCapture(res, config.maxBodyBytes, {
      push(chunk: Buffer): void {
        responseBytes += chunk.length;
        responseChunks.push(chunk);
      },
      get bytes() {
        return responseBytes;
      },
      markStream(): void {
        streamDetected = true;
      },
      get isStream() {
        return streamDetected;
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
      if (config.captureBodies) {
        if (rawRequestBody != null && rawRequestBody.length > 0) {
          record.requestBody = redactAuditText(truncateToBytes(rawRequestBody, config.maxBodyBytes));
        }
        // Streaming responses record metadata only (a full stream is unbounded).
        if (!streamDetected && responseChunks.length > 0) {
          const body = Buffer.concat(responseChunks).toString('utf8');
          record.responseBody = redactAuditText(body);
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

/** The bounded accumulator the response-capture wrapper feeds. */
interface ResponseCaptureSink {
  push(chunk: Buffer): void;
  readonly bytes: number;
  markStream(): void;
  readonly isStream: boolean;
}

/**
 * Wrap `res.write`/`res.end` to accumulate a BOUNDED response-body head. Once a
 * streaming response is detected (via its Content-Type on the first chunk) it
 * marks the sink as a stream and stops accumulating (metadata only). Every
 * original call is delegated verbatim so the response itself is unaffected.
 */
function installResponseCapture(
  res: http.ServerResponse,
  maxBodyBytes: number,
  sink: ResponseCaptureSink,
): void {
  let contentTypeChecked = false;
  const capture = (chunk: unknown): void => {
    if (sink.isStream) return;
    if (!contentTypeChecked) {
      contentTypeChecked = true;
      if (isStreamingContentType(res)) {
        sink.markStream();
        return;
      }
    }
    if (sink.bytes >= maxBodyBytes) return;
    let buf: Buffer | null = null;
    if (Buffer.isBuffer(chunk)) buf = chunk;
    else if (typeof chunk === 'string') buf = Buffer.from(chunk, 'utf8');
    if (!buf || buf.length === 0) return;
    const remaining = maxBodyBytes - sink.bytes;
    sink.push(buf.length > remaining ? buf.subarray(0, remaining) : buf);
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
