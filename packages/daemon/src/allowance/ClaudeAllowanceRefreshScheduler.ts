/**
 * Low-frequency, non-blocking cache maintenance for Claude allowance snapshots.
 *
 * The routing policy intentionally ignores stale quota data. Without a resident
 * UI poll, the five-minute Claude snapshot would therefore age out and silently
 * stop influencing account selection. This worker checks once a minute and asks
 * the existing collector to refresh entries that are close to expiry. The
 * collector remains the cache/coalescing authority, so a tick normally performs
 * no network I/O and can share an in-flight request with the admin UI.
 *
 * Zero-regression invariant: the worker does not arm a timer or perform an
 * initial sweep unless `server.allowanceScheduling.enabled` is true.
 */

import type { Logger } from '@omnicross/core';
import type { AllowanceSchedulingConfig } from '@omnicross/core/outbound-api';

/** Cheap cache check cadence; this is not the upstream request cadence. */
export const CLAUDE_ALLOWANCE_CHECK_INTERVAL_MS = 60_000;
/** Refresh before the five-minute snapshot expires, avoiding a stale gap. */
export const CLAUDE_ALLOWANCE_REFRESH_AHEAD_MS = 90_000;

export interface ClaudeAllowanceCacheMaintainer {
  maintainClaudeCache(refreshAheadMs: number): Promise<void>;
}

export class ClaudeAllowanceRefreshScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private enabled = false;
  private sweeping = false;

  constructor(
    private readonly service: ClaudeAllowanceCacheMaintainer,
    private readonly logger: Logger,
    private readonly intervalMs: number = CLAUDE_ALLOWANCE_CHECK_INTERVAL_MS,
    private readonly refreshAheadMs: number = CLAUDE_ALLOWANCE_REFRESH_AHEAD_MS,
  ) {}

  /**
   * Apply live server policy. Once started, enable/disable changes arm or disarm
   * immediately; the initial enabled sweep is fire-and-forget.
   */
  configure(config: AllowanceSchedulingConfig | undefined): void {
    const nextEnabled = config?.enabled === true;
    if (this.enabled === nextEnabled) return;
    this.enabled = nextEnabled;
    if (!this.started) return;
    if (nextEnabled) {
      this.arm();
      void this.sweep();
    } else {
      this.disarm();
    }
  }

  /** Start the lifecycle. Disabled policy remains completely inert. */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (!this.enabled) return;
    this.arm();
    void this.sweep();
  }

  /** Stop all future checks. Idempotent and safe during an in-flight refresh. */
  dispose(): void {
    this.started = false;
    this.disarm();
  }

  /** One non-overlapping cache-maintenance pass. Exposed for focused tests. */
  async sweep(): Promise<void> {
    if (!this.enabled || this.sweeping) return;
    this.sweeping = true;
    try {
      await this.service.maintainClaudeCache(this.refreshAheadMs);
    } catch (error) {
      this.logger.warn('Claude allowance background refresh failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.sweeping = false;
    }
  }

  private arm(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sweep(), this.intervalMs);
    this.timer.unref?.();
  }

  private disarm(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
