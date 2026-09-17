/**
 * AllowanceBoundaryLog.test.ts — the boundary-detection rules, the
 * persistence-decorator contract (load seeds the restart baseline; a failed
 * append retries on the next save; the inner save always runs), and the
 * defensive ledger reader.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AccountAllowanceSnapshot } from '@omnicross/contracts/account-allowance-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AllowanceBoundaryLog,
  detectAllowanceBoundaryEvents,
  readAllowanceBoundaryEvents,
  trackedAllowanceWindow,
  type AccountAllowanceBoundaryEvent,
} from '../AllowanceBoundaryLog';

const WEEK_MIN = 7 * 24 * 60;

/** Epoch ms helpers — fixed clock so assertions are exact. */
const T0 = Date.parse('2026-09-01T09:41:06.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

let tmpDir: string;
let logPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-boundary-'));
  logPath = join(tmpDir, 'allowance-boundaries.jsonl');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A codex snapshot carrying only the weekly primary window. */
function codexSnapshot(over: {
  resetsAt?: string;
  usedPercent?: number | null;
  observedAtMs?: number;
  accountId?: string;
}): AccountAllowanceSnapshot {
  return {
    providerId: 'codex',
    accountId: over.accountId ?? 'acc-1',
    source: 'response-headers',
    observedAt: iso(over.observedAtMs ?? T0),
    windows: [
      {
        id: 'primary',
        label: 'Primary · 1 week',
        scope: 'all',
        usedPercent: over.usedPercent ?? null,
        windowMinutes: WEEK_MIN,
        ...(over.resetsAt !== undefined ? { resetsAt: over.resetsAt } : {}),
        state: 'fresh',
      },
    ],
  };
}

describe('trackedAllowanceWindow', () => {
  it('prefers the widest window of at least a week', () => {
    const snapshot = codexSnapshot({ resetsAt: iso(T0), usedPercent: 10 });
    snapshot.windows.unshift({
      id: 'secondary',
      label: 'Secondary · 0 weeks',
      scope: 'all',
      usedPercent: 0,
      windowMinutes: 0,
      state: 'fresh',
    });
    expect(trackedAllowanceWindow(snapshot)?.id).toBe('primary');
  });

  it('ignores a 5-hour window entirely', () => {
    const snapshot: AccountAllowanceSnapshot = {
      providerId: 'claude',
      accountId: 'c1',
      source: 'response-headers',
      observedAt: iso(T0),
      windows: [
        { id: 'five-hour', label: '5 hours', scope: 'all', usedPercent: 40, windowMinutes: 300, resetsAt: iso(T0 + 300_000), state: 'fresh' },
      ],
    };
    expect(trackedAllowanceWindow(snapshot)).toBeNull();
  });
});

describe('detectAllowanceBoundaryEvents', () => {
  /** Convert a snapshot into the baseline shape via a real detection pass. */
  function baselineOf(prev: AccountAllowanceSnapshot) {
    return detectAllowanceBoundaryEvents([prev], new Map(), T0).next;
  }

  const detect = (
    prev: AccountAllowanceSnapshot | null,
    next: AccountAllowanceSnapshot,
    observedMs = T0 + 3_600_000,
  ) =>
    detectAllowanceBoundaryEvents(
      [next],
      prev !== null ? baselineOf(prev) : new Map(),
      observedMs,
    ).events;

  it('emits no event on first observation (baseline seeding)', () => {
    expect(detect(null, codexSnapshot({ resetsAt: iso(T0 + 604_800_000), usedPercent: 5 }))).toHaveLength(0);
  });

  it('emits no event for monotonic usedPercent growth', () => {
    const prev = codexSnapshot({ resetsAt: iso(T0 + 604_800_000), usedPercent: 10 });
    const next = codexSnapshot({ resetsAt: iso(T0 + 604_800_000), usedPercent: 55 });
    expect(detect(prev, next)).toHaveLength(0);
  });

  it('classifies a full-window resetsAt roll as scheduled with cycleStart at the old expiry', () => {
    const prev = codexSnapshot({ resetsAt: iso(T0), usedPercent: 96 });
    const next = codexSnapshot({ resetsAt: iso(T0 + 604_800_000), usedPercent: 4, observedAtMs: T0 + 604_900_000 });
    const events = detect(prev, next, T0 + 604_900_000);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('scheduled');
    expect(events[0].cycleStartMs).toBe(T0);
    expect(events[0].previousResetsAt).toBe(iso(T0));
    expect(events[0].resetsAt).toBe(iso(T0 + 604_800_000));
  });

  it('classifies an off-cadence resetsAt jump as unscheduled anchored at the observation', () => {
    const prev = codexSnapshot({ resetsAt: iso(T0 + 604_800_000), usedPercent: 90 });
    const next = codexSnapshot({ resetsAt: iso(T0 + 200_000_000), usedPercent: 2 });
    const observed = T0 + 1_000_000;
    const events = detect(prev, next, observed);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('unscheduled');
    expect(events[0].cycleStartMs).toBe(observed);
  });

  it('classifies a usedPercent drop at the same resetsAt as in-place (reset card)', () => {
    const prev = codexSnapshot({ resetsAt: iso(T0 + 604_800_000), usedPercent: 88 });
    const next = codexSnapshot({ resetsAt: iso(T0 + 604_800_000), usedPercent: 12 });
    const observed = T0 + 9_000_000;
    const events = detect(prev, next, observed);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('in-place');
    expect(events[0].cycleStartMs).toBe(observed);
  });

  it('ignores a usedPercent drop below the threshold (rounding jitter)', () => {
    const prev = codexSnapshot({ resetsAt: iso(T0 + 604_800_000), usedPercent: 12 });
    const next = codexSnapshot({ resetsAt: iso(T0 + 604_800_000), usedPercent: 8 });
    expect(detect(prev, next)).toHaveLength(0);
  });

  it('ignores a sub-tolerance resetsAt wobble (vendor clock jitter, the codex ±1 s flip)', () => {
    const prev = codexSnapshot({ resetsAt: iso(T0), usedPercent: 100 });
    const next = codexSnapshot({ resetsAt: iso(T0 + 1_000), usedPercent: 100 });
    expect(detect(prev, next)).toHaveLength(0);
  });

  it('keeps the wobble from accumulating: repeated flips never fire, a drift past the band fires once', () => {
    // Baseline anchored at T0; each save wobbles or drifts the instant a little.
    let baseline = detectAllowanceBoundaryEvents(
      [codexSnapshot({ resetsAt: iso(T0), usedPercent: 50 })],
      new Map(),
      T0,
    ).next;
    // Flip-flop ±1 s — no events, baseline anchor stays pinned at T0.
    for (const [resetsAt, at] of [
      [iso(T0 + 1_000), T0 + 300_000],
      [iso(T0), T0 + 600_000],
      [iso(T0 + 1_000), T0 + 900_000],
    ] as const) {
      const { events, next } = detectAllowanceBoundaryEvents(
        [codexSnapshot({ resetsAt, usedPercent: 50 })],
        baseline,
        at,
      );
      expect(events).toHaveLength(0);
      baseline = next;
    }
    // Slow genuine drift: steps of 2 min stay silent while cumulatively under
    // the 5-min band, then the step that crosses it fires exactly one
    // `unscheduled` event anchored at its observation time.
    let drifted = T0;
    let observed = T0 + 1_200_000;
    for (let i = 0; i < 3; i += 1) {
      drifted += 2 * 60_000;
      observed += 2 * 60_000;
      const { events, next } = detectAllowanceBoundaryEvents(
        [codexSnapshot({ resetsAt: iso(drifted), usedPercent: 50 })],
        baseline,
        observed,
      );
      if (drifted - T0 < 5 * 60_000) {
        expect(events).toHaveLength(0);
      } else {
        expect(events).toHaveLength(1);
        expect(events[0].kind).toBe('unscheduled');
        expect(events[0].cycleStartMs).toBe(observed);
      }
      baseline = next;
    }
  });

  it('still classifies a full-window roll as scheduled after a sub-tolerance wobble', () => {
    const prev = codexSnapshot({ resetsAt: iso(T0), usedPercent: 96 });
    const wobbled = detectAllowanceBoundaryEvents(
      [codexSnapshot({ resetsAt: iso(T0 + 1_000), usedPercent: 96 })],
      baselineOf(prev),
      T0 + 60_000,
    );
    expect(wobbled.events).toHaveLength(0); // jitter swallowed, anchor pinned
    const rolled = detectAllowanceBoundaryEvents(
      [codexSnapshot({ resetsAt: iso(T0 + 604_801_000), usedPercent: 4 })],
      wobbled.next,
      T0 + 604_900_000,
    );
    expect(rolled.events).toHaveLength(1);
    expect(rolled.events[0].kind).toBe('scheduled');
    expect(rolled.events[0].cycleStartMs).toBe(T0); // the pinned anchor, not T0+1 s
  });
});

describe('AllowanceBoundaryLog (decorator)', () => {
  // A file-backed fake: state is shared across log instances (restarts), so a
  // fresh decorator's `load()` sees what the previous one persisted.
  let persisted: AccountAllowanceSnapshot[] = [];
  const inner = {
    load: () => persisted,
    save: (snapshots: readonly AccountAllowanceSnapshot[]) => {
      persisted = [...snapshots];
    },
  };
  const makeLog = (): AllowanceBoundaryLog =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new AllowanceBoundaryLog(inner as any, logPath, () => T0);

  beforeEach(() => {
    persisted = [];
  });

  it('seeds the baseline from load() so a restart does not re-emit old state', () => {
    const first = makeLog();
    first.load(); // empty file on first boot
    first.save([codexSnapshot({ resetsAt: iso(T0), usedPercent: 10 })]);
    expect(readAllowanceBoundaryEvents(logPath)).toHaveLength(0);

    // Simulate a restart: a NEW log instance loads what was persisted and the
    // next save carries a rolled window — one event, cycleStart exact.
    const second = makeLog();
    second.load();
    second.save([codexSnapshot({ resetsAt: iso(T0 + 604_800_000), usedPercent: 3 })]);
    const events = readAllowanceBoundaryEvents(logPath);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('scheduled');
    expect(events[0].cycleStartMs).toBe(T0);
  });

  it('does not seed a baseline from a save-before-load (no noise)', () => {
    const log = makeLog();
    log.save([codexSnapshot({ resetsAt: iso(T0), usedPercent: 10 })]);
    log.save([codexSnapshot({ resetsAt: iso(T0), usedPercent: 40 })]);
    expect(existsSync(logPath)).toBe(false);
  });

  it('retries a failed append by keeping the old baseline', () => {
    const log = makeLog();
    log.load();
    log.save([codexSnapshot({ resetsAt: iso(T0), usedPercent: 10 })]);
    expect(readAllowanceBoundaryEvents(logPath)).toHaveLength(0);

    // Make the NEXT append fail by pointing the log at a path whose parent is
    // a regular file (mkdir fails), then restore it for the retry. The inner
    // save still ran — verified indirectly: the retry below sees the NEW state
    // vs the OLD baseline (if the baseline had advanced, no event would fire).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (log as any).logPath = join(tmpDir, 'file.jsonl', 'nested');
    writeFileSync(join(tmpDir, 'file.jsonl'), 'not a directory');
    log.save([codexSnapshot({ resetsAt: iso(T0 + 604_800_000), usedPercent: 3 })]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (log as any).logPath = logPath;
    log.save([codexSnapshot({ resetsAt: iso(T0 + 604_800_000), usedPercent: 4 })]);
    const events = readAllowanceBoundaryEvents(logPath);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('scheduled');
  });

  it('stops writing once the ledger exceeds its size cap', () => {
    const log = makeLog();
    log.load();
    writeFileSync(logPath, 'x'.repeat(1_100_000));
    log.save([codexSnapshot({ resetsAt: iso(T0 + 604_800_000), usedPercent: 3 })]);
    expect(readAllowanceBoundaryEvents(logPath)).toHaveLength(0); // oversized reads as empty
    expect(readFileSync(logPath, 'utf8').length).toBe(1_100_000); // untouched
  });

  it('drops the baseline for accounts that disappear from the save list', () => {
    const log = makeLog();
    log.load();
    log.save([codexSnapshot({ resetsAt: iso(T0), usedPercent: 10 })]);
    log.save([]); // account deleted
    // Re-added with a fresh window: first observation again — no event.
    log.save([codexSnapshot({ resetsAt: iso(T0 + 604_800_000), usedPercent: 3 })]);
    expect(existsSync(logPath)).toBe(false);
  });
});

describe('readAllowanceBoundaryEvents', () => {
  it('skips malformed lines and validates shape', () => {
    const good: AccountAllowanceBoundaryEvent = {
      version: 1,
      observedAt: iso(T0),
      providerId: 'codex',
      accountId: 'a',
      kind: 'scheduled',
      cycleStartMs: T0,
    };
    writeFileSync(
      logPath,
      `${JSON.stringify(good)}\n{"torn":\n${JSON.stringify({ ...good, cycleStartMs: 'nope' })}\n`,
      'utf8',
    );
    const events = readAllowanceBoundaryEvents(logPath);
    expect(events).toHaveLength(1);
    expect(events[0].cycleStartMs).toBe(T0);
  });

  it('reads a missing file as empty', () => {
    expect(readAllowanceBoundaryEvents(join(tmpDir, 'nope.jsonl'))).toEqual([]);
  });

  it('filters phantom sub-tolerance rows (pre-dead-band ledger self-heal), keeps genuine ones', () => {
    // Shape lifted from the live ledger: codex rows flipping 09:41:06↔09:41:07.
    const phantom = {
      version: 1,
      observedAt: iso(T0),
      providerId: 'codex',
      accountId: 'a',
      kind: 'unscheduled',
      cycleStartMs: T0,
      windowMinutes: WEEK_MIN,
      previousResetsAt: '2026-09-19T09:41:06.000Z',
      resetsAt: '2026-09-19T09:41:07.000Z',
      previousUsedPercent: 100,
      usedPercent: 100,
    };
    const scheduled = {
      ...phantom,
      kind: 'scheduled',
      previousResetsAt: iso(T0),
      resetsAt: iso(T0 + 604_800_000),
    };
    const genuineUnscheduled = {
      ...phantom,
      previousResetsAt: iso(T0),
      resetsAt: iso(T0 + 3 * 24 * 3_600_000),
    };
    const inPlace = {
      ...phantom,
      kind: 'in-place',
      previousResetsAt: undefined,
      resetsAt: iso(T0 + 604_800_000),
    };
    writeFileSync(
      logPath,
      [phantom, scheduled, genuineUnscheduled, inPlace].map((e) => JSON.stringify(e)).join('\n'),
      'utf8',
    );
    const events = readAllowanceBoundaryEvents(logPath);
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.kind)).toEqual(['scheduled', 'unscheduled', 'in-place']);
  });
});
