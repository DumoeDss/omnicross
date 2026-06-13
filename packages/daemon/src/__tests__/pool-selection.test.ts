/**
 * pool-selection.test.ts — drives the REAL core `ApiKeyPoolService` with the
 * daemon's loader + resolver to prove selection semantics (design D1/D2),
 * mirroring core's poolFailover style.
 *
 * Covers: weighted round-robin across multiple keys, session affinity (a bound
 * session re-uses its key), the daemon's null-session path does NOT throw, and
 * 429 cooldown failover re-binds to a second key (a UNIT-level proof — note the
 * daemon's OUTBOUND path resolves with sessionId=null so this failover does NOT
 * fire end-to-end there; design D2).
 */

import { ApiKeyPoolService } from '@omnicross/core/completion/ApiKeyPoolService';
import { afterEach, describe, expect, it } from 'vitest';

import type { DaemonProviderConfig } from '../config';
import { AutoDisableStore } from '../pool/autoDisableStore';
import { createPoolKeysLoader } from '../pool/loadPoolKeys';
import { resolveEnvKey } from '../pool/resolveEnvKey';
import { ConsoleLogger } from '../ports/ConsoleLogger';

let pool: ApiKeyPoolService | undefined;

afterEach(() => {
  pool?.dispose();
  pool = undefined;
});

function buildPool(row: DaemonProviderConfig, store = new AutoDisableStore()): ApiKeyPoolService {
  const p = new ApiKeyPoolService(
    createPoolKeysLoader(() => row, store),
    resolveEnvKey,
    new ConsoleLogger(),
    async () => true,
    async (keyId, status, at) => store.markAutoDisabled(keyId, status, at),
  );
  pool = p;
  return p;
}

const TWO_KEY_ROW: DaemonProviderConfig = {
  id: 'oai',
  apiFormat: 'openai',
  baseUrl: 'https://x/v1',
  apiKey: '',
  apiKeys: [
    { id: 'k1', apiKey: 'sk-a', weight: 1 },
    { id: 'k2', apiKey: 'sk-b', weight: 1 },
  ],
};

describe('pool selection', () => {
  it('weighted round-robin spreads across both keys over many one-shot picks', async () => {
    const p = buildPool(TWO_KEY_ROW);
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) seen.add(await p.getKey('oai'));
    expect(seen.has('sk-a')).toBe(true);
    expect(seen.has('sk-b')).toBe(true);
  });

  it('honors session affinity (same session → same key)', async () => {
    const p = buildPool(TWO_KEY_ROW);
    const first = await p.getKeyForSession('oai', 'sess-1');
    for (let i = 0; i < 5; i++) {
      expect(await p.getKeyForSession('oai', 'sess-1')).toBe(first);
    }
  });

  it('single-key fallback returns that key for any session', async () => {
    const p = buildPool({ id: 'oai', apiFormat: 'openai', baseUrl: 'https://x/v1', apiKey: 'sk-x' });
    expect(await p.getKey('oai')).toBe('sk-x');
    expect(await p.getKeyForSession('oai', 'sess-z')).toBe('sk-x');
  });

  it('resolves a $ENV pool key to the real env value through the pool', async () => {
    process.env.OMNI_POOL_KEY = 'sk-pool-env';
    try {
      const p = buildPool({
        id: 'oai', apiFormat: 'openai', baseUrl: 'https://x/v1', apiKey: '',
        apiKeys: [{ id: 'k1', apiKey: '$OMNI_POOL_KEY' }],
      });
      expect(await p.getKey('oai')).toBe('sk-pool-env');
    } finally {
      delete process.env.OMNI_POOL_KEY;
    }
  });

  it('does not throw on the daemon null-session pattern (empty/no-binding reportError)', async () => {
    const p = buildPool(TWO_KEY_ROW);
    // reportError on a session that was never bound returns null (no failover);
    // this mirrors the daemon's null-session outbound path (design D2).
    await expect(p.reportError('oai', 'never-bound', 429)).resolves.toBeNull();
  });
});

describe('429 cooldown failover (pool unit-level proof; design D2 outbound caveat)', () => {
  it('re-binds the session to the OTHER key and cools the first', async () => {
    const p = buildPool(TWO_KEY_ROW);
    const first = await p.getKeyForSession('oai', 'sess-cd');
    const rebound = await p.reportError('oai', 'sess-cd', 429);
    expect(rebound).toBeTruthy();
    expect(rebound).not.toBe(first); // failover picked the other key
    // The cooling key shows up in the health map until its cooldown expires.
    const health = await p.getKeyHealth('oai');
    expect(Object.keys(health).length).toBe(1);
    const [cooledId] = Object.keys(health);
    expect(health[cooledId].lastStatus).toBe(429);
    expect(health[cooledId].until).toBeGreaterThan(Date.now());
  });

  it('401 auth-failure marks the in-memory store (no disk write here)', async () => {
    const store = new AutoDisableStore();
    const p = buildPool(TWO_KEY_ROW, store);
    await p.getKeyForSession('oai', 'sess-auth');
    await p.reportError('oai', 'sess-auth', 401);
    // The bound key was auto-disabled into the in-memory store.
    expect(store.isDisabled('k1') || store.isDisabled('k2')).toBe(true);
  });
});
