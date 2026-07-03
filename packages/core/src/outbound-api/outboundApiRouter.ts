/**
 * outboundApiRouter — the per-request pipeline for the outbound API server
 * (`outbound-api-server`, design D1/D2).
 *
 * For every inbound request:
 *   1. AUTH — extract the external named API key (`Authorization: Bearer <key>`
 *      / `x-api-key` / `x-goog-api-key`) and verify it (→ 401 on miss / disabled
 *      / revoked). API-key auth is enforced on EVERY request incl. loopback.
 *   2. RATE LIMIT — per-key sliding window (→ 429 + `Retry-After`).
 *   3. ENDPOINT SELECT — match method+path to one of the four endpoints (→ 404).
 *   4. ROLE + ROUTE — read the body, detect the role, resolve a `RouteContext`
 *      from that endpoint's live config (→ 503 on a routing error).
 *   5. DISPATCH — mint the route on the SHARED `ProviderProxyRouteMap`
 *      (`addRoute → token`), shim the forwarded request's auth header to the
 *      route token, and delegate to the existing `routeRequest()` so the four
 *      ingress parsers + transformer are reused. `removeRoute(token)` in a
 *      `finally`. Streaming is preserved (no buffering).
 *
 * @module outbound-api/outboundApiRouter
 */

import type http from 'node:http';
import { Readable } from 'node:stream';

import { serializeError } from '@omnicross/core/serializeError';

import { routeRequest } from '../provider-proxy/providerProxyRouter';

import { isKindMappedEndpoint } from './kindDetection';
import { verifyPresentedKey } from './outboundApiKeyAuth';
import type { OutboundRateLimiter } from './outboundRateLimiter';
import { detectRequestRole, endpointToIngressFormat, extractRequestedModel } from './roleDetection';
import { parseModelRef, resolveRoute } from './routeResolver';
import type { EndpointRoutingConfig, OutboundApiDeps, OutboundEndpoint } from './types';

/** Per-request config the listener supplies (read live, no restart). */
export interface OutboundRequestConfig {
  endpoints: EndpointRoutingConfig[];
}

/** Write a JSON error response with a status + optional headers. */
function writeJsonError(
  res: http.ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify({ error: { type: 'outbound_api_error', message } }));
}

/** Extract the presented external API key from the auth headers. */
export function extractPresentedKey(req: http.IncomingMessage): string | undefined {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.trim()) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    return (m ? m[1] : auth).trim() || undefined;
  }
  const xApiKey = req.headers['x-api-key'];
  const xApi = Array.isArray(xApiKey) ? xApiKey[0] : xApiKey;
  if (xApi?.trim()) return xApi.trim();
  const goog = req.headers['x-goog-api-key'];
  const g = Array.isArray(goog) ? goog[0] : goog;
  return g?.trim() || undefined;
}

/** Match an HTTP method+path to one of the four outbound endpoints. */
export function selectEndpoint(
  method: string | undefined,
  url: string | undefined,
): OutboundEndpoint | null {
  if (method !== 'POST' || !url) return null;
  const path = url.split('?')[0]?.replace(/\/+$/, '') ?? '';
  if (path.endsWith('/chat/completions')) return 'chat';
  if (path.endsWith('/responses')) return 'responses';
  // m3: require `/v1/messages` so selection AGREES with the shared dispatcher's
  // `isAnthropicMessagesRequest` (`url.includes('/v1/messages')`). A bare
  // `/messages` would otherwise be selected, mint a route, then 404 in dispatch.
  if (path.includes('/v1/messages')) return 'messages';
  const lastSeg = path.split('/').pop() ?? '';
  if (lastSeg.endsWith(':generateContent') || lastSeg.endsWith(':streamGenerateContent')) {
    return 'gemini';
  }
  return null;
}

/**
 * Extract the model id from a Gemini generateContent URL
 * (`.../v1beta/models/<model>:generateContent` or `:streamGenerateContent`).
 * Returns `undefined` when the path doesn't match. Used for background-tier role
 * detection (m4) since Gemini carries the model in the path, not the body.
 */
export function extractGeminiModelFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const path = url.split('?')[0] ?? '';
  const m = /\/models\/([^/:]+):(?:stream)?[gG]enerateContent$/.exec(path.replace(/\/+$/, ''));
  return m ? decodeURIComponent(m[1]) : undefined;
}

/** True for `GET <base>/models` (the OpenAI model-list discovery route). */
export function isModelsListRequest(url: string | undefined): boolean {
  if (!url) return false;
  const path = url.split('?')[0]?.replace(/\/+$/, '') ?? '';
  return path.endsWith('/models');
}

/**
 * Serve the chat endpoint's configured model list in the OpenAI `GET /v1/models`
 * shape. The advertised `id` is each ref's modelId — exactly the name
 * `pickModelRefFromList` matches on the request path. An unconfigured chat
 * endpoint serves an empty list (valid shape; the endpoint is simply unused).
 */
function writeChatModelsList(res: http.ServerResponse, config: OutboundRequestConfig): void {
  const chat = config.endpoints.find((e) => e.endpoint === 'chat');
  const data = (chat?.models ?? [])
    .map((ref) => parseModelRef(ref))
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .map((p) => ({ id: p.modelId, object: 'model', owned_by: 'omnicross' }));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ object: 'list', data }));
}

/** Read the full request body as a string (used to detect the role). */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Rewrite the forwarded request so the shared `routeRequest()` authenticates by
 * the freshly minted route token. `routeRequest` reads `Authorization` first
 * then `x-goog-api-key`; we set `authorization` to the token and clear the
 * Gemini header so there's no ambiguity. The external key never reaches the
 * shared dispatch.
 */
function shimAuthHeader(req: http.IncomingMessage, routeToken: string): void {
  req.headers['authorization'] = `Bearer ${routeToken}`;
  delete req.headers['x-goog-api-key'];
  delete req.headers['x-api-key'];
}

/**
 * Handle one outbound request end-to-end. `deps` carries the shared proxy +
 * llmConfig; `config` is the live per-endpoint routing config.
 */
export async function handleOutboundRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: OutboundApiDeps,
  config: OutboundRequestConfig,
  rateLimiter: OutboundRateLimiter,
): Promise<void> {
  // 1. AUTH — external named API key (enforced on every request incl. loopback).
  const presented = extractPresentedKey(req);
  const verified = await verifyPresentedKey(deps.db, presented);
  if (!verified) {
    writeJsonError(res, 401, 'Invalid or missing API key');
    return;
  }

  // 2. RATE LIMIT.
  const decision = rateLimiter.check(verified.id);
  if (!decision.allowed) {
    writeJsonError(res, 429, 'Rate limit exceeded', {
      'Retry-After': String(decision.retryAfterSeconds),
    });
    return;
  }

  // 3. ENDPOINT SELECT. `GET <base>/models` serves the chat endpoint's
  // configured model list (OpenAI list shape) so generic OpenAI clients can
  // discover the names to request — handled before the POST-only selection.
  if (req.method === 'GET' && isModelsListRequest(req.url)) {
    writeChatModelsList(res, config);
    return;
  }
  const endpoint = selectEndpoint(req.method, req.url);
  if (!endpoint) {
    writeJsonError(res, 404, `Unsupported: ${req.method} ${req.url}`);
    return;
  }
  const endpointConfig = config.endpoints.find((e) => e.endpoint === endpoint);
  if (!endpointConfig) {
    writeJsonError(res, 503, `endpoint '${endpoint}' is not configured`);
    return;
  }

  // 4. ROLE + ROUTE. Read the body to detect role, then re-feed it downstream.
  const ingressFormat = endpointToIngressFormat(endpoint);
  const rawBody = await readBody(req);
  let parsedBody: Record<string, unknown> = {};
  try {
    parsedBody = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
  } catch {
    writeJsonError(res, 400, 'Invalid JSON in request body');
    return;
  }

  // m4: Gemini carries its model in the URL path
  // (`/v1beta/models/<model>:generateContent`), not the body, so background-tier
  // detection would never fire. Inject the URL-derived model into the parsed
  // body (detection-only copy — `rawBody` is what gets replayed downstream).
  if (endpoint === 'gemini' && typeof parsedBody['model'] !== 'string') {
    const urlModel = extractGeminiModelFromUrl(req.url);
    if (urlModel) parsedBody['model'] = urlModel;
  }

  // pool-seam (omnicross-daemon-parity-poolseam, design D1/D2(a)): synthesize a
  // STABLE per-verified-key sessionId so the BYO ingress can seed a pool session
  // binding and 429/529/401/403 failover actually fires. Synthesize ONLY when
  // the pool is wired — pool-null embedders/tests keep `route.sessionId === null`
  // (byte-identical to pre-seam). The `outbound:` prefix is namespace-isolated
  // from real chat-session ids; `verified.id` is a small operator-controlled set,
  // so `sessionBindings` stays bounded (one binding per named key, not per
  // request — `sessionBindings` has no TTL).
  const sessionId = deps.proxyDeps.apiKeyPool ? `outbound:${verified.id}` : null;

  // D2: dispatch the classifier by endpoint CLASS. The kind-mapped endpoints
  // (`messages`/`responses`) route by model KIND and carry the client's original
  // requested id through to the response `model` passthrough; the list-mapped
  // `chat` endpoint matches the requested id against its configured model list;
  // the role-based `gemini` endpoint keeps detecting default/background.
  const resolved =
    isKindMappedEndpoint(endpoint) || endpoint === 'chat'
      ? await resolveRoute({
          config: endpointConfig,
          ingressFormat,
          llmConfig: deps.llmConfig,
          sessionId,
          // Capture the ORIGINAL requested id BEFORE any downstream swap; for
          // kind-mapped endpoints it selects the kind AND is stamped onto
          // `route.requestedModel`; for chat it is matched against the list.
          requestedModel: extractRequestedModel(ingressFormat, parsedBody),
          // Attribution: stamp the verified named-key id onto the route.
          apiKeyId: verified.id,
        })
      : await resolveRoute({
          config: endpointConfig,
          role: detectRequestRole(ingressFormat, parsedBody, {
            backgroundModelIds: endpointConfig.backgroundModelIds,
          }),
          ingressFormat,
          llmConfig: deps.llmConfig,
          sessionId,
          // Attribution: stamp the verified named-key id onto the route.
          apiKeyId: verified.id,
        });
  if (!resolved.ok) {
    writeJsonError(res, resolved.error.status, resolved.error.message);
    return;
  }

  // 5. DISPATCH — mint a route on the SHARED map, shim the auth header, delegate
  // to the existing routeRequest, and remove the route in a finally.
  const routeMap = deps.providerProxy.getRouteMap();
  const token = routeMap.addRoute(resolved.route);
  try {
    shimAuthHeader(req, token);
    // We consumed the request stream once to detect the role. Every shared
    // ingress consumer (`readBody` / the Anthropic delegation's own reader)
    // re-reads the body via `req.on('data'/'end')`, so replay the buffered
    // bytes through a fresh readable that carries the request's metadata.
    const replay = makeReplayRequest(req, rawBody);
    await routeRequest(replay, res, routeMap, deps.proxyDeps);
  } catch (err) {
    const message = serializeError(err);
    console.error('[OutboundApi] dispatch error:', message);
    writeJsonError(res, 502, message);
  } finally {
    routeMap.removeRoute(token);
  }
}

/**
 * Build a fresh `IncomingMessage`-shaped readable that replays an
 * already-consumed body. The shared ingress parsers read the body via
 * `req.on('data'/'end')`; the original stream is already at EOF, so we back the
 * replay with a `Readable` carrying the buffered bytes and copy over the
 * request's `method` / `url` / `headers` / `socket` so downstream sees a valid
 * request. Streaming of the RESPONSE is unaffected — only the (already-buffered)
 * REQUEST body is replayed.
 */
function makeReplayRequest(
  req: http.IncomingMessage,
  rawBody: string,
): http.IncomingMessage {
  const buf = Buffer.from(rawBody, 'utf8');
  const readable = Readable.from(buf.length > 0 ? [buf] : []) as unknown as http.IncomingMessage;
  readable.method = req.method;
  readable.url = req.url;
  readable.headers = req.headers;
  readable.httpVersion = req.httpVersion;
  // The socket is referenced by some downstream loggers; reuse the live one.
  (readable as unknown as { socket: unknown }).socket = req.socket;
  return readable;
}
