/**
 * BillingRetrySweeper — the bounded retry + reconciliation sweep for the billing
 * ledger (billing-event-stream, design D5). Periodically re-POSTs UNdelivered
 * ledger events (via the publisher's built-in delivery) with a bounded age:
 *  - an undelivered event WITHIN `maxRetryAgeMs` of its timestamp is re-POSTed
 *    (the request id makes the re-POST safe — the consumer dedupes);
 *  - an undelivered event PAST `maxRetryAgeMs` is LEFT in the ledger for external
 *    reconciliation — it is NEVER deleted (a delivery failure must never drop a
 *    billing record; the ledger is a financial record, so there is NO prune here,
 *    unlike the #13 audit TTL);
 *  - a DELIVERED event (has a marker) is never re-sent (delivery-marking prevents
 *    double delivery).
 *
 * Modeled on the #8/#13 sweepers: `start()` arms an `unref()`ed interval, a
 * single-sweep re-entrancy guard prevents overlap, `dispose()` clears it. A sweep
 * ALSO runs once at boot (`start` fires an immediate sweep). Disabled/ledger-only
 * (no endpoint) ⇒ armed-off ⇒ no-op. Never throws.
 *
 * @module @omnicross/daemon/billing/BillingRetrySweeper
 */

import type { BillingConfig } from '@omnicross/contracts/billing-types';
import type { Logger } from '@omnicross/core';

import type { BillingPublisher } from './BillingPublisher';
import { readUndeliveredEvents } from './billingReader';

/** Retry cadence — every 5 minutes is ample for a durable ledger with hours-long bounds. */
const SWEEP_INTERVAL_MS = 5 * 60_000;

export class BillingRetrySweeper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  constructor(
    private readonly billingDir: string,
    private readonly publisher: BillingPublisher,
    private readonly logger: Logger,
    private config: BillingConfig,
    private readonly intervalMs: number = SWEEP_INTERVAL_MS,
    /** Injectable clock (ms) for deterministic tests. */
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether retrying is active: billing enabled AND an endpoint is configured. */
  get enabled(): boolean {
    return this.config.enabled && typeof this.config.endpoint === 'string' && this.config.endpoint.length > 0;
  }

  /** Re-apply config to the live instance (boot + admin PUT hot-reload). */
  configure(config: BillingConfig): void {
    this.config = config;
  }

  /**
   * Arm the retry interval AND run one sweep immediately (boot catch-up for events
   * that failed to deliver while the daemon was down). No-op when disabled or in
   * ledger-only mode (no endpoint to POST to). Idempotent.
   */
  start(): void {
    if (this.timer || !this.enabled) return;
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), this.intervalMs);
    this.timer.unref?.();
  }

  /** Clear the interval (daemon shutdown / test teardown). Idempotent. */
  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One sweep: re-POST every UNdelivered ledger event still within
   * `maxRetryAgeMs`; leave over-age undelivered events for reconciliation (NEVER
   * deleted). Exposed for tests; never throws. Returns the number of events a
   * re-POST was attempted for.
   */
  async sweep(): Promise<number> {
    if (!this.enabled || this.sweeping) return 0;
    this.sweeping = true;
    try {
      const cutoff = this.now() - this.config.maxRetryAgeMs;
      let attempted = 0;
      for (const event of readUndeliveredEvents(this.billingDir)) {
        // Past the retry bound → stop retrying but KEEP for reconciliation. Events
        // are oldest-first, but ages can interleave with the request `ts`, so
        // `continue` (not `break`) — a newer event may still be within the bound.
        if (event.ts < cutoff) continue;
        attempted += 1;
        // deliverNow marks delivered on ack; a failure leaves it undelivered for
        // the next sweep. Never rejects.
        await this.publisher.deliverNow(event);
      }
      if (attempted > 0) this.logger.debug('billing retry sweep complete', { attempted });
      return attempted;
    } catch (error) {
      this.logger.warn('billing retry sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    } finally {
      this.sweeping = false;
    }
  }
}
