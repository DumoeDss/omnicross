/**
 * CircuitBreaker — per-model circuit breaker for OpenCodeGo subscription routing.
 *
 * One `CircuitBreaker` tracks one model's health across
 * requests; the `CircuitBreakerRegistry` lazily owns one breaker per model id
 * in a per-model registry.
 *
 * State machine (defaults are configurable for deterministic tests):
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

/** The three circuit-breaker states. */
export type CircuitState = 'closed' | 'open' | 'half-open';

/** Constructor knobs with production defaults. */
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

interface CircuitSnapshot {
  mode: CircuitState;
  consecutiveFailures: number;
  openedAt: number;
  probeAdmissions: number;
  probeSuccesses: number;
}

/**
 * One model's circuit-breaker state machine. It runs on the single Node event
 * loop, so no mutex is needed.
 */
export class CircuitBreaker {
  private snapshot: CircuitSnapshot = {
    mode: 'closed',
    consecutiveFailures: 0,
    openedAt: 0,
    probeAdmissions: 0,
    probeSuccesses: 0,
  };

  private readonly limits: Required<Omit<CircuitBreakerOptions, 'now'>>;
  private readonly now: () => number;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.limits = {
      threshold: opts.threshold ?? 3,
      openMs: opts.openMs ?? 30_000,
      halfOpenMaxCalls: opts.halfOpenMaxCalls ?? 3,
    };
    this.now = opts.now ?? Date.now;
  }

  /** Current state (diagnostics / tests). */
  getState(): CircuitState {
    return this.snapshot.mode;
  }

  /**
   * Admission gate. Returns whether a
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
    if (this.snapshot.mode === 'closed') return true;

    if (this.snapshot.mode === 'open') {
      const elapsed = this.now() - this.snapshot.openedAt;
      if (elapsed <= this.limits.openMs) return false;
      this.snapshot = {
        ...this.snapshot,
        mode: 'half-open',
        probeAdmissions: 1,
        probeSuccesses: 0,
      };
      return true;
    }

    if (this.snapshot.probeAdmissions >= this.limits.halfOpenMaxCalls) return false;
    this.snapshot = {
      ...this.snapshot,
      probeAdmissions: this.snapshot.probeAdmissions + 1,
    };
    return true;
  }

  /**
   * Record a successful attempt.
   *   - `half-open` → increment `successCount`; at `halfOpenMaxCalls` successes,
   *     CLOSE the circuit and reset all counters.
   *   - `closed`    → reset the consecutive `failureCount` (a single good call
   *     clears the streak).
   */
  recordSuccess(): void {
    if (this.snapshot.mode === 'open') return;

    if (this.snapshot.mode === 'closed') {
      if (this.snapshot.consecutiveFailures !== 0) {
        this.snapshot = { ...this.snapshot, consecutiveFailures: 0 };
      }
      return;
    }

    const probeSuccesses = this.snapshot.probeSuccesses + 1;
    if (probeSuccesses >= this.limits.halfOpenMaxCalls) {
      this.snapshot = {
        mode: 'closed',
        consecutiveFailures: 0,
        openedAt: 0,
        probeAdmissions: 0,
        probeSuccesses: 0,
      };
      return;
    }
    this.snapshot = { ...this.snapshot, probeSuccesses };
  }

  /**
   * Record a failed attempt.
   *   - `half-open` → immediately RE-OPEN (one probe failure is enough); stamp
   *     `lastFailureTime`, reset `successCount`.
   *   - `closed`    → increment the consecutive `failureCount`; at `threshold`,
   *     OPEN the circuit. Always stamp `lastFailureTime`.
   */
  recordFailure(): void {
    const openedAt = this.now();
    if (this.snapshot.mode === 'half-open') {
      this.snapshot = {
        ...this.snapshot,
        mode: 'open',
        openedAt,
        probeAdmissions: 0,
        probeSuccesses: 0,
      };
      return;
    }

    const consecutiveFailures = this.snapshot.consecutiveFailures + 1;
    this.snapshot = {
      ...this.snapshot,
      consecutiveFailures,
      openedAt,
      mode: consecutiveFailures >= this.limits.threshold ? 'open' : this.snapshot.mode,
    };
    if (this.snapshot.mode === 'open') {
      this.snapshot.probeAdmissions = 0;
      this.snapshot.probeSuccesses = 0;
    }
  }
}

/**
 * Per-model registry of `CircuitBreaker`s. Lazily creates a
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
