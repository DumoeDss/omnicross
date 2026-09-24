/**
 * allowanceCycles — turn the boundary ledger + the live allowance snapshots
 * into billable-cycle segments the Usage page can query usage against.
 *
 * The ledger holds OBSERVED boundaries (and will hold none for cycles that
 * began before the feature existed or while the daemon was down); the live
 * snapshot's anchored `resetsAt`/`windowMinutes` pins the CURRENT cycle's span.
 * Merging the two: each boundary event contributes a start; the live window's
 * start (`resetsAt − windowMinutes`) is added when no event already marks it —
 * such an inferred start is flagged `kind: 'live'` so the UI can say the exact
 * boundary moment was not observed.
 *
 * Pure functions throughout — no I/O — so the merge rules are unit-testable.
 *
 * @module @omnicross/daemon/allowance/allowanceCycles
 */

import type {
  AccountAllowanceSnapshot,
  AllowanceWindow,
} from '@omnicross/contracts/account-allowance-types';
import type { SubscriptionProviderId } from '@omnicross/contracts/subscription-types';

import {
  isUnstartedCodexWindow,
  trackedAllowanceWindow,
  type AccountAllowanceBoundaryEvent,
} from './AllowanceBoundaryLog';

/** How the start of a cycle was established. */
export type AllowanceCycleKind = AccountAllowanceBoundaryEvent['kind'] | 'live';

/** One billable-cycle segment for one account. */
export interface AccountAllowanceCycle {
  providerId: SubscriptionProviderId;
  accountId: string;
  /** Cycle start, unix ms — the exclusive-lower-bound for usage queries. */
  startTs: number;
  /**
   * Next boundary, unix ms — the FOLLOWING cycle's start, or the live window's
   * `resetsAt` for the ongoing cycle. Null when neither is known.
   */
  endTs: number | null;
  /** ISO of the upcoming reset when the live snapshot knows it. */
  resetsAt: string | null;
  kind: AllowanceCycleKind;
  /** ISO when the boundary event was observed; null for `live` cycles. */
  boundaryObservedAt: string | null;
}

/** Two starts closer than this are the same boundary (ms). */
const SAME_BOUNDARY_MS = 90_000;

/** Most cycles returned per account — the ledger grows weekly, not hourly. */
const MAX_CYCLES_PER_ACCOUNT = 40;

/** Keep only the boundary events a filter asks for (undefined field ≡ no constraint). */
export function filterAllowanceBoundaryEvents(
  events: readonly AccountAllowanceBoundaryEvent[],
  filter: { providerId?: string; accountId?: string },
): AccountAllowanceBoundaryEvent[] {
  return events.filter(
    (event) =>
      (filter.providerId === undefined || event.providerId === filter.providerId) &&
      (filter.accountId === undefined || event.accountId === filter.accountId),
  );
}

interface AccountKey {
  providerId: string;
  accountId: string;
}

const keyOf = (k: AccountKey): string => `${k.providerId}\0${k.accountId}`;

interface StartEntry {
  startMs: number;
  kind: AllowanceCycleKind;
  boundaryObservedAt: string | null;
  /** A real reset observed before Codex anchored the new window on first use. */
  awaitingFirstUse: boolean;
}

/**
 * Compose cycles for the given accounts: `events` supplies observed boundary
 * starts, `snapshots` supply the live current window (and the accounts worth
 * listing at all — an account with neither produces nothing). Output is sorted
 * by account, then start DESCENDING (newest cycle first, the UI's order).
 */
export function composeAllowanceCycles(
  events: readonly AccountAllowanceBoundaryEvent[],
  snapshots: readonly AccountAllowanceSnapshot[],
  now: number,
): AccountAllowanceCycle[] {
  // Per account: boundary-derived starts (sorted, deduped)…
  const starts = new Map<string, StartEntry[]>();
  const orderedEvents = [...events].sort((a, b) => a.cycleStartMs - b.cycleStartMs);
  for (const event of orderedEvents) {
    const key = keyOf(event);
    const list = starts.get(key) ?? [];
    const last = list[list.length - 1];
    if (last && Math.abs(last.startMs - event.cycleStartMs) < SAME_BOUNDARY_MS) continue;
    list.push({
      startMs: event.cycleStartMs,
      kind: event.kind,
      boundaryObservedAt: event.observedAt,
      awaitingFirstUse: event.providerId === 'codex' &&
        isUnstartedCodexWindow(event, Date.parse(event.observedAt)),
    });
    starts.set(key, list);
  }

  // …plus the live window's start when it marks a boundary the ledger missed.
  const liveEnds = new Map<string, { resetsAt: string; resetMs: number }>();
  for (const snapshot of snapshots) {
    const window: AllowanceWindow | null = trackedAllowanceWindow(snapshot);
    if (!window?.resetsAt || !window.windowMinutes) continue;
    // Zero usage with a full window remaining is only a moving projection.
    // Keep any observed reset open until first use supplies an anchored end.
    if (snapshot.providerId === 'codex' &&
        isUnstartedCodexWindow(window, Date.parse(snapshot.observedAt))) continue;
    const resetMs = Date.parse(window.resetsAt);
    if (!Number.isFinite(resetMs)) continue;
    const key = keyOf(snapshot);
    liveEnds.set(key, { resetsAt: window.resetsAt, resetMs });
    const liveStartMs = resetMs - window.windowMinutes * 60_000;
    const list = starts.get(key) ?? [];
    const covered = list.some((entry) => Math.abs(entry.startMs - liveStartMs) < SAME_BOUNDARY_MS);
    const latest = list[list.length - 1];
    // The reset and the later first request belong to one cycle. Do not add
    // an inferred start between them just because the idle deadline moved.
    const followsObservedReset = latest?.awaitingFirstUse &&
      latest.startMs <= liveStartMs &&
      liveStartMs - latest.startMs < window.windowMinutes * 60_000;
    if (!covered && !followsObservedReset && liveStartMs <= now) {
      list.push({ startMs: liveStartMs, kind: 'live', boundaryObservedAt: null, awaitingFirstUse: false });
      starts.set(key, list);
    }
  }

  // Segment: each start's end is the next start; the newest takes the live
  // window's resetsAt when known.
  const out: AccountAllowanceCycle[] = [];
  for (const [key, list] of starts) {
    const [providerId, accountId] = key.split('\0');
    list.sort((a, b) => a.startMs - b.startMs);
    const live = liveEnds.get(key) ?? null;
    const capped = list.length > MAX_CYCLES_PER_ACCOUNT
      ? list.slice(list.length - MAX_CYCLES_PER_ACCOUNT)
      : list;
    for (let i = 0; i < capped.length; i += 1) {
      const entry = capped[i];
      const isLast = i === capped.length - 1;
      const nextStart = isLast ? null : capped[i + 1].startMs;
      const liveEnd = isLast && live && live.resetMs > entry.startMs ? live.resetMs : null;
      const endTs = nextStart ?? liveEnd;
      out.push({
        providerId: providerId as SubscriptionProviderId,
        accountId,
        startTs: entry.startMs,
        endTs,
        resetsAt: isLast && live ? live.resetsAt : null,
        kind: entry.kind,
        boundaryObservedAt: entry.boundaryObservedAt,
      });
    }
  }
  out.sort(
    (a, b) =>
      a.providerId.localeCompare(b.providerId) ||
      a.accountId.localeCompare(b.accountId) ||
      b.startTs - a.startTs,
  );
  return out;
}
