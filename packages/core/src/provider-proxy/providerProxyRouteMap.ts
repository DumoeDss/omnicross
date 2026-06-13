/**
 * ProviderProxyRouteMap — the per-run `Map<token, RouteContext>` with crypto
 * route-token minting + TTL/idle reaping.
 *
 * OpenSpec `engine-provider-decouple` tasks 2.2 + 2.3 (design D9). Isolation is
 * CODE-enforced, not network-enforced:
 *   - tokens are minted from `node:crypto` (`randomBytes`), so they are
 *     unguessable and run A's token can never resolve run B's `RouteContext`;
 *   - a lookup that misses or whose entry has been reaped returns `undefined`
 *     (the caller rejects with no fallback);
 *   - each entry carries an idle timer (`armIdleTimer` / `clearIdleTimer` /
 *     `DEFAULT_IDLE_TIMEOUT_MS`): the timer is `.unref()`'d
 *     so it never holds the process open, is touched on each `lookup`, and
 *     reaps the entry after `DEFAULT_ROUTE_IDLE_MS` with no traffic.
 *
 * @module provider-proxy/providerProxyRouteMap
 */

import { randomBytes } from 'node:crypto';

import type { RouteContext } from './types';

/**
 * Idle teardown: drop a route entry after this long with no request touching
 * it. Mirrors the ACP manager's `DEFAULT_IDLE_TIMEOUT_MS` (10 min) — a run's
 * route should outlive normal between-request gaps but never leak after the
 * run ends without an explicit `removeRoute`.
 */
export const DEFAULT_ROUTE_IDLE_MS = 10 * 60 * 1000;

/** Bytes of entropy per token (256-bit, hex-encoded → 64 chars). */
const TOKEN_BYTES = 32;

/** One live route entry: the context + its idle reaper bookkeeping. */
interface RouteEntry {
  readonly context: RouteContext;
  idleTimer: NodeJS.Timeout | null;
  readonly idleMs: number;
}

/**
 * The resident proxy owns ONE of these for the whole app session. Per-run
 * state is added at run start (`addRoute`) and removed at run end
 * (`removeRoute`) or reaped on idle TTL.
 */
export class ProviderProxyRouteMap {
  private readonly routes = new Map<string, RouteEntry>();

  constructor(private readonly defaultIdleMs: number = DEFAULT_ROUTE_IDLE_MS) {}

  /**
   * Register a route for one run and return its crypto-random token. The
   * caller (next batch) injects the token as the forwarded auth-header sentinel
   * (`ANTHROPIC_AUTH_TOKEN` / `OPENAI_API_KEY`). Optionally override the idle
   * timeout (tests use a short one).
   */
  addRoute(context: RouteContext, idleMs?: number): string {
    const token = randomBytes(TOKEN_BYTES).toString('hex');
    const entry: RouteEntry = {
      context,
      idleTimer: null,
      idleMs: idleMs ?? this.defaultIdleMs,
    };
    this.routes.set(token, entry);
    this.armIdleTimer(token, entry);
    return token;
  }

  /**
   * Look up a route by its token, touching the idle timer so an active run's
   * context survives. Returns `undefined` on a miss / reaped entry — the caller
   * rejects (no fallback).
   */
  lookup(token: string | undefined | null): RouteContext | undefined {
    if (!token) return undefined;
    const entry = this.routes.get(token);
    if (!entry) return undefined;
    // Touch: re-arm the idle timer on each request (mirrors ACP's
    // clearIdleTimer-on-activity + armIdleTimer-after-turn).
    this.armIdleTimer(token, entry);
    return entry.context;
  }

  /** Remove a route at run end. Returns true if an entry existed. */
  removeRoute(token: string): boolean {
    const entry = this.routes.get(token);
    if (!entry) return false;
    this.clearIdleTimer(entry);
    this.routes.delete(token);
    return true;
  }

  /** Current live-route count (tests / diagnostics). */
  size(): number {
    return this.routes.size;
  }

  /** Whether a token currently resolves (does NOT touch the idle timer). */
  has(token: string): boolean {
    return this.routes.has(token);
  }

  /** Tear down every route (proxy stop / app teardown). */
  clear(): void {
    for (const entry of this.routes.values()) {
      this.clearIdleTimer(entry);
    }
    this.routes.clear();
  }

  // ---------------------------------------------------------------------------
  // Idle reaping (modeled on AcpSessionManager.armIdleTimer / clearIdleTimer)
  // ---------------------------------------------------------------------------

  private armIdleTimer(token: string, entry: RouteEntry): void {
    this.clearIdleTimer(entry);
    entry.idleTimer = setTimeout(() => {
      // Reap: drop the entry. A later lookup with this token misses → reject.
      this.routes.delete(token);
    }, entry.idleMs);
    // Don't keep the event loop alive purely for the route reaper.
    entry.idleTimer.unref?.();
  }

  private clearIdleTimer(entry: RouteEntry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }
}
