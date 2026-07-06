/**
 * webhookEmit — the module-slot emit port for `@omnicross/core`
 * (webhook-notifications, design D2).
 *
 * Core SOURCES (the wire quota path in `outboundApiRouter`, the relay/dispatch
 * error path) call {@link emitWebhookEvent}. The concrete `WebhookDispatcher`
 * (config/secrets/HTTP/HMAC) lives in the DAEMON and registers itself as the
 * sink at bootstrap via {@link setWebhookSink}. Core imports NOTHING from the
 * daemon — exactly the `setSharedAccountHealth` / `setUpstreamProxyResolver`
 * precedent.
 *
 * HARD CONTRACT (design D2 / risk "a webhook blocking the request path"):
 * {@link emitWebhookEvent} NEVER throws and NEVER awaits. It hands the event to
 * the sink (which enqueues and returns immediately) — a slow/failing/throwing
 * sink can never affect the caller. Absent a sink it is a pure no-op, so a
 * no-webhook-config daemon is byte-identical to before this change.
 *
 * @module @omnicross/core/pipeline/webhookEmit
 */

import type { WebhookEvent } from '@omnicross/contracts/webhook-types';

/** The sink the daemon registers; it MUST enqueue-and-return (never block). */
export type WebhookSink = (event: WebhookEvent) => void;

let sink: WebhookSink | null = null;

/** Install (or clear, with `null`) the webhook sink. Idempotent; last write wins. */
export function setWebhookSink(fn: WebhookSink | null): void {
  sink = fn;
}

/**
 * Emit a webhook event to the registered sink. A no-op when no sink is set
 * (zero regression). NEVER throws (a misbehaving sink is swallowed) and NEVER
 * awaits (the sink enqueues + returns) — so no request path is ever delayed.
 */
export function emitWebhookEvent(event: WebhookEvent): void {
  const active = sink;
  if (!active) return;
  try {
    active(event);
  } catch {
    // A misbehaving sink must never propagate into a request/source path.
  }
}

/** TEST SEAM — clear the sink so a suite starts from the no-sink baseline. */
export function __resetWebhookSinkForTests(): void {
  sink = null;
}
