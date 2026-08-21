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
 * Body snapshots have exactly one persistence path: the date-rotated audit
 * writer. Applying audit config explicitly disables the legacy upstream trace so
 * enabling `captureBodies` cannot duplicate every exchange into a second file.
 *
 * @module @omnicross/daemon/audit/auditRuntime
 */

import type { AuditConfig } from '@omnicross/contracts/audit-types';
import { setAuditCaptureConfig, setAuditSink } from '@omnicross/core/pipeline/auditSink';
import { setUpstreamTracePath } from '@omnicross/core/pipeline/upstreamTrace';

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
 * The legacy upstream trace is always disabled: request/response bodies belong
 * only to the date-rotated audit record and must not be written twice.
 */
export function applyAuditConfig(config: AuditConfig | undefined): void {
  setUpstreamTracePath(null);
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
    // Release the body-store encoding bases (audit-store-sharding): turning audit
    // off should not keep tens of MB of retained request bodies resident.
    writer?.reset();
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
  setUpstreamTracePath(null);
  writer?.reset();
  if (sweeper) sweeper.dispose();
  writer = null;
  sweeper = null;
}
