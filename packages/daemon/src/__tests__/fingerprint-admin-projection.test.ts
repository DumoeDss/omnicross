/**
 * fingerprint-admin-projection.test.ts — the COARSE per-account fingerprint
 * captured-status on the admin accounts projection (subscription-client-fingerprint
 * #7, D7). Asserts the projection exposes `identityCaptured`/`identityCapturedAt`
 * ONLY when replay is enabled, and NEVER surfaces the raw captured headers.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  __resetSharedIdentityStoreForTests,
  getSharedIdentityStore,
} from '@omnicross/core/provider-proxy/identity/SubscriptionIdentityStore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JsonSubscriptionCredentialStore } from '../ports/JsonSubscriptionCredentialStore';
import { resolveMasterKey, SecretBox } from '../secrets';

let tmpDir: string;
let tokensPath: string;
let keyFile: string;

function makeStore(): JsonSubscriptionCredentialStore {
  return new JsonSubscriptionCredentialStore(
    tokensPath,
    new SecretBox(resolveMasterKey({ keyFilePath: keyFile })),
  );
}

// Distinctive sentinels: a real fingerprint header value + a would-be secret. The
// coarse projection must expose NEITHER.
const HEADER_SENTINEL = 'STAINLESS-VALUE-SENTINEL';
const SECRET_SENTINEL = 'Bearer AUTH-LEAK-SENTINEL';

async function seedClaudeAccount(store: JsonSubscriptionCredentialStore): Promise<string> {
  await store.writeProviderTokens('claude', {
    authMethod: 'oauth',
    status: 'authorized',
    accessToken: 'at',
    refreshToken: 'rt',
  });
  const cfg = await store.getFullConfig();
  return cfg.claudeAccounts![0].id;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-fp-proj-'));
  tokensPath = join(tmpDir, 'tokens.json');
  keyFile = join(tmpDir, 'master.key');
  __resetSharedIdentityStoreForTests();
});

afterEach(() => {
  __resetSharedIdentityStoreForTests();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('coarse fingerprint captured-status projection', () => {
  it('disabled ⇒ NO identityCaptured field on the account (indicator hidden)', async () => {
    const store = makeStore();
    const accountId = await seedClaudeAccount(store);
    // Even with an identity captured, a DISABLED store surfaces nothing.
    getSharedIdentityStore().seed('claude', accountId, {
      headers: { 'x-stainless-lang': HEADER_SENTINEL },
      capturedAt: 1,
    });
    const accounts = await store.listSanitizedAccounts();
    const claude = accounts.claude![0];
    expect(claude.identityCaptured).toBeUndefined();
    expect(claude.identityCapturedAt).toBeUndefined();
  });

  it('enabled + captured ⇒ coarse boolean + timestamp, but NEVER the raw headers', async () => {
    const store = makeStore();
    const accountId = await seedClaudeAccount(store);
    getSharedIdentityStore().configure({ enabled: true });
    getSharedIdentityStore().capture(
      'claude',
      accountId,
      {
        'x-stainless-lang': HEADER_SENTINEL,
        authorization: SECRET_SENTINEL,
      } as Record<string, string>,
      1_700_000_000_000,
    );

    const accounts = await store.listSanitizedAccounts();
    const claude = accounts.claude![0];
    expect(claude.identityCaptured).toBe(true);
    expect(typeof claude.identityCapturedAt).toBe('string');
    expect(new Date(claude.identityCapturedAt!).getTime()).toBe(1_700_000_000_000);

    // The whole serialized admin projection must contain NEITHER the raw captured
    // header value NOR any auth/secret value.
    const serialized = JSON.stringify(accounts);
    expect(serialized).not.toContain(HEADER_SENTINEL);
    expect(serialized).not.toContain('AUTH-LEAK-SENTINEL');
    // The account object exposes no `headers`/`identity` field.
    expect((claude as Record<string, unknown>).headers).toBeUndefined();
    expect((claude as Record<string, unknown>).identity).toBeUndefined();
  });

  it('enabled + uncaptured ⇒ identityCaptured is false (honest "not yet")', async () => {
    const store = makeStore();
    await seedClaudeAccount(store);
    getSharedIdentityStore().configure({ enabled: true });
    const accounts = await store.listSanitizedAccounts();
    expect(accounts.claude![0].identityCaptured).toBe(false);
    expect(accounts.claude![0].identityCapturedAt).toBeUndefined();
  });
});
