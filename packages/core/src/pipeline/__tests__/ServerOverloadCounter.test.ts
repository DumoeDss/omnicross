import { describe, expect, it } from 'vitest';

import {
  OVERLOAD_ENTRY_TTL_MS,
  OVERLOAD_RECENT_LIMIT,
  ServerOverloadCounterStore,
} from '../ServerOverloadCounter';

describe('ServerOverloadCounterStore', () => {
  it('counts per key, prepends recent most-recent-first, and returns copies', () => {
    const store = new ServerOverloadCounterStore();
    const first = store.recordOverload(
      { providerId: 'codex', accountId: 'A', endpoint: 'responses' },
      1_000,
    );
    expect(first).toMatchObject({ count: 1, firstTs: 1_000, lastTs: 1_000 });
    expect(first.recent).toEqual([1_000]);

    const second = store.recordOverload(
      { providerId: 'codex', accountId: 'A', endpoint: 'responses' },
      2_000,
    );
    expect(second).toMatchObject({ count: 2, firstTs: 1_000, lastTs: 2_000 });
    expect(second.recent).toEqual([2_000, 1_000]);

    // Copy-safety: the returned recent array is a copy. `now` within the TTL of
    // the recorded events so they are not pruned on read.
    second.recent.push(999);
    expect(store.list({}, 2_000)[0]?.recent).toEqual([2_000, 1_000]);
  });

  it('keeps separate keys per provider/account/endpoint', () => {
    const store = new ServerOverloadCounterStore();
    store.recordOverload({ providerId: 'codex', accountId: 'A', endpoint: 'responses' }, 1_000);
    store.recordOverload({ providerId: 'codex', accountId: 'B', endpoint: 'responses' }, 2_000);
    store.recordOverload({ providerId: 'claude', accountId: 'C', endpoint: 'messages' }, 3_000);
    expect(store.list({}, 3_000).map((e) => e.accountId).sort()).toEqual(['A', 'B', 'C']);
  });

  it('caps the recent ring at OVERLOAD_RECENT_LIMIT while keeping the lifetime count', () => {
    const store = new ServerOverloadCounterStore();
    for (let i = 0; i < OVERLOAD_RECENT_LIMIT + 5; i += 1) {
      store.recordOverload({ providerId: 'codex', accountId: 'A', endpoint: 'responses' }, i);
    }
    const entry = store.list({}, OVERLOAD_RECENT_LIMIT + 4)[0]!;
    expect(entry.count).toBe(OVERLOAD_RECENT_LIMIT + 5);
    expect(entry.recent).toHaveLength(OVERLOAD_RECENT_LIMIT);
    expect(entry.recent[0]).toBe(OVERLOAD_RECENT_LIMIT + 4); // newest first
  });

  it('list filters by provider/account and prunes stale entries on read', () => {
    const store = new ServerOverloadCounterStore();
    store.recordOverload({ providerId: 'codex', accountId: 'A', endpoint: 'responses' }, 1_000);
    store.recordOverload({ providerId: 'codex', accountId: 'B', endpoint: 'responses' }, 2_000);
    store.recordOverload({ providerId: 'claude', accountId: 'C', endpoint: 'messages' }, 3_000);

    expect(store.list({ providerId: 'codex' }, 3_000).map((e) => e.accountId).sort()).toEqual(['A', 'B']);
    expect(store.list({ providerId: 'codex', accountId: 'A' }, 3_000)).toHaveLength(1);

    // An entry older than the TTL is pruned and absent from the result.
    expect(store.list({}, 3_000 + OVERLOAD_ENTRY_TTL_MS + 1)).toEqual([]);
  });

  it('clear resets all entries', () => {
    const store = new ServerOverloadCounterStore();
    store.recordOverload({ providerId: 'codex', accountId: 'A', endpoint: 'responses' }, 1_000);
    store.clear();
    expect(store.list({}, 1_000)).toEqual([]);
  });
});
