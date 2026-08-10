import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_ROUTE_ACTIVITY_LIMIT,
  AccountRouteActivityStore,
} from '../AccountRouteActivity';

function input(accountId: string, sessionKey?: string, ts = 1_000) {
  return {
    providerId: 'codex',
    accountId,
    endpoint: 'responses' as const,
    sessionKey,
    sessionSource: sessionKey ? 'session-header' as const : 'none' as const,
    model: 'gpt-5-codex',
    status: 200,
    durationMs: 12,
    ts,
  };
}

describe('AccountRouteActivityStore', () => {
  it('classifies new, sticky, switched and untracked attempts', () => {
    const store = new AccountRouteActivityStore();
    expect(store.record(input('account-a', 'session-a')).affinity).toBe('new');
    expect(store.record(input('account-a', 'session-a', 2_000)).affinity).toBe('sticky');
    expect(store.record(input('account-b', 'session-a', 3_000))).toMatchObject({
      affinity: 'switched',
      previousAccountId: 'account-a',
    });
    expect(store.record(input('account-b', undefined, 4_000)).affinity).toBe('untracked');
  });

  it('is bounded, newest-first, filterable and copy-safe', () => {
    const store = new AccountRouteActivityStore();
    for (let index = 0; index < ACCOUNT_ROUTE_ACTIVITY_LIMIT + 5; index += 1) {
      store.record(input(index % 2 ? 'account-a' : 'account-b', `session-${index}`, index));
    }
    const all = store.list({ limit: ACCOUNT_ROUTE_ACTIVITY_LIMIT });
    expect(all).toHaveLength(ACCOUNT_ROUTE_ACTIVITY_LIMIT);
    expect(all[0]?.ts).toBe(ACCOUNT_ROUTE_ACTIVITY_LIMIT + 4);
    expect(store.list({ accountId: 'account-a', limit: 7 })).toHaveLength(7);
    all[0]!.accountId = 'mutated';
    expect(store.list({ limit: 1 })[0]?.accountId).not.toBe('mutated');
  });

  it('amend backfills a post-hoc field on an existing record (copy-safe, no-op on unknown id)', () => {
    const store = new AccountRouteActivityStore();
    const recorded = store.record(input('account-a', 'session-a'));
    expect(recorded.streamError).toBeUndefined();

    store.amend(recorded.id, { streamError: 'server_overloaded' });

    const listed = store.list({ limit: 1 });
    expect(listed[0]?.streamError).toBe('server_overloaded');

    // Copy-safety: mutating a listed copy does not affect the stored record.
    listed[0]!.streamError = 'tampered';
    expect(store.list({ limit: 1 })[0]?.streamError).toBe('server_overloaded');

    // Unknown id (aged out of the ring) is a silent no-op.
    store.amend('does-not-exist', { streamError: 'server_overloaded' });
    expect(store.list()).toHaveLength(1);
  });
});
