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
 * It ALSO drives the upstream-exchange trace (`setUpstreamTracePath`): when
 * `captureBodies` is opted in, the trace file is resolved beside the audit store
 * and `fetchUpstream` records the full omnicross → provider leg (the codex
 * request/response the client-facing audit cannot see). Core imports NOTHING
 * from the daemon — the same module-slot precedent.
 *
 * @module @omnicross/daemon/audit/auditRuntime
 */

import { join } from 'node:path';

import type { AuditConfig } from '@omnicross/contracts/audit-types';
import { setAuditCaptureConfig, setAuditSink } from '@omnicross/core/pipeline/auditSink';
import { setUpstreamTracePath } from '@omnicross/core/pipeline/upstreamTrace';

import type { AuditPruneSweeper } from './AuditPruneSweeper';
import type { AuditWriter } from './AuditWriter';

let writer: AuditWriter | null = null;
let sweeper: AuditPruneSweeper | null = null;
/** The audit store dir — sibling target for the upstream-trace file. */
let auditDir = '';

/**
 * Inject the live writer + prune sweeper + the audit store dir (bootstrap, once
 * per boot). The dir is used to resolve the upstream-trace file path.
 */
export function setAuditRuntime(w: AuditWriter, s: AuditPruneSweeper, dir: string): void {
  writer = w;
  sweeper = s;
  auditDir = dir;
}

/**
 * Apply the current audit config: when enabled, install the core capture config
 * + the writer sink and arm the prune sweeper; when disabled/absent, clear BOTH
 * core slots and dispose the sweeper. Idempotent — safe on every admin PUT.
 *
 * The upstream-exchange trace (the omnicross → provider leg the audit cannot
 * see — see `upstreamTrace.ts`) is gated on `captureBodies`: when body capture
 * is opted in, the trace file lives beside the audit store; otherwise the trace
 * is disabled (zero-regression no-op in `fetchUpstream`).
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
    // Enable the upstream trace exactly when bodies are captured. The audit
    // segment carries no secret; the trace masks auth header VALUES itself.
    setUpstreamTracePath(config.captureBodies ? join(auditDir, 'upstream-trace.jsonl') : null);
  } else {
    setAuditCaptureConfig(null);
    setAuditSink(null);
    setUpstreamTracePath(null);
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
  if (sweeper) sweeper.dispose();
  writer = null;
  sweeper = null;
  auditDir = '';
}
