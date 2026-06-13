/**
 * CircuitBreaker — per-model circuit breaker for OpenCodeGo subscription routing.
 *
 * Ported VERBATIM from `_others/oc-go-cc/internal/router/fallback.go:38-115`
 * (audit item D5). One `CircuitBreaker` tracks ONE model's health across
 * requests; the `CircuitBreakerRegistry` lazily owns one breaker per model id
 * (mirroring the reference `FallbackHandler.circuitBreakers map[string]*CircuitBreaker`).
 *
 * State machine (reference thresholds, NOT user-configurable):
 *   - `closed`    : normal. Opens after **3 consecutive failures**
 *                   (`failureCount >= threshold`); any success in `closed`
 *                   RESETS `failureCount` to 0 (failures are CONSECUTIVE).
 *   - `open`      : reject all requests for **30s** since the last failure. The
 *                   next `allowRequest` AFTER the window elapses flips it to
 *                   `half-open` and admits a test call (consult IS the gate).
 *   - `half-open` : admit at most **3** test calls. **3 successes** → `closed`
 *                   (counters reset); **1 failure** → immediately back to `open`.
 *
 * Timing reads an injectable `now: () => number` (default `Date.now`) so tests
 * advance past the 30s window deterministically, with no real timers (design D5).
 *
 * NOTE: this class lives EXCLUSIVELY in `@omnicross/subscriptions` — the
 * cross-layer litmus forbids `@omnicross/core` from importing it. Core only ever
 * invokes the OPTIONAL `recordModelOutcome` profile callback that closes over a
 * registry instance built here.
 *
 * @module opencodego/CircuitBreaker
 */

/** The three breaker states (mirrors the reference `closed`/`open`/`half-open`). */
export type CircuitState = 'closed' | 'open' | 'half-open';

/** Constructor knobs — all default to the reference's verbatim values. */
export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit. Default 3. */
  threshold?: number;
  /** How long the circuit stays open before half-open is admitted (ms). Default 30_000. */
  openMs?: number;
  /** Max half-open test calls admitted AND the success-count needed to close. Default 3. */
  halfOpenMaxCalls?: number;
  /** Injectable clock (ms). Default `Date.now`. */
  now?: () => number;
}

/**
 * One model's circuit-breaker state machine. Faithful port of the reference
 * `CircuitBreaker` (`fallback.go:38-115`): same fields, same transitions, same
 * thresholds. The reference mutates under a mutex; this runs on the single Node
 * event loop so no lock is needed.
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  /** CONSECUTIVE failures while closed (reset by any closed success). */
  private failureCount = 0;
  /** Successes accumulated in the current half-open probe window. */
  private successCount = 0;
  /** Test calls admitted in the current half-open window (cap = halfOpenMaxCalls). */
  private halfOpenCalls = 0;
  /** `now()` at the last recorded failure — drives the open→half-open elapsed check. */
  private lastFailureTime = 0;

  private readonly threshold: number;
  private readonly openMs: number;
  private readonly halfOpenMaxCalls: number;
  private readonly now: () => number;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.threshold = opts.threshold ?? 3;
    this.openMs = opts.openMs ?? 30_000;
    this.halfOpenMaxCalls = opts.halfOpenMaxCalls ?? 3;
    this.now = opts.now ?? Date.now;
  }

  /** Current state (diagnostics / tests). */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Admission gate (`fallback.go:54-72` `AllowRequest`). Returns whether a
   * request to this model is allowed RIGHT NOW. Side-effecting BY DESIGN:
   *   - `closed`    → always admit.
   *   - `open`      → if `now() - lastFailureTime > openMs`, FLIP to `half-open`,
   *                   reset the probe counters, admit the FIRST test call;
   *                   otherwise reject.
   *   - `half-open` → admit while `halfOpenCalls < halfOpenMaxCalls`, counting
   *                   each admission; reject once the cap is reached (until a
   *                   recorded outcome resolves the state).
   */
  allowRequest(): boolean {
    switch (this.state) {
      case 'closed':
        return true;
      case 'open':
        if (this.now() - this.lastFailureTime > this.openMs) {
          // Transition to half-open and admit the first test call.
          this.state = 'half-open';
          this.successCount = 0;
          this.halfOpenCalls = 1;
          return true;
        }
        return false;
      case 'half-open':
        if (this.halfOpenCalls < this.halfOpenMaxCalls) {
          this.halfOpenCalls += 1;
          return true;
        }
        return false;
      default:
        return true;
    }
  }

  /**
   * Record a successful attempt (`fallback.go:75-91` `RecordSuccess`).
   *   - `half-open` → increment `successCount`; at `halfOpenMaxCalls` successes,
   *     CLOSE the circuit and reset all counters.
   *   - `closed`    → reset the consecutive `failureCount` (a single good call
   *     clears the streak).
   */
  recordSuccess(): void {
    if (this.state === 'half-open') {
      this.successCount += 1;
      if (this.successCount >= this.halfOpenMaxCalls) {
        this.state = 'closed';
        this.failureCount = 0;
        this.successCount = 0;
        this.halfOpenCalls = 0;
      }
      return;
    }
    // closed (open never records — allowRequest gates it): clear the streak.
    this.failureCount = 0;
  }

  /**
   * Record a failed attempt (`fallback.go:94-115` `RecordFailure`).
   *   - `half-open` → immediately RE-OPEN (one probe failure is enough); stamp
   *     `lastFailureTime`, reset `successCount`.
   *   - `closed`    → increment the consecutive `failureCount`; at `threshold`,
   *     OPEN the circuit. Always stamp `lastFailureTime`.
   */
  recordFailure(): void {
    this.lastFailureTime = this.now();
    if (this.state === 'half-open') {
      this.state = 'open';
      this.successCount = 0;
      this.halfOpenCalls = 0;
      return;
    }
    this.failureCount += 1;
    if (this.failureCount >= this.threshold) {
      this.state = 'open';
    }
  }
}

/**
 * Per-model registry of `CircuitBreaker`s (mirrors the reference
 * `FallbackHandler.getCircuitBreaker`, `fallback.go:156-166`). Lazily creates a
 * breaker the first time a model id is seen, threading the SAME options (clock +
 * thresholds) to every child. Owned as a single process instance by
 * `SubscriptionProviderRegistry` (design D1) so breaker state is shared across
 * requests.
 */
export class CircuitBreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(private readonly options: CircuitBreakerOptions = {}) {}

  /** Get (or lazily create) the breaker for a model id. */
  private get(modelId: string): CircuitBreaker {
    let breaker = this.breakers.get(modelId);
    if (!breaker) {
      breaker = new CircuitBreaker(this.options);
      this.breakers.set(modelId, breaker);
    }
    return breaker;
  }

  /** Admission gate for a model (creates a fresh closed breaker on first sight). */
  allowRequest(modelId: string): boolean {
    return this.get(modelId).allowRequest();
  }

  /** Record a successful attempt for a model. */
  recordSuccess(modelId: string): void {
    this.get(modelId).recordSuccess();
  }

  /** Record a failed attempt for a model. */
  recordFailure(modelId: string): void {
    this.get(modelId).recordFailure();
  }
}
