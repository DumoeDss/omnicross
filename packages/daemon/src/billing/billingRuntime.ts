/**
 * billingRuntime — the module-slot that connects the core billing sink + capture
 * gate to the daemon `BillingPublisher` + `BillingRetrySweeper`
 * (billing-event-stream, design D4/D5). Mirrors `auditRuntime`: `bootstrap`
 * injects the live publisher + sweeper once ({@link setBillingRuntime}); then
 * `start.ts` (boot) and the admin config PUT (hot-reload) call
 * {@link applyBillingConfig} with the current `billing` segment.
 *
 * When the segment is ENABLED it installs BOTH core slots — the capture config
 * (`setBillingCaptureConfig`, which GATES event assembly in the outbound router)
 * AND the sink (`setBillingSink`, the durable-first publisher) — pushes the live
 * config into the publisher + sweeper, and arms the retry sweeper (a no-op in
 * ledger-only mode). When disabled/absent it clears BOTH slots and disposes the
 * sweeper, so the capture hook returns to a strict no-op (byte-identical zero
 * regression). Core imports NOTHING from the daemon — the `setWebhookSink`/
 * `setAuditSink` precedent.
 *
 * @module @omnicross/daemon/billing/billingRuntime
 */

import type { BillingConfig } from '@omnicross/contracts/billing-types';
import { setBillingCaptureConfig, setBillingSink } from '@omnicross/core/pipeline/billingEmit';

import type { BillingPublisher } from './BillingPublisher';
import type { BillingRetrySweeper } from './BillingRetrySweeper';

let publisher: BillingPublisher | null = null;
let sweeper: BillingRetrySweeper | null = null;

/** Inject the live publisher + retry sweeper (bootstrap, once per boot). */
export function setBillingRuntime(p: BillingPublisher, s: BillingRetrySweeper): void {
  publisher = p;
  sweeper = s;
}

/**
 * Apply the current billing config: when enabled, push the live config into the
 * publisher + sweeper, install the core capture config + the publisher sink, and
 * arm the retry sweeper; when disabled/absent, clear BOTH core slots and dispose
 * the sweeper. Idempotent — safe on every admin PUT.
 */
export function applyBillingConfig(config: BillingConfig | undefined): void {
  const enabled = config?.enabled === true && publisher !== null;
  if (enabled && config) {
    const activePublisher = publisher as BillingPublisher;
    activePublisher.setConfig(config);
    setBillingCaptureConfig(config);
    setBillingSink((event) => activePublisher.record(event));
    if (sweeper) {
      sweeper.configure(config);
      sweeper.start();
    }
  } else {
    setBillingCaptureConfig(null);
    setBillingSink(null);
    if (sweeper) {
      if (config) sweeper.configure(config);
      sweeper.dispose();
    }
  }
}

/** TEST SEAM — clear the runtime slot + both core slots between suites. */
export function resetBillingRuntimeForTests(): void {
  setBillingCaptureConfig(null);
  setBillingSink(null);
  if (sweeper) sweeper.dispose();
  publisher = null;
  sweeper = null;
}
