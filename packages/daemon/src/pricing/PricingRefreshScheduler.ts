/**
 * Non-blocking stale-while-revalidate scheduler for the durable pricing table.
 *
 * `start()` never awaits the network. The UI and serving path continue to read
 * the last persisted `pricing.json` snapshot while this worker refreshes the
 * LiteLLM primary catalog and OpenRouter supplement in the background.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

import type { PricingSourceRefreshResult } from '@omnicross/contracts/pricing-types';
import type { Logger, PricingEngine } from '@omnicross/core';

export interface PricingRefreshState {
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  sources: PricingSourceRefreshResult[];
}

export interface PricingRefreshSchedulerOptions {
  staleAfterMs?: number;
  intervalMs?: number;
  now?: () => number;
}

export interface PricingCatalogSnapshot {
  hasUsableSnapshot(): boolean;
}

const EMPTY_STATE: PricingRefreshState = {
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastError: null,
  sources: [],
};

export class PricingRefreshScheduler {
  private readonly staleAfterMs: number;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly engine: PricingEngine,
    private readonly catalog: PricingCatalogSnapshot,
    private readonly statePath: string,
    private readonly logger: Logger,
    options: PricingRefreshSchedulerOptions = {},
  ) {
    this.staleAfterMs = options.staleAfterMs ?? 24 * 60 * 60 * 1000;
    this.intervalMs = options.intervalMs ?? 60 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  /** Fire one stale check immediately and arm an unref'ed periodic check. */
  start(): void {
    if (this.timer) return;
    void this.refreshIfStale();
    this.timer = setInterval(() => void this.refreshIfStale(), this.intervalMs);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getState(): PricingRefreshState {
    if (!existsSync(this.statePath)) return { ...EMPTY_STATE, sources: [] };
    try {
      const value = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<PricingRefreshState>;
      return {
        lastAttemptAt: finiteOrNull(value.lastAttemptAt),
        lastSuccessAt: finiteOrNull(value.lastSuccessAt),
        lastError: typeof value.lastError === 'string' ? value.lastError : null,
        sources: Array.isArray(value.sources) ? value.sources : [],
      };
    } catch {
      return { ...EMPTY_STATE, sources: [] };
    }
  }

  /** Public for admin/manual tests; concurrent checks share one promise. */
  refreshIfStale(force = false): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const state = this.getState();
    if (
      !force &&
      this.catalog.hasUsableSnapshot() &&
      state.lastSuccessAt !== null &&
      this.now() - state.lastSuccessAt < this.staleAfterMs
    ) {
      return Promise.resolve();
    }
    const task = this.runRefresh(state);
    this.inFlight = task;
    return task.finally(() => {
      if (this.inFlight === task) this.inFlight = null;
    });
  }

  private async runRefresh(previous: PricingRefreshState): Promise<void> {
    const lastAttemptAt = this.now();
    try {
      const result = await this.engine.fetchLatestFromSource();
      const failed = result.sources.filter((source) => source.status === 'failed');
      const complete = failed.length === 0;
      this.writeState({
        lastAttemptAt,
        // A partial refresh keeps useful rows, but remains stale so the failed
        // source is retried on the next hourly check instead of 24 hours later.
        lastSuccessAt: complete ? this.now() : previous.lastSuccessAt,
        lastError: complete
          ? null
          : failed.map((source) => `${source.source}: ${source.error ?? 'failed'}`).join('; '),
        sources: result.sources,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.writeState({
        lastAttemptAt,
        lastSuccessAt: previous.lastSuccessAt,
        lastError: message,
        sources: previous.sources,
      });
      this.logger.warn('[PricingRefreshScheduler] background refresh failed; cached prices retained', {
        error: message,
      });
    }
  }

  private writeState(state: PricingRefreshState): void {
    const temporaryPath = `${this.statePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    renameSync(temporaryPath, this.statePath);
  }
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
