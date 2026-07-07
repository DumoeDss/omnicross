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

import type { VoucherConfig } from '@omnicross/contracts/voucher-types';

import { serializeError } from '@omnicross/core/serializeError';

import { emitWebhookEvent } from '../pipeline/webhookEmit';
import { routeRequest } from '../provider-proxy/providerProxyRouter';

import { DEFAULT_CONCURRENCY_QUEUE } from './apiServerConfig';
import { beginAuditCapture } from './auditCapture';
import { beginBillingCapture } from './billingCapture';
import { isKindMappedEndpoint } from './kindDetection';
import { verifyKey } from './outboundApiKeyAuth';
import { checkKeyQuota, checkModelAllowed } from './keyPolicy';
import { computeQuotaWarnings, markQuotaWarnedOnce } from './quotaWarn';
import { type GateSlot, isConcurrencyRejection, type OutboundConcurrencyGate } from './outboundConcurrencyGate';
import { OutboundRateLimiter } from './outboundRateLimiter';
import { detectRequestRole, endpointToIngressFormat, extractRequestedModel } from './roleDetection';
import { parseModelRef, resolveRoute } from './routeResolver';
import type {
  ConcurrencyQueueConfig,
  EndpointRoutingConfig,
  OutboundApiDeps,
  OutboundEndpoint,
  UserMessageQueueConfig,
} from './types';
import type { KeyedMutex } from './keyedMutex';
import { isUserMessageRequest } from './userMessageDetection';
import { isSerialQueueTimeout, type UserMessageSerialQueue } from './userMessageSerialQueue';
import { handleVoucherRedeem, isRedeemRequest } from './voucherRedeem';

/**
 * Lazily-constructed fallback redeem-attempt limiter (voucher-redemption #9) for
 * callers that do not supply one. The real server passes its own; this only
 * covers direct callers (tests) that send a `/redeem` request without a limiter.
 */
let fallbackRedeemLimiter: OutboundRateLimiter | null = null;
function getFallbackRedeemLimiter(): OutboundRateLimiter {
  fallbackRedeemLimiter ??= new OutboundRateLimiter({ maxRequests: 10, windowMs: 60_000 });
  return fallbackRedeemLimiter;
}

/** Per-request config the listener supplies (read live, no restart). */
export interface OutboundRequestConfig {
  endpoints: EndpointRoutingConfig[];
  /**
   * User-message serial-queue segment (opt-in; `enabled` default false). When
   * present + enabled the serial queue engages for real user-message turns; the
   * server threads the normalized segment (see `apiServerConfig`).
   */
  userMessageQueue?: UserMessageQueueConfig;
  /**
   * Per-key concurrency-queue sizing/timeout segment. Read when the concurrency
   * gate engages (a key with a positive `maxConcurrency`); falls back to the
   * frozen defaults when absent.
   */
  concurrencyQueue?: ConcurrencyQueueConfig;
  /**
   * Voucher segment (voucher-redemption #9). Gates the key-authenticated
   * `POST /redeem` endpoint; absent or `enabled:false` ⇒ redeem is rejected and no
   * key is ever mutated (byte-identical zero regression).
   */
  voucher?: VoucherConfig;
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

/**
 * Write the 402 cost-limit body (outbound-key-policy). Secret-safe: it names the
 * presented key's OWN exceeded scope + its own limit/spend and NOTHING about any
 * other key. The numbers are this caller's own attributed spend, so surfacing
 * them leaks no cross-key data.
 */
function writeCostLimitError(
  res: http.ServerResponse,
  scope: 'daily' | 'weekly' | 'total',
  limitUsd: number,
  spentUsd: number,
): void {
  if (res.headersSent) return;
  res.writeHead(402, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      error: {
        type: 'outbound_api_error',
        message: `Cost limit reached for this key (${scope}): $${spentUsd.toFixed(4)} of $${limitUsd.toFixed(4)}`,
      },
      scope,
      limitUsd,
      spentUsd,
    }),
  );
}

/**
 * Write the 403 model-restriction body (outbound-key-policy #6). Secret-safe: it
 * names ONLY the disallowed resolved model + this key's own restriction mode, and
 * NOTHING about any other key. 403 (authorized-but-forbidden) is deliberately
 * distinct from the 401 (invalid/expired credential), 402 (spend), and 429 (rate)
 * rejections so a client can react correctly.
 */
function writeModelNotAllowedError(
  res: http.ServerResponse,
  model: string,
  mode: 'blacklist' | 'allowlist',
): void {
  if (res.headersSent) return;
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      error: {
        type: 'outbound_api_error',
        message: `Model '${model}' is not permitted for this key (${mode})`,
      },
      model,
      mode,
    }),
  );
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
  serialQueue: UserMessageSerialQueue,
  concurrencyGate: OutboundConcurrencyGate,
  /**
   * Redeem-attempt limiter (voucher-redemption #9). OPTIONAL so existing callers
   * (tests) that predate vouchers compile unchanged; the real server always
   * supplies its own instance. A caller that omits it AND sends a `/redeem`
   * request falls back to a lazily-constructed shared limiter.
   */
  redeemLimiter?: OutboundRateLimiter,
  /**
   * Per-key redeem mutex (voucher-redemption #9, MJ1 fix). OPTIONAL; the handler
   * falls back to a process-shared instance when omitted (tests). The real server
   * supplies its own so serialization spans concurrent requests.
   */
  redeemMutex?: KeyedMutex,
): Promise<void> {
  // One clock for the whole request so expiry / rate / quota agree.
  const now = Date.now();

  // AUDIT (request-audit-log, design D5). Gated inside `beginAuditCapture` on the
  // core capture-config slot: audit-disabled ⇒ `null` (one slot read, no work,
  // zero regression). When enabled it registers a `res.close` listener that emits
  // the record fire-and-forget at response end, covering EVERY exit path below
  // (incl. the 401/429/402/403 early-returns). The handler enriches it (keyId /
  // model / provider / body / error) as it progresses. NEVER captures headers.
  const audit = beginAuditCapture(req, res, now);

  // BILLING (billing-event-stream, design D4). Gated inside `beginBillingCapture`
  // on the core billing-config slot: billing-disabled ⇒ `null` (one slot read, no
  // work, zero regression). When enabled it registers a `res.close` listener that
  // emits a metered-fact event fire-and-forget at response end — but ONLY for a
  // BILLABLE request (one that produced usage), reusing the already-computed cost.
  // The handler enriches it (keyId / model / provider / authMode) as it progresses.
  const billing = beginBillingCapture(req, res, now);

  // 1. AUTH — external named API key (enforced on every request incl. loopback).
  // Reason-bearing (outbound-key-policy): an expired / not-yet-valid key is a
  // 401 (OQ1), same status as a missing/disabled/revoked key. First use of an
  // activation-mode key stamps its activation inside `verifyKey` (best-effort).
  const presented = extractPresentedKey(req);
  const verification = await verifyKey(deps.db, presented, now);
  if (verification.status !== 'ok') {
    writeJsonError(
      res,
      401,
      verification.status === 'expired' ? 'API key has expired' : 'Invalid or missing API key',
    );
    return;
  }
  const verified = verification.key;
  if (audit) audit.keyId = verified.id;
  if (billing) billing.keyId = verified.id;

  // 1a. VOUCHER REDEEM (voucher-redemption #9, design D1). A key-authenticated
  // `POST /redeem` applies a card's value to THIS verified key. Handled right
  // after auth (the key is now known) and BEFORE the traffic rate-limit / endpoint
  // select — redemption is NOT relay traffic and carries its OWN attempt limiter
  // (design D6). The redeem code is a CREDENTIAL: the handler hashes it, never logs
  // it, and this branch returns before any request body is stashed for audit, so
  // the plaintext code never reaches the audit/billing capture.
  if (isRedeemRequest(req.method, req.url)) {
    await handleVoucherRedeem(
      req,
      res,
      deps,
      config.voucher?.enabled === true,
      redeemLimiter ?? getFallbackRedeemLimiter(),
      verified.id,
      presented ?? '',
      now,
      redeemMutex,
    );
    return;
  }

  // 2. RATE LIMIT — per-key window when the key configures one (else 60/60s).
  const decision = rateLimiter.check(verified.id, now, verified.rateLimit);
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

  // 3a. COST QUOTA (outbound-key-policy, design D4). Runs ONLY when the key has a
  // cost limit AND the host wired a spend reader — a policy-less key (or a
  // tracker-less embedder/test) does zero work here (byte-identical). Placed
  // after endpoint validation so `GET /v1/models` + non-POST early-return above
  // never trigger a quota computation. The 402 body names ONLY this key's
  // exceeded scope + its own limit/spend — never any other key's data.
  if (verified.costLimits && deps.keySpendTracker) {
    const spend = await deps.keySpendTracker.getSpend(verified.id, now);
    const quota = checkKeyQuota(verified.costLimits, spend);
    if (!quota.allowed) {
      // webhook-notifications D3: fire the quota-exceeded event ALONGSIDE the 402
      // (fire-and-forget — a no-op unless a sink is wired). Secret-free: keyId +
      // this key's own scope/limit/spend.
      emitWebhookEvent({
        kind: 'key.quotaExceeded',
        at: now,
        keyId: verified.id,
        scope: quota.scope,
        limitUsd: quota.limitUsd,
        spentUsd: quota.spentUsd,
      });
      writeCostLimitError(res, quota.scope, quota.limitUsd, quota.spentUsd);
      return;
    }
    // webhook-notifications D3 (Phase 2): fire quota-WARNING once per window when a
    // scope crosses the warn ratio but is not yet exceeded (deduped per window so
    // it doesn't spam every request past 80%).
    for (const warn of computeQuotaWarnings(verified.costLimits, spend)) {
      if (markQuotaWarnedOnce(verified.id, warn.scope, warn.windowStart)) {
        emitWebhookEvent({
          kind: 'key.quotaWarning',
          at: now,
          keyId: verified.id,
          scope: warn.scope,
          limitUsd: warn.limitUsd,
          spentUsd: warn.spentUsd,
        });
      }
    }
  }

  // 3b. CONCURRENCY GATE (design D-WIRE-1/2). Placed AFTER endpoint validation so
  // `GET /v1/models` + non-POST early-return above and never engage the gate.
  // Keyed by `verified.id`; the gate is bypassed entirely when the key has no
  // positive `maxConcurrency`. The acquired slot is held to request end and
  // released idempotently from BOTH the dispatch `finally` AND a `res.close`
  // listener (the CRS #1130 leak fix); a still-WAITING acquisition is cancelled
  // when the client disconnects mid-queue.
  const concurrencyLimit = verified.maxConcurrency;
  let releaseConcurrency: (() => void) | null = null;
  if (typeof concurrencyLimit === 'number' && concurrencyLimit > 0) {
    const cq = config.concurrencyQueue ?? DEFAULT_CONCURRENCY_QUEUE;
    const acquisition = concurrencyGate.acquire(verified.id, concurrencyLimit, {
      maxQueueSizeFactor: cq.maxQueueSizeFactor,
      minQueueSize: cq.minQueueSize,
      waitTimeoutMs: cq.waitTimeoutMs,
    });
    // Cancel the queued wait if the client disconnects before the grant.
    const cancelOnClose = (): void => acquisition.cancel();
    res.once('close', cancelOnClose);
    let slot: GateSlot;
    try {
      slot = await acquisition.granted;
    } catch (err) {
      res.removeListener('close', cancelOnClose);
      if (isConcurrencyRejection(err)) {
        writeJsonError(res, 429, 'Concurrency limit exceeded', { 'Retry-After': '5' });
        return;
      }
      throw err;
    }
    // Granted: stop cancelling-on-close, switch to release-on-close. The core
    // slot's `release()` is idempotent, so the finally + close double-fire is
    // safe and never double-decrements.
    res.removeListener('close', cancelOnClose);
    const release = (): void => slot.release();
    releaseConcurrency = release;
    res.once('close', release);
  }

  // Everything from here (body read → resolveRoute → serial → dispatch) runs
  // inside the concurrency finally so a routing error or a serial-queue timeout
  // after the acquire still frees the held slot.
  try {
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
    // AUDIT: stash the raw request body (a no-op unless `captureBodies`). Captured
    // even for a routing error below so the audited request is complete.
    if (audit) audit.setRequestBody(rawBody);

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
    // AUDIT: record the RESOLVED upstream model + provider (post kind-mapping).
    if (audit) {
      audit.model = resolved.route.model;
      audit.provider = resolved.route.providerId;
    }
    // BILLING: stamp the RESOLVED model + provider + the re-auth mode the request
    // billed under (byo vs subscription) onto the metered-fact context.
    if (billing) {
      billing.model = resolved.route.model;
      billing.provider = resolved.route.providerId;
      billing.authMode = resolved.route.authMode;
    }

    // 4a. MODEL RESTRICTION (outbound-key-policy #6, design D3/D4). Runs ONLY when
    // the key has restriction enabled (`verified.modelRestriction` is populated by
    // `verifyKey` only then) — a restriction-less key does zero work here
    // (byte-identical). Enforced on the RESOLVED upstream model (`route.model`,
    // post kind-mapping / list resolution), NOT the raw client string, so an
    // aliased/versioned id cannot bypass a block. Sits AFTER route resolution
    // (the resolved model only exists here) and BEFORE dispatch, so a disallowed
    // model is rejected before any upstream call. On a deny → 403 naming ONLY this
    // model + this key's mode (no other-key leak).
    if (verified.modelRestriction) {
      const modelDecision = checkModelAllowed(verified.modelRestriction, resolved.route.model);
      if (!modelDecision.allowed) {
        writeModelNotAllowedError(res, modelDecision.model, verified.modelRestriction.mode);
        return;
      }
    }

    // 4b. USER-MESSAGE SERIAL QUEUE (design D-WIRE-3/4). Keyed by the resolved
    // upstream account (`route.providerId`); engages ONLY when the queue is
    // enabled AND this is a real user-message turn (tool-loop / non-user turns
    // bypass so agent latency is preserved). The lock releases on RESPONSE START
    // (the wrapped `writeHead` below) with a finally backstop.
    let releaseSerial: (() => void) | null = null;
    const providerKey = resolved.route.providerId;
    if (
      config.userMessageQueue?.enabled &&
      providerKey &&
      isUserMessageRequest(endpoint, parsedBody)
    ) {
      const umq = config.userMessageQueue;
      try {
        const serialSlot = await serialQueue.acquire(providerKey, {
          waitTimeoutMs: umq.waitTimeoutMs,
          delayMs: umq.delayMs,
        });
        releaseSerial = () => serialSlot.release();
      } catch (err) {
        if (isSerialQueueTimeout(err)) {
          // Nothing has streamed yet (`res.headersSent` is false) → plain 503
          // JSON. The enclosing finally releases the held concurrency slot.
          writeJsonError(res, 503, 'User-message serial queue wait timed out');
          return;
        }
        throw err;
      }
    }

    // Release the serial lock on RESPONSE START so the next account request can
    // begin while this response streams. Wrap `res.writeHead` as a one-shot: the
    // FIRST call releases (seeding the `delayMs` gap) then restores + delegates
    // to the original. Format-agnostic — covers the Anthropic host-handler path
    // without threading a callback through the shared relay.
    if (releaseSerial) {
      const original = res.writeHead.bind(res) as http.ServerResponse['writeHead'];
      const releaseOnce = releaseSerial;
      res.writeHead = ((...args: Parameters<http.ServerResponse['writeHead']>) => {
        res.writeHead = original;
        releaseOnce();
        return (original as (...a: unknown[]) => http.ServerResponse)(...args);
      }) as http.ServerResponse['writeHead'];
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
      // Relay request-dispatch error → injected logger when wired (honors level/
      // format/sink), else the legacy console.error (byte-identical fallback).
      if (deps.logger) deps.logger.error('[OutboundApi] dispatch error:', message);
      else console.error('[OutboundApi] dispatch error:', message);
      // webhook-notifications D3 (OQ3): a relay/dispatch FAILURE (thrown → 502) is a
      // REAL server error → fire the event (fire-and-forget; no-op unless a sink is
      // wired). Client 4xx early-returns above never reach here, so no 4xx noise.
      // The message is the already-sanitized `serializeError` string (no secrets).
      emitWebhookEvent({ kind: 'server.error', at: Date.now(), message });
      // AUDIT: record the sanitized failure message (redacted again at assembly).
      if (audit) audit.error = message;
      writeJsonError(res, 502, message);
    } finally {
      routeMap.removeRoute(token);
      // Backstop for paths that end the response without a `writeHead` (errors);
      // idempotent with the writeHead one-shot above.
      if (releaseSerial) releaseSerial();
    }
  } finally {
    if (releaseConcurrency) releaseConcurrency();
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
