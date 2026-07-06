/**
 * account-pool-by-id.test.ts — the daemon `JsonSubscriptionCredentialStore`
 * by-id account-pool surface (subscription-account-scheduling, task 3.5):
 *  - `getAccessTokenForAccount` reads a specific account's token by id, incl. the
 *    codex/gemini near-expiry refresh; opencodego returns the static key,
 *  - `refreshAccountToken` refreshes by id (opencodego → false),
 *  - `touchAccountLastUsed` persists `lastUsedAt` on the entry (mirror untouched),
 *  - `setAccountPriority` persists `priority` and the sanitized view reflects it.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ClaudeTokenConfig,
  GeminiTokenConfig,
} from '@omnicross/contracts/account-tokens-types';
import type { OpenCodeGoTokenConfig } from '@omnicross/contracts/subscription-types';
import type { FetchLike } from '@omnicross/subscriptions';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JsonSubscriptionCredentialStore } from '../ports/JsonSubscriptionCredentialStore';
import { resolveMasterKey, SecretBox } from '../secrets';

let tmpDir: string;
let tokensPath: string;
let keyFile: string;

function makeStore(fetchImpl?: FetchLike): JsonSubscriptionCredentialStore {
  return new JsonSubscriptionCredentialStore(
    tokensPath,
    new SecretBox(resolveMasterKey({ keyFilePath: keyFile })),
    fetchImpl,
  );
}

function claude(at: string, rt?: string): ClaudeTokenConfig {
  return { authMethod: 'oauth', status: 'authorized', accessToken: at, refreshToken: rt };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-pool-byid-'));
  tokensPath = join(tmpDir, 'tokens.json');
  keyFile = join(tmpDir, 'master.key');
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('getAccessTokenForAccount', () => {
  it('reads a NON-active account token by id (claude, no inline refresh)', async () => {
    const store = makeStore();
    const { id: idA } = await store.appendProviderAccount('claude', claude('AT-A'), 'A');
    const { id: idB } = await store.appendProviderAccount('claude', claude('AT-B'), 'B');
    // B is active (appended last); resolve A by id.
    expect((await store.getFullConfig()).activeClaudeAccountId).toBe(idB);
    expect(await store.getAccessTokenForAccount('claude', idA)).toBe('AT-A');
    expect(await store.getAccessTokenForAccount('claude', idB)).toBe('AT-B');
  });

  it('returns null for an unknown id', async () => {
    const store = makeStore();
    await store.appendProviderAccount('claude', claude('AT-A'), 'A');
    expect(await store.getAccessTokenForAccount('claude', 'nope')).toBeNull();
  });

  it('opencodego returns the account static key by id', async () => {
    const store = makeStore();
    const oc: OpenCodeGoTokenConfig = { authMethod: 'manual', status: 'configured', apiKey: 'ock-1' };
    const { id } = await store.appendProviderAccount('opencodego', oc, 'A');
    expect(await store.getAccessTokenForAccount('opencodego', id)).toBe('ock-1');
  });

  it('refreshes a near-expiry gemini account by id and returns the fresh token', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      new Response(JSON.stringify({ access_token: 'AT-fresh', expires_in: 3600 }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const store = makeStore(fetchImpl);
    const past = new Date(Date.now() - 60_000).toISOString();
    const gem: GeminiTokenConfig = {
      authMethod: 'oauth',
      status: 'authorized',
      accessToken: 'AT-stale',
      refreshToken: 'RT-1',
      expiresAt: past,
    };
    const { id } = await store.appendProviderAccount('gemini', gem, 'A');
    // Second account so the pool is multi-account (mirrors real scheduling), but
    // by-id resolution works regardless.
    await store.appendProviderAccount('gemini', { ...gem, accessToken: 'AT-other' }, 'B');

    const token = await store.getAccessTokenForAccount('gemini', id);
    expect(token).toBe('AT-fresh');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('refreshAccountToken', () => {
  it('refreshes claude by id', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      new Response(
        JSON.stringify({ access_token: 'AT-A-new', refresh_token: 'RT-A-new', expires_in: 3600 }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const store = makeStore(fetchImpl);
    const { id: idA } = await store.appendProviderAccount('claude', claude('AT-A', 'RT-A'), 'A');
    await store.appendProviderAccount('claude', claude('AT-B', 'RT-B'), 'B'); // B active

    expect(await store.refreshAccountToken('claude', idA)).toBe(true);
    const fresh = (await store.getFullConfig()).claudeAccounts?.find((a) => a.id === idA);
    expect(fresh?.tokens.accessToken).toBe('AT-A-new');
  });

  it('opencodego is not refreshable → false', async () => {
    const store = makeStore();
    const { id } = await store.appendProviderAccount(
      'opencodego',
      { authMethod: 'manual', status: 'configured', apiKey: 'k' },
      'A',
    );
    expect(await store.refreshAccountToken('opencodego', id)).toBe(false);
  });
});

describe('touchAccountLastUsed + setAccountPriority', () => {
  it('persists lastUsedAt on the entry (mirror untouched)', async () => {
    const store = makeStore();
    const { id } = await store.appendProviderAccount('claude', claude('AT-A'), 'A');
    const iso = '2026-07-06T12:00:00.000Z';
    await store.touchAccountLastUsed('claude', id, iso);
    const cfg = await store.getFullConfig();
    expect(cfg.claudeAccounts?.[0].lastUsedAt).toBe(iso);
    // The token mirror is unaffected by metadata writes.
    expect(cfg.claude?.accessToken).toBe('AT-A');
  });

  it('touchAccountLastUsed no-ops for an unknown id', async () => {
    const store = makeStore();
    await store.appendProviderAccount('claude', claude('AT-A'), 'A');
    await store.touchAccountLastUsed('claude', 'nope', '2026-07-06T12:00:00.000Z');
    const cfg = await store.getFullConfig();
    expect(cfg.claudeAccounts?.[0].lastUsedAt).toBeUndefined();
  });

  it('setAccountPriority persists and the sanitized view reflects it', async () => {
    const store = makeStore();
    const { id } = await store.appendProviderAccount('claude', claude('AT-A'), 'A');
    expect((await store.setAccountPriority('claude', id, 10)).ok).toBe(true);
    const cfg = await store.getFullConfig();
    expect(cfg.claudeAccounts?.[0].priority).toBe(10);
    const sanitized = await store.listSanitizedAccounts();
    expect(sanitized.claude?.[0].priority).toBe(10);
    expect(JSON.stringify(sanitized)).not.toContain('AT-A'); // still secret-free
  });

  it('setAccountPriority rejects an unknown id', async () => {
    const store = makeStore();
    await store.appendProviderAccount('claude', claude('AT-A'), 'A');
    expect((await store.setAccountPriority('claude', 'nope', 10)).ok).toBe(false);
  });
});
