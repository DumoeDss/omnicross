/**
 * health.ts — the pure `/health` report builder (daemon-health-endpoint, D2).
 *
 * `buildHealthReport(deps)` returns a COARSE, SECRET-FREE {@link HealthReport}
 * from cheap SYNCHRONOUS probes. It NEVER hits an upstream, NEVER blocks, and
 * NEVER embeds a token/email/config-value/record-count — the body is served
 * UNAUTHENTICATED (before the admin auth gate, and optionally before the outbound
 * key-auth), so it must expose nothing sensitive.
 *
 * Each check is a caller-supplied boolean thunk; a thunk that THROWS collapses to
 * `false` (a health probe must never crash the process). Status math:
 *  - CRITICAL (`config`, `credentialStore`): a false critical → `error`.
 *  - READINESS (`outboundServer`): the serving-path signal — false → `degraded`.
 *  - INFORMATIONAL (`adminServer`): reported in `checks` but does NOT affect
 *    `status` — a disabled/loopback dashboard must not fail the TRAFFIC-port
 *    probe (the whole point of the outbound secondary mount).
 * `error` and `degraded` both map to HTTP 503 (see `healthHttpStatus`), so a
 * probe treats "not fully ready" as not-ready.
 *
 * @module @omnicross/daemon/admin/health
 */

import type { HealthReport, HealthStatus } from '@omnicross/contracts/health-logging-types';

/** The coarse dependency probes + process-stat seams the builder reads. */
export interface HealthReportDeps {
  /** The daemon package version (non-secret; also on the identity header). */
  version: string;
  /** CRITICAL: the bootstrap config is present/loaded. */
  configPresent: () => boolean;
  /** CRITICAL: the credential store is constructed + its file readable (no decrypt). */
  credentialStoreReadable: () => boolean;
  /** Non-critical: the outbound `/v1/*` serving listener is running. */
  outboundServerRunning: () => boolean;
  /** Non-critical: the admin listener is running. */
  adminServerRunning: () => boolean;
  /** TEST SEAM: process memory snapshot (defaults to `process.memoryUsage`). */
  memoryUsage?: () => NodeJS.MemoryUsage;
  /** TEST SEAM: process uptime seconds (defaults to `process.uptime`). */
  uptimeSeconds?: () => number;
  /** TEST SEAM: wall clock ms (defaults to `Date.now`). */
  now?: () => number;
}

/** The critical check keys — a false here forces `error` (vs `degraded`). */
const CRITICAL_CHECKS = ['config', 'credentialStore'] as const;
/** The readiness check keys — a false here forces `degraded` (serving-path). */
const READINESS_CHECKS = ['outboundServer'] as const;

/** Evaluate a boolean thunk, collapsing a throw to `false` (never crash). */
function safeBool(fn: () => boolean): boolean {
  try {
    return fn() === true;
  } catch {
    return false;
  }
}

/** Bytes → whole MB (coarse, one decimal). */
function toMb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

/** Build the coarse, secret-free health report (design D2). */
export function buildHealthReport(deps: HealthReportDeps): HealthReport {
  const checks: Record<string, boolean> = {
    config: safeBool(deps.configPresent),
    credentialStore: safeBool(deps.credentialStoreReadable),
    outboundServer: safeBool(deps.outboundServerRunning),
    adminServer: safeBool(deps.adminServerRunning),
  };

  const criticalOk = CRITICAL_CHECKS.every((k) => checks[k]);
  const readinessOk = READINESS_CHECKS.every((k) => checks[k]);
  const status: HealthStatus = !criticalOk ? 'error' : readinessOk ? 'ok' : 'degraded';

  const mem = (deps.memoryUsage ?? process.memoryUsage)();
  const uptime = (deps.uptimeSeconds ?? process.uptime)();
  const nowMs = (deps.now ?? Date.now)();

  return {
    status,
    version: deps.version,
    uptimeSeconds: Math.floor(uptime),
    timestamp: new Date(nowMs).toISOString(),
    memory: { rssMb: toMb(mem.rss), heapUsedMb: toMb(mem.heapUsed) },
    checks,
  };
}
