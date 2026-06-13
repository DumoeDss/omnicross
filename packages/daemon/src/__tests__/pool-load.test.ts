/**
 * pool-load.test.ts — `createPoolKeysLoader` (design D1/D5), `resolveEnvKey`
 * (design D6), and the in-memory `AutoDisableStore` (design D5).
 *
 * Asserts: multi-key normalization (weight/enabled/providerId/label/sortOrder
 * defaults), single-key 1-key fallback, empty/absent → []; `$ENV` resolution +
 * literal passthrough; and that an in-memory auto-disabled key has its `enabled`
 * flipped false by the loader (the disable takes effect in-process).
 */

import { describe, expect, it } from 'vitest';

import type { DaemonProviderConfig } from '../config';
import { AutoDisableStore } from '../pool/autoDisableStore';
import { createPoolKeysLoader } from '../pool/loadPoolKeys';
import { resolveEnvKey } from '../pool/resolveEnvKey';

function loaderFor(row: DaemonProviderConfig | undefined, store = new AutoDisableStore()) {
  return createPoolKeysLoader(() => row, store);
}

describe('resolveEnvKey', () => {
  it('resolves a $ENV reference to its value', () => {
    process.env.OMNI_TEST_KEY = 'sk-env-real';
    try {
      expect(resolveEnvKey('$OMNI_TEST_KEY')).toBe('sk-env-real');
    } finally {
      delete process.env.OMNI_TEST_KEY;
    }
  });

  it('returns "" for an unset $ENV reference', () => {
    delete process.env.OMNI_MISSING_KEY;
    expect(resolveEnvKey('$OMNI_MISSING_KEY')).toBe('');
  });

  it('passes a literal key through unchanged', () => {
    expect(resolveEnvKey('sk-lit')).toBe('sk-lit');
  });

  it('returns "" for empty input', () => {
    expect(resolveEnvKey('')).toBe('');
  });
});

describe('createPoolKeysLoader — multi-key normalization', () => {
  it('normalizes apiKeys with weight/enabled/providerId/label/sortOrder defaults', async () => {
    const load = loaderFor({
      id: 'oai',
      apiFormat: 'openai',
      baseUrl: 'https://x/v1',
      apiKey: '',
      apiKeys: [
        { id: 'k1', apiKey: 'sk-a', weight: 2 },
        { id: 'k2', apiKey: 'sk-b' },
      ],
    });
    const keys = await load('oai');
    expect(keys).toHaveLength(2);
    expect(keys[0]).toEqual({
      id: 'k1', providerId: 'oai', label: 'k1', apiKey: 'sk-a', enabled: true, weight: 2, sortOrder: 0,
    });
    expect(keys[1]).toEqual({
      id: 'k2', providerId: 'oai', label: 'k2', apiKey: 'sk-b', enabled: true, weight: 1, sortOrder: 1,
    });
  });

  it('honors an explicit enabled:false in the pool entry', async () => {
    const load = loaderFor({
      id: 'oai', apiFormat: 'openai', baseUrl: 'https://x/v1', apiKey: '',
      apiKeys: [{ id: 'k1', apiKey: 'sk-a', enabled: false }],
    });
    const keys = await load('oai');
    expect(keys[0].enabled).toBe(false);
  });
});

describe('createPoolKeysLoader — single-key fallback', () => {
  it('synthesizes a 1-key pool from the row apiKey', async () => {
    const load = loaderFor({ id: 'oai', apiFormat: 'openai', baseUrl: 'https://x/v1', apiKey: 'sk-x' });
    const keys = await load('oai');
    expect(keys).toHaveLength(1);
    expect(keys[0]).toEqual({
      id: 'oai:default', providerId: 'oai', label: 'oai:default', apiKey: 'sk-x', enabled: true, weight: 1, sortOrder: 0,
    });
  });

  it('returns [] when neither apiKeys nor apiKey is set', async () => {
    const load = loaderFor({ id: 'oai', apiFormat: 'openai', baseUrl: 'https://x/v1', apiKey: '' });
    expect(await load('oai')).toEqual([]);
  });

  it('returns [] for an unknown provider', async () => {
    const load = loaderFor(undefined);
    expect(await load('nope')).toEqual([]);
  });
});

describe('AutoDisableStore + loader (design D5)', () => {
  it('records an auth-failure in memory', () => {
    const store = new AutoDisableStore();
    store.markAutoDisabled('k1', 401, 1234);
    expect(store.isDisabled('k1')).toBe(true);
    expect(store.get('k1')).toEqual({ status: 401, at: 1234, reason: 'auth_failure' });
    expect(store.isDisabled('k2')).toBe(false);
  });

  it('flips an in-memory disabled key enabled:false at load time', async () => {
    const store = new AutoDisableStore();
    const load = loaderFor(
      {
        id: 'oai', apiFormat: 'openai', baseUrl: 'https://x/v1', apiKey: '',
        apiKeys: [{ id: 'k1', apiKey: 'sk-a' }, { id: 'k2', apiKey: 'sk-b' }],
      },
      store,
    );
    expect((await load('oai')).find((k) => k.id === 'k1')!.enabled).toBe(true);
    store.markAutoDisabled('k1', 401, Date.now());
    const after = await load('oai');
    expect(after.find((k) => k.id === 'k1')!.enabled).toBe(false);
    expect(after.find((k) => k.id === 'k2')!.enabled).toBe(true);
  });

  it('a fresh store (restart) restores enabled (honest v1 boundary)', async () => {
    const row: DaemonProviderConfig = {
      id: 'oai', apiFormat: 'openai', baseUrl: 'https://x/v1', apiKey: '',
      apiKeys: [{ id: 'k1', apiKey: 'sk-a' }],
    };
    const disabled = new AutoDisableStore();
    disabled.markAutoDisabled('k1', 401, Date.now());
    expect((await createPoolKeysLoader(() => row, disabled)('oai'))[0].enabled).toBe(false);
    // A new store == a process restart → the key is enabled again.
    expect((await createPoolKeysLoader(() => row, new AutoDisableStore())('oai'))[0].enabled).toBe(true);
  });
});
