/**
 * credential-refresh.test.ts — `JsonSubscriptionCredentialStore.refresh*Token`
 * real implementations (omnicross-daemon-parity-oauth task 3.6).
 *
 * Covers, per provider (claude/codex/gemini), with an INJECTED mock fetch (no
 * network):
 *   - success → `true`, block access token updated, status `authorized`,
 *     expiresAt advanced, and the on-disk bytes are an `enc:` envelope (no
 *     plaintext token leaks),
 *   - failure (upstream `error` / unparseable) → `false`, block `status:'expired'`
 *     + errorMessage (stale token material preserved),
 *   - no refresh_token (setup-token / manual) → HONEST `false` with NO upstream
 *     call and the block untouched,
 *   - gemini → reuses the OLD refresh_token (the response omits it),
 *   - codex → writes back the refreshed idToken.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AccountTokensConfig } from '@omnicross/contracts/account-tokens-types';
import type { FetchLike } from '@omnicross/subscriptions';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JsonSubscriptionCredentialStore } from '../ports/JsonSubscriptionCredentialStore';
import { isEnvelope, resolveMasterKey, SecretBox } from '../secrets';

let tmpDir: string;
let tokensPath: string;
let keyFile: string;
let box: SecretBox;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-refresh-'));
  tokensPath = join(tmpDir, 'tokens.json');
  keyFile = join(tmpDir, 'master.key');
  box = new SecretBox(resolveMasterKey({ keyFilePath: keyFile }));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Seed an ENCRYPTED-at-rest tokens.json from a plaintext config (via the store). */
function seed(config: AccountTokensConfig): void {
  // Write the plaintext config then let an offline store re-persist it encrypted.
  writeFileSync(tokensPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

/** A mock `FetchLike` returning one JSON body; records the call count. */
function jsonFetch(body: unknown): { fetch: FetchLike; calls: number } {
  const state = { fetch: undefined as unknown as FetchLike, calls: 0 };
  state.fetch = vi.fn(async () => {
    state.calls += 1;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return state;
}

/** Raw on-disk bytes (no decrypt). */
function rawBytes(): string {
  return readFileSync(tokensPath, 'utf8');
}

/** Decrypted config from a fresh store (proves the round-trip). */
async function readBack(): Promise<AccountTokensConfig> {
  return new JsonSubscriptionCredentialStore(tokensPath, box).getFullConfig();
}

describe('refreshClaudeToken', () => {
  it('success → updates access+refresh+expiresAt+status, encrypted at rest', async () => {
    seed({
      claude: { authMethod: 'oauth', status: 'authorized', accessToken: 'old-at', refreshToken: 'rt-1' },
      updatedAt: '',
    });
    const m = jsonFetch({ access_token: 'new-at', refresh_token: 'rt-2', expires_in: 3600 });
    const store = new JsonSubscriptionCredentialStore(tokensPath, box, m.fetch, () => null);

    const before = Date.now();
    expect(await store.refreshClaudeToken()).toBe(true);
    expect(m.calls).toBe(1);

    const cfg = await readBack();
    expect(cfg.claude?.accessToken).toBe('new-at');
    expect(cfg.claude?.refreshToken).toBe('rt-2');
    expect(cfg.claude?.status).toBe('authorized');
    expect(new Date(cfg.claude?.expiresAt as string).getTime()).toBeGreaterThan(before);

    // On-disk bytes are an envelope — no plaintext token.
    const raw = rawBytes();
    expect(raw).not.toContain('new-at');
    expect(raw).not.toContain('rt-2');
    const onDisk = JSON.parse(raw) as { claude: { accessToken: string; refreshToken: string } };
    expect(isEnvelope(onDisk.claude.accessToken)).toBe(true);
    expect(isEnvelope(onDisk.claude.refreshToken)).toBe(true);
  });

  it('no refresh_token (setup-token) → honest false, NO upstream call, block untouched', async () => {
    seed({
      claude: { authMethod: 'setup_token', status: 'authorized', accessToken: 'setup-at', isSetupToken: true },
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const m = jsonFetch({ access_token: 'should-not-be-used', expires_in: 99 });
    const store = new JsonSubscriptionCredentialStore(tokensPath, box, m.fetch, () => null);

    expect(await store.refreshClaudeToken()).toBe(false);
    expect(m.calls).toBe(0);
    const cfg = await readBack();
    expect(cfg.claude?.accessToken).toBe('setup-at');
    expect(cfg.claude?.status).toBe('authorized'); // untouched
  });

  it('upstream error → false, status expired + errorMessage', async () => {
    seed({
      claude: { authMethod: 'oauth', status: 'authorized', accessToken: 'old-at', refreshToken: 'rt-1' },
      updatedAt: '',
    });
    const m = jsonFetch({ error: 'invalid_grant', error_description: 'revoked' });
    const store = new JsonSubscriptionCredentialStore(tokensPath, box, m.fetch, () => null);

    expect(await store.refreshClaudeToken()).toBe(false);
    const cfg = await readBack();
    expect(cfg.claude?.status).toBe('expired');
    expect(cfg.claude?.errorMessage).toBe('revoked');
    expect(cfg.claude?.accessToken).toBe('old-at'); // stale material preserved
  });
});

describe('refreshCodexToken', () => {
  it('success → writes idToken + reuses old refresh_token when response omits it', async () => {
    seed({
      codex: { authMethod: 'oauth', status: 'authorized', accessToken: 'old-at', refreshToken: 'rt-1', idToken: 'idt-1' },
      updatedAt: '',
    });
    // Response omits refresh_token → store should reuse 'rt-1'.
    const m = jsonFetch({ access_token: 'new-at', id_token: 'idt-2', expires_in: 3600 });
    const store = new JsonSubscriptionCredentialStore(tokensPath, box, m.fetch, () => null);

    expect(await store.refreshCodexToken()).toBe(true);
    const cfg = await readBack();
    expect(cfg.codex?.accessToken).toBe('new-at');
    expect(cfg.codex?.idToken).toBe('idt-2');
    expect(cfg.codex?.refreshToken).toBe('rt-1'); // reused
    expect(cfg.codex?.status).toBe('authorized');
  });
});

describe('refreshGeminiToken', () => {
  it('success → updates access+expiresAt but REUSES old refresh_token (never overwritten)', async () => {
    seed({
      gemini: { authMethod: 'oauth', status: 'authorized', accessToken: 'old-at', refreshToken: 'rt-keep' },
      updatedAt: '',
    });
    // Gemini refresh response has NO refresh_token.
    const m = jsonFetch({ access_token: 'new-at', expires_in: 3600 });
    const store = new JsonSubscriptionCredentialStore(tokensPath, box, m.fetch, () => null);

    expect(await store.refreshGeminiToken()).toBe(true);
    const cfg = await readBack();
    expect(cfg.gemini?.accessToken).toBe('new-at');
    expect(cfg.gemini?.refreshToken).toBe('rt-keep'); // NOT cleared
    expect(cfg.gemini?.status).toBe('authorized');

    const onDisk = JSON.parse(rawBytes()) as { gemini: { refreshToken: string } };
    expect(isEnvelope(onDisk.gemini.refreshToken)).toBe(true);
  });

  it('no refresh_token → honest false, no upstream call', async () => {
    seed({
      gemini: { authMethod: 'manual', status: 'configured', accessToken: 'manual-at' },
      updatedAt: '',
    });
    const m = jsonFetch({ access_token: 'x', expires_in: 1 });
    const store = new JsonSubscriptionCredentialStore(tokensPath, box, m.fetch, () => null);
    expect(await store.refreshGeminiToken()).toBe(false);
    expect(m.calls).toBe(0);
  });
});
