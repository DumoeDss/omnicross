/**
 * AdminServer — the daemon's localhost admin/dashboard HTTP listener (RT3,
 * design D1/D2).
 *
 * A SEPARATE `node:http` listener distinct from core's outbound `/v1/*` server
 * (port 8765, untouched). Mirrors `OutboundApiServer`'s proven shape:
 *  - `http.createServer`, default bind `127.0.0.1` (or `0.0.0.0` when
 *    `networkBinding`), `listen` with `EADDRINUSE`→ephemeral(port 0) fallback,
 *  - `getStatus()` (running / bound port / dashboard URL), `start` / `stop`.
 * Default admin port 8766.
 *
 * Auth (design D2):
 *  - Baseline = localhost bind, no token → reachable only from the machine.
 *  - Optional `admin.token` → every `/admin/*` request (incl. `GET /`) must
 *    carry `Authorization: Bearer <token>` or `X-Admin-Token: <token>`; compared
 *    server-side with a constant-time equality → `401` on a miss.
 *  - HARD SAFETY GATE: `networkBinding` (LAN/`0.0.0.0`) without a non-empty
 *    `admin.token` → `start` REFUSES to bind (logs + stays down, fail closed).
 *
 * Routing: `GET /` (and `GET /admin`) → `302 /ui/`; `* /admin/api/*` → the
 * management API (`handleAdminApi`); `GET /ui[/...]` → the Control Panel static
 * UI (`handleUiStatic`, from `@omnicross/ui`); everything else → `404`.
 *
 * @module @omnicross/daemon/admin/AdminServer
 */

import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';

import {
  type HealthReport,
  healthHttpStatus,
} from '@omnicross/contracts/health-logging-types';
import type { Logger } from '@omnicross/core';

import type { AccountProbeHistoryReader } from '../AccountHealthProbeScheduler';
import type { ResolvedAdminConfig } from '../config';

import { handleAccountProbes } from './accountProbesApi';
import { type AuditQueryReader, handleAuditQuery } from './auditQueryApi';
import { type BillingStatusReader, handleBillingStatus } from './billingStatusApi';
import { handleWebhookTest } from './webhookTestApi';
import { type AdminApiDeps, handleAdminApi } from './adminApi';
import { handleUiStatic, resolveUiDist } from './uiStatic';
import { DAEMON_VERSION } from './version';

const LOOPBACK_ADDR = '127.0.0.1';
const LAN_ADDR = '0.0.0.0';

/** The dependencies the admin server + its API need (live daemon handles). */
export interface AdminServerDeps extends AdminApiDeps {
  /** Read the resolved admin config (enabled/port/networkBinding/token). */
  getAdminConfig: () => ResolvedAdminConfig;
  /**
   * Build the coarse, secret-free `/health` report (daemon-health-endpoint). A
   * shared closure over live handles (bootstrap wires the SAME builder into the
   * outbound server), served UNAUTHENTICATED — before the admin auth gate.
   */
  getHealthReport: () => HealthReport;
  /**
   * Injected logger (configurable-logging) — the admin listener's OWN lifecycle
   * lines (bind/refuse/error) route through it so they honor the configured
   * level / format / file sink.
   */
  logger: Logger;
  /**
   * OPTIONAL per-account probe-history reader (subscription-account-probe #8,
   * design D5). When wired (bootstrap → the `AccountHealthProbeScheduler`), the
   * AUTHED `GET /admin/api/account-probes` returns per-account probe history.
   * Absent ⇒ the route serves an empty list (byte-safe for embedders/tests that
   * do not wire it). Read-only + secret-free (ids + status labels, no tokens).
   */
  probeHistoryReader?: AccountProbeHistoryReader;
  /**
   * OPTIONAL audit query reader (request-audit-log, design D6). When wired
   * (bootstrap → the date-rotated store), the AUTHED `GET /admin/api/audit`
   * returns filtered records. Absent ⇒ the route serves an empty list. The
   * records carry IP/UA/bodies → this route is behind the auth gate ONLY, NEVER
   * unauthenticated, NEVER on `/health`.
   */
  auditReader?: AuditQueryReader;
  /**
   * OPTIONAL billing delivery-status reader (billing-event-stream, design D5).
   * When wired (bootstrap → the ledger dir), the AUTHED `GET /admin/api/billing-status`
   * returns secret-free total/delivered/pending counts. Absent ⇒ zeroed counts.
   */
  billingStatusReader?: BillingStatusReader;
}

/** A live status snapshot for the admin listener. */
export interface AdminServerStatus {
  running: boolean;
  /** Actual bound port (0 when not running). */
  port: number;
  /** The dashboard URL (loopback or LAN base), or null when not running. */
  url: string | null;
}

export class AdminServer {
  private server: http.Server | null = null;
  private boundPort = 0;
  private boundAddr = LOOPBACK_ADDR;
  /** Control Panel dist dir (resolved once at first request; null = no UI). */
  private uiDist: string | null | undefined;

  constructor(private readonly deps: AdminServerDeps) {}

  /**
   * Start the admin listener honoring the resolved admin config. Returns the
   * actual bound port, or `0` when it refuses/declines to bind (disabled or the
   * LAN fail-closed gate). Idempotent: a second call returns the bound port.
   */
  async start(): Promise<number> {
    if (this.server) return this.boundPort;
    const cfg = this.deps.getAdminConfig();
    if (!cfg.enabled) return 0;

    // HARD SAFETY GATE (design D2): never expose the dashboard on the LAN
    // without a token. Fail closed — log a clear error and stay down.
    if (cfg.networkBinding && !cfg.token) {
      this.deps.logger.error(
        '[AdminServer] REFUSING to bind: admin.networkBinding (LAN/0.0.0.0) requires a non-empty admin.token. ' +
          'Set admin.token in config.json or disable networkBinding. Dashboard stays DOWN (fail closed).',
      );
      return 0;
    }

    const bindAddr = cfg.networkBinding ? LAN_ADDR : LOOPBACK_ADDR;
    const actualPort = await this.listen(bindAddr, cfg.port);
    this.boundAddr = bindAddr;
    this.boundPort = actualPort;
    this.deps.logger.info(`[AdminServer] Dashboard listening on ${bindAddr}:${actualPort}`);
    return actualPort;
  }

  /** Bind once; on EADDRINUSE retry with an ephemeral port (port 0). */
  private listen(bindAddr: string, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.onRequest(req, res);
      });
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && port !== 0) {
          server.removeListener('error', onError);
          this.listen(bindAddr, 0).then(resolve, reject);
          return;
        }
        reject(err);
      };
      server.on('error', onError);
      server.listen(port, bindAddr, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          server.removeListener('error', onError);
          server.on('error', (e) => this.deps.logger.error('[AdminServer] server error', e));
          this.server = server;
          resolve(addr.port);
        } else {
          reject(new Error('Failed to get admin server address'));
        }
      });
    });
  }

  /** Per-request handler: auth gate (when a token is set) → routing. */
  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    void this.dispatch(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.logger.error('[AdminServer] unhandled error:', message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'admin_error', message } }));
      }
    });
  }

  private async dispatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const cfg = this.deps.getAdminConfig();

    // Identity handshake headers (desktop-shell adopt-or-restart): set on EVERY
    // response — including the 401 below — so the shell can tell "this is an
    // omnicross daemon, version X, pid Y" WITHOUT authenticating. Version + pid
    // only; never anything secret.
    res.setHeader('x-omnicross-daemon', DAEMON_VERSION);
    res.setHeader('x-omnicross-pid', String(process.pid));

    const url = req.url ?? '/';
    const path = url.split('?')[0];

    // UNAUTHENTICATED liveness/readiness probe (daemon-health-endpoint, D1):
    // mounted at the TOP — after the identity headers, BEFORE the auth gate — so
    // a container/orchestrator probe reaches it even when an `admin.token` is
    // configured. Coarse + secret-free body (no token/email/config-value); 200
    // when `ok`, else 503 (see `healthHttpStatus`).
    // Strip trailing slashes so `/health/` + `/healthz/` behave identically to
    // the bare forms (parity with the outbound server's `tryServeHealth`).
    const healthPath = path.replace(/\/+$/, '') || '/';
    if (
      (req.method === 'GET' || req.method === 'HEAD') &&
      (healthPath === '/health' || healthPath === '/healthz')
    ) {
      const report = this.deps.getHealthReport();
      const code = healthHttpStatus(report.status);
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(report));
      return;
    }

    // Auth gate — when a token is configured, EVERY /admin/* request (incl. the
    // dashboard HTML on `GET /`) must present it.
    if (cfg.token && !this.isAuthorized(req, cfg.token)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'unauthorized', message: 'admin token required' } }));
      return;
    }

    // The legacy embedded vanilla-JS dashboard is GONE — the Control Panel
    // (`/ui/`, the same React UI the desktop app wraps) is the only frontend.
    if ((req.method === 'GET' || req.method === 'HEAD') && (path === '/' || path === '/admin')) {
      res.writeHead(302, { Location: '/ui/' });
      res.end();
      return;
    }

    // AUTHED per-account probe history (subscription-account-probe #8) — routed
    // HERE (not through `adminApi.ts`, which is at its line cap) so it honors the
    // auth gate above yet keeps that router untouched. Detailed (names account
    // ids) → admin-only, unlike the coarse `/health` boolean.
    if (
      path === '/admin/api/account-probes' &&
      (req.method === 'GET' || req.method === 'HEAD')
    ) {
      handleAccountProbes(res, this.deps.probeHistoryReader);
      return;
    }

    // AUTHED audit query (request-audit-log, design D6) — routed HERE (not through
    // `adminApi.ts`, at its line cap) so it honors the auth gate above. The records
    // carry IP/UA + possibly bodies → admin-only; NEVER unauth, NEVER on `/health`.
    if (path === '/admin/api/audit' && (req.method === 'GET' || req.method === 'HEAD')) {
      handleAuditQuery(req, res, this.deps.auditReader);
      return;
    }

    // AUTHED billing delivery status (billing-event-stream, design D5) — routed
    // HERE (not through `adminApi.ts`, at its line cap) so it honors the auth gate
    // above. Secret-free counts only; no event payload, no secret.
    if (path === '/admin/api/billing-status' && (req.method === 'GET' || req.method === 'HEAD')) {
      handleBillingStatus(res, this.deps.billingStatusReader);
      return;
    }

    // AUTHED webhook test (webhook-notifications, D8) — routed HERE (not through
    // `adminApi.ts`, at its line cap) so it honors the auth gate above. Delivers a
    // `test` event to one destination via the live dispatcher; returns the outcome.
    if (path === '/admin/api/webhook-test' && req.method === 'POST') {
      await handleWebhookTest(req, res);
      return;
    }

    if (path.startsWith('/admin/api/')) {
      await handleAdminApi(req, res, path, this.deps);
      return;
    }

    // Control Panel web UI (same-origin static serving — no CORS needed).
    if (this.uiDist === undefined) this.uiDist = resolveUiDist();
    if (await handleUiStatic(req, res, path, this.uiDist)) return;

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'not_found', message: 'no such admin route' } }));
  }

  /** Constant-time bearer/header check against the configured token. */
  private isAuthorized(req: http.IncomingMessage, token: string): boolean {
    const header = req.headers['authorization'];
    const bearer =
      typeof header === 'string' && header.startsWith('Bearer ')
        ? header.slice('Bearer '.length).trim()
        : undefined;
    const xToken = req.headers['x-admin-token'];
    const presented = bearer ?? (typeof xToken === 'string' ? xToken.trim() : undefined);
    return constantTimeEquals(presented, token);
  }

  /** Stop the listener and release the port. */
  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    this.boundPort = 0;
    return new Promise((resolve) => {
      server.close(() => resolve());
    });
  }

  /** A live status snapshot. */
  getStatus(): AdminServerStatus {
    const running = this.server !== null;
    if (!running) return { running: false, port: 0, url: null };
    const host = this.boundAddr === LAN_ADDR ? LOOPBACK_ADDR : this.boundAddr;
    return { running: true, port: this.boundPort, url: `http://${host}:${this.boundPort}` };
  }
}

/** Constant-time string equality (length-guarded `timingSafeEqual`). */
function constantTimeEquals(a: string | undefined, b: string): boolean {
  if (typeof a !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
