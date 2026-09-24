/**
 * allowanceCycles.test.ts — the merge rules behind the cycles view: observed
 * boundary events segment into `[start, nextStart)`; the live snapshot pins
 * the ongoing cycle (and back-fills it as `kind: 'live'` when no event marks
 * it); ordering is account-major, start-descending.
 */

import type { AccountAllowanceSnapshot } from '@omnicross/contracts/account-allowance-types';
import { describe, expect, it } from 'vitest';

import {
  composeAllowanceCycles,
  filterAllowanceBoundaryEvents,
} from '../allowanceCycles';
import type { AccountAllowanceBoundaryEvent } from '../AllowanceBoundaryLog';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const WEEK = 7 * DAY;
const NOW = Date.parse('2026-09-14T03:00:00.000Z');

const boundary = (over: Partial<AccountAllowanceBoundaryEvent>): AccountAllowanceBoundaryEvent => ({
  version: 1,
  observedAt: new Date(over.cycleStartMs ?? 0).toISOString(),
  providerId: 'codex',
  accountId: 'acc-1',
  kind: 'scheduled',
  cycleStartMs: 0,
  ...over,
});

/** Live codex snapshot whose primary window spans `[resetsAt − 1w, resetsAt)`. */
const liveSnapshot = (resetsAtMs: number, accountId = 'acc-1'): AccountAllowanceSnapshot => ({
  providerId: 'codex',
  accountId,
  source: 'response-headers',
  observedAt: new Date(NOW).toISOString(),
  windows: [
    {
      id: 'primary',
      label: 'Primary · 1 week',
      scope: 'all',
      usedPercent: 79,
      windowMinutes: 10_080,
      resetsAt: new Date(resetsAtMs).toISOString(),
      state: 'fresh',
    },
  ],
});

describe('composeAllowanceCycles', () => {
  it('segments observed boundaries into half-open cycles, newest first', () => {
    const s1 = Date.parse('2026-09-05T09:41:06.000Z');
    const s2 = Date.parse('2026-09-12T09:41:06.000Z');
    const cycles = composeAllowanceCycles(
      [boundary({ cycleStartMs: s1 }), boundary({ cycleStartMs: s2, kind: 'unscheduled' })],
      [],
      NOW,
    );
    expect(cycles).toHaveLength(2);
    expect(cycles[0]).toMatchObject({ startTs: s2, endTs: null, kind: 'unscheduled' });
    expect(cycles[1]).toMatchObject({ startTs: s1, endTs: s2, kind: 'scheduled' });
  });

  it('pins the ongoing cycle end to the live window resetsAt', () => {
    const s2 = NOW - 2 * DAY;
    const resetsAt = NOW + 5 * DAY;
    const cycles = composeAllowanceCycles(
      [boundary({ cycleStartMs: s2 })],
      [liveSnapshot(resetsAt)],
      NOW,
    );
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toMatchObject({
      startTs: s2,
      endTs: resetsAt,
      resetsAt: new Date(resetsAt).toISOString(),
    });
  });

  it('synthesizes the current cycle from the snapshot alone, flagged live', () => {
    const resetsAt = NOW + 5 * DAY;
    const start = resetsAt - WEEK;
    const cycles = composeAllowanceCycles([], [liveSnapshot(resetsAt)], NOW);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toMatchObject({
      startTs: start,
      endTs: resetsAt,
      kind: 'live',
      boundaryObservedAt: null,
    });
  });

  it('does not infer a cycle from an unused Codex window whose deadline follows the clock', () => {
    const snapshot = liveSnapshot(NOW + WEEK);
    snapshot.windows[0].usedPercent = 0;
    expect(composeAllowanceCycles([], [snapshot], NOW)).toEqual([]);
    // Reading the same cached snapshot later must not make its projection
    // look like an established cycle.
    expect(composeAllowanceCycles([], [snapshot], NOW + DAY)).toEqual([]);
  });

  it('keeps a real reset open until first use fixes its deadline without splitting the cycle', () => {
    const reset = NOW - 6 * 60 * MIN;
    const event = boundary({
      kind: 'unscheduled',
      cycleStartMs: reset,
      windowMinutes: WEEK / MIN,
      previousUsedPercent: 100,
      usedPercent: 0,
      resetsAt: new Date(reset + WEEK).toISOString(),
    });
    const idle = liveSnapshot(NOW + WEEK);
    idle.windows[0].usedPercent = 0;
    expect(composeAllowanceCycles([event], [idle], NOW)).toMatchObject([
      { startTs: reset, endTs: null, resetsAt: null, kind: 'unscheduled' },
    ]);
    const firstUse = NOW - 60 * MIN;
    const active = liveSnapshot(firstUse + WEEK);
    expect(composeAllowanceCycles([event], [active], NOW)).toMatchObject([
      { startTs: reset, endTs: firstUse + WEEK, kind: 'unscheduled' },
    ]);
  });

  it('still infers a later cycle after a full window has passed since a reset', () => {
    const reset = NOW - 2 * WEEK;
    const event = boundary({
      cycleStartMs: reset,
      windowMinutes: WEEK / MIN,
      usedPercent: 0,
      resetsAt: new Date(reset + WEEK).toISOString(),
    });
    const cycles = composeAllowanceCycles([event], [liveSnapshot(NOW + 5 * DAY)], NOW);
    expect(cycles).toHaveLength(2);
    expect(cycles[0]).toMatchObject({ kind: 'live', startTs: NOW - 2 * DAY });
  });

  it('does not duplicate a live start an event already marks', () => {
    const resetsAt = NOW + 5 * DAY;
    const start = resetsAt - WEEK;
    const cycles = composeAllowanceCycles(
      [boundary({ cycleStartMs: start + 30_000 })], // within the 90s tolerance
      [liveSnapshot(resetsAt)],
      NOW,
    );
    expect(cycles).toHaveLength(1);
    expect(cycles[0].kind).toBe('scheduled'); // the OBSERVED boundary wins
  });

  it('keeps the live start even when it predates every observed boundary', () => {
    // The feature shipped mid-cycle: an old boundary exists, the live window
    // began later without a logged event (daemon was down at the reset).
    const oldStart = NOW - 12 * DAY;
    const resetsAt = NOW + 5 * DAY;
    const cycles = composeAllowanceCycles(
      [boundary({ cycleStartMs: oldStart })],
      [liveSnapshot(resetsAt)],
      NOW,
    );
    expect(cycles).toHaveLength(2);
    expect(cycles[0]).toMatchObject({ kind: 'live', endTs: resetsAt });
    expect(cycles[1]).toMatchObject({ startTs: oldStart, endTs: cycles[0].startTs });
  });

  it('groups by account and orders provider/account-major', () => {
    // b's live window starts exactly where its observed boundary sits, so b
    // keeps ONE cycle; a has only the live window.
    const bStart = NOW - DAY;
    const cycles = composeAllowanceCycles(
      [boundary({ providerId: 'codex', accountId: 'b', cycleStartMs: bStart })],
      [liveSnapshot(NOW + DAY, 'a'), liveSnapshot(bStart + WEEK, 'b')],
      NOW,
    );
    expect(cycles.map((c) => `${c.providerId}:${c.accountId}`)).toEqual(['codex:a', 'codex:b']);
  });

  it('produces nothing for an account whose snapshot has no tracked window', () => {
    const snapshot: AccountAllowanceSnapshot = {
      providerId: 'codex',
      accountId: 'fresh',
      source: 'response-headers',
      observedAt: new Date(NOW).toISOString(),
      windows: [
        { id: 'primary', label: 'Primary', scope: 'all', usedPercent: null, state: 'unavailable' },
      ],
    };
    expect(composeAllowanceCycles([], [snapshot], NOW)).toEqual([]);
  });

  it('ignores a live start in the future (clock-skewed resetsAt)', () => {
    const cycles = composeAllowanceCycles([], [liveSnapshot(NOW + 10 * WEEK)], NOW);
    expect(cycles).toEqual([]);
  });
});

describe('filterAllowanceBoundaryEvents', () => {
  const events = [
    boundary({ providerId: 'codex', accountId: 'a', cycleStartMs: 1 }),
    boundary({ providerId: 'claude', accountId: 'b', cycleStartMs: 2 }),
  ];
  it('keeps everything under an empty filter', () => {
    expect(filterAllowanceBoundaryEvents(events, {})).toHaveLength(2);
  });
  it('filters by provider and account independently', () => {
    expect(filterAllowanceBoundaryEvents(events, { providerId: 'codex' })).toHaveLength(1);
    expect(filterAllowanceBoundaryEvents(events, { accountId: 'b' })).toHaveLength(1);
    expect(filterAllowanceBoundaryEvents(events, { providerId: 'claude', accountId: 'a' })).toHaveLength(0);
  });
});
