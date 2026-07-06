/**
 * SubscriptionIdentityStore — in-memory capture/freeze/replay + TTL refresh +
 * persistence port (subscription-client-fingerprint #7).
 */

import { describe, expect, it, vi } from 'vitest';

import {
  CC_HEADER_TTL_MS,
  type FrozenIdentity,
  type IdentityPersistencePort,
  SubscriptionIdentityStore,
} from '../SubscriptionIdentityStore';

describe('SubscriptionIdentityStore capture/freeze/replay', () => {
  it('freezes the first-seen identity and replays it verbatim', () => {
    const store = new SubscriptionIdentityStore({ enabled: true, now: () => 1000 });
    store.capture('claude', 'acc-1', { 'x-stainless-lang': 'js', 'user-agent': 'ua-1' });
    expect(store.replay('claude', 'acc-1')).toEqual({ 'x-stainless-lang': 'js', 'user-agent': 'ua-1' });
    expect(store.capturedAt('claude', 'acc-1')).toBe(1000);
  });

  it('a SECOND capture within the TTL does NOT overwrite (stable stainless)', () => {
    let now = 1000;
    const store = new SubscriptionIdentityStore({ enabled: true, now: () => now });
    store.capture('claude', 'acc-1', { 'x-stainless-lang': 'js', 'user-agent': 'ua-1' });
    now = 1000 + CC_HEADER_TTL_MS - 1;
    store.capture('claude', 'acc-1', { 'x-stainless-lang': 'python', 'user-agent': 'ua-2' });
    expect(store.replay('claude', 'acc-1')).toEqual({ 'x-stainless-lang': 'js', 'user-agent': 'ua-1' });
    expect(store.capturedAt('claude', 'acc-1')).toBe(1000);
  });

  it('past the TTL refreshes NON-stainless headers while stainless stays frozen', () => {
    let now = 1000;
    const store = new SubscriptionIdentityStore({ enabled: true, now: () => now });
    store.capture('claude', 'acc-1', {
      'x-stainless-lang': 'js',
      'x-stainless-os': 'MacOS',
      'user-agent': 'ua-old',
    });
    now = 1000 + CC_HEADER_TTL_MS + 1;
    store.capture('claude', 'acc-1', {
      'x-stainless-lang': 'python', // ignored — stainless frozen
      'user-agent': 'ua-new',
      'x-app': 'cli',
    });
    const replayed = store.replay('claude', 'acc-1');
    expect(replayed?.['x-stainless-lang']).toBe('js');
    expect(replayed?.['x-stainless-os']).toBe('MacOS');
    expect(replayed?.['user-agent']).toBe('ua-new');
    expect(replayed?.['x-app']).toBe('cli');
    expect(store.capturedAt('claude', 'acc-1')).toBe(now);
  });

  it('isolates distinct accounts and providers', () => {
    const store = new SubscriptionIdentityStore({ enabled: true });
    store.capture('claude', 'acc-A', { 'x-stainless-lang': 'A' });
    store.capture('claude', 'acc-B', { 'x-stainless-lang': 'B' });
    expect(store.replay('claude', 'acc-A')).toEqual({ 'x-stainless-lang': 'A' });
    expect(store.replay('claude', 'acc-B')).toEqual({ 'x-stainless-lang': 'B' });
    expect(store.replay('codex', 'acc-A')).toBeUndefined();
  });

  it('replays nothing for an uncaptured account', () => {
    const store = new SubscriptionIdentityStore({ enabled: true });
    expect(store.replay('claude', 'nope')).toBeUndefined();
    expect(store.hasIdentity('claude', 'nope')).toBe(false);
  });

  it('never captures/replays an authorization/x-api-key/cookie value (secret guard)', () => {
    const store = new SubscriptionIdentityStore({ enabled: true });
    store.capture('claude', 'acc-1', {
      'x-stainless-lang': 'js',
      authorization: 'Bearer sk-ant-SECRET',
      'x-api-key': 'sk-SECRET',
      cookie: 'session=SECRET',
    } as Record<string, string>);
    const replayed = store.replay('claude', 'acc-1') ?? {};
    expect(replayed['authorization']).toBeUndefined();
    expect(replayed['x-api-key']).toBeUndefined();
    expect(replayed['cookie']).toBeUndefined();
    expect(JSON.stringify(replayed).toLowerCase()).not.toContain('secret');
  });

  it('an empty (all-excluded) capture freezes nothing', () => {
    const store = new SubscriptionIdentityStore({ enabled: true });
    store.capture('claude', 'acc-1', { authorization: 'Bearer x' } as Record<string, string>);
    expect(store.replay('claude', 'acc-1')).toBeUndefined();
  });
});

describe('SubscriptionIdentityStore config + UA baseline', () => {
  it('configure toggles enabled and clears the UA baseline with null', () => {
    const store = new SubscriptionIdentityStore();
    expect(store.isEnabled()).toBe(false);
    store.configure({ enabled: true, ua: '  ua-x  ' });
    expect(store.isEnabled()).toBe(true);
    expect(store.uaBaseline()).toBe('ua-x');
    store.configure({ ua: null });
    expect(store.uaBaseline()).toBeUndefined();
    expect(store.isEnabled()).toBe(true); // enabled untouched
  });
});

describe('SubscriptionIdentityStore persistence + seed (P2)', () => {
  it('writes through the persistence port on a first-seen freeze', () => {
    const persisted: FrozenIdentity[] = [];
    const port: IdentityPersistencePort = {
      persist: (_p, _a, identity) => persisted.push(identity),
    };
    const store = new SubscriptionIdentityStore({ enabled: true, now: () => 42 });
    store.setPersistence(port);
    store.capture('claude', 'acc-1', { 'x-stainless-lang': 'js' });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toEqual({ headers: { 'x-stainless-lang': 'js' }, capturedAt: 42 });
  });

  it('a throwing persistence port never breaks capture (best-effort)', () => {
    const store = new SubscriptionIdentityStore({ enabled: true });
    store.setPersistence({
      persist: () => {
        throw new Error('disk full');
      },
    });
    expect(() => store.capture('claude', 'acc-1', { 'x-stainless-lang': 'js' })).not.toThrow();
    expect(store.replay('claude', 'acc-1')).toEqual({ 'x-stainless-lang': 'js' });
  });

  it('seed installs a persisted identity (survives restart) without a write-back', () => {
    const port = { persist: vi.fn() };
    const store = new SubscriptionIdentityStore({ enabled: true });
    store.setPersistence(port);
    store.seed('claude', 'acc-1', { headers: { 'x-stainless-lang': 'seeded' }, capturedAt: 5 });
    expect(store.replay('claude', 'acc-1')).toEqual({ 'x-stainless-lang': 'seeded' });
    expect(port.persist).not.toHaveBeenCalled();
  });

  it('seed never overwrites a live in-memory capture', () => {
    const store = new SubscriptionIdentityStore({ enabled: true, now: () => 100 });
    store.capture('claude', 'acc-1', { 'x-stainless-lang': 'live' });
    store.seed('claude', 'acc-1', { headers: { 'x-stainless-lang': 'stale' }, capturedAt: 1 });
    expect(store.replay('claude', 'acc-1')).toEqual({ 'x-stainless-lang': 'live' });
  });

  it('seed sanitizes (a persisted bag can never re-introduce a secret)', () => {
    const store = new SubscriptionIdentityStore({ enabled: true });
    store.seed('claude', 'acc-1', {
      headers: { 'x-stainless-lang': 'js', authorization: 'Bearer sk' } as Record<string, string>,
      capturedAt: 1,
    });
    expect(store.replay('claude', 'acc-1')).toEqual({ 'x-stainless-lang': 'js' });
  });
});
