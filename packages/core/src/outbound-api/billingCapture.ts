/**
 * billingCapture — the outbound server's post-response billing capture hook
 * (billing-event-stream, design D1/D4).
 *
 * {@link beginBillingCapture} is called at the TOP of `handleOutboundRequest`. It
 * reads the active billing config from the core slot; when billing is DISABLED it
 * returns `null` immediately (one slot read — no assembly, no listener, zero
 * regression). When enabled it registers a one-shot `res.close` listener that
 * assembles a {@link BillingEvent} from the handler-filled context (keyId / model
 * / provider / authMode), the response `statusCode`, and this request's METERED
 * FACTS (token counts + the ALREADY-COMPUTED cost) — then hands it to the
 * no-throw {@link publishBillingEvent}.
 *
 * COST REUSE (design D3 — no double pricing): the metered facts are read from the
 * per-request usage stash the usage tap populates ({@link readAuditUsage} — the
 * SAME stash `usage-events.jsonl` correlation uses, populated UNCONDITIONALLY by
 * the taps, independent of whether request-audit is enabled). Token counts are
 * stashed SYNCHRONOUSLY at `record()`; the cost lands on the recorder's deferred
 * pricing tick (scheduled BEFORE the response closes). So the assembly is deferred
 * one macrotask past `close` — by then the earlier-scheduled pricing tick has run
 * and stashed the computed cost we REUSE (we never re-price).
 *
 * BILLABLE-ONLY: an event is emitted ONLY when the request produced usage (an
 * upstream call was billed). Auth failures / rate-limit / model-restriction
 * rejections return before dispatch, stash no usage, and emit NO billing event.
 *
 * @module @omnicross/core/outbound-api/billingCapture
 */

import { randomUUID } from 'node:crypto';
import type http from 'node:http';

import type { BillingEvent } from '@omnicross/contracts/billing-types';

import { readAuditUsage } from '../pipeline/auditUsageStash';
import { getBillingCaptureConfig, publishBillingEvent } from '../pipeline/billingEmit';

/**
 * The mutable context the request handler enriches as it progresses. `null` is
 * returned by {@link beginBillingCapture} when billing is disabled — the handler
 * guards every write with `if (billing)`.
 */
export interface BillingCaptureContext {
  /** Outbound key id (set after auth). NEVER the key material. */
  keyId?: string | null;
  /** Resolved upstream model (set after route resolution). */
  model?: string;
  /** Upstream provider id (set after route resolution). */
  provider?: string;
  /** Re-auth mode the request billed under (set after route resolution). */
  authMode?: 'byo' | 'subscription';
}

/**
 * Deferral used to schedule the event assembly one macrotask past `close`, so the
 * usage tap's earlier-scheduled pricing tick has stashed the cost we reuse.
 * Injectable ONLY for deterministic tests; production uses a zero-delay timer.
 */
export type BillingDefer = (fn: () => void) => void;

const defaultDefer: BillingDefer = (fn) => {
  setTimeout(fn, 0);
};

/**
 * Begin billing capture for one request. Returns a mutable context the handler
 * enriches, or `null` when billing is disabled (zero-cost path). The event is
 * emitted on response `close` via the no-throw sink — but ONLY when the request
 * produced usage (a billable request).
 */
export function beginBillingCapture(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  now: number,
  defer: BillingDefer = defaultDefer,
): BillingCaptureContext | null {
  if (!getBillingCaptureConfig()) return null;

  const ctx: BillingCaptureContext = {};
  let finished = false;

  const finalize = (): void => {
    if (finished) return;
    finished = true;
    // Snapshot the final status now (the response is done); assemble one macrotask
    // later so the recorder's deferred cost stash (scheduled earlier) has landed.
    const status = res.statusCode;
    defer(() => {
      try {
        const usage = readAuditUsage(res);
        // Not billable — no upstream usage was recorded for this request.
        if (!usage) return;
        const event: BillingEvent = {
          id: randomUUID(),
          ts: now,
          model: ctx.model ?? usage.model ?? '',
          authMode: ctx.authMode ?? 'byo',
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          costUsd: usage.costUsd ?? 0,
          status,
        };
        if (ctx.keyId != null) event.keyId = ctx.keyId;
        const provider = ctx.provider ?? usage.provider;
        if (provider) event.provider = provider;
        publishBillingEvent(event);
      } catch {
        // A capture failure must NEVER surface into the relay path.
      }
    });
  };

  res.once('close', finalize);
  return ctx;
}
