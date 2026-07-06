/**
 * billingEmit — the module-slot sink + capture-gate port for `@omnicross/core`
 * (billing-event-stream, design D4/D7).
 *
 * The outbound server's post-response billing hook calls {@link publishBillingEvent}
 * with an assembled {@link BillingEvent}. The concrete `BillingPublisher` (the
 * durable-first jsonl ledger + built-in POST) lives in the DAEMON and registers
 * itself as the sink at bootstrap via {@link setBillingSink}. Core imports NOTHING
 * from the daemon — exactly the `setWebhookSink` / `setAuditSink` precedent.
 *
 * A SECOND slot holds the active {@link BillingConfig} ({@link setBillingCaptureConfig}
 * / {@link getBillingCaptureConfig}). The capture hook reads it to GATE assembly:
 * absent/`enabled:false` ⇒ the hook does nothing (not even event assembly), so
 * billing-disabled is byte-identical zero regression. The daemon sets BOTH slots
 * together (config + sink) when billing is enabled and clears BOTH when disabled.
 *
 * HARD CONTRACT (design D7 / risk "a billing POST blocking the request path"):
 * {@link publishBillingEvent} NEVER throws and NEVER awaits — it hands the event
 * to the sink (which durably appends + enqueues delivery and returns immediately)
 * and swallows any sink error, so a slow/failing/throwing publisher can never
 * affect the relay path. Absent a sink it is a pure no-op.
 *
 * @module @omnicross/core/pipeline/billingEmit
 */

import type { BillingConfig, BillingEvent } from '@omnicross/contracts/billing-types';

/** The sink the daemon registers; it MUST durably-append-and-return (never block/throw). */
export type BillingSink = (event: BillingEvent) => void;

let sink: BillingSink | null = null;
let captureConfig: BillingConfig | null = null;

/** Install (or clear, with `null`) the billing sink. Idempotent; last write wins. */
export function setBillingSink(fn: BillingSink | null): void {
  sink = fn;
}

/**
 * Install (or clear, with `null`) the active billing config. `null` (or an
 * `enabled:false` config) disables the capture entirely — the hook does no work.
 */
export function setBillingCaptureConfig(config: BillingConfig | null): void {
  captureConfig = config && config.enabled ? config : null;
}

/** The active billing config, or `null` when billing is disabled/unset. */
export function getBillingCaptureConfig(): BillingConfig | null {
  return captureConfig;
}

/**
 * Publish one billing event to the registered sink. A no-op when no sink is set
 * (zero regression). NEVER throws (a misbehaving sink is swallowed) and NEVER
 * awaits (the sink durably appends + enqueues delivery, then returns) — so no
 * relay path is ever delayed.
 */
export function publishBillingEvent(event: BillingEvent): void {
  const active = sink;
  if (!active) return;
  try {
    active(event);
  } catch {
    // A misbehaving billing sink must never propagate into the relay path.
  }
}

/** TEST SEAM — clear both slots so a suite starts from the no-billing baseline. */
export function __resetBillingSinkForTests(): void {
  sink = null;
  captureConfig = null;
}
