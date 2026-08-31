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

  it('preserves frozen hosted-image metadata through lookup and TTL refresh', () => {
    let now = 100;
    const store = new ResponsesAffinityStore({ ttlMs: 10, now: () => now });
    store.record({
      ...scope,
      responseId: 'resp_image',
      credential: { kind: 'subscription-account', id: 'account-a' },
      hostedImage: {
        hasImageContext: true,
        pendingReceipts: [{
          upstreamCallId: 'call_selector_1',
          publicImageCallId: 'ig_1234567890abcdef',
        }],
      },
    });

    const first = store.lookup('resp_image', scope);
    expect(first.hostedImage).toEqual({
      hasImageContext: true,
      pendingReceipts: [{
        upstreamCallId: 'call_selector_1',
        publicImageCallId: 'ig_1234567890abcdef',
      }],
    });
    expect(Object.isFrozen(first.hostedImage)).toBe(true);
    expect(Object.isFrozen(first.hostedImage?.pendingReceipts)).toBe(true);
    expect(Object.isFrozen(first.hostedImage?.pendingReceipts[0])).toBe(true);

    now = 109;
    const refreshed = store.lookup('resp_image', scope);
    expect(refreshed.hostedImage).toEqual(first.hostedImage);
    expect(refreshed.expiresAt).toBe(119);
  });

  it('copies hosted-image metadata so caller mutation cannot alter stored affinity', () => {
    const receipt = {
      upstreamCallId: 'call_selector_1',
      publicImageCallId: 'ig_1234567890abcdef',
    };
    const pendingReceipts = [receipt];
    const hostedImage = { hasImageContext: true, pendingReceipts };
    const store = new ResponsesAffinityStore();

    store.record({
      ...scope,
      responseId: 'resp_image',
      credential: { kind: 'byo-key', id: 'key-a' },
      hostedImage,
    });
    receipt.upstreamCallId = 'call_mutated';
    pendingReceipts.push({
      upstreamCallId: 'call_added',
      publicImageCallId: 'ig_fedcba0987654321',
    });
    hostedImage.hasImageContext = false;

    expect(store.lookup('resp_image', scope).hostedImage).toEqual({
      hasImageContext: true,
      pendingReceipts: [{
        upstreamCallId: 'call_selector_1',
        publicImageCallId: 'ig_1234567890abcdef',
      }],
    });
  });

  it.each([
    ['wrong state shape', { hasImageContext: 'yes', pendingReceipts: [] }],
    ['unknown state field', { hasImageContext: false, pendingReceipts: [], token: 'secret-value' }],
    ['malformed upstream id', {
      hasImageContext: false,
      pendingReceipts: [{ upstreamCallId: 'secret-value', publicImageCallId: 'ig_1234567890abcdef' }],
    }],
    ['malformed public id', {
      hasImageContext: false,
      pendingReceipts: [{ upstreamCallId: 'call_selector_1', publicImageCallId: 'ig_short' }],
    }],
    ['oversized receipt list', {
      hasImageContext: false,
      pendingReceipts: Array.from({ length: 17 }, (_, index) => ({
        upstreamCallId: `call_selector_${index}`,
        publicImageCallId: `ig_${String(index).padStart(16, '0')}`,
      })),
    }],
  ])('rejects %s without retaining or disclosing malformed metadata', (_label, hostedImage) => {
    const store = new ResponsesAffinityStore();
    expect(() => store.record({
      ...scope,
      responseId: 'resp_invalid',
      credential: { kind: 'provider-key', id: 'provider-a' },
      hostedImage,
    } as never)).toThrow(expect.objectContaining({
      message: expect.not.stringContaining('secret-value'),
    }));
    expect(store.size).toBe(0);
  });

  it('keeps ordinary records source-compatible without hosted-image metadata', () => {
    const store = new ResponsesAffinityStore();
    store.record({
      ...scope,
      responseId: 'resp_text',
      credential: { kind: 'provider-key', id: 'provider-a' },
    });
    expect(store.lookup('resp_text', scope).hostedImage).toBeUndefined();
  });
});
