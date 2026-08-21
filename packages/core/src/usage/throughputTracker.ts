/**
 * throughputTracker — a bounded, in-memory sliding window of recently recorded
 * usage events, answering "how fast is the gateway serving RIGHT NOW".
 *
 * WHY a dedicated in-memory store (not a `UsageEventStore` range query): the
 * daemon's `JsonlUsageEventStore.getTotals()` reads and parses the ENTIRE
 * `usage-events.jsonl` synchronously on every call (a deliberate simplification
 * documented there). That is fine for an on-demand stats page, but a live rate
 * widget polls every few seconds, and a periodic synchronous full-file scan
 * would stall the same event loop that is relaying gateway requests. This
 * tracker is fed O(1) per recorded request from `UsageRecorder`'s `onEvent`
 * hook and read in O(samples-in-window) — it never touches disk.
 *
 * Shaped like `pipeline/ServerOverloadCounter`: process-local, cleared on
 * restart, an injectable `now` clock, no external deps. It carries ONLY token
 * counts, costs, and epoch timestamps — never a prompt, header, model secret,
 * or key id — so no snapshot of it can leak one.
 *
 * TWO MEASUREMENT DECISIONS worth stating explicitly, because both are easy to
 * get subtly wrong:
 *
 *  1. `totalTokens` deliberately EXCLUDES `reasoningTokens`. Providers report
 *     reasoning tokens as a SUBSET of the completion/output tokens, so adding
 *     them would double-count. They are still reported separately.
 *
 *  2. Rates always divide by the FULL requested window, never by "how long this
 *     process has been up". A daemon that was down served no traffic, so the
 *     honest rate over that wall-clock window really is lower; after a restart
 *     the number climbs back from zero on its own. `startedAt` is reported so a
 *     reader can say "this process started less than a window ago" without the
 *     rate itself being fudged.
 *
 * @module usage/throughputTracker
 */

/** Longest window a snapshot can answer; also the sample-retention horizon. */
export const THROUGHPUT_RETENTION_MS = 15 * 60_000;

/**
 * Hard memory ceiling on retained samples (~20k x a few dozen bytes). Reaching
 * it means sustained >22 req/s for a full 15 minutes; past that the OLDEST
 * samples are evicted and the affected windows report `complete: false` rather
 * than quietly under-reporting.
 */
export const THROUGHPUT_SAMPLE_LIMIT = 20_000;

/** Windows every snapshot reports, shortest first. The last must be <= retention. */
export const THROUGHPUT_WINDOWS_MS = [60_000, 300_000, 900_000] as const;

/** Trend-series resolution: 30 buckets across the retention horizon (30s each). */
export const THROUGHPUT_BUCKET_COUNT = 30;

/** Compact the sample array once this many consumed slots pile up at the front. */
const COMPACT_THRESHOLD = 1_024;

/**
 * One recorded request's contribution. Structurally satisfied by the recorder's
 * `UsageEventInput` row, so the daemon can forward it verbatim.
 */
export interface UsageThroughputInput {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  costUsd: number;
  /** Epoch-ms of the event. Omit to use the `now` argument. */
  ts?: number;
}

interface ThroughputSample {
  ts: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  costUsd: number;
}

/** Aggregates + rates for one trailing window. */
export interface UsageThroughputWindow {
  /** Trailing window this row covers, in ms. */
  windowMs: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  /** input + output + cacheRead + cacheCreation (reasoning is a subset of output). */
  totalTokens: number;
  costUsd: number;
  requestsPerMinute: number;
  /** The headline TPM: `totalTokens` per minute over `windowMs`. */
  tokensPerMinute: number;
  inputTokensPerMinute: number;
  outputTokensPerMinute: number;
  costUsdPerMinute: number;
  /**
   * False when the sample cap evicted events that fall inside this window, so
   * every figure above is a LOWER BOUND rather than an exact count.
   */
  complete: boolean;
}

/** One fixed-width bucket of the trend series. */
export interface UsageThroughputBucket {
  /** Epoch-ms of the bucket's (grid-aligned) start. */
  startTs: number;
  requests: number;
  tokens: number;
}

/** The `GET /admin/api/usage/throughput` payload. */
export interface UsageThroughputSnapshot {
  /** Always true here; the UI's fallback shape uses `false` for older daemons. */
  available: true;
  collectedAt: number;
  /** Epoch-ms this tracker began observing (effectively the daemon's start). */
  startedAt: number;
  retentionMs: number;
  /** Width of one `buckets` entry, in ms. */
  bucketMs: number;
  /** One row per {@link THROUGHPUT_WINDOWS_MS} entry, shortest window first. */
  windows: UsageThroughputWindow[];
  /**
   * Oldest to newest, exactly {@link THROUGHPUT_BUCKET_COUNT} entries covering
   * `retentionMs` on a `bucketMs` grid. Empty buckets are present and zeroed;
   * the final bucket is still in progress. Grid alignment (rather than
   * "now minus retention") keeps boundaries stable between polls so a sparkline
   * does not shimmer.
   */
  buckets: UsageThroughputBucket[];
}

export class UsageThroughputTracker {
  private samples: ThroughputSample[] = [];
  /** Index of the oldest live sample; slots before it are consumed. */
  private head = 0;
  private readonly startedAt: number;
  /** Newest ts dropped by the sample CAP (not by retention). Null when none. */
  private evictedThroughTs: number | null = null;

  constructor(now: number = Date.now()) {
    this.startedAt = now;
  }

  /** Record one served request. O(1) amortised; never touches disk. */
  record(input: UsageThroughputInput, now: number = Date.now()): void {
    this.samples.push({
      ts: input.ts ?? now,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadTokens: input.cacheReadTokens,
      cacheCreationTokens: input.cacheCreationTokens,
      reasoningTokens: input.reasoningTokens,
      costUsd: input.costUsd,
    });
    this.prune(now);
  }

  /** Aggregate every reported window plus the shared trend series. */
  snapshot(now: number = Date.now()): UsageThroughputSnapshot {
    this.prune(now);
    return {
      available: true,
      collectedAt: now,
      startedAt: this.startedAt,
      retentionMs: THROUGHPUT_RETENTION_MS,
      bucketMs: THROUGHPUT_RETENTION_MS / THROUGHPUT_BUCKET_COUNT,
      windows: THROUGHPUT_WINDOWS_MS.map((windowMs) => this.window(windowMs, now)),
      buckets: this.buckets(now),
    };
  }

  /** Drop all samples (tests / teardown). `startedAt` is unchanged. */
  clear(): void {
    this.samples = [];
    this.head = 0;
    this.evictedThroughTs = null;
  }

  /**
   * Drop samples past the retention horizon, then enforce the sample cap.
   *
   * Retention pruning uses the CALLER's `now`, which is never later than a
   * subsequent snapshot's `now`, so it can only ever keep MORE than the widest
   * window needs — it can never shave data off the 15-minute window.
   */
  private prune(now: number): void {
    const cutoff = now - THROUGHPUT_RETENTION_MS;
    while (this.head < this.samples.length && this.samples[this.head]!.ts < cutoff) {
      this.head += 1;
    }
    // Cap eviction is real data loss inside the retention horizon, so remember
    // how far it reached — the affected windows must admit they are partial.
    while (this.samples.length - this.head > THROUGHPUT_SAMPLE_LIMIT) {
      const dropped = this.samples[this.head]!;
      this.evictedThroughTs = this.evictedThroughTs === null
        ? dropped.ts
        : Math.max(this.evictedThroughTs, dropped.ts);
      this.head += 1;
    }
    if (this.head >= COMPACT_THRESHOLD) {
      this.samples = this.samples.slice(this.head);
      this.head = 0;
    }
  }

  private window(windowMs: number, now: number): UsageThroughputWindow {
    const startTs = now - windowMs;
    const row: UsageThroughputWindow = {
      windowMs,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      requestsPerMinute: 0,
      tokensPerMinute: 0,
      inputTokensPerMinute: 0,
      outputTokensPerMinute: 0,
      costUsdPerMinute: 0,
      complete: this.evictedThroughTs === null || this.evictedThroughTs < startTs,
    };
    for (let i = this.head; i < this.samples.length; i += 1) {
      const sample = this.samples[i]!;
      if (sample.ts < startTs) continue;
      row.requests += 1;
      row.inputTokens += sample.inputTokens;
      row.outputTokens += sample.outputTokens;
      row.cacheReadTokens += sample.cacheReadTokens;
      row.cacheCreationTokens += sample.cacheCreationTokens;
      row.reasoningTokens += sample.reasoningTokens;
      row.costUsd += sample.costUsd;
    }
    row.totalTokens =
      row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheCreationTokens;

    const minutes = windowMs / 60_000;
    row.requestsPerMinute = row.requests / minutes;
    row.tokensPerMinute = row.totalTokens / minutes;
    row.inputTokensPerMinute = row.inputTokens / minutes;
    row.outputTokensPerMinute = row.outputTokens / minutes;
    row.costUsdPerMinute = row.costUsd / minutes;
    return row;
  }

  private buckets(now: number): UsageThroughputBucket[] {
    const bucketMs = THROUGHPUT_RETENTION_MS / THROUGHPUT_BUCKET_COUNT;
    const endTs = Math.floor(now / bucketMs) * bucketMs + bucketMs;
    const startTs = endTs - THROUGHPUT_RETENTION_MS;
    const out: UsageThroughputBucket[] = [];
    for (let i = 0; i < THROUGHPUT_BUCKET_COUNT; i += 1) {
      out.push({ startTs: startTs + i * bucketMs, requests: 0, tokens: 0 });
    }
    for (let i = this.head; i < this.samples.length; i += 1) {
      const sample = this.samples[i]!;
      if (sample.ts < startTs || sample.ts >= endTs) continue;
      const bucket = out[Math.floor((sample.ts - startTs) / bucketMs)];
      if (!bucket) continue;
      bucket.requests += 1;
      bucket.tokens +=
        sample.inputTokens +
        sample.outputTokens +
        sample.cacheReadTokens +
        sample.cacheCreationTokens;
    }
    return out;
  }
}

let sharedTracker: UsageThroughputTracker | null = null;

export function getSharedUsageThroughputTracker(): UsageThroughputTracker {
  if (!sharedTracker) sharedTracker = new UsageThroughputTracker();
  return sharedTracker;
}

/**
 * TEST SEAM — swap the singleton (e.g. with a fixed-clock instance). Mirrors the
 * `setShared…`/`__reset…ForTests` discipline of the sibling in-memory stores.
 */
export function setSharedUsageThroughputTracker(instance: UsageThroughputTracker): void {
  sharedTracker = instance;
}

export function __resetSharedUsageThroughputTrackerForTests(): void {
  sharedTracker = null;
}
