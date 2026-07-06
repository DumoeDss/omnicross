/**
 * auditUsageStash — a per-request usage correlation stash for the audit capture
 * (request-audit-log, design D1). The audit record is assembled at the outbound
 * router's post-response point, but token counts + cost are produced downstream
 * by the usage tap → `UsageRecorder`. This `WeakMap<res, detail>` bridges them:
 * the recorder stashes the usage detail keyed by the SAME `http.ServerResponse`
 * the audit capture holds, so `beginAuditCapture` can read it at response close.
 *
 * The token counts + model/provider are stashed SYNCHRONOUSLY at `record()` time
 * (before the response closes ⇒ reliably present); the cost is stashed on the
 * deferred pricing tick (best-effort — populated when it lands before close).
 * Keyed by the response OBJECT (a `WeakMap`, so a completed request's entry is
 * GC'd with the response — no leak, no cleanup needed).
 *
 * This is OPT-IN + gated: only the outbound taps set `auditResponse`, and the
 * audit capture only reads when audit is enabled. Any other `UsageRecorder`
 * caller leaves `auditResponse` unset ⇒ this map is never touched ⇒ zero
 * regression.
 *
 * @module @omnicross/core/pipeline/auditUsageStash
 */

/** The subset of usage numbers an audit record carries (all optional). */
export interface AuditUsageDetail {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  model?: string;
  provider?: string;
}

const stash = new WeakMap<object, AuditUsageDetail>();

/** Merge a partial usage detail into the entry keyed by `key` (the response). */
export function stashAuditUsage(key: object, detail: AuditUsageDetail): void {
  const existing = stash.get(key);
  stash.set(key, existing ? { ...existing, ...detail } : { ...detail });
}

/** Read the accumulated usage detail for `key`, or `undefined` when none. */
export function readAuditUsage(key: object): AuditUsageDetail | undefined {
  return stash.get(key);
}

/** TEST SEAM — drop a stashed entry so a suite starts clean. */
export function __clearAuditUsageForTests(key: object): void {
  stash.delete(key);
}
