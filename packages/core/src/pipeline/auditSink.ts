/**
 * auditSink — the module-slot sink + capture-config port for `@omnicross/core`
 * (request-audit-log, design D5).
 *
 * The outbound server's post-response capture hook calls {@link recordAudit}
 * with an assembled {@link AuditRecord}. The concrete `AuditWriter` (the
 * date-rotated jsonl store) lives in the DAEMON and registers itself as the sink
 * at bootstrap via {@link setAuditSink}. Core imports NOTHING from the daemon —
 * exactly the `setWebhookSink` / `setUpstreamProxyResolver` precedent.
 *
 * A SECOND slot holds the active {@link AuditConfig} ({@link setAuditCaptureConfig}
 * / {@link getAuditCaptureConfig}). The capture hook reads it to GATE assembly:
 * absent/`enabled:false` ⇒ the hook does nothing (not even record assembly), so
 * audit-disabled is byte-identical zero regression. The daemon sets BOTH slots
 * together (config + sink) when audit is enabled and clears BOTH when disabled.
 *
 * HARD CONTRACT (design D5 / risk "the audit write adding latency"):
 * {@link recordAudit} NEVER throws and NEVER awaits — it hands the record to the
 * sink (which enqueues and returns immediately) and swallows any sink error, so
 * a slow/failing/throwing writer can never affect the relay path. Absent a sink
 * it is a pure no-op.
 *
 * @module @omnicross/core/pipeline/auditSink
 */

import type { AuditConfig, AuditRecord } from '@omnicross/contracts/audit-types';

/** The sink the daemon registers; it MUST enqueue-and-return (never block/throw). */
export type AuditSink = (record: AuditRecord) => void;

let sink: AuditSink | null = null;
let captureConfig: AuditConfig | null = null;

/** Install (or clear, with `null`) the audit sink. Idempotent; last write wins. */
export function setAuditSink(fn: AuditSink | null): void {
  sink = fn;
}

/**
 * Install (or clear, with `null`) the active audit-capture config. `null` (or an
 * `enabled:false` config) disables capture entirely — the hook does no work.
 */
export function setAuditCaptureConfig(config: AuditConfig | null): void {
  captureConfig = config && config.enabled ? config : null;
}

/** The active capture config, or `null` when audit is disabled/unset. */
export function getAuditCaptureConfig(): AuditConfig | null {
  return captureConfig;
}

/**
 * Hand one audit record to the registered sink. A no-op when no sink is set
 * (zero regression). NEVER throws (a misbehaving sink is swallowed) and NEVER
 * awaits (the sink enqueues + returns) — so no relay path is ever delayed.
 */
export function recordAudit(record: AuditRecord): void {
  const active = sink;
  if (!active) return;
  try {
    active(record);
  } catch {
    // A misbehaving audit sink must never propagate into the relay path.
  }
}

/** TEST SEAM — clear both slots so a suite starts from the no-audit baseline. */
export function __resetAuditSinkForTests(): void {
  sink = null;
  captureConfig = null;
}
