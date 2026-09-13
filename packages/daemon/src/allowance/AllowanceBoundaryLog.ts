/**
 * AllowanceBoundaryLog — the append-only ledger of subscription cycle
 * boundaries (usage-cycle-history).
 *
 * WHY: the account's weekly quota window can reset at a moment omnicross does
 * not choose — the vendor's anchor may drift, and a redeemed reset card clears
 * the counter mid-window. The live `allowance-cache.json` keeps only the LATEST
 * snapshot per account, so boundaries that were never persisted are gone the
 * moment the next response overwrites the cache. This ledger keeps the one
 * fact the cache cannot: WHEN each boundary happened, as observed from the
 * `resetsAt` / `usedPercent` sequence in the response-header tap.
 *
 * HOW: a DECORATOR over the host `AccountAllowancePersistence`. `load()`
 * delegates and remembers the persisted snapshots as the diff baseline (so a
 * daemon restart does not re-emit, and a boundary crossed while the daemon was
 * down is still caught on the first live observation). `save()` diffs each
 * account's tracked window against that baseline, appends one JSON line per
 * detected boundary, then delegates. Boundary detection is best-effort: a
 * logging failure never blocks the snapshot persist.
 *
 * WHAT COUNTS AS A BOUNDARY (per account, on the tracked window — the widest
 * window of at least MIN_TRACKED_WINDOW_MINUTES, i.e. the weekly/billing
 * window; a 5-hour Claude window is deliberately noise):
 *  - `resetsAt` MOVED by ≈ its window length → `scheduled` (the ordinary
 *    weekly roll). `cycleStartMs` = the PREVIOUS `resetsAt`, which is the exact
 *    expiry instant of the old window even when observed late.
 *  - `resetsAt` moved any other way → `unscheduled` (anchor drift, or a reset
 *    card that replaced the window). `cycleStartMs` = the observation time —
 *    the best locally knowable instant.
 *  - `resetsAt` UNCHANGED while `usedPercent` DROPPED by at least
 *    {@link IN_PLACE_DROP_PERCENT} points → `in-place` (counter cleared without
 *    moving the reset date — the reset-card signature; within a window the
 *    usage share is monotonic, so a real drop cannot be jitter).
 *
 * @module @omnicross/daemon/allowance/AllowanceBoundaryLog
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import type { AccountAllowancePersistence } from '@omnicross/core/pipeline/AccountAllowanceStore';
import type {
  AccountAllowanceSnapshot,
  AllowanceWindow,
} from '@omnicross/contracts/account-allowance-types';
import type { SubscriptionProviderId } from '@omnicross/contracts/subscription-types';

export const ALLOWANCE_BOUNDARY_LOG_VERSION = 1;

/** Only windows this long participate (the weekly/billing window). */
export const MIN_TRACKED_WINDOW_MINUTES = 7 * 24 * 60;

/** A usedPercent drop of at least this many points at the same resetsAt. */
export const IN_PLACE_DROP_PERCENT = 5;

/** A `scheduled` roll may deviate from exactly one window by this much. */
export const SCHEDULED_TOLERANCE_MS = 60 * 60 * 1000;

/** Fail-safe cap: a boundary ledger larger than this stops appending. */
export const MAX_BOUNDARY_LOG_BYTES = 1_000_000;

/** One appended boundary record. */
export interface AccountAllowanceBoundaryEvent {
  version: typeof ALLOWANCE_BOUNDARY_LOG_VERSION;
  /** ISO instant the change was first OBSERVED (an upper bound of the boundary). */
  observedAt: string;
  providerId: SubscriptionProviderId;
  accountId: string;
  kind: 'scheduled' | 'unscheduled' | 'in-place';
  /** The segmentation authority: unix-ms cycle start derived at detection time. */
  cycleStartMs: number;
  windowMinutes?: number;
  previousResetsAt?: string;
  resetsAt?: string;
  previousUsedPercent?: number | null;
  usedPercent?: number | null;
}

/** The tracked window of a snapshot: the widest window ≥ the weekly minimum. */
export function trackedAllowanceWindow(
  snapshot: AccountAllowanceSnapshot,
): AllowanceWindow | null {
  let best: AllowanceWindow | null = null;
  for (const window of snapshot.windows) {
    if ((window.windowMinutes ?? 0) < MIN_TRACKED_WINDOW_MINUTES) continue;
    if (!best || (window.windowMinutes ?? 0) > (best.windowMinutes ?? 0)) best = window;
  }
  return best;
}

interface BaselineEntry {
  resetsAt: string | undefined;
  usedPercent: number | null | undefined;
  windowMinutes: number | undefined;
}

type Baseline = Map<string, BaselineEntry>;

function baselineKey(providerId: string, accountId: string): string {
  return `${providerId}\0${accountId}`;
}

/** Seed a baseline from whatever `load()` returned (defensive — it is `unknown`). */
function baselineFromLoaded(loaded: unknown): Baseline {
  const out: Baseline = new Map();
  if (!Array.isArray(loaded)) return out;
  for (const raw of loaded) {
    if (!raw || typeof raw !== 'object') continue;
    const snapshot = raw as Partial<AccountAllowanceSnapshot>;
    if (typeof snapshot.providerId !== 'string' || typeof snapshot.accountId !== 'string') continue;
    if (!Array.isArray(snapshot.windows)) continue;
    const normalized: AccountAllowanceSnapshot = {
      providerId: snapshot.providerId,
      accountId: snapshot.accountId,
      source: 'response-headers',
      observedAt: snapshot.observedAt ?? new Date(0).toISOString(),
      windows: snapshot.windows as AllowanceWindow[],
    };
    const window = trackedAllowanceWindow(normalized);
    if (!window) continue;
    out.set(baselineKey(snapshot.providerId, snapshot.accountId), {
      resetsAt: window.resetsAt,
      usedPercent: window.usedPercent,
      windowMinutes: window.windowMinutes,
    });
  }
  return out;
}

/**
 * Diff one save's snapshots against the baseline, producing the boundary
 * events (and the next baseline). Pure — unit-tested without any file I/O.
 */
export function detectAllowanceBoundaryEvents(
  snapshots: readonly AccountAllowanceSnapshot[],
  previous: Baseline,
  observedMs: number,
): { events: AccountAllowanceBoundaryEvent[]; next: Baseline } {
  const events: AccountAllowanceBoundaryEvent[] = [];
  const next: Baseline = new Map();
  const observedAt = new Date(observedMs).toISOString();

  for (const snapshot of snapshots) {
    const window = trackedAllowanceWindow(snapshot);
    if (!window) continue; // nothing tracked for this account — leave no baseline
    const key = baselineKey(snapshot.providerId, snapshot.accountId);
    next.set(key, {
      resetsAt: window.resetsAt,
      usedPercent: window.usedPercent,
      windowMinutes: window.windowMinutes,
    });

    const prev = previous.get(key);
    if (!prev) continue; // first observation: establish the baseline silently

    const prevResetMs = prev.resetsAt !== undefined ? Date.parse(prev.resetsAt) : Number.NaN;
    const nextResetMs = window.resetsAt !== undefined ? Date.parse(window.resetsAt) : Number.NaN;
    const windowMs =
      (window.windowMinutes ?? prev.windowMinutes ?? 0) * 60_000 || 604_800_000;

    if (Number.isFinite(prevResetMs) && Number.isFinite(nextResetMs) && prevResetMs !== nextResetMs) {
      const rolledOnSchedule =
        Math.abs(nextResetMs - prevResetMs - windowMs) <= SCHEDULED_TOLERANCE_MS;
      events.push({
        version: ALLOWANCE_BOUNDARY_LOG_VERSION,
        observedAt,
        providerId: snapshot.providerId,
        accountId: snapshot.accountId,
        kind: rolledOnSchedule ? 'scheduled' : 'unscheduled',
        // A scheduled roll starts exactly where the old window expired; any
        // other movement is only known to have happened by observation time.
        cycleStartMs: rolledOnSchedule ? prevResetMs : observedMs,
        ...(window.windowMinutes !== undefined ? { windowMinutes: window.windowMinutes } : {}),
        previousResetsAt: prev.resetsAt,
        resetsAt: window.resetsAt,
        previousUsedPercent: prev.usedPercent ?? null,
        usedPercent: window.usedPercent ?? null,
      });
      continue;
    }

    const prevUsed = typeof prev.usedPercent === 'number' ? prev.usedPercent : null;
    const nextUsed = typeof window.usedPercent === 'number' ? window.usedPercent : null;
    if (prevUsed !== null && nextUsed !== null && prevUsed - nextUsed >= IN_PLACE_DROP_PERCENT) {
      events.push({
        version: ALLOWANCE_BOUNDARY_LOG_VERSION,
        observedAt,
        providerId: snapshot.providerId,
        accountId: snapshot.accountId,
        kind: 'in-place',
        cycleStartMs: observedMs,
        ...(window.windowMinutes !== undefined ? { windowMinutes: window.windowMinutes } : {}),
        ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
        previousUsedPercent: prevUsed,
        usedPercent: nextUsed,
      });
    }
  }
  return { events, next };
}

/**
 * Parse the ledger. Torn/malformed lines are skipped (the JSONL contract);
 * an oversized or unreadable file reads as empty — a damaged ledger must never
 * take the allowance surface down with it.
 */
export function readAllowanceBoundaryEvents(logPath: string): AccountAllowanceBoundaryEvent[] {
  if (!existsSync(logPath)) return [];
  try {
    if (statSync(logPath).size > MAX_BOUNDARY_LOG_BYTES) return [];
    const raw = readFileSync(logPath, 'utf8');
    const out: AccountAllowanceBoundaryEvent[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as Partial<AccountAllowanceBoundaryEvent>;
        if (
          parsed.version === ALLOWANCE_BOUNDARY_LOG_VERSION &&
          typeof parsed.observedAt === 'string' &&
          typeof parsed.providerId === 'string' &&
          typeof parsed.accountId === 'string' &&
          (parsed.kind === 'scheduled' || parsed.kind === 'unscheduled' || parsed.kind === 'in-place') &&
          typeof parsed.cycleStartMs === 'number' && Number.isFinite(parsed.cycleStartMs)
        ) {
          out.push(parsed as AccountAllowanceBoundaryEvent);
        }
      } catch {
        /* torn tail — skip */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * The persistence decorator. Construction never touches the disk — the
 * baseline is seeded lazily on the first `load()` (which the core store calls
 * from its constructor).
 */
export class AllowanceBoundaryLog implements AccountAllowancePersistence {
  private baseline: Baseline | null = null;

  constructor(
    private readonly inner: AccountAllowancePersistence,
    private readonly logPath: string,
    private readonly now: () => number = Date.now,
  ) {}

  load(): unknown {
    const loaded = this.inner.load();
    this.baseline = baselineFromLoaded(loaded);
    return loaded;
  }

  save(snapshots: readonly AccountAllowanceSnapshot[]): void {
    // Baseline must exist before diffing — if the store ever saved before
    // loading, treat this save as the baseline instead of emitting noise.
    if (this.baseline === null) {
      const { next } = detectAllowanceBoundaryEvents(snapshots, new Map(), this.now());
      this.baseline = next;
    } else {
      const { events, next } = detectAllowanceBoundaryEvents(snapshots, this.baseline, this.now());
      if (events.length > 0) {
        try {
          this.appendEvents(events);
          // Advance the baseline ONLY on a successful append: a failed write
          // keeps the old baseline, so the next save re-detects (retry).
          this.baseline = next;
        } catch {
          /* boundary logging is best-effort — never block the snapshot persist */
        }
      } else {
        this.baseline = next;
      }
    }
    this.inner.save(snapshots);
  }

  private appendEvents(events: readonly AccountAllowanceBoundaryEvent[]): void {
    let payload = '';
    for (const event of events) payload += `${JSON.stringify(event)}\n`;
    mkdirSync(dirname(this.logPath), { recursive: true });
    if (existsSync(this.logPath) && statSync(this.logPath).size > MAX_BOUNDARY_LOG_BYTES) {
      throw new Error('allowance boundary log exceeds its size limit');
    }
    appendFileSync(this.logPath, payload, 'utf8');
  }
}
