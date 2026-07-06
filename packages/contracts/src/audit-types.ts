/**
 * Request-audit contracts (request-audit-log, design D1/D2).
 *
 * Two dependency-light shapes shared across the `@omnicross/*` packages:
 *  - `AuditRecord` — the FROZEN per-request audit entry. It carries request
 *    METADATA (who/where/when/status/latency/model) plus, ONLY when body capture
 *    is explicitly enabled, a redacted+truncated request/response body snapshot.
 *    It is SECRET-FREE BY CONSTRUCTION: it holds the outbound key ID (NEVER the
 *    key material/hash), the client IP + user-agent (PII, hence the whole store
 *    is authed-only + TTL-pruned), and NEVER a token, Authorization header, or
 *    api-key header value (request headers are NEVER captured). A secret-scan
 *    test asserts no key/token pattern survives in a written record.
 *  - `AuditConfig` — the `audit` config segment. Two independent switches:
 *    `enabled` (record metadata) and `captureBodies` (the sensitive second
 *    opt-in — record bodies too), both default OFF (zero regression).
 *
 * @module audit-types
 */

/**
 * One per-request audit entry (design D1). The metadata fields are recorded
 * whenever audit is `enabled`; the two body snapshots are present ONLY when
 * `captureBodies` is ALSO on, and always after truncation + redaction. NO field
 * ever holds key material, an upstream token, or an Authorization/api-key header.
 */
export interface AuditRecord {
  /** Unique record id (a generated request id — NOT any secret). */
  id: string;
  /** Epoch ms the request was captured. */
  ts: number;
  /** Outbound key id (attribution) — NEVER the key secret/hash. Null when unauthenticated. */
  keyId?: string | null;
  /** Client IP (PII). Socket address by default; a trusted forwarded header only when configured. */
  ip?: string;
  /** Client user-agent (PII). */
  ua?: string;
  /** HTTP method. */
  method: string;
  /** Request path (query string dropped so no secret query param is stored). */
  path: string;
  /** Resolved upstream model. */
  model?: string;
  /** Upstream provider id (or `'byo'`). */
  provider?: string;
  /** HTTP status the client received. */
  status: number;
  /** End-to-end latency (ms). */
  latencyMs: number;
  /** Prompt-side token count (present only when the host correlates usage). */
  inputTokens?: number;
  /** Completion-side token count (present only when the host correlates usage). */
  outputTokens?: number;
  /** Cost in USD (present only when the host correlates usage). */
  costUsd?: number;
  /** Sanitized error message (present only on a failed relay). */
  error?: string;
  /**
   * Request body snapshot — present ONLY when `captureBodies`, truncated to the
   * configured cap, and ALWAYS run through the secret-redaction pass first.
   */
  requestBody?: string;
  /**
   * Response body snapshot — present ONLY when `captureBodies` AND the response
   * was NON-streaming (a streaming response records metadata only), truncated +
   * redacted like `requestBody`.
   */
  responseBody?: string;
}

/**
 * The `audit` config segment (design D2), normalized like `accountHealth`.
 * Absent/`enabled:false` ⇒ no sink wired + no capture ⇒ byte-identical zero
 * regression. `captureBodies` is a SEPARATE, sensitive opt-in that does nothing
 * unless `enabled` is also on.
 */
export interface AuditConfig {
  /** Master switch; default FALSE (zero regression). */
  enabled: boolean;
  /** Capture request/response bodies too (redacted+truncated); default FALSE. */
  captureBodies: boolean;
  /** Per-body truncation cap in bytes; default 8192, clamped. */
  maxBodyBytes: number;
  /** TTL retention in days; default 7, clamped `[1, 365]`. */
  retentionDays: number;
  /**
   * Trust the `X-Forwarded-For` header for the client IP (LEAD OQ1 anti-spoof).
   * Default FALSE — the socket remote address is authoritative. Only set true
   * behind a trusted reverse proxy; a client-supplied XFF is NEVER trusted by
   * default.
   */
  trustForwardedFor: boolean;
}

/** Frozen defaults for the `audit` segment (SSOT). */
export const DEFAULT_AUDIT_CONFIG: AuditConfig = {
  enabled: false,
  captureBodies: false,
  maxBodyBytes: 8192,
  retentionDays: 7,
  trustForwardedFor: false,
};

/** One page of audit records the authed admin query returns (newest first). */
export interface AuditQueryResult {
  records: AuditRecord[];
}
