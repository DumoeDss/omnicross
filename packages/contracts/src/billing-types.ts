/**
 * Billing-event-stream contracts (billing-event-stream, design D1/D6).
 *
 * Two dependency-light shapes shared across the `@omnicross/*` packages:
 *  - `BillingEvent` — the FROZEN per-request metered fact an EXTERNAL consumer
 *    ingests (a metering service, a data warehouse, a billing platform). It is
 *    SECRET-FREE BY CONSTRUCTION: it carries the outbound key ID (an id, NEVER
 *    the key material/hash) and NEVER a token, Authorization header, or the
 *    signing secret. Its `id` (the request id) doubles as the consumer's
 *    IDEMPOTENCY KEY — delivery is at-least-once, so a consumer dedupes by `id`.
 *    A secret-scan test asserts no key/token/secret pattern survives in a
 *    written/POSTed event.
 *  - `BillingConfig` — the `billing` config segment. Default OFF (zero
 *    regression). Carries the OPTIONAL POST `endpoint` (absent ⇒ ledger-only
 *    mode) and the OPTIONAL HMAC `secret` (the ONLY secret — encrypted at rest +
 *    masked in admin, never in a payload/log).
 *
 * Distinct from `usage-events.jsonl` (internal dashboard telemetry): billing is
 * the external-facing metered fact with its OWN schema + delivery + HMAC.
 *
 * @module billing-types
 */

/**
 * One per-request billing event (design D1) — the metered fact for external
 * consumption. Produced at the post-response point from the SAME computed cost
 * the usage telemetry records (no double pricing). NO field ever holds key
 * material, an upstream token, or the HMAC signing secret.
 */
export interface BillingEvent {
  /**
   * Request id — the consumer's IDEMPOTENCY KEY. Stable for one event across
   * delivery RETRIES (the retry sweep re-POSTs the SAME id) so an at-least-once
   * consumer applies it exactly once. NOT any secret.
   */
  id: string;
  /** Epoch ms the request was billed (the request timestamp). */
  ts: number;
  /** Outbound key id (attribution) — NEVER the key secret/hash. Null when unattributed. */
  keyId?: string | null;
  /** Resolved upstream model the request billed against. */
  model: string;
  /** Upstream provider id (or `'byo'`). */
  provider?: string;
  /** Re-auth mode the request billed under (BYO key vs subscription OAuth). */
  authMode: 'byo' | 'subscription';
  /** Prompt-side token count. */
  inputTokens: number;
  /** Completion-side token count. */
  outputTokens: number;
  /** Cost in USD (the SAME value the usage telemetry recorded). */
  costUsd: number;
  /** HTTP status of the billed request. */
  status: number;
}

/**
 * The `billing` config segment (design D6), normalized like `audit`.
 * Absent/`enabled:false` ⇒ no sink wired ⇒ `publishBillingEvent` is a no-op ⇒
 * no append, no POST, byte-identical zero regression. `enabled` WITHOUT an
 * `endpoint` is a first-class LEDGER-ONLY mode (the durable jsonl IS the product;
 * an external tailer consumes it). The `secret` is the ONLY secret field
 * (encrypted at rest + masked in admin).
 */
export interface BillingConfig {
  /** Master switch; default FALSE (zero regression). */
  enabled: boolean;
  /**
   * POST target for the built-in delivery. ABSENT ⇒ ledger-only mode: events are
   * durably appended and an external consumer tails the jsonl directly (no push).
   */
  endpoint?: string;
  /**
   * HMAC-SHA256 signing key — a SECRET. When set, each POST carries
   * `X-Omnicross-Billing-Signature: sha256=<hmac hex of body>`. Encrypted at rest
   * + masked in admin views; the secret ONLY signs, it NEVER travels in the event
   * payload or a log line.
   */
  secret?: string;
  /**
   * Stop RE-POSTing an undelivered event after this age (ms); default 24h,
   * clamped. This governs RETRY only — an over-age undelivered event is RETAINED
   * in the ledger for reconciliation, NEVER deleted (a billing ledger is a
   * financial record).
   */
  maxRetryAgeMs: number;
}

/** Frozen defaults for the `billing` segment (SSOT). 24h retry bound. */
export const DEFAULT_BILLING_CONFIG: BillingConfig = {
  enabled: false,
  maxRetryAgeMs: 24 * 60 * 60_000,
};

/** Aggregate delivery status the authed admin surfaces (secret-free counts). */
export interface BillingDeliveryStatus {
  /** Total events in the durable ledger. */
  total: number;
  /** Events an external endpoint has acknowledged (delivered). */
  delivered: number;
  /** Events not yet delivered (still retried within `maxRetryAgeMs`, then retained). */
  pending: number;
}
