/**
 * outboundRateLimiter — per-API-key in-memory sliding-window rate limiter for
 * the outbound API server (`outbound-api-server`, design D6).
 *
 * A simple fixed-size sliding window keyed by `apiKeyId`. In-memory only (resets
 * on app restart, acceptable for v1). Exceeding the limit returns a deny with a
 * `Retry-After` (seconds). Limits are conservative defaults, not user-
 * configurable in v1.
 *
 * @module outbound-api/outboundRateLimiter
 */

/** Default window length (ms). */
const DEFAULT_WINDOW_MS = 60_000;
/** Default max requests per key per window. */
const DEFAULT_MAX_REQUESTS = 60;

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the window frees up (only meaningful when `!allowed`). */
  retryAfterSeconds: number;
}

export interface RateLimiterOptions {
  windowMs?: number;
  maxRequests?: number;
}

/**
 * Per-key sliding-window limiter. `check(apiKeyId)` records the request and
 * returns whether it is allowed.
 */
export class OutboundRateLimiter {
  private readonly windowMs: number;
  private readonly maxRequests: number;
  /** apiKeyId → ascending request timestamps within the current window. */
  private readonly hits = new Map<string, number[]>();

  constructor(options: RateLimiterOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
  }

  /**
   * Record a request for `apiKeyId` and decide whether it is allowed. Prunes
   * timestamps older than the window first; when allowed, the request's
   * timestamp is appended.
   *
   * `override` (outbound-key-policy) supplies a PER-KEY window/max for this
   * bucket, superseding the instance defaults for THAT key. Absent ⇒ the
   * instance default 60/60s (byte-identical to before this change). An effective
   * `maxRequests` of `0` means UNLIMITED — the request is allowed and NOT
   * recorded (no bucket growth).
   */
  check(
    apiKeyId: string,
    now: number = Date.now(),
    override?: RateLimiterOptions,
  ): RateLimitDecision {
    const maxRequests = override?.maxRequests ?? this.maxRequests;
    const windowMs = override?.windowMs ?? this.windowMs;
    // `0` = unlimited: bypass entirely (allow, no bucket record).
    if (maxRequests === 0) return { allowed: true, retryAfterSeconds: 0 };

    const cutoff = now - windowMs;
    const timestamps = (this.hits.get(apiKeyId) ?? []).filter((ts) => ts > cutoff);

    if (timestamps.length >= maxRequests) {
      // Window full — deny. Retry-After = time until the oldest hit ages out.
      // m6: when the pruned window is empty, drop the entry rather than
      // re-storing an empty array, so the map does not accumulate empty entries
      // for keys that never get an allowed hit.
      if (timestamps.length === 0) {
        this.hits.delete(apiKeyId);
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(windowMs / 1000)) };
      }
      const oldest = timestamps[0];
      const retryAfterMs = Math.max(0, oldest + windowMs - now);
      this.hits.set(apiKeyId, timestamps);
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      };
    }

    timestamps.push(now);
    this.hits.set(apiKeyId, timestamps);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Drop all recorded state (tests / teardown). */
  reset(): void {
    this.hits.clear();
  }
}
