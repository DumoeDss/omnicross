/**
 * WebhookDispatcher — the daemon-side fire-and-forget webhook sender
 * (webhook-notifications, design D4/D5/D6).
 *
 * Registered as the core emit sink at bootstrap. {@link emit} pushes the event
 * onto a bounded in-memory queue and RETURNS IMMEDIATELY — it never awaits a
 * send and never throws, so a slow/failing/throwing destination can NEVER block
 * or delay a relay request (the HARD contract). An async drain loop then:
 *  - matches each event to every enabled destination whose `events` filter
 *    allows it (absent/empty ⇒ all kinds),
 *  - sends to the matching destinations CONCURRENTLY,
 *  - retries a failed send with bounded exponential backoff up to
 *    `maxAttempts`, then LOGS (via the injected #10 logger) and DROPS it.
 * The queue is bounded (drop-OLDEST + a one-shot warn) so a runaway source can't
 * OOM the process.
 *
 * Egress is #3's proxy-aware `fetchUpstream` with NO ctx → the GLOBAL proxy only
 * (webhooks aren't per-account). Signing uses node `crypto` (no new deps):
 * `custom` → optional `X-Omnicross-Signature: sha256=<hex hmac of body>`;
 * `feishu` → Feishu's `timestamp` + `sign` (HMAC-SHA256 base64 of
 * `timestamp\nsecret`) envelope. The destination `secret` is used ONLY to sign;
 * it is NEVER placed in a payload or a log line.
 *
 * @module @omnicross/daemon/webhook/WebhookDispatcher
 */

import { createHmac } from 'node:crypto';

import type {
  WebhookConfig,
  WebhookDestination,
  WebhookEvent,
  WebhookEventKind,
} from '@omnicross/contracts/webhook-types';
import type { Logger } from '@omnicross/core';
import { fetchUpstream } from '@omnicross/core/pipeline/upstreamFetch';

/** Bounded retry attempts per destination before log-and-drop (design D4). */
export const WEBHOOK_MAX_ATTEMPTS = 3;
/** Bounded in-memory queue depth; a full queue drops the OLDEST (design D4). */
export const WEBHOOK_QUEUE_MAX = 1000;
/** Per-send timeout (ms). */
export const WEBHOOK_SEND_TIMEOUT_MS = 10_000;
/** Base backoff (ms); attempt N waits `base * 2^(N-1)`. */
export const WEBHOOK_BASE_BACKOFF_MS = 200;

/** The minimal `fetch` shape the dispatcher POSTs through (proxy-aware by default). */
export type WebhookFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Outcome of a single delivery attempt (used by the admin test path). */
export interface WebhookDeliveryResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/** Constructor knobs (all optional; test seams for fetch/logger/sleep/clock). */
export interface WebhookDispatcherOptions {
  /** Egress fn; defaults to #3's proxy-aware `fetchUpstream` (global proxy only). */
  fetchImpl?: WebhookFetch;
  /** Injected #10 logger for drop/debug lines (never logs a secret). */
  logger?: Logger;
  maxAttempts?: number;
  queueMax?: number;
  timeoutMs?: number;
  baseBackoffMs?: number;
  /** Backoff sleep seam (tests inject an instant/fake sleep). */
  sleep?: (ms: number) => Promise<void>;
  /** Clock seam for the `test` event `at` + Feishu `timestamp` (tests fix it). */
  now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class WebhookDispatcher {
  private config: WebhookConfig | undefined;
  private readonly queue: WebhookEvent[] = [];
  private draining = false;
  private warnedFull = false;

  private readonly fetchImpl: WebhookFetch;
  private readonly logger: Logger | undefined;
  private readonly maxAttempts: number;
  private readonly queueMax: number;
  private readonly timeoutMs: number;
  private readonly baseBackoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(opts: WebhookDispatcherOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetchUpstream(url, init));
    this.logger = opts.logger;
    this.maxAttempts = opts.maxAttempts ?? WEBHOOK_MAX_ATTEMPTS;
    this.queueMax = opts.queueMax ?? WEBHOOK_QUEUE_MAX;
    this.timeoutMs = opts.timeoutMs ?? WEBHOOK_SEND_TIMEOUT_MS;
    this.baseBackoffMs = opts.baseBackoffMs ?? WEBHOOK_BASE_BACKOFF_MS;
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? Date.now;
  }

  /** Install/replace the live webhook config (destinations + master switch). */
  setConfig(config: WebhookConfig | undefined): void {
    this.config = config;
  }

  /**
   * Enqueue an event and return IMMEDIATELY (fire-and-forget). NEVER awaits a
   * send, NEVER throws — the drain loop does all sending on a side channel. A
   * full queue drops the OLDEST event (with a one-shot warn) so a runaway source
   * can't OOM the process.
   */
  emit(event: WebhookEvent): void {
    if (this.queue.length >= this.queueMax) {
      this.queue.shift();
      if (!this.warnedFull) {
        this.logger?.warn('[webhook] queue full — dropping oldest events');
        this.warnedFull = true;
      }
    }
    this.queue.push(event);
    if (!this.draining) {
      this.draining = true;
      // Kick the async drain WITHOUT awaiting it — the caller returns now.
      queueMicrotask(() => void this.drain());
    }
  }

  /** Drain the queue, sending each event to its matching destinations concurrently. */
  private async drain(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const event = this.queue.shift() as WebhookEvent;
        const destinations = this.matchingDestinations(event.kind);
        if (destinations.length === 0) continue;
        await Promise.all(destinations.map((d) => this.sendWithRetry(event, d)));
      }
    } finally {
      this.draining = false;
      // A late `emit` during the final await may have re-filled the queue.
      if (this.queue.length > 0) {
        this.draining = true;
        queueMicrotask(() => void this.drain());
      }
    }
  }

  /** The enabled destinations whose event filter admits this kind (empty ⇒ all). */
  private matchingDestinations(kind: WebhookEventKind): WebhookDestination[] {
    const cfg = this.config;
    if (!cfg || !cfg.enabled) return [];
    return cfg.destinations.filter(
      (d) => d.enabled && (!d.events || d.events.length === 0 || d.events.includes(kind)),
    );
  }

  /** Send with bounded exponential backoff; log-and-drop after `maxAttempts`. */
  private async sendWithRetry(event: WebhookEvent, dest: WebhookDestination): Promise<void> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const result = await this.sendOnce(event, dest);
      if (result.ok) {
        this.logger?.debug(`[webhook] delivered ${event.kind} → ${dest.id} (${result.status})`);
        return;
      }
      if (attempt < this.maxAttempts) {
        await this.sleep(this.baseBackoffMs * 2 ** (attempt - 1));
      } else {
        this.logger?.warn(
          `[webhook] dropped ${event.kind} → ${dest.id} after ${this.maxAttempts} attempts: ${result.error ?? `HTTP ${result.status}`}`,
        );
      }
    }
  }

  /** One POST attempt. Returns an outcome; a thrown error becomes `{ ok:false }`. */
  private async sendOnce(event: WebhookEvent, dest: WebhookDestination): Promise<WebhookDeliveryResult> {
    try {
      const { body, headers } = buildRequest(event, dest, this.now());
      const res = await this.fetchImpl(dest.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return res.ok ? { ok: true, status: res.status } : { ok: false, status: res.status };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * ADMIN test path (design D8): deliver a `test` event to ONE destination and
   * AWAIT the single-attempt result. This is the ONLY awaited send — it runs on
   * the admin request path (an operator clicking "Test"), NEVER on a relay path,
   * so awaiting it is safe. Finds the destination regardless of its `enabled`
   * flag or the master switch (an explicit operator action).
   */
  async deliverTest(destinationId: string): Promise<WebhookDeliveryResult> {
    const dest = this.config?.destinations.find((d) => d.id === destinationId);
    if (!dest) return { ok: false, error: 'destination not found' };
    return this.sendOnce({ kind: 'test', at: this.now() }, dest);
  }
}

/** Build the POST body + signing headers for one destination (per-type formatter). */
export function buildRequest(
  event: WebhookEvent,
  dest: WebhookDestination,
  nowMs: number,
): { body: string; headers: Record<string, string> } {
  if (dest.type === 'feishu') return buildFeishu(event, dest, nowMs);
  return buildCustom(event, dest);
}

/** `custom`: POST the raw event JSON + an optional HMAC-SHA256 hex signature. */
function buildCustom(
  event: WebhookEvent,
  dest: WebhookDestination,
): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify(event);
  const headers: Record<string, string> = {};
  if (dest.secret) {
    const hmac = createHmac('sha256', dest.secret).update(body).digest('hex');
    headers['X-Omnicross-Signature'] = `sha256=${hmac}`;
  }
  return { body, headers };
}

/**
 * `feishu` (Lark custom-bot): wrap the event in Feishu's text-message envelope;
 * when a secret is set, add `timestamp` + `sign` (HMAC-SHA256 base64 of
 * `timestamp\nsecret`, empty message) per Feishu's spec. The secret only signs —
 * it never appears in the payload.
 */
function buildFeishu(
  event: WebhookEvent,
  dest: WebhookDestination,
  nowMs: number,
): { body: string; headers: Record<string, string> } {
  const payload: Record<string, unknown> = {
    msg_type: 'text',
    content: { text: feishuText(event) },
  };
  if (dest.secret) {
    const timestamp = Math.floor(nowMs / 1000).toString();
    const stringToSign = `${timestamp}\n${dest.secret}`;
    payload['timestamp'] = timestamp;
    payload['sign'] = createHmac('sha256', stringToSign).digest('base64');
  }
  return { body: JSON.stringify(payload), headers: {} };
}

/** A short, human-readable, SECRET-FREE line for a Feishu text message. */
function feishuText(event: WebhookEvent): string {
  switch (event.kind) {
    case 'account.recovery':
      return `omnicross: account recovered — ${event.providerId}/${event.accountId}`;
    case 'account.anomaly':
      return `omnicross: account anomaly [${event.state}] — ${event.providerId}/${event.accountId}`;
    case 'key.quotaWarning':
      return `omnicross: key quota warning (${event.scope}) — $${event.spentUsd.toFixed(2)} of $${event.limitUsd.toFixed(2)} (key ${event.keyId})`;
    case 'key.quotaExceeded':
      return `omnicross: key quota EXCEEDED (${event.scope}) — $${event.spentUsd.toFixed(2)} of $${event.limitUsd.toFixed(2)} (key ${event.keyId})`;
    case 'server.error':
      return `omnicross: server error — ${event.message}`;
    case 'test':
      return 'omnicross: webhook test';
  }
}
