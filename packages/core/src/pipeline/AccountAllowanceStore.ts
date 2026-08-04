/**
 * Secret-free upstream account allowance snapshots.
 *
 * Claude actively populates this store from the daemon. Codex is observed at the
 * core egress seam so the response headers are attributed to the exact account id
 * selected for that request. Only normalized numbers are retained; raw headers
 * and credentials never enter the store. A host may inject a small persistence
 * port; core deliberately does not know where that host stores the snapshot.
 */

import type {
  AccountAllowanceSnapshot,
  AllowanceWindow,
} from '@omnicross/contracts/account-allowance-types';
import type { SubscriptionProviderId } from '@omnicross/contracts/subscription-types';

export const DEFAULT_CODEX_ALLOWANCE_FRESH_MS = 15 * 60_000;
export const DEFAULT_ALLOWANCE_MAX_SNAPSHOTS = 256;
const MAX_WINDOWS_PER_SNAPSHOT = 8;
const MAX_TEXT_LENGTH = 200;

export type AllowanceHeadersLike =
  | Headers
  | Record<string, string | string[] | number | null | undefined>;

export interface CodexAllowanceWindowObservation {
  usedPercent?: number;
  resetAfterSeconds?: number;
  windowMinutes?: number;
}

export interface CodexAllowanceObservation {
  primary?: CodexAllowanceWindowObservation;
  secondary?: CodexAllowanceWindowObservation;
  primaryOverSecondaryLimitPercent?: number;
}

/** Host-owned persistence seam for normalized allowance snapshots. */
export interface AccountAllowancePersistence {
  /** Return the decoded file payload, or any value for the store to validate. */
  load(): unknown;
  /** Replace the durable snapshot with this already-normalized bounded list. */
  save(snapshots: readonly AccountAllowanceSnapshot[]): void;
}

function snapshotKey(providerId: SubscriptionProviderId, accountId: string): string {
  return `${providerId}\0${accountId}`;
}

function cloneWindow(window: AllowanceWindow): AllowanceWindow {
  return {
    id: window.id,
    label: window.label,
    scope: window.scope,
    ...(window.modelFamily === undefined ? {} : { modelFamily: window.modelFamily }),
    usedPercent: window.usedPercent,
    ...(window.windowMinutes === undefined ? {} : { windowMinutes: window.windowMinutes }),
    ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
    ...(window.remainingSeconds === undefined ? {} : { remainingSeconds: window.remainingSeconds }),
    state: window.state,
  };
}

function cloneSnapshot(snapshot: AccountAllowanceSnapshot): AccountAllowanceSnapshot {
  return {
    providerId: snapshot.providerId,
    accountId: snapshot.accountId,
    source: snapshot.source,
    observedAt: snapshot.observedAt,
    ...(snapshot.expiresAt === undefined ? {} : { expiresAt: snapshot.expiresAt }),
    windows: snapshot.windows.map(cloneWindow),
    ...(snapshot.lastErrorCode === undefined ? {} : { lastErrorCode: snapshot.lastErrorCode }),
    ...(snapshot.primaryOverSecondaryLimitPercent === undefined
      ? {}
      : { primaryOverSecondaryLimitPercent: snapshot.primaryOverSecondaryLimitPercent }),
  };
}

function finiteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function boundedText(value: unknown, max = MAX_TEXT_LENGTH): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}

function finitePercent(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (value === undefined || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : undefined;
}

function finiteNonNegativeInteger(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  return parsed === undefined ? undefined : Math.floor(parsed);
}

function normalizedInstant(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function isAllowanceProvider(value: unknown): value is SubscriptionProviderId {
  return value === 'claude' || value === 'codex' || value === 'gemini' || value === 'opencodego';
}

function isWindowState(value: unknown): value is AllowanceWindow['state'] {
  return value === 'fresh' || value === 'stale' || value === 'unavailable' || value === 'unsupported';
}

/**
 * Pick and normalize only the public DTO fields. This is used for both live
 * writes and restart loads, so a structurally-cast object can never smuggle raw
 * headers, response bodies, or token fields into the cache.
 */
export function normalizeAccountAllowanceSnapshot(value: unknown): AccountAllowanceSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const providerId = raw.providerId;
  const accountId = boundedText(raw.accountId);
  const source = raw.source;
  const observedAt = normalizedInstant(raw.observedAt);
  if (
    !isAllowanceProvider(providerId) ||
    !accountId ||
    (source !== 'oauth-usage-api' && source !== 'response-headers') ||
    !observedAt ||
    !Array.isArray(raw.windows) ||
    raw.windows.length > MAX_WINDOWS_PER_SNAPSHOT
  ) return null;

  const windows: AllowanceWindow[] = [];
  for (const item of raw.windows) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const window = item as Record<string, unknown>;
    const id = boundedText(window.id);
    const label = boundedText(window.label);
    const scope = window.scope;
    const state = window.state;
    const usedPercent = finitePercent(window.usedPercent);
    if (
      !id ||
      !label ||
      (scope !== 'all' && scope !== 'model-family') ||
      !isWindowState(state) ||
      (window.usedPercent !== undefined && usedPercent === undefined)
    ) return null;
    const modelFamily = boundedText(window.modelFamily, 80);
    if (scope === 'model-family' && !modelFamily) return null;
    const windowMinutes = window.windowMinutes === undefined
      ? undefined
      : finiteNonNegativeInteger(window.windowMinutes);
    const remainingSeconds = window.remainingSeconds === undefined
      ? undefined
      : finiteNonNegativeInteger(window.remainingSeconds);
    if (
      (window.windowMinutes !== undefined && windowMinutes === undefined) ||
      (window.remainingSeconds !== undefined && remainingSeconds === undefined)
    ) return null;
    const resetsAt = window.resetsAt === undefined ? undefined : normalizedInstant(window.resetsAt);
    if (window.resetsAt !== undefined && !resetsAt) return null;
    windows.push({
      id,
      label,
      scope,
      ...(scope === 'model-family' ? { modelFamily } : {}),
      usedPercent: usedPercent ?? null,
      ...(windowMinutes === undefined ? {} : { windowMinutes }),
      ...(resetsAt === undefined ? {} : { resetsAt }),
      ...(remainingSeconds === undefined ? {} : { remainingSeconds }),
      state,
    });
  }

  const expiresAt = raw.expiresAt === undefined ? undefined : normalizedInstant(raw.expiresAt);
  if (raw.expiresAt !== undefined && !expiresAt) return null;
  const lastErrorCode = raw.lastErrorCode === undefined
    ? undefined
    : typeof raw.lastErrorCode === 'string' && /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(raw.lastErrorCode)
      ? raw.lastErrorCode
      : undefined;
  if (raw.lastErrorCode !== undefined && lastErrorCode === undefined) return null;
  let primaryOverSecondaryLimitPercent: number | undefined;
  if (raw.primaryOverSecondaryLimitPercent !== undefined) {
    if (raw.primaryOverSecondaryLimitPercent === null) return null;
    const parsed = finitePercent(raw.primaryOverSecondaryLimitPercent);
    if (parsed === undefined || parsed === null) return null;
    primaryOverSecondaryLimitPercent = parsed;
  }

  return {
    providerId,
    accountId,
    source,
    observedAt,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    windows,
    ...(lastErrorCode === undefined ? {} : { lastErrorCode }),
    ...(primaryOverSecondaryLimitPercent === undefined
      ? {}
      : { primaryOverSecondaryLimitPercent }),
  };
}

function headerValue(headers: AllowanceHeadersLike, name: string): unknown {
  const getter = (headers as { get?: (key: string) => string | null }).get;
  if (typeof getter === 'function') return getter.call(headers, name);

  const record = headers as Record<string, string | string[] | number | null | undefined>;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() !== wanted) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

function parseWindow(
  headers: AllowanceHeadersLike,
  prefix: 'primary' | 'secondary',
): CodexAllowanceWindowObservation | undefined {
  const usedPercent = finitePercent(headerValue(headers, `x-codex-${prefix}-used-percent`)) ?? undefined;
  const resetAfterSeconds = finiteNumber(
    headerValue(headers, `x-codex-${prefix}-reset-after-seconds`),
  );
  const windowMinutes = finiteNumber(headerValue(headers, `x-codex-${prefix}-window-minutes`));
  if (usedPercent === undefined && resetAfterSeconds === undefined && windowMinutes === undefined) {
    return undefined;
  }
  return { usedPercent, resetAfterSeconds, windowMinutes };
}

/** Parse only the documented numeric Codex allowance headers. */
export function parseCodexAllowanceHeaders(
  headers: AllowanceHeadersLike,
): CodexAllowanceObservation | null {
  const primary = parseWindow(headers, 'primary');
  const secondary = parseWindow(headers, 'secondary');
  const primaryOverSecondaryLimitPercent = finitePercent(
    headerValue(headers, 'x-codex-primary-over-secondary-limit-percent'),
  ) ?? undefined;
  if (!primary && !secondary && primaryOverSecondaryLimitPercent === undefined) return null;
  return { primary, secondary, primaryOverSecondaryLimitPercent };
}

function durationLabel(minutes: number | undefined): string | undefined {
  if (minutes === undefined) return undefined;
  if (minutes % (7 * 24 * 60) === 0) {
    const weeks = minutes / (7 * 24 * 60);
    return `${weeks} week${weeks === 1 ? '' : 's'}`;
  }
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${minutes} minutes`;
}

function codexLabel(id: 'primary' | 'secondary', minutes: number | undefined): string {
  const base = id === 'primary' ? 'Primary' : 'Secondary';
  const duration = durationLabel(minutes);
  return duration ? `${base} · ${duration}` : base;
}

function resetAt(observedMs: number, seconds: number | undefined): string | undefined {
  if (seconds === undefined) return undefined;
  return new Date(observedMs + seconds * 1000).toISOString();
}

function remainingSeconds(resetsAt: string | undefined, now: number): number | undefined {
  if (!resetsAt) return undefined;
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs)) return undefined;
  return Math.max(0, Math.floor((resetMs - now) / 1000));
}

function mergeCodexWindow(
  id: 'primary' | 'secondary',
  observation: CodexAllowanceWindowObservation | undefined,
  existing: AllowanceWindow | undefined,
  observedMs: number,
): AllowanceWindow {
  const windowMinutes = observation?.windowMinutes ?? existing?.windowMinutes;
  const nextResetAt = observation?.resetAfterSeconds !== undefined
    ? resetAt(observedMs, observation.resetAfterSeconds)
    : existing?.resetsAt;
  const hasExistingData = !!existing && (
    existing.usedPercent !== null ||
    existing.windowMinutes !== undefined ||
    existing.resetsAt !== undefined
  );

  return {
    id,
    label: codexLabel(id, windowMinutes),
    scope: 'all',
    usedPercent: observation?.usedPercent ?? existing?.usedPercent ?? null,
    windowMinutes,
    resetsAt: nextResetAt,
    remainingSeconds: remainingSeconds(nextResetAt, observedMs),
    state: observation ? 'fresh' : hasExistingData ? 'stale' : 'unavailable',
  };
}

function projectSnapshot(snapshot: AccountAllowanceSnapshot, now: number): AccountAllowanceSnapshot {
  const expiredAt = snapshot.expiresAt ? Date.parse(snapshot.expiresAt) : Number.POSITIVE_INFINITY;
  const expired = Number.isFinite(expiredAt) && expiredAt <= now;
  return {
    ...snapshot,
    windows: snapshot.windows.map((window) => ({
      ...window,
      state: expired && window.state === 'fresh' ? 'stale' : window.state,
      remainingSeconds: remainingSeconds(window.resetsAt, now),
    })),
  };
}

/** In-memory allowance projection shared by serving/admin with optional host persistence. */
export class AccountAllowanceStore {
  private readonly snapshots = new Map<string, AccountAllowanceSnapshot>();
  private readonly maxSnapshots: number;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly codexFreshMs = DEFAULT_CODEX_ALLOWANCE_FRESH_MS,
    private readonly persistence?: AccountAllowancePersistence,
    maxSnapshots = DEFAULT_ALLOWANCE_MAX_SNAPSHOTS,
  ) {
    this.maxSnapshots = Number.isFinite(maxSnapshots) && maxSnapshots > 0
      ? Math.floor(maxSnapshots)
      : DEFAULT_ALLOWANCE_MAX_SNAPSHOTS;
    this.loadPersisted();
  }

  set(snapshot: AccountAllowanceSnapshot): void {
    const normalized = normalizeAccountAllowanceSnapshot(snapshot);
    if (!normalized) return;
    this.snapshots.set(
      snapshotKey(normalized.providerId, normalized.accountId),
      normalized,
    );
    while (this.snapshots.size > this.maxSnapshots) {
      const oldest = this.snapshots.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.snapshots.delete(oldest);
    }
    this.persist();
  }

  delete(providerId: SubscriptionProviderId, accountId: string): void {
    if (this.snapshots.delete(snapshotKey(providerId, accountId))) this.persist();
  }

  /** Remove rows that no longer correspond to a configured account. */
  pruneToKnownAccounts(
    accounts: Iterable<{ providerId: SubscriptionProviderId; accountId: string }>,
  ): number {
    const known = new Set<string>();
    for (const account of accounts) {
      if (account.accountId) known.add(snapshotKey(account.providerId, account.accountId));
    }
    let removed = 0;
    for (const key of this.snapshots.keys()) {
      if (!known.has(key)) {
        this.snapshots.delete(key);
        removed += 1;
      }
    }
    if (removed > 0) this.persist();
    return removed;
  }

  get(
    providerId: SubscriptionProviderId,
    accountId: string,
    now: number = this.now(),
  ): AccountAllowanceSnapshot | null {
    const snapshot = this.snapshots.get(snapshotKey(providerId, accountId));
    return snapshot ? projectSnapshot(cloneSnapshot(snapshot), now) : null;
  }

  list(
    filter: { providerId?: SubscriptionProviderId; accountId?: string } = {},
    now: number = this.now(),
  ): AccountAllowanceSnapshot[] {
    const out: AccountAllowanceSnapshot[] = [];
    for (const snapshot of this.snapshots.values()) {
      if (filter.providerId && snapshot.providerId !== filter.providerId) continue;
      if (filter.accountId && snapshot.accountId !== filter.accountId) continue;
      out.push(projectSnapshot(cloneSnapshot(snapshot), now));
    }
    return out.sort(
      (a, b) => a.providerId.localeCompare(b.providerId) || a.accountId.localeCompare(b.accountId),
    );
  }

  /**
   * Merge one real Codex upstream response into the selected account's snapshot.
   * A response with no recognized headers is a strict no-op, and a partial header
   * set preserves previous values while marking untouched windows stale.
   */
  recordCodexHeaders(
    accountId: string,
    headers: AllowanceHeadersLike,
    observedMs: number = this.now(),
  ): AccountAllowanceSnapshot | null {
    if (!accountId) return null;
    const observation = parseCodexAllowanceHeaders(headers);
    if (!observation) return this.get('codex', accountId, observedMs);

    const previous = this.snapshots.get(snapshotKey('codex', accountId));
    const previousPrimary = previous?.source === 'response-headers'
      ? previous.windows.find((window) => window.id === 'primary')
      : undefined;
    const previousSecondary = previous?.source === 'response-headers'
      ? previous.windows.find((window) => window.id === 'secondary')
      : undefined;
    const observedAt = new Date(observedMs).toISOString();
    const snapshot: AccountAllowanceSnapshot = {
      providerId: 'codex',
      accountId,
      source: 'response-headers',
      observedAt,
      expiresAt: new Date(observedMs + this.codexFreshMs).toISOString(),
      windows: [
        mergeCodexWindow('primary', observation.primary, previousPrimary, observedMs),
        mergeCodexWindow('secondary', observation.secondary, previousSecondary, observedMs),
      ],
      primaryOverSecondaryLimitPercent:
        observation.primaryOverSecondaryLimitPercent ??
        previous?.primaryOverSecondaryLimitPercent,
    };
    this.set(snapshot);
    return this.get('codex', accountId, observedMs);
  }

  clear(): void {
    if (this.snapshots.size === 0) return;
    this.snapshots.clear();
    this.persist();
  }

  private loadPersisted(): void {
    if (!this.persistence) return;
    let payload: unknown;
    try {
      payload = this.persistence.load();
    } catch {
      return;
    }
    if (!Array.isArray(payload)) return;
    for (const value of payload) {
      const snapshot = normalizeAccountAllowanceSnapshot(value);
      if (!snapshot) continue;
      this.snapshots.set(snapshotKey(snapshot.providerId, snapshot.accountId), snapshot);
      if (this.snapshots.size >= this.maxSnapshots) break;
    }
  }

  private persist(): void {
    if (!this.persistence) return;
    try {
      this.persistence.save(Array.from(this.snapshots.values(), cloneSnapshot));
    } catch {
      // Allowance telemetry must never break a serving request or admin read.
    }
  }
}

let sharedAllowanceStore: AccountAllowanceStore | null = null;

export function getSharedAccountAllowanceStore(): AccountAllowanceStore {
  if (!sharedAllowanceStore) sharedAllowanceStore = new AccountAllowanceStore();
  return sharedAllowanceStore;
}

export function setSharedAccountAllowanceStore(store: AccountAllowanceStore): void {
  sharedAllowanceStore = store;
}

/** Test/daemon teardown seam. */
export function __resetSharedAccountAllowanceStoreForTests(): void {
  sharedAllowanceStore = null;
}
