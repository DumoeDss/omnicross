/**
 * UsageRecorder — funnels every captured LLM-request event through cost
 * calculation and persists it via the injected `UsageEventStore`.
 *
 * Capture taps call `record()` synchronously with the parsed usage data. The
 * store insert is enqueued via an injectable deferral function (default: a
 * zero-delay timer; Node hosts may inject `setImmediate`) so the response path
 * is never blocked on disk I/O.
 *
 * @module usage/usage-recorder
 */
import type {
  ApiKeyUsageRow,
  MessageUsageRow,
  ModelUsageRow,
  SessionCacheStats,
  UsageDateRange,
  UsageEventInput,
  UsageTotals,
} from '@omnicross/contracts/usage-stats-types';
import type { UsageEngineOrigin, UsageTokens } from '@omnicross/contracts/usage-types';

import type { Logger } from '../ports/logger';
import type { UsageEventStore } from '../ports/usage-event-store';

import type { PricingEngine } from './pricing-engine';

/** Subset of fields the caller MUST provide. Recorder fills cost (store fills ts). */
export interface UsageRecordInput {
  messageId?: string | null;
  parentMessageId?: string | null;
  sessionId?: string | null;
  providerId: string;
  model: string;
  apiKeyId?: string | null;
  engineOrigin: UsageEngineOrigin;
  usage: UsageTokens;
  /** Optional raw provider usage block — kept verbatim for forensics. */
  rawUsage?: unknown;
  /** Host run-correlation id. Optional / additive. */
  runId?: string | null;
  /** Host event-correlation id for this call. Optional / additive. */
  eventId?: string | null;
}

/** Optional knobs (mostly for hosts/tests). */
export interface UsageRecorderOptions {
  /**
   * Deferral function used by `record()` to schedule the async persist off
   * the caller's path. Defaults to a zero-delay timer; Node hosts may inject
   * `setImmediate` to preserve their exact scheduling.
   */
  defer?: (fn: () => void) => void;
}

export class UsageRecorder {
  private defer: (fn: () => void) => void;

  constructor(
    private store: UsageEventStore,
    private pricing: PricingEngine,
    private logger: Logger,
    options: UsageRecorderOptions = {},
  ) {
    this.defer = options.defer ?? (fn => setTimeout(fn, 0));
  }

  /**
   * Record one LLM request. Returns immediately — the actual store insert is
   * deferred so the caller's response path is unblocked.
   *
   * Errors during the insert are logged but never thrown.
   */
  record(input: UsageRecordInput): void {
    this.defer(() => {
      void this.recordAsync(input).catch(err => {
        this.logger.warn('[UsageRecorder] failed to persist usage event', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });
  }

  /**
   * Same as `record()` but awaitable — preferred in tests so they can assert
   * after the row exists.
   */
  async recordAsync(input: UsageRecordInput): Promise<string | null> {
    const { costUsd, costSavedByCacheUsd } = await this.pricing.calculateCost(
      input.providerId,
      input.model,
      input.usage,
    );

    const row: UsageEventInput = {
      messageId: input.messageId ?? null,
      parentMessageId: input.parentMessageId ?? null,
      sessionId: input.sessionId ?? null,
      providerId: input.providerId,
      model: input.model,
      apiKeyId: input.apiKeyId ?? null,
      engineOrigin: input.engineOrigin,
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      cacheReadTokens: input.usage.cacheReadTokens,
      cacheCreationTokens: input.usage.cacheCreationTokens,
      reasoningTokens: input.usage.reasoningTokens,
      costUsd,
      costSavedByCacheUsd,
      rawUsage: input.rawUsage != null ? safeStringify(input.rawUsage) : null,
      runId: input.runId ?? null,
      eventId: input.eventId ?? null,
    };

    try {
      return await this.store.insert(row);
    } catch (err) {
      this.logger.warn('[UsageRecorder] store insert failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // ===== Query delegates =====

  getTotals(range: UsageDateRange): Promise<UsageTotals> {
    return this.store.getTotals(range);
  }

  getByModel(range: UsageDateRange): Promise<ModelUsageRow[]> {
    return this.store.getByModel(range);
  }

  getByApiKey(range: UsageDateRange): Promise<ApiKeyUsageRow[]> {
    return this.store.getByApiKey(range);
  }

  getMessagesForSession(sessionId: string): Promise<MessageUsageRow[]> {
    return this.store.getMessagesForSession(sessionId);
  }

  /** Cumulative cache hit/miss stats for one session. */
  getSessionCacheStats(sessionId: string): Promise<SessionCacheStats> {
    return this.store.getSessionCacheStats(sessionId);
  }
}

const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
};
