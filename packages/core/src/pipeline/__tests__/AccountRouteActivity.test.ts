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

/** A BYO provider-key row — same store, credential identified by pool key id. */
function keyInput(keyId: string | undefined, sessionKey?: string, ts = 1_000) {
  return {
    providerId: 'deepseek',
    credentialKind: 'provider-key' as const,
    keyId,
    endpoint: 'chat' as const,
    sessionKey,
    sessionSource: sessionKey ? 'route-session-id' as const : 'none' as const,
    model: 'deepseek-v3',
    status: 200,
    durationMs: 34,
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

  it('defaults absent credentialKind to subscription-account (back-compat)', () => {
    const store = new AccountRouteActivityStore();
    const legacy = store.record(input('account-a', 'session-a'));
    expect(legacy.credentialKind).toBe('subscription-account');
  });

  it('tracks provider-key rows and key rotation within one session', () => {
    const store = new AccountRouteActivityStore();
    expect(store.record(keyInput('key-1', 'session-k')).affinity).toBe('new');
    expect(store.record(keyInput('key-1', 'session-k', 2_000))).toMatchObject({
      affinity: 'sticky',
      credentialKind: 'provider-key',
    });
    // Pool rotated the session to another key — switched, with the PREVIOUS key id.
    expect(store.record(keyInput('key-2', 'session-k', 3_000))).toMatchObject({
      affinity: 'switched',
      previousKeyId: 'key-1',
    });
    // No session key ⇒ no affinity tracking, exactly like account rows.
    expect(store.record(keyInput('key-2', undefined, 4_000)).affinity).toBe('untracked');
  });

  it('treats keyless provider-key rows as one identity (static row key ⇒ sticky)', () => {
    const store = new AccountRouteActivityStore();
    store.record(keyInput(undefined, 'session-s'));
    const again = store.record(keyInput(undefined, 'session-s', 2_000));
    expect(again.affinity).toBe('sticky');
    expect(again.keyId).toBeUndefined();
  });

  it('filters by credentialKind without breaking the legacy queries', () => {
    const store = new AccountRouteActivityStore();
    store.record(input('account-a', 'session-a'));
    store.record(keyInput('key-1', 'session-k', 2_000));
    expect(store.list()).toHaveLength(2);
    expect(store.list({ credentialKind: 'subscription-account' })).toHaveLength(1);
    expect(store.list({ credentialKind: 'provider-key' })).toHaveLength(1);
    expect(store.list({ credentialKind: 'provider-key' })[0]).toMatchObject({
      providerId: 'deepseek',
      keyId: 'key-1',
      endpoint: 'chat',
    });
    // A missing credentialKind on a stored row still matches the account filter.
    expect(store.list({ credentialKind: 'subscription-account' })[0]).toMatchObject({
      accountId: 'account-a',
    });
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
