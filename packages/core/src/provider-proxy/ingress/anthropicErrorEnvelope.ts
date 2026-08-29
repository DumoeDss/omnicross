/**
 * anthropicErrorEnvelope — Anthropic-protocol error shaping for LOCALLY
 * generated errors (`claude-api-routing-errors`, R3 / audit F-2).
 *
 * Anthropic SDK clients type-parse error bodies via the top-level
 * `{"type":"error","error":{"type","message"}}` discriminated shape. The
 * gateway's local errors (auth, rate limit, routing, pipeline failures) used
 * to answer with the internal `outbound_api_error` / `provider_proxy_error`
 * envelopes, which no Anthropic SDK can type-parse and which break Claude
 * Code's wording-based recovery. This module gives those local errors the
 * official Anthropic shape — WITHOUT touching upstream errors, which stay
 * verbatim with their real status (the same-format moat).
 *
 * Mechanism (design D4): each serving face marks the `res` object at the very
 * top of its request pipeline (before auth) when the request path classifies
 * as Anthropic-protocol. Every local error writer then consults the mark:
 * marked → Anthropic envelope, unmarked → byte-identical legacy envelope. The
 * mark rides the `res` object into deep error sites (plan builders, pipeline
 * catches) with zero parameter threading, and it can never affect relayed
 * upstream bytes — `relayResponse` writes those directly via `writeHead`/`end`
 * without passing through any writer here.
 *
 * @module provider-proxy/ingress/anthropicErrorEnvelope
 */

import type http from 'node:http';

/** Symbol key under which the Anthropic-protocol mark rides the `res` object. */
const anthropicProtocolMarker = Symbol('omnicross.anthropicProtocolResponse');

/**
 * Mark `res` as serving an Anthropic-protocol request. Called ONCE per request
 * at the pipeline entry (before auth) whenever
 * `classifyAnthropicMessagesPath(req.url) !== null`.
 */
export function markAnthropicProtocolResponse(res: http.ServerResponse): void {
  (res as unknown as Record<symbol, boolean>)[anthropicProtocolMarker] = true;
}

/** Whether `res` was marked as serving an Anthropic-protocol request. */
export function isAnthropicProtocolResponse(res: http.ServerResponse): boolean {
  return (res as unknown as Record<symbol, boolean>)[anthropicProtocolMarker] === true;
}

/**
 * Map an HTTP status to the Anthropic `error.type` vocabulary (requirements
 * §6 error-protocol table). 402 maps to `rate_limit_error` — the Anthropic
 * spend-cap semantics — with all cost fields preserved inside `error`.
 * Unmapped statuses degrade to `api_error`.
 */
export function anthropicErrorTypeForStatus(status: number): string {
  switch (status) {
    case 400:
      return 'invalid_request_error';
    case 401:
      return 'authentication_error';
    case 402:
    case 429:
      return 'rate_limit_error';
    case 403:
      return 'permission_error';
    case 404:
    case 501:
      return 'not_found_error';
    case 499:
    case 502:
    case 503:
      return 'api_error';
    default:
      return 'api_error';
  }
}

/**
 * Write an Anthropic-shaped error body:
 * `{"type":"error","error":{"type","message",…details}}`. Extra machine-readable
 * fields (`code`/`reason`, `scope`/`limitUsd`/`spentUsd`, …) fold INTO the
 * `error` object — the official Anthropic error body itself carries additional
 * keys and the SDK tolerates them. `headers` pass through (e.g. `Retry-After`).
 * Silent no-op once headers were sent (same short-circuit semantics as the
 * legacy writers — never truncate an already-streaming response).
 */
export function writeAnthropicError(
  res: http.ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {},
  details: Record<string, unknown> = {},
): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(
    JSON.stringify({
      type: 'error',
      error: { type: anthropicErrorTypeForStatus(status), message, ...details },
    }),
  );
}
