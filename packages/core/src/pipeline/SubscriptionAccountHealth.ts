/**
 * SubscriptionAccountHealth — the in-memory account health state machine
 * (subscription-account-health, design D1/D2/D3/D6).
 *
 * Shaped like the existing per-model `CircuitBreaker` (`opencodego/CircuitBreaker`):
 * an in-memory `Map`, an injectable `now` clock, and NO external deps / NO
 * persistence. It is keyed by an opaque `providerId + '\0' + accountId` string —
 * core never learns "account" semantics, exactly as the breaker keys by opaque
 * `modelId`. It is hosted in `@omnicross/core` because all three consumers reach
 * it in the allowed dependency direction:
 *   - the subscriptions strategies COMPUTE `schedulable` (`isSchedulable`) + mark
 *     a final-401;
 *   - the core `/v1/messages` relay MARKS 429/529/403/5xx from the upstream
 *     response (`recordUpstreamOutcome`);
 *   - the daemon `AccountHealthSweeper` drives proactive recovery
 *     (`sweepRecoveries` + `onRecovered`).
 *
 * It carries NO secrets — only statuses + epoch-ms timers — so the secret-free
 * discipline is untouched. Health is IN-MEMORY (cleared on restart): the worst
 * case after a restart is one request hitting a still-cooling account and getting
 * the upstream's authoritative 429 (which re-marks it). Nothing is written to
 * `tokens.json`.
 *
 * @module pipeline/SubscriptionAccountHealth
 */

/** Default 529 overload cooldown (LEAD OQ1: ON by default, bounded 10 min). */
export const OVERLOAD_TTL_MS = 10 * 60_000;
/** 529 overload cooldown enabled by default (LEAD OQ1). */
export const OVERLOAD_ENABLED_DEFAULT = true;
/** Transient cooldown for a final-401 / plain-403 (CRS auth_error 1800s). */
export const AUTH_ERROR_TTL_MS = 30 * 60_000;
/** Transient cooldown for a 5xx / thrown network failure (CRS server_error 300s). */
export const SERVER_ERROR_TTL_MS = 5 * 60_000;

/** 403-ban body markers → permanent block (CRS `markAccountBlocked`). */
const BAN_BODY_MARKERS = [
  'this organization has been disabled',
  'oauth authentication is currently not allowed',
] as const;

/** Per-account health record (all timers are epoch ms). Absent fields ⇒ healthy. */
export interface HealthRecord {
  /** From a 429 authoritative reset header — rate-limited until this instant. */
  rateLimitEndAt?: number;
  /** From a 529 overload — in overload cooldown until this instant. */
  overloadUntil?: number;
  /** From a final-401 / plain-403 / 5xx / thrown — transient cooldown until this. */
  tempUnavailableUntil?: number;
  /** From a 403-ban — permanent, self-heal never clears it. */
  blocked?: boolean;
}

/** The coarse health state surfaced to the admin accounts view (secret-free). */
export type AccountHealthState = 'healthy' | 'rate_limited' | 'overloaded' | 'transient' | 'blocked';

/** Admin-facing status projection for one account. */
export interface AccountHealthStatus {
  state: AccountHealthState;
  /** Epoch ms the current cooldown elapses (absent for healthy / blocked). */
  cooldownUntil?: number;
}

/**
 * The recovery signal emitted when an account transitions unhealthy → schedulable.
 * FROZEN here (subscription-account-health OQ3) as the stable seam #5 (webhooks)
 * and #8 (health-cron) CONSUME — they must not re-derive health.
 */
export interface AccountRecoveryEvent {
  /** Opaque provider id ('claude' | 'codex' | 'gemini' | 'opencodego'). */
  providerId: string;
  /** The recovered account id. */
  accountId: string;
  /** Epoch ms of the recovery observation. */
  at: number;
  /** Discriminator so consumers can widen this to an anomaly union later. */
  kind: 'rateLimitRecovery';
}

/** A recovery listener (fire-and-forget; the emitter never awaits it). */
export type AccountRecoveryListener = (event: AccountRecoveryEvent) => void;

/** The coarse anomaly state an account transitioned into (secret-free). */
export type AccountAnomalyState = 'blocked' | 'unauthorized' | 'rate_limited' | 'overloaded';

/**
 * The anomaly signal emitted when a HEALTHY account transitions to unhealthy —
 * the additive union #5 (webhooks) consumes, which this tracker's frozen `kind`
 * discriminator (on {@link AccountRecoveryEvent}) explicitly anticipated. ADDITIVE:
 * it fires ONLY on the healthy→unhealthy EDGE (de-duped) and changes NOTHING about
 * the existing marking / recovery behavior. A #8 probe failure flows through the
 * same `recordUpstreamOutcome` path, so anomaly covers it for free.
 */
export interface AccountAnomalyEvent {
  /** Opaque provider id ('claude' | 'codex' | 'gemini' | 'opencodego'). */
  providerId: string;
  /** The account id that became unhealthy. */
  accountId: string;
  /** Epoch ms of the transition. */
  at: number;
  /** The coarse state the account entered (mapped from the marking). */
  state: AccountAnomalyState;
}

/** An anomaly listener (fire-and-forget; the emitter never awaits it). */
export type AccountAnomalyListener = (event: AccountAnomalyEvent) => void;

/** The inputs one upstream attempt contributes to health marking (design D3). */
export interface RecordUpstreamOutcomeInput {
  /** The final HTTP status, or `null` for a thrown / network failure. */
  status: number | null;
  /** Parsed authoritative reset (epoch SECONDS) — `anthropic-ratelimit-unified-reset`. */
  resetHeaderSeconds?: number | null;
  /** Parsed `retry-after` DELTA seconds (non-claude fallback, OQ2). */
  retryAfterSeconds?: number | null;
  /** Bounded response body text for the 403-ban sniff (only read on a 403). */
  bodyText?: string;
  /** Injectable clock (default the tracker's `now`). */
  now?: number;
}

/** Constructor knobs (all default to the exported constants). */
export interface SubscriptionAccountHealthOptions {
  /** Injectable clock (ms). Default `Date.now`. */
  now?: () => number;
  /** Whether a 529 places the account in overload cooldown (LEAD OQ1: ON). */
  overloadEnabled?: boolean;
  /** The 529 overload cooldown duration (ms). */
  overloadTtlMs?: number;
  /** The final-401 / plain-403 transient cooldown (ms). */
  authErrorTtlMs?: number;
  /** The 5xx / thrown transient cooldown (ms). */
  serverErrorTtlMs?: number;
}

/** Minimal structural read over a `Headers` OR a plain header record. */
export type HeadersLike =
  | { get(name: string): string | null }
  | Record<string, string | undefined>;

function readHeader(headers: HeadersLike, name: string): string | null {
  if (typeof (headers as { get?: unknown }).get === 'function') {
    return (headers as { get(n: string): string | null }).get(name);
  }
  const rec = headers as Record<string, string | undefined>;
  return rec[name] ?? rec[name.toLowerCase()] ?? null;
}

/** Parse an integer header value; `null` when absent / non-numeric. */
function parseIntHeader(value: string | null): number | null {
  if (value == null) return null;
  const n = Number.parseInt(value.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve the 429 cooldown drivers per provider (OQ2 seam) — a single pure
 * function. claude is STRICT (only the authoritative
 * `anthropic-ratelimit-unified-reset`, epoch seconds; a bare 429 stays unmarked);
 * codex / gemini / opencodego additionally accept `retry-after` (delta seconds)
 * and a provider-specific reset header as the cooldown driver.
 */
export function resolveResetSeconds(
  providerId: string,
  headers: HeadersLike,
): { resetHeaderSeconds: number | null; retryAfterSeconds: number | null } {
  const unified = parseIntHeader(readHeader(headers, 'anthropic-ratelimit-unified-reset'));
  if (providerId === 'claude') {
    // STRICT: only the authoritative reset header; no retry-after fallback.
    return { resetHeaderSeconds: unified, retryAfterSeconds: null };
  }
  // Other providers: accept the unified reset if present, else a retry-after
  // delta (or a provider reset header carrying epoch seconds).
  const providerReset =
    parseIntHeader(readHeader(headers, 'x-ratelimit-reset')) ??
    parseIntHeader(readHeader(headers, 'ratelimit-reset'));
  const retryAfter = parseIntHeader(readHeader(headers, 'retry-after'));
  return {
    resetHeaderSeconds: unified ?? providerReset,
    retryAfterSeconds: retryAfter,
  };
}

function isBanBody(bodyText: string | undefined): boolean {
  if (!bodyText) return false;
  const lower = bodyText.toLowerCase();
  return BAN_BODY_MARKERS.some((marker) => lower.includes(marker));
}

function isRecordEmpty(record: HealthRecord): boolean {
  return (
    record.rateLimitEndAt === undefined &&
    record.overloadUntil === undefined &&
    record.tempUnavailableUntil === undefined &&
    !record.blocked
  );
}

const KEY_SEP = '\0';

export class SubscriptionAccountHealth {
  private readonly records = new Map<string, HealthRecord>();
  private readonly listeners = new Set<AccountRecoveryListener>();
  private readonly anomalyListeners = new Set<AccountAnomalyListener>();

  private readonly now: () => number;
  private overloadEnabled: boolean;
  private overloadTtlMs: number;
  private authErrorTtlMs: number;
  private serverErrorTtlMs: number;

  constructor(opts: SubscriptionAccountHealthOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.overloadEnabled = opts.overloadEnabled ?? OVERLOAD_ENABLED_DEFAULT;
    this.overloadTtlMs = opts.overloadTtlMs ?? OVERLOAD_TTL_MS;
    this.authErrorTtlMs = opts.authErrorTtlMs ?? AUTH_ERROR_TTL_MS;
    this.serverErrorTtlMs = opts.serverErrorTtlMs ?? SERVER_ERROR_TTL_MS;
  }

  /**
   * Re-apply cooldown config to the LIVE shared instance (subscription-account-
   * health, LEAD OQ1). `buildDaemon` is synchronous so it cannot await the
   * persisted server config; the async `start.ts` path loads it and applies the
   * `accountHealth` segment here — every strategy/relay/sweeper that already
   * captured this instance picks the new values up. Only defined fields override.
   */
  configure(opts: Pick<SubscriptionAccountHealthOptions, 'overloadEnabled' | 'overloadTtlMs' | 'authErrorTtlMs' | 'serverErrorTtlMs'>): void {
    if (opts.overloadEnabled !== undefined) this.overloadEnabled = opts.overloadEnabled;
    if (opts.overloadTtlMs !== undefined) this.overloadTtlMs = opts.overloadTtlMs;
    if (opts.authErrorTtlMs !== undefined) this.authErrorTtlMs = opts.authErrorTtlMs;
    if (opts.serverErrorTtlMs !== undefined) this.serverErrorTtlMs = opts.serverErrorTtlMs;
  }

  /**
   * Whether an account may be scheduled RIGHT NOW. `blocked` → false; any timer
   * still in the future → false. Expired timers are lazily deleted on read (CRS
   * lazy-clear parity) so an elapsed cooldown restores the account WITHOUT a
   * timer — but the recovery SIGNAL is the sweeper's job (`sweepRecoveries`), so
   * this read never emits (correctness is independent of the tick).
   */
  isSchedulable(providerId: string, accountId: string, now: number = this.now()): boolean {
    const key = this.key(providerId, accountId);
    const record = this.records.get(key);
    if (!record) return true;
    if (record.blocked) return false;
    const active = this.clearExpired(record, now);
    if (!active && isRecordEmpty(record)) this.records.delete(key);
    return !active;
  }

  /**
   * The single marking entry point (design D3). Faithful to CRS status semantics:
   *  - 429 + authoritative reset → `rateLimitEndAt`; a non-claude 429 may use
   *    `retryAfterSeconds`; a bare 429 (no resolvable reset) is NOT marked;
   *  - 529 → `overloadUntil` (gated by `overloadEnabled`);
   *  - 403-ban body → `blocked` (permanent); plain 403 → transient;
   *  - final-401 → transient; 5xx / thrown(null) → transient;
   *  - non-429 4xx → NEUTRAL (never marked);
   *  - 2xx → clear rate-limit + transient state (keep `blocked`).
   */
  recordUpstreamOutcome(
    providerId: string,
    accountId: string,
    input: RecordUpstreamOutcomeInput,
  ): void {
    const now = input.now ?? this.now();
    const key = this.key(providerId, accountId);
    const preExisting = this.records.get(key);
    const record = preExisting ?? {};
    const status = input.status;

    // Edge-trigger input for the ADDITIVE anomaly emit (webhook-notifications D3):
    // was the account already unhealthy BEFORE this marking? If so, escalating it
    // is NOT a healthy→unhealthy edge, so no anomaly fires (de-dupe). Computed on
    // the pre-existing record without mutating it.
    const wasUnhealthyBefore = preExisting ? this.isUnhealthyAt(preExisting, now) : false;
    // The coarse state this marking put the account into (undefined ⇒ no anomaly —
    // a bare 429 / 5xx-transient / neutral 4xx has no clean anomaly state).
    let anomalyState: AccountAnomalyState | undefined;

    // A 2xx on an account that WAS unhealthy is a traffic-driven recovery edge —
    // emit the recovery signal here (the 60s sweep never sees it, because the 2xx
    // clears the record before the next tick). See `onRecovered` (OQ3).
    let recovered = false;

    if (status === null) {
      record.tempUnavailableUntil = now + this.serverErrorTtlMs;
    } else if (status >= 200 && status < 300) {
      // Success recovery: clear rate-limit + transient; a ban survives (D3).
      const wasUnhealthy =
        record.rateLimitEndAt !== undefined ||
        record.overloadUntil !== undefined ||
        record.tempUnavailableUntil !== undefined;
      delete record.rateLimitEndAt;
      delete record.overloadUntil;
      delete record.tempUnavailableUntil;
      recovered = wasUnhealthy && !record.blocked;
    } else if (status === 429) {
      if (input.resetHeaderSeconds != null) {
        record.rateLimitEndAt = input.resetHeaderSeconds * 1000;
        anomalyState = 'rate_limited';
      } else if (input.retryAfterSeconds != null) {
        record.rateLimitEndAt = now + input.retryAfterSeconds * 1000;
        anomalyState = 'rate_limited';
      }
      // else bare 429: transient overflow, passed through — NOT marked.
    } else if (status === 529) {
      if (this.overloadEnabled) {
        record.overloadUntil = now + this.overloadTtlMs;
        anomalyState = 'overloaded';
      }
    } else if (status === 403) {
      if (isBanBody(input.bodyText)) {
        record.blocked = true;
        anomalyState = 'blocked';
      } else {
        record.tempUnavailableUntil = now + this.authErrorTtlMs;
        anomalyState = 'unauthorized';
      }
    } else if (status === 401) {
      record.tempUnavailableUntil = now + this.authErrorTtlMs;
      anomalyState = 'unauthorized';
    } else if (status >= 500) {
      record.tempUnavailableUntil = now + this.serverErrorTtlMs;
      // A 5xx/thrown marks the account transiently unavailable, but that's a
      // SERVER error (delivered via `server.error`), not one of the four account
      // anomaly states — so no anomaly is emitted for it.
    }
    // else: non-429 4xx (400/422/…) — NEUTRAL, never marked.

    if (isRecordEmpty(record)) this.records.delete(key);
    else this.records.set(key, record);

    if (recovered) this.emit({ providerId, accountId, at: now, kind: 'rateLimitRecovery' });
    // ADDITIVE anomaly emit: only on the healthy→unhealthy EDGE with a mapped state.
    if (anomalyState && !wasUnhealthyBefore) {
      this.emitAnomaly({ providerId, accountId, at: now, state: anomalyState });
    }
  }

  /** Whether a record is unhealthy at `now`: blocked, or any timer still future. */
  private isUnhealthyAt(record: HealthRecord, now: number): boolean {
    if (record.blocked) return true;
    if (record.rateLimitEndAt !== undefined && now < record.rateLimitEndAt) return true;
    if (record.overloadUntil !== undefined && now < record.overloadUntil) return true;
    if (record.tempUnavailableUntil !== undefined && now < record.tempUnavailableUntil) return true;
    return false;
  }

  /**
   * Clear ONLY the auth/transient unavailability mark (`tempUnavailableUntil`) —
   * the narrow healing a background PROBE is allowed to do (subscription-account-
   * probe #8, review M1). A probe 2xx from the lightweight `GET /v1/models` attests
   * the TOKEN works (so a final-401 / plain-403 / 5xx transient may be healed), but
   * it does NOT prove the traffic endpoint's rate-limit / overload has recovered —
   * so it MUST NOT touch `rateLimitEndAt` / `overloadUntil` (those clear only on the
   * upstream's authoritative reset, or a REAL-traffic 2xx). `blocked` (a ban) is
   * never cleared here. Distinct from `recordUpstreamOutcome`'s 2xx path, which is
   * UNCHANGED and still clears rate + transient together because it IS traffic.
   * Returns whether a transient mark was actually cleared. Does NOT emit a recovery
   * signal (a probe is internal maintenance; the account is schedulable-on-read).
   */
  clearTransientMark(providerId: string, accountId: string): boolean {
    const key = this.key(providerId, accountId);
    const record = this.records.get(key);
    if (!record || record.tempUnavailableUntil === undefined) return false;
    delete record.tempUnavailableUntil;
    if (isRecordEmpty(record)) this.records.delete(key);
    else this.records.set(key, record);
    return true;
  }

  /**
   * Proactively surface accounts that transitioned unhealthy → schedulable since
   * the last sweep (design D6). Clears their expired timers, emits a recovery
   * signal for each through `onRecovered`, and returns the list. A `blocked`
   * account never recovers here. Correctness does NOT depend on this running —
   * `isSchedulable` already restores an elapsed cooldown lazily; this adds the
   * proactive signal (#5/#8) + lets the daemon nudge a token refresh.
   */
  sweepRecoveries(now: number = this.now()): AccountRecoveryEvent[] {
    const recovered: AccountRecoveryEvent[] = [];
    for (const [key, record] of this.records) {
      if (record.blocked) continue;
      const hadTimer =
        record.rateLimitEndAt !== undefined ||
        record.overloadUntil !== undefined ||
        record.tempUnavailableUntil !== undefined;
      const active = this.clearExpired(record, now);
      if (hadTimer && !active && isRecordEmpty(record)) {
        const [pid, aid] = this.parseKey(key);
        recovered.push({ providerId: pid, accountId: aid, at: now, kind: 'rateLimitRecovery' });
        this.records.delete(key);
      }
    }
    for (const event of recovered) this.emit(event);
    return recovered;
  }

  /** Admin-facing coarse status + cooldown-until for one account (secret-free). */
  getStatus(providerId: string, accountId: string, now: number = this.now()): AccountHealthStatus {
    const record = this.records.get(this.key(providerId, accountId));
    if (!record) return { state: 'healthy' };
    if (record.blocked) return { state: 'blocked' };
    if (record.rateLimitEndAt !== undefined && now < record.rateLimitEndAt) {
      return { state: 'rate_limited', cooldownUntil: record.rateLimitEndAt };
    }
    if (record.overloadUntil !== undefined && now < record.overloadUntil) {
      return { state: 'overloaded', cooldownUntil: record.overloadUntil };
    }
    if (record.tempUnavailableUntil !== undefined && now < record.tempUnavailableUntil) {
      return { state: 'transient', cooldownUntil: record.tempUnavailableUntil };
    }
    return { state: 'healthy' };
  }

  /**
   * Register a recovery listener (the OQ3 seam #5 webhooks + #8 health-cron
   * consume). Returns an unsubscribe function. Two edges fire it:
   *  - TRAFFIC-DRIVEN: a `recordUpstreamOutcome` 2xx that clears an unhealthy
   *    account (guaranteed — the sweep would miss it, as the 2xx deletes the
   *    record first); and
   *  - PURE-IDLE: `sweepRecoveries` when an idle account's cooldown elapsed with
   *    no traffic (best-effort, on the 60s tick).
   * A lazy `isSchedulable` read that heals an account does NOT emit (a request is
   * already using it) — so consumers never double-count a recovery.
   */
  onRecovered(listener: AccountRecoveryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: AccountRecoveryEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A misbehaving consumer never breaks health tracking.
      }
    }
  }

  /**
   * Register an anomaly listener (the ADDITIVE seam #5 webhooks consumes; the
   * frozen `kind` discriminator on {@link AccountRecoveryEvent} anticipated it).
   * Fires ONLY on the healthy→unhealthy EDGE inside `recordUpstreamOutcome`
   * (de-duped: an already-unhealthy account escalating does NOT re-fire). Returns
   * an unsubscribe function. Existing marking/recovery behavior is UNCHANGED.
   */
  onAnomaly(listener: AccountAnomalyListener): () => void {
    this.anomalyListeners.add(listener);
    return () => this.anomalyListeners.delete(listener);
  }

  private emitAnomaly(event: AccountAnomalyEvent): void {
    for (const listener of this.anomalyListeners) {
      try {
        listener(event);
      } catch {
        // A misbehaving consumer never breaks health tracking.
      }
    }
  }

  /**
   * Delete every EXPIRED timer field on the record in place; return whether any
   * timer is STILL active (in the future). `blocked` is not a timer and is left
   * untouched here (only an explicit reset / restart clears a ban).
   */
  private clearExpired(record: HealthRecord, now: number): boolean {
    let active = false;
    if (record.rateLimitEndAt !== undefined) {
      if (now >= record.rateLimitEndAt) delete record.rateLimitEndAt;
      else active = true;
    }
    if (record.overloadUntil !== undefined) {
      if (now >= record.overloadUntil) delete record.overloadUntil;
      else active = true;
    }
    if (record.tempUnavailableUntil !== undefined) {
      if (now >= record.tempUnavailableUntil) delete record.tempUnavailableUntil;
      else active = true;
    }
    return active;
  }

  private key(providerId: string, accountId: string): string {
    return `${providerId}${KEY_SEP}${accountId}`;
  }

  private parseKey(key: string): [string, string] {
    const idx = key.indexOf(KEY_SEP);
    return [key.slice(0, idx), key.slice(idx + 1)];
  }
}

// ── Shared process singleton ─────────────────────────────────────────────────
//
// The core relay, the subscriptions strategies, and the daemon sweeper all need
// the SAME tracker instance. This mirrors the `subscriptionRegistryPort` slot: a
// lazily-created default (so tests + core-only contexts always get a usable
// tracker) that bootstrap MAY replace with a config-tuned instance BEFORE any
// request runs.

let _shared: SubscriptionAccountHealth | null = null;

/** The shared tracker; lazily constructs a default-config instance on first use. */
export function getSharedAccountHealth(): SubscriptionAccountHealth {
  if (!_shared) _shared = new SubscriptionAccountHealth();
  return _shared;
}

/** Install a config-tuned tracker at bootstrap (idempotent; last write wins). */
export function setSharedAccountHealth(instance: SubscriptionAccountHealth): void {
  _shared = instance;
}

/** Reset the shared singleton (tests / teardown only). */
export function __resetSharedAccountHealthForTests(): void {
  _shared = null;
}
