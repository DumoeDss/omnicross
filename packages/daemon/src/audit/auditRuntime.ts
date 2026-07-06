/**
 * auditRuntime — the module-slot that connects the core audit sink + capture
 * config to the daemon `AuditWriter` + `AuditPruneSweeper` (request-audit-log,
 * design D5). Mirrors `webhookRuntime`: `bootstrap` injects the live writer +
 * sweeper once ({@link setAuditRuntime}); then `start.ts` (boot) and the admin
 * config PUT (hot-reload) call {@link applyAuditConfig} with the current `audit`
 * segment.
 *
 * When the segment is ENABLED it installs BOTH core slots — the capture config
 * (`setAuditCaptureConfig`, which GATES record assembly in the outbound router)
 * AND the sink (`setAuditSink`, the writer) — and arms the prune sweeper. When
 * disabled/absent it clears BOTH slots and disposes the sweeper, so the capture
 * hook returns to a strict no-op (byte-identical zero regression). Core imports
 * NOTHING from the daemon — the `setWebhookSink` precedent.
 *
 * @module @omnicross/daemon/audit/auditRuntime
 */

import type { AuditConfig } from '@omnicross/contracts/audit-types';
import { setAuditCaptureConfig, setAuditSink } from '@omnicross/core/pipeline/auditSink';

import type { AuditPruneSweeper } from './AuditPruneSweeper';
import type { AuditWriter } from './AuditWriter';

let writer: AuditWriter | null = null;
let sweeper: AuditPruneSweeper | null = null;

/** Inject the live writer + prune sweeper (bootstrap, once per boot). */
export function setAuditRuntime(w: AuditWriter, s: AuditPruneSweeper): void {
  writer = w;
  sweeper = s;
}

/**
 * Apply the current audit config: when enabled, install the core capture config
 * + the writer sink and arm the prune sweeper; when disabled/absent, clear BOTH
 * core slots and dispose the sweeper. Idempotent — safe on every admin PUT.
 */
export function applyAuditConfig(config: AuditConfig | undefined): void {
  const enabled = config?.enabled === true && writer !== null;
  if (enabled && config) {
    setAuditCaptureConfig(config);
    const activeWriter = writer as AuditWriter;
    setAuditSink((record) => activeWriter.record(record));
    if (sweeper) {
      sweeper.configure(config);
      sweeper.start();
    }
  } else {
    setAuditCaptureConfig(null);
    setAuditSink(null);
    if (sweeper) {
      if (config) sweeper.configure(config);
      sweeper.dispose();
    }
  }
}

/** TEST SEAM — clear the runtime slot + both core slots between suites. */
export function resetAuditRuntimeForTests(): void {
  setAuditCaptureConfig(null);
  setAuditSink(null);
  if (sweeper) sweeper.dispose();
  writer = null;
  sweeper = null;
}
