/**
 * SubscriptionAccountSelector tests (subscription-account-scheduling, task 2.6) —
 * the pure ordering (priority → LRU → createdAt), the ≤1-schedulable null signal,
 * session affinity (hit/miss/expiry), in-process round-robin, and the
 * `schedulable=false` skip.
 */

import { describe, expect, it } from 'vitest';

import {
  type SchedulableAccount,
  SESSION_AFFINITY_TTL_MS,
  SubscriptionAccountSelector,
} from '../scheduler/SubscriptionAccountSelector';

const T0 = 1_000_000;

function acc(id: string, over: Partial<SchedulableAccount> = {}): SchedulableAccount {
  return { id, ...over };
}

describe('SubscriptionAccountSelector — ordering', () => {
  it('lower priority number wins', () => {
    const s = new SubscriptionAccountSelector();
    const result = s.select({
      providerId: 'claude',
      accounts: [acc('B', { priority: 50 }), acc('A', { priority: 10 })],
      now: T0,
    });
    expect(result?.accountId).toBe('A');
  });

  it('LRU tie-break at equal priority (older lastUsedAt wins)', () => {
    const s = new SubscriptionAccountSelector();
    const result = s.select({
      providerId: 'claude',
      accounts: [
        acc('B', { priority: 50, lastUsedAt: '2026-01-02T00:00:00.000Z' }),
        acc('A', { priority: 50, lastUsedAt: '2026-01-01T00:00:00.000Z' }),
      ],
      now: T0,
    });
    expect(result?.accountId).toBe('A');
  });

  it('createdAt is the final tie-break (older wins)', () => {
    const s = new SubscriptionAccountSelector();
    const result = s.select({
      providerId: 'claude',
      accounts: [
        acc('B', { createdAt: '2026-01-02T00:00:00.000Z' }),
        acc('A', { createdAt: '2026-01-01T00:00:00.000Z' }),
      ],
      now: T0,
    });
    expect(result?.accountId).toBe('A');
  });

  it('missing priority defaults to 50', () => {
    const s = new SubscriptionAccountSelector();
    const result = s.select({
      providerId: 'claude',
      accounts: [acc('A'), acc('B', { priority: 60 })],
      now: T0,
    });
    expect(result?.accountId).toBe('A');
  });

  it('isActive is set when the chosen account is the active one', () => {
    const s = new SubscriptionAccountSelector();
    const result = s.select({
      providerId: 'claude',
      accounts: [acc('A', { priority: 10 }), acc('B', { priority: 50 })],
      activeAccountId: 'A',
      now: T0,
    });
    expect(result).toEqual({ accountId: 'A', isActive: true });
  });
});

describe('SubscriptionAccountSelector — zero-regression null signal', () => {
  it('returns null for a single schedulable account', () => {
    const s = new SubscriptionAccountSelector();
    expect(s.select({ providerId: 'claude', accounts: [acc('A')], now: T0 })).toBeNull();
  });

  it('returns null for zero accounts', () => {
    const s = new SubscriptionAccountSelector();
    expect(s.select({ providerId: 'claude', accounts: [], now: T0 })).toBeNull();
  });

  it('returns null when only one account is schedulable (rest health-blocked)', () => {
    const s = new SubscriptionAccountSelector();
    const result = s.select({
      providerId: 'claude',
      accounts: [acc('A'), acc('B', { schedulable: false }), acc('C', { schedulable: false })],
      now: T0,
    });
    expect(result).toBeNull();
  });
});

describe('SubscriptionAccountSelector — schedulable filter', () => {
  it('skips schedulable=false accounts even at better priority', () => {
    const s = new SubscriptionAccountSelector();
    const result = s.select({
      providerId: 'claude',
      accounts: [acc('A', { priority: 1, schedulable: false }), acc('B', { priority: 50 }), acc('C', { priority: 60 })],
      now: T0,
    });
    expect(result?.accountId).toBe('B');
  });
});

describe('SubscriptionAccountSelector — in-process round-robin', () => {
  it('rotates within a process at equal priority (no session key)', () => {
    const s = new SubscriptionAccountSelector();
    const accounts = [acc('A'), acc('B')];
    const first = s.select({ providerId: 'claude', accounts, now: T0 });
    const second = s.select({ providerId: 'claude', accounts, now: T0 });
    expect(first?.accountId).toBe('A');
    expect(second?.accountId).toBe('B'); // A now most-recently-used → B chosen
  });

  it('scopes the overlay by provider (independent rotation)', () => {
    const s = new SubscriptionAccountSelector();
    const accounts = [acc('A'), acc('B')];
    expect(s.select({ providerId: 'claude', accounts, now: T0 })?.accountId).toBe('A');
    // A different provider's overlay is untouched → also starts at A.
    expect(s.select({ providerId: 'codex', accounts, now: T0 })?.accountId).toBe('A');
  });
});

describe('SubscriptionAccountSelector — session affinity', () => {
  it('sticky reuse within TTL', () => {
    const s = new SubscriptionAccountSelector();
    const accounts = [acc('A'), acc('B')];
    const first = s.select({ providerId: 'claude', accounts, sessionKey: 'sess-1', now: T0 });
    const second = s.select({ providerId: 'claude', accounts, sessionKey: 'sess-1', now: T0 + 1000 });
    expect(second?.accountId).toBe(first?.accountId);
  });

  it('no session key does not record affinity (pure LRU rotation)', () => {
    const s = new SubscriptionAccountSelector();
    const accounts = [acc('A'), acc('B')];
    const a = s.select({ providerId: 'claude', accounts, now: T0 });
    const b = s.select({ providerId: 'claude', accounts, now: T0 });
    expect(a?.accountId).not.toBe(b?.accountId);
  });

  it('expired affinity re-selects a fresh account', () => {
    const s = new SubscriptionAccountSelector();
    const accounts = [acc('A'), acc('B')];
    const first = s.select({ providerId: 'claude', accounts, sessionKey: 'sess-1', now: T0 });
    // After the TTL, the mapping is stale → re-selection (which, by LRU, is the
    // OTHER account since `first` is most-recently-used).
    const later = s.select({
      providerId: 'claude',
      accounts,
      sessionKey: 'sess-1',
      now: T0 + SESSION_AFFINITY_TTL_MS + 1,
    });
    expect(later?.accountId).not.toBe(first?.accountId);
  });

  it('unschedulable sticky account re-selects', () => {
    const s = new SubscriptionAccountSelector();
    const first = s.select({
      providerId: 'claude',
      accounts: [acc('A'), acc('B')],
      sessionKey: 'sess-1',
      now: T0,
    });
    const stuck = first!.accountId;
    const other = stuck === 'A' ? 'B' : 'A';
    // The stuck account goes unschedulable + a third healthy account joins so the
    // pool still has ≥2 schedulable → the selector re-picks a schedulable one.
    const next = s.select({
      providerId: 'claude',
      accounts: [acc(stuck, { schedulable: false }), acc(other), acc('C')],
      sessionKey: 'sess-1',
      now: T0 + 1000,
    });
    expect(next?.accountId).not.toBe(stuck);
  });
});

describe('SubscriptionAccountSelector — duePersist throttle', () => {
  it('is due first, throttled within the window, due again after it', () => {
    const s = new SubscriptionAccountSelector();
    expect(s.duePersist('claude', 'A', T0)).toBe(true);
    expect(s.duePersist('claude', 'A', T0 + 1000)).toBe(false);
    expect(s.duePersist('claude', 'A', T0 + 60_001)).toBe(true);
  });
});
