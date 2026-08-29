import { describe, expect, it } from 'vitest';

import { ResponsesAffinityStore } from '../responsesAffinity';

const scope = { providerId: 'provider-a', clientScope: 'key:client-a', sessionKey: 'session-a' };

describe('ResponsesAffinityStore', () => {
  it('records successful response ids and refreshes a sliding TTL', () => {
    let now = 100;
    const store = new ResponsesAffinityStore({ ttlMs: 10, now: () => now });
    store.record({ ...scope, responseId: 'resp_1', credential: { kind: 'subscription-account', id: 'account-a' } });
    now = 109;
    expect(store.lookup('resp_1', scope).credential).toEqual({ kind: 'subscription-account', id: 'account-a' });
    now = 118;
    expect(store.lookup('resp_1', scope).responseId).toBe('resp_1');
  });

  it('expires and evicts least-recently-used entries within its bound', () => {
    let now = 0;
    const store = new ResponsesAffinityStore({ maxEntries: 2, ttlMs: 10, now: () => now });
    for (const id of ['resp_1', 'resp_2']) {
      store.record({ ...scope, responseId: id, credential: { kind: 'byo-key', id: `key-${id}` } });
    }
    store.lookup('resp_1', scope);
    store.record({ ...scope, responseId: 'resp_3', credential: { kind: 'byo-key', id: 'key-3' } });
    expect(() => store.lookup('resp_2', scope)).toThrow(expect.objectContaining({ code: 'previous_response_not_found' }));
    expect(store.lookup('resp_1', scope).responseId).toBe('resp_1');
    now = 11;
    expect(() => store.lookup('resp_1', scope)).toThrow(expect.objectContaining({ code: 'previous_response_not_found' }));
    expect(store.size).toBe(0);
  });

  it.each([
    ['provider', { ...scope, providerId: 'provider-b' }],
    ['client', { ...scope, clientScope: 'key:client-b' }],
    ['session', { ...scope, sessionKey: 'session-b' }],
  ])('returns the same non-leaking error for cross-%s lookups', (_label, otherScope) => {
    const store = new ResponsesAffinityStore();
    store.record({ ...scope, responseId: 'resp_secret', credential: { kind: 'provider-key', id: 'provider-row' } });
    for (const id of ['resp_missing', 'resp_secret']) {
      const lookupScope = id === 'resp_missing' ? scope : otherScope;
      expect(() => store.lookup(id, lookupScope)).toThrow(expect.objectContaining({
        status: 404,
        code: 'previous_response_not_found',
        retryable: false,
        message: expect.not.stringContaining('resp_secret'),
      }));
    }
  });
});
