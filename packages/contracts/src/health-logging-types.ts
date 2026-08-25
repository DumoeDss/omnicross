/**
 * Health-probe + logging contracts (daemon-health-endpoint / configurable-logging).
 *
 * Two small, dependency-light shapes shared across the `@omnicross/*` packages:
 *  - `HealthReport` — the coarse, SECRET-FREE body served by the unauthenticated
 *    `/health` probe (mounted on the admin server before its auth gate, and
 *    optionally on the outbound `/v1/*` server before key-auth). Frozen so a
 *    liveness/readiness probe + sibling changes (#8 health-cron surfacing into
 *    `checks`) agree on one shape.
 *  - `LogLevel` / `LoggingConfig` — the configurable-logger's level enum + config
 *    segment. Frozen so sibling changes (#5 webhooks / #13 audit-log) reuse the
 *    SAME level vocabulary + config shape rather than reinventing it.
 *
 * NON-SECRET by construction: nothing here carries a token, email, config value,
 * or record-of-count. `HealthReport.checks` are COARSE booleans only.
 *
 * @module health-logging-types
 */

/** The coarse health status. Anything other than `ok` maps to HTTP 503. */
export type HealthStatus = 'ok' | 'degraded' | 'error';

/**
 * The `/health` probe body (design D2). COARSE + SECRET-FREE:
 *  - `status`        — `ok` (200) | `degraded` | `error` (both 503).
 *  - `version`       — the daemon package version (already exposed pre-auth via
 *                      the `x-omnicross-daemon` response header; non-sensitive).
 *  - `uptimeSeconds` — `Math.floor(process.uptime())`.
 *  - `timestamp`     — ISO time the report was built.
 *  - `memory`        — coarse process stats (rss / heapUsed, MB).
 *  - `checks`        — COARSE dependency booleans ONLY (never tokens/emails/
 *                      config-values/record-counts).
 */
export interface HealthReport {
  status: HealthStatus;
  version: string;
  uptimeSeconds: number;
  timestamp: string;
  memory: {
    rssMb: number;
    heapUsedMb: number;
  };
  checks: Record<string, boolean>;
}

/** Map a {@link HealthStatus} to its probe HTTP code: `ok` → 200, else → 503. */
export function healthHttpStatus(status: HealthStatus): number {
  return status === 'ok' ? 200 : 503;
}

/**
 * The logger's level threshold (configurable-logging, design D3). Numeric
 * severity order `error(0) < warn(1) < info(2) < debug(3)`; a message at a level
 * BELOW the configured threshold's severity (i.e. a higher ordinal) is dropped.
 */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/** Output shape of the logger sinks. */
export type LogFormat = 'text' | 'json';

/**
 * The daemon's `logging` config segment (design D3/D4). ALL fields optional; an
 * absent/empty segment reads as the zero-regression default (console + all
 * levels + text — byte-identical to the legacy `ConsoleLogger`).
 *  - `level`  — threshold (default `debug` = print everything).
 *  - `format` — `text` (human-readable, legacy shape) | `json` (structured lines).
 *  - `file`   — OPTIONAL append-only file sink path. A PLAIN config value (NOT a
 *               secret — never walked by the at-rest secret encryption).
 *  - `maxFileBytes` / `maxFiles` — file-sink rotation (default 8 MB x 5). Only
 *               meaningful alongside `file`. An uncapped daemon log is a slow
 *               disk-fill, so the cap is a default rather than an opt-in.
 */
export interface LoggingConfig {
  level?: LogLevel;
  format?: LogFormat;
  file?: string;
  /** Size cap for one generation of the file sink, in bytes. Default 8 MB. */
  maxFileBytes?: number;
  /** Generations kept as `<file>.1` … `<file>.N`. Default 5. */
  maxFiles?: number;
}
