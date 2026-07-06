/**
 * BillingPublisher — the daemon's durable-first billing sink (billing-event-stream,
 * design D2/D4). Registered as `@omnicross/core`'s billing sink when billing is
 * enabled; its {@link record} is what `publishBillingEvent` hands each assembled
 * event.
 *
 * DURABLE-FIRST (THE key decision, design D2): {@link record}
 *  1. APPENDS the event as one JSON line to `billing/billing-YYYY-MM-DD.jsonl` —
 *     SYNCHRONOUSLY, BEFORE any delivery attempt. This is the DURABLE source of
 *     truth: once appended, the event is NEVER lost, even if the process crashes
 *     or every delivery attempt fails. A billing ledger is a financial record.
 *  2. then, only when an `endpoint` is configured, schedules a best-effort POST
 *     OFF the caller's stack (an injectable `defer`, default a zero-delay timer)
 *     so {@link record} RETURNS IMMEDIATELY — a slow/failing endpoint never blocks
 *     the caller (which is already off the relay response path). Ledger-only mode
 *     (no `endpoint`) simply appends — an external tailer consumes the jsonl.
 *  3. on a POST ack, appends a delivery marker (`delivered-YYYY-MM-DD.jsonl`); on
 *     failure the event stays UNdelivered in the ledger for the retry sweep +
 *     external reconciliation. A delivery failure NEVER drops the event.
 *
 * At-least-once: the consumer dedupes on the event `id` (the request id). The
 * built-in POST optionally signs the body with `X-Omnicross-Billing-Signature:
 * sha256=<hmac hex>` (node `crypto`, no new dep). The signing `secret` is used
 * ONLY to sign — it NEVER appears in the payload or a log line. Egress is #3's
 * proxy-aware `fetchUpstream` (global proxy).
 *
 * @module @omnicross/daemon/billing/BillingPublisher
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { join } from 'node:path';

import type { BillingConfig, BillingEvent } from '@omnicross/contracts/billing-types';
import type { Logger } from '@omnicross/core';
import { fetchUpstream } from '@omnicross/core/pipeline/upstreamFetch';

import { billingFileName, deliveredFileName } from './billingFiles';

/** Per-POST timeout (ms). */
export const BILLING_POST_TIMEOUT_MS = 10_000;

/** The minimal `fetch` shape the publisher POSTs through (proxy-aware by default). */
export type BillingFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Constructor knobs (all optional; test seams for fetch/defer/clock). */
export interface BillingPublisherOptions {
  /** Egress fn; defaults to #3's proxy-aware `fetchUpstream` (global proxy only). */
  fetchImpl?: BillingFetch;
  /** Deferral used by `record()` to schedule the POST off the caller's path. */
  defer?: (fn: () => void) => void;
  timeoutMs?: number;
  /** Clock seam for delivery-marker timestamps (tests fix it). */
  now?: () => number;
}

export class BillingPublisher {
  private config: BillingConfig | undefined;
  private dirEnsured = false;

  private readonly fetchImpl: BillingFetch;
  private readonly defer: (fn: () => void) => void;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(
    private readonly billingDir: string,
    private readonly logger: Logger,
    opts: BillingPublisherOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetchUpstream(url, init));
    this.defer = opts.defer ?? ((fn) => setTimeout(fn, 0));
    this.timeoutMs = opts.timeoutMs ?? BILLING_POST_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Install/replace the live billing config (endpoint + secret + retry bound). */
  setConfig(config: BillingConfig | undefined): void {
    this.config = config;
  }

  /**
   * Record one billing event. DURABLE-FIRST: append synchronously (the event is
   * now on disk, never lost), THEN schedule a best-effort POST off the caller's
   * stack (non-blocking; ledger-only when no endpoint). Returns IMMEDIATELY and
   * NEVER throws — a failing append/POST is logged, never propagated.
   */
  record(event: BillingEvent): void {
    let appended = false;
    try {
      this.appendNow(event);
      appended = true;
    } catch (error) {
      this.logger.warn('[BillingPublisher] failed to append billing event', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // Deliver only when the event is safely on disk AND an endpoint is configured.
    // Ledger-only mode (no endpoint) stops here — the jsonl IS the product.
    if (appended && this.config?.endpoint) {
      this.defer(() => {
        void this.deliverNow(event).catch(() => {
          /* deliverNow never rejects; belt-and-suspenders */
        });
      });
    }
  }

  /**
   * Append the event as one JSON line to `billing-YYYY-MM-DD.jsonl` (the event's
   * LOCAL date). Synchronous — the awaitable form tests use to assert the ledger
   * line landed BEFORE any delivery. Ensures the `billing/` directory on first write.
   */
  appendNow(event: BillingEvent): void {
    this.ensureDir();
    const file = join(this.billingDir, billingFileName(event.ts));
    appendFileSync(file, JSON.stringify(event) + '\n', 'utf8');
  }

  /**
   * One best-effort delivery attempt for an event ALREADY in the ledger. POSTs the
   * event JSON to the configured endpoint (optionally HMAC-signed); on a 2xx ack
   * appends a delivery marker and returns `true`. Any non-2xx / thrown / timed-out
   * attempt returns `false` — the event stays UNdelivered in the ledger (never
   * lost). NEVER rejects. A no-op `false` when no endpoint is configured.
   */
  async deliverNow(event: BillingEvent): Promise<boolean> {
    const endpoint = this.config?.endpoint;
    if (!endpoint) return false;
    try {
      const body = JSON.stringify(event);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const secret = this.config?.secret;
      if (secret) {
        const hmac = createHmac('sha256', secret).update(body).digest('hex');
        headers['X-Omnicross-Billing-Signature'] = `sha256=${hmac}`;
      }
      const res = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        this.logger.debug(`[billing] delivery failed ${event.id} (HTTP ${res.status})`);
        return false;
      }
      this.markDelivered(event);
      this.logger.debug(`[billing] delivered ${event.id}`);
      return true;
    } catch (error) {
      this.logger.debug(
        `[billing] delivery error ${event.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /**
   * Append a delivery marker `{ id, deliveredAt }` to `delivered-YYYY-MM-DD.jsonl`
   * (keyed by the EVENT's date so the reader finds both together). Idempotent at
   * the reconciliation layer — the reader unions marker ids into a delivered set,
   * so a duplicate marker is harmless. A marker-write failure is logged, never thrown.
   */
  markDelivered(event: BillingEvent): void {
    try {
      this.ensureDir();
      const file = join(this.billingDir, deliveredFileName(event.ts));
      appendFileSync(file, JSON.stringify({ id: event.id, deliveredAt: this.now() }) + '\n', 'utf8');
    } catch (error) {
      this.logger.warn('[BillingPublisher] failed to append delivery marker', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private ensureDir(): void {
    if (this.dirEnsured) return;
    mkdirSync(this.billingDir, { recursive: true });
    this.dirEnsured = true;
  }
}
