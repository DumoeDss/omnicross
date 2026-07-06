/**
 * SubscriptionIdentityStore — the per-account client-identity capture/freeze/replay
 * store for claude-subscription outbound traffic (subscription-client-fingerprint
 * #7, design D1/D4/D5/D7).
 *
 * Shaped like the existing in-memory `SubscriptionAccountHealth` tracker: an
 * in-memory `Map`, an injectable `now` clock, NO external deps. It is keyed by an
 * opaque `providerId + '\0' + accountId` string — core never learns "account"
 * semantics (exactly the health-tracker precedent), and there is NO
 * `@omnicross/subscriptions` import. It carries NO token/secret: the capture
 * whitelist + `sanitizeFrozenHeaders` exclude `authorization`/`x-api-key`/`cookie`
 * at BOTH ingress and store-normalize.
 *
 * Freeze/replay model (D4 — never fabricate):
 *  - The FIRST captured fingerprint set for an account is FROZEN; every later
 *    outbound request for that account REPLAYS that frozen set → a stable
 *    per-account identity. Stainless headers are frozen-stable forever; the
 *    non-stainless (CC) headers refresh on a 7-day TTL from a newer real
 *    observation (P2, `refreshNonStainless`).
 *  - Values are ONLY ever REAL captured client values — nothing here invents a
 *    `x-stainless-*`. An un-captured account replays NOTHING (the caller then
 *    applies at most the operator UA baseline).
 *
 * Persistence (P2, D5): OPTIONAL. When a persistence port is installed
 * (`setPersistence`), a first-seen freeze / TTL refresh is written through to the
 * account entry (additive NON-secret metadata) so the identity survives restart;
 * at boot the daemon `seed()`s the store from the persisted entries. In-memory-only
 * (no port) is the P1 default — a real client re-captures after restart.
 *
 * @module provider-proxy/identity/SubscriptionIdentityStore
 */

import { refreshNonStainless, sanitizeFrozenHeaders } from './fingerprintHeaders';

/** A frozen per-account client identity (the captured fingerprint headers). */
export interface FrozenIdentity {
  /** The captured fingerprint headers (lowercased keys; token/secret excluded). */
  headers: Record<string, string>;
  /** Epoch ms of the freeze (or last TTL refresh). */
  capturedAt: number;
}

/**
 * Write-through persistence port (P2, D5). The store calls `persist` on a
 * first-seen freeze / TTL refresh; the daemon implementation writes the identity
 * onto the account entry. Fire-and-forget — the store swallows any throw so the
 * hot path is never affected. Core defines the port; the daemon supplies it (the
 * `setUpstreamProxyResolver` / `setWebhookSink` precedent — no daemon import).
 */
export interface IdentityPersistencePort {
  persist(providerId: string, accountId: string, identity: FrozenIdentity): void;
}

/** The CC-header (non-stainless) refresh TTL — 7 days (design D6/P2). */
export const CC_HEADER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Constructor knobs (all optional). */
export interface SubscriptionIdentityStoreOptions {
  /** Injectable clock (ms). Default `Date.now`. */
  now?: () => number;
  /** Whether capture/replay engages. Default `false` (byte-identical outbound). */
  enabled?: boolean;
  /** Operator UA baseline applied ONLY when nothing was captured (piece 4). */
  ua?: string;
  /** The CC-header refresh TTL (ms). Default {@link CC_HEADER_TTL_MS}. */
  ccHeaderTtlMs?: number;
}

const KEY_SEP = '\0';

function normalizeUa(ua: string | undefined): string | undefined {
  if (typeof ua !== 'string') return undefined;
  const trimmed = ua.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export class SubscriptionIdentityStore {
  private readonly identities = new Map<string, FrozenIdentity>();
  private readonly now: () => number;
  private enabled: boolean;
  private ua: string | undefined;
  private ccHeaderTtlMs: number;
  private persistence: IdentityPersistencePort | null = null;

  constructor(opts: SubscriptionIdentityStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.enabled = opts.enabled ?? false;
    this.ua = normalizeUa(opts.ua);
    this.ccHeaderTtlMs = opts.ccHeaderTtlMs ?? CC_HEADER_TTL_MS;
  }

  /** Whether capture/replay is engaged (config flag). */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** The operator UA baseline (piece 4), or undefined when unset. */
  uaBaseline(): string | undefined {
    return this.ua;
  }

  /**
   * Re-apply config to the LIVE shared instance (bootstrap, mirroring the health
   * tracker's `configure`). Only defined fields override; `ua: null` clears the
   * baseline.
   */
  configure(opts: { enabled?: boolean; ua?: string | null }): void {
    if (opts.enabled !== undefined) this.enabled = opts.enabled;
    if (opts.ua !== undefined) this.ua = normalizeUa(opts.ua ?? undefined);
  }

  /** Install (or clear) the write-through persistence port (P2). */
  setPersistence(port: IdentityPersistencePort | null): void {
    this.persistence = port;
  }

  /**
   * Boot seed (P2, D5): install a PERSISTED identity for an account, but NEVER
   * over a live in-memory capture (a re-captured identity from this session wins).
   * A no-op for an empty/absent identity. Does NOT write back through the port.
   */
  seed(providerId: string, accountId: string, identity: FrozenIdentity | undefined): void {
    if (!accountId || !identity) return;
    const headers = sanitizeFrozenHeaders(identity.headers ?? {});
    if (Object.keys(headers).length === 0) return;
    const key = this.key(providerId, accountId);
    if (this.identities.has(key)) return;
    this.identities.set(key, {
      headers,
      capturedAt: typeof identity.capturedAt === 'number' ? identity.capturedAt : this.now(),
    });
  }

  /**
   * Capture a real client's fingerprint headers for an account. First-seen ⇒
   * FREEZE the whole (sanitized) bag. Already-frozen ⇒ within the TTL, no change
   * (stable identity); past the TTL, refresh the NON-stainless headers from the
   * new observation while keeping stainless frozen-stable (P2). An empty/absent
   * account id or an empty sanitized bag is a no-op (so an account with no
   * fingerprint headers never freezes an empty identity → the caller falls back
   * to the UA baseline). Fires the persistence port on a freeze/refresh.
   */
  capture(
    providerId: string,
    accountId: string,
    incoming: Record<string, string>,
    now: number = this.now(),
  ): void {
    if (!accountId) return;
    const clean = sanitizeFrozenHeaders(incoming);
    if (Object.keys(clean).length === 0) return;
    const key = this.key(providerId, accountId);
    const existing = this.identities.get(key);
    if (!existing) {
      const frozen: FrozenIdentity = { headers: clean, capturedAt: now };
      this.identities.set(key, frozen);
      this.emitPersist(providerId, accountId, frozen);
      return;
    }
    // Within the TTL: the frozen identity stays stable (never re-frozen).
    if (now - existing.capturedAt < this.ccHeaderTtlMs) return;
    // Past the TTL: refresh non-stainless headers; stainless stays frozen-stable.
    const refreshed: FrozenIdentity = {
      headers: refreshNonStainless(existing.headers, clean),
      capturedAt: now,
    };
    this.identities.set(key, refreshed);
    this.emitPersist(providerId, accountId, refreshed);
  }

  /**
   * The frozen identity headers for an account, or `undefined` when none is
   * frozen (or the frozen set is empty). Returns a COPY (the caller merges it into
   * a mutable outbound header bag).
   */
  replay(providerId: string, accountId: string): Record<string, string> | undefined {
    if (!accountId) return undefined;
    const frozen = this.identities.get(this.key(providerId, accountId));
    if (!frozen || Object.keys(frozen.headers).length === 0) return undefined;
    return { ...frozen.headers };
  }

  /** Whether an identity is frozen for an account (admin coarse status — D7). */
  hasIdentity(providerId: string, accountId: string): boolean {
    const frozen = this.identities.get(this.key(providerId, accountId));
    return !!frozen && Object.keys(frozen.headers).length > 0;
  }

  /** The freeze/refresh time for an account's identity (admin coarse status). */
  capturedAt(providerId: string, accountId: string): number | undefined {
    return this.identities.get(this.key(providerId, accountId))?.capturedAt;
  }

  private emitPersist(providerId: string, accountId: string, identity: FrozenIdentity): void {
    if (!this.persistence) return;
    try {
      this.persistence.persist(providerId, accountId, {
        headers: { ...identity.headers },
        capturedAt: identity.capturedAt,
      });
    } catch {
      // Persistence is best-effort — a failed write NEVER breaks the hot path.
    }
  }

  private key(providerId: string, accountId: string): string {
    return `${providerId}${KEY_SEP}${accountId}`;
  }
}

// ── Shared process singleton ─────────────────────────────────────────────────
//
// The core relay and the daemon bootstrap need the SAME store instance. Mirrors
// `getSharedAccountHealth`: a lazily-created default (disabled) that bootstrap
// re-`configure`s + `seed`s + wires persistence into before any request runs.

let _shared: SubscriptionIdentityStore | null = null;

/** The shared identity store; lazily constructs a default (disabled) instance. */
export function getSharedIdentityStore(): SubscriptionIdentityStore {
  if (!_shared) _shared = new SubscriptionIdentityStore();
  return _shared;
}

/** Install a specific store at bootstrap (idempotent; last write wins). */
export function setSharedIdentityStore(instance: SubscriptionIdentityStore): void {
  _shared = instance;
}

/** Reset the shared singleton (tests / teardown only). */
export function __resetSharedIdentityStoreForTests(): void {
  _shared = null;
}
