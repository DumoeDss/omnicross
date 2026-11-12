/**
 * ProviderKeyQuotaLearningStore tests — merge semantics (same-length windows
 * replace, diagnostics ride along), per-window reset expiry, observed-at TTL,
 * and the cap/prune defenses.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PROVIDER_KEY_QUOTA_LEARNING_TTL_MS,
  ProviderKeyQuotaLearningStore,
} from '../ProviderKeyQuotaLearningStore';

const T0 = Date.parse('2026-11-12T10:00:00.000Z');
const RESET_5H = T0 + 2 * 60 * 60_000;
const RESET_7D = T0 + 3 * 24 * 60 * 60_000;

let store: ProviderKeyQuotaLearningStore;
let now: number;

beforeEach(() => {
  now = T0;
  store = new ProviderKeyQuotaLearningStore(() => now);
});

afterEach(() => {
  store.clear();
});

describe('record + lookup', () => {
  it('stores a learned window and projects remaining seconds as a future stamp', () => {
    store.record('row-1', 'key-a', {
      windows: [{ windowMinutes: 300, resetsAtMs: RESET_5H, usedPercent: 100 }],
    });
    expect(store.lookup('row-1', 'key-a', now)).toEqual({
      rowId: 'row-1',
      keyId: 'key-a',
      windows: [{ windowMinutes: 300, resetsAtMs: RESET_5H, usedPercent: 100 }],
      observedAt: new Date(T0).toISOString(),
    });
  });

  it('replaces the same-length window and keeps others', () => {
    store.record('row-1', 'key-a', {
      windows: [{ windowMinutes: 300, resetsAtMs: RESET_5H, usedPercent: 100 }],
    });
    store.record('row-1', 'key-a', {
      windows: [{ windowMinutes: 10_080, resetsAtMs: RESET_7D, usedPercent: 100 }],
    });
    const entry = store.lookup('row-1', 'key-a', now);
    expect(entry?.windows.map((w) => w.windowMinutes)).toEqual([300, 10_080]);

    now += 60_000;
    store.record('row-1', 'key-a', {
      windows: [{ windowMinutes: 300, resetsAtMs: now + 30 * 60_000, usedPercent: 100 }],
    });
    const refreshed = store.lookup('row-1', 'key-a', now);
    expect(refreshed?.windows.find((w) => w.windowMinutes === 300)?.resetsAtMs).toBe(now + 30 * 60_000);
    expect(refreshed?.windows.find((w) => w.windowMinutes === 10_080)).toBeDefined();
  });

  it('keeps the latest diagnostic and rides it next to windows', () => {
    store.record('row-1', 'key-a', { windows: [], diagnostic: 'zai_plan_expired' });
    expect(store.lookup('row-1', 'key-a', now)?.diagnostic).toBe('zai_plan_expired');

    // A later window observation does not erase the diagnostic.
    store.record('row-1', 'key-a', {
      windows: [{ windowMinutes: 300, resetsAtMs: RESET_5H, usedPercent: 100 }],
    });
    expect(store.lookup('row-1', 'key-a', now)).toMatchObject({
      diagnostic: 'zai_plan_expired',
      windows: [{ windowMinutes: 300 }],
    });
  });

  it('keys by row AND key — neighbor keys never see each other', () => {
    store.record('row-1', 'key-a', {
      windows: [{ windowMinutes: 300, resetsAtMs: RESET_5H, usedPercent: 100 }],
    });
    expect(store.lookup('row-1', 'key-b', now)).toBeNull();
    expect(store.lookup('row-2', 'key-a', now)).toBeNull();
  });

  it('ignores empty observations and blank ids', () => {
    store.record('row-1', 'key-a', { windows: [] });
    expect(store.lookup('row-1', 'key-a', now)).toBeNull();
    store.record('', 'key-a', { windows: [{ windowMinutes: 300, resetsAtMs: RESET_5H, usedPercent: 100 }] });
    store.record('row-1', '', { windows: [{ windowMinutes: 300, resetsAtMs: RESET_5H, usedPercent: 100 }] });
    expect(store.lookup('', 'key-a', now)).toBeNull();
    expect(store.lookup('row-1', '', now)).toBeNull();
  });
});

describe('expiry', () => {
  it('drops windows whose reset passed, but keeps a live diagnostic entry', () => {
    store.record('row-1', 'key-a', { windows: [], diagnostic: 'zai_insufficient_balance' });
    now += PROVIDER_KEY_QUOTA_LEARNING_TTL_MS / 2;
    expect(store.lookup('row-1', 'key-a', now)?.diagnostic).toBe('zai_insufficient_balance');
    now += PROVIDER_KEY_QUOTA_LEARNING_TTL_MS;
    expect(store.lookup('row-1', 'key-a', now)).toBeNull();
  });

  it('expires a window once its own reset instant passed', () => {
    store.record('row-1', 'key-a', {
      windows: [{ windowMinutes: 300, resetsAtMs: RESET_5H, usedPercent: 100 }],
    });
    now = RESET_5H + 1_000;
    expect(store.lookup('row-1', 'key-a', now)).toBeNull();
  });

  it('prunes stale entries wholesale on the next record', () => {
    store.record('row-1', 'key-a', {
      windows: [{ windowMinutes: 300, resetsAtMs: RESET_5H, usedPercent: 100 }],
    });
    now += PROVIDER_KEY_QUOTA_LEARNING_TTL_MS + 60_000;
    store.record('row-1', 'key-b', {
      windows: [{ windowMinutes: 300, resetsAtMs: now + 60_000, usedPercent: 100 }],
    });
    expect(store.lookup('row-1', 'key-a', now)).toBeNull();
    expect(store.lookup('row-1', 'key-b', now)).toBeDefined();
  });
});
