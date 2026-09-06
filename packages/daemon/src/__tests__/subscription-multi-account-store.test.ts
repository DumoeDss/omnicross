/**
 * subscription-multi-account-store.test.ts — the daemon `JsonSubscriptionCredentialStore`
 * multi-account invariants (subscription-multi-account 11.1 / 11.2).
 *
 * Drives a REAL store over a temp `tokens.json` + a real `SecretBox` and asserts:
 *  - lazy idempotent migration (legacy → 1 account, read-pure intent),
 *  - setActiveAccount switches + re-derives the mirror,
 *  - refresh write-back keyed by the captured id with an interleaved switch,
 *  - remove-active promotion + clear-when-empty,
 *  - writeProviderTokens updates the active account (append when none),
 *  - secrets at-rest: every account's token field is an `enc:` envelope on disk
 *    and decrypts round-trip; id/label/createdAt stay plaintext; mirror encrypted.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ClaudeTokenConfig } from '@omnicross/contracts/account-tokens-types';
import type { FetchLike } from '@omnicross/subscriptions';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JsonSubscriptionCredentialStore } from '../ports/JsonSubscriptionCredentialStore';
import { isEnvelope, resolveMasterKey, SecretBox } from '../secrets';

let tmpDir: string;
let tokensPath: string;
let keyFile: string;

function makeBox(): SecretBox {
  return new SecretBox(resolveMasterKey({ keyFilePath: keyFile }));
}

function makeStore(fetchImpl?: FetchLike): JsonSubscriptionCredentialStore {
  return new JsonSubscriptionCredentialStore(tokensPath, makeBox(), fetchImpl);
}

function claudeBlock(at: string, rt?: string): ClaudeTokenConfig {
  return { authMethod: 'oauth', status: 'authorized', accessToken: at, refreshToken: rt };
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-multi-store-'));
  tokensPath = join(tmpDir, 'tokens.json');
  keyFile = join(tmpDir, 'master.key');
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('lazy migration', () => {
  it('migrates a legacy single-slot tokens.json into one active account on read', async () => {
    const store = makeStore();
    await store.writeProviderTokens('claude', claudeBlock('legacy-AT', 'legacy-RT'));
    // First write goes through the active-account path → one account materialized.
    const cfg = await store.getFullConfig();
    expect(cfg.claudeAccounts).toHaveLength(1);
    expect(cfg.claudeAccounts?.[0].tokens.accessToken).toBe('legacy-AT');
    expect(cfg.activeClaudeAccountId).toBe(cfg.claudeAccounts?.[0].id);
    expect(cfg.claude?.accessToken).toBe('legacy-AT');
  });
});

describe('switch + mirror', () => {
  it('setActiveAccount switches and re-derives the mirror', async () => {
    const store = makeStore();
    const { id: idA } = await store.appendProviderAccount('claude', claudeBlock('AT-A'), 'A');
    const { id: idB } = await store.appendProviderAccount('claude', claudeBlock('AT-B'), 'B');
    // B is active (appended last).
    expect((await store.getFullConfig()).activeClaudeAccountId).toBe(idB);
    await store.setActiveAccount('claude', idA);
    const cfg = await store.getFullConfig();
    expect(cfg.activeClaudeAccountId).toBe(idA);
    expect(cfg.claude?.accessToken).toBe('AT-A');
  });
});

describe('refresh write-back keyed by captured id (interleaved switch)', () => {
  it('refreshed tokens land on the captured account; current active wins the mirror', async () => {
    const refresh = vi.fn<FetchLike>();
    const store = makeStore(refresh);
    const { id: idA } = await store.appendProviderAccount('claude', claudeBlock('AT-A', 'RT-A'), 'A');
    const { id: idB } = await store.appendProviderAccount('claude', claudeBlock('AT-B', 'RT-B'), 'B');
    await store.setActiveAccount('claude', idA); // A active → refresh captures A.

    // The mocked refresh fetch flips active to B mid-flight, then returns rotated tokens.
    refresh.mockImplementationOnce(async () => {
      await store.setActiveAccount('claude', idB);
      return new Response(
        JSON.stringify({ access_token: 'AT-A-refreshed', refresh_token: 'RT-A-refreshed', expires_in: 3600 }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    });

    const ok = await store.refreshClaudeToken();
    expect(ok).toBe(true);

    const cfg = await store.getFullConfig();
    const freshA = cfg.claudeAccounts?.find((a) => a.id === idA);
    const freshB = cfg.claudeAccounts?.find((a) => a.id === idB);
    expect(freshA?.tokens.accessToken).toBe('AT-A-refreshed'); // captured account
    expect(cfg.activeClaudeAccountId).toBe(idB); // current active unchanged
    expect(freshB?.tokens.accessToken).toBe('AT-B');
    expect(cfg.claude?.accessToken).toBe('AT-B'); // mirror = B
  });

  it('refresh on a NOT-YET-materialized legacy single-slot file lands the token (MAJOR regression)', async () => {
    // Seed a RAW legacy tokens.json (plaintext, no accounts array, never
    // materialized) — the common upgrade path. With deterministic synthesized
    // ids (and belt-and-braces materializeMigration), the capture-then-re-read
    // write-back keys against a consistent id.
    writeFileSync(
      tokensPath,
      JSON.stringify(
        { claude: { authMethod: 'oauth', status: 'authorized', accessToken: 'legacy-AT', refreshToken: 'legacy-RT' }, updatedAt: '2026-01-01T00:00:00.000Z' },
        null,
        2,
      ) + '\n',
      'utf8',
    );
    const refresh = vi.fn<FetchLike>(async () =>
      new Response(
        JSON.stringify({ access_token: 'legacy-AT-refreshed', refresh_token: 'legacy-RT-refreshed', expires_in: 3600 }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const store = makeStore(refresh);

    const ok = await store.refreshClaudeToken();
    expect(ok).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);

    const cfg = await store.getFullConfig();
    expect(cfg.claudeAccounts?.[0].tokens.accessToken).toBe('legacy-AT-refreshed');
    expect(cfg.claude?.accessToken).toBe('legacy-AT-refreshed'); // mirror, not stale
  });
});

describe('remove-active promotion + writeProviderTokens', () => {
  it('removing the active account promotes the most-recent remaining', async () => {
    const store = makeStore();
    const { id: idA } = await store.appendProviderAccount('claude', claudeBlock('AT-A'), 'A');
    await delay(5);
    const { id: idB } = await store.appendProviderAccount('claude', claudeBlock('AT-B'), 'B');
    await delay(5);
    const { id: idC } = await store.appendProviderAccount('claude', claudeBlock('AT-C'), 'C');

    await store.removeAccount('claude', idC); // active → promote most-recent remaining
    const cfg = await store.getFullConfig();
    expect(cfg.claudeAccounts).toHaveLength(2);
    expect(cfg.activeClaudeAccountId).toBe(idB);
    expect(cfg.claude?.accessToken).toBe('AT-B');
    expect(idA).not.toBe(idB);
  });

  it('writeProviderTokens updates the ACTIVE account in place (appends when none)', async () => {
    const store = makeStore();
    // No account yet → first write appends + activates.
    await store.writeProviderTokens('claude', claudeBlock('AT-first'));
    let cfg = await store.getFullConfig();
    expect(cfg.claudeAccounts).toHaveLength(1);
    const id = cfg.activeClaudeAccountId;

    // Second write to the same provider updates the ACTIVE account (no append).
    await store.writeProviderTokens('claude', claudeBlock('AT-updated'));
    cfg = await store.getFullConfig();
    expect(cfg.claudeAccounts).toHaveLength(1);
    expect(cfg.activeClaudeAccountId).toBe(id);
    expect(cfg.claude?.accessToken).toBe('AT-updated');
  });

  it('clearProvider removes accounts + active id + mirror', async () => {
    const store = makeStore();
    await store.appendProviderAccount('claude', claudeBlock('AT-A'), 'A');
    await store.clearProvider('claude');
    const cfg = await store.getFullConfig();
    expect(cfg.claudeAccounts).toBeUndefined();
    expect(cfg.activeClaudeAccountId).toBeUndefined();
    expect(cfg.claude).toBeUndefined();
  });
});

describe('secrets at-rest (D6)', () => {
  it('every account token is enc: on disk + decrypts round-trip; metadata stays plaintext', async () => {
    const store = makeStore();
    await store.appendProviderAccount('claude', claudeBlock('plain-AT-1', 'plain-RT-1'), 'Personal');
    await store.appendProviderAccount('claude', claudeBlock('plain-AT-2', 'plain-RT-2'), 'Work');

    // On-disk: each account's tokens are envelopes; the mirror too.
    const onDisk = JSON.parse(readFileSync(tokensPath, 'utf8')) as {
      claude: { accessToken: string };
      claudeAccounts: Array<{ id: string; label: string; createdAt: string; tokens: { accessToken: string; refreshToken: string } }>;
    };
    expect(isEnvelope(onDisk.claude.accessToken)).toBe(true);
    for (const acc of onDisk.claudeAccounts) {
      expect(isEnvelope(acc.tokens.accessToken)).toBe(true);
      expect(isEnvelope(acc.tokens.refreshToken)).toBe(true);
      // Metadata stays plaintext.
      expect(isEnvelope(acc.id)).toBe(false);
      expect(isEnvelope(acc.label)).toBe(false);
      expect(isEnvelope(acc.createdAt)).toBe(false);
      // The raw plaintext token NEVER appears on disk.
      expect(acc.tokens.accessToken).not.toContain('plain-AT');
    }

    // Decrypt round-trip via a fresh store reads back the original plaintext.
    const fresh = makeStore();
    const cfg = await fresh.getFullConfig();
    const labels = (cfg.claudeAccounts ?? []).map((a) => a.tokens.accessToken).sort();
    expect(labels).toEqual(['plain-AT-1', 'plain-AT-2']);
  });

  it('listSanitizedAccounts is secret-free (no token, exactly one active)', async () => {
    const store = makeStore();
    await store.appendProviderAccount('claude', claudeBlock('sentinel-AT-1', 'sentinel-RT-1'), 'A');
    await store.appendProviderAccount('claude', claudeBlock('sentinel-AT-2', 'sentinel-RT-2'), 'B');
    const sanitized = await store.listSanitizedAccounts();
    const json = JSON.stringify(sanitized);
    expect(json).not.toContain('sentinel-AT');
    expect(json).not.toContain('sentinel-RT');
    expect(json).not.toContain('enc:');
    expect(sanitized.claude).toHaveLength(2);
    expect(sanitized.claude.filter((a) => a.isActive)).toHaveLength(1);
  });
});

describe('corrupt tokens.json quarantine (2026-09-06 incident)', () => {
  const CORRUPT_BODY = '{"codexAccounts": [ {"id": "x", "tokens": {"acce';

  it('moves an unparseable (truncated-write) file aside before treating it as empty', async () => {
    writeFileSync(tokensPath, CORRUPT_BODY, 'utf8');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = makeStore();
    // Read tolerates the corrupt file as empty (daemon keeps serving)…
    const cfg = await store.getFullConfig();
    expect(cfg.codexAccounts).toBeUndefined();
    // …but ONLY after the corrupt bytes were moved to a sibling backup, so a
    // later login persist can no longer overwrite the only copy of the accounts.
    const backups = readdirSync(tmpDir).filter((f) => f.startsWith('tokens.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(tmpDir, backups[0]), 'utf8')).toBe(CORRUPT_BODY);
    expect(existsSync(tokensPath)).toBe(false);
    // Loud, secret-free stderr line — exactly one (latched, not per-read).
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0])).toContain('corrupt');
    await store.getFullConfig();
    expect(errSpy).toHaveBeenCalledTimes(1);
  });

  it('quarantines a valid-JSON non-object file the same way', async () => {
    writeFileSync(tokensPath, '[1,2,3]', 'utf8');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = makeStore();
    expect(await store.getFullConfig()).toEqual({ updatedAt: '' });
    const backups = readdirSync(tmpDir).filter((f) => f.startsWith('tokens.json.corrupt-'));
    expect(backups).toHaveLength(1);
  });

  it('a MISSING file stays the silent first-boot empty — no backup, no log', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = makeStore();
    expect(await store.getFullConfig()).toEqual({ updatedAt: '' });
    expect(readdirSync(tmpDir).filter((f) => f.includes('corrupt'))).toHaveLength(0);
    expect(errSpy).not.toHaveBeenCalled();
  });
});

describe('atomic persist (2026-09-06 incident)', () => {
  it('writes via temp+rename and leaves no temp litter beside tokens.json', async () => {
    const store = makeStore();
    await store.writeProviderTokens('claude', claudeBlock('AT-1', 'RT-1'));
    expect(existsSync(tokensPath)).toBe(true);
    const litter = readdirSync(tmpDir).filter((f) => f.startsWith('.tokens.json.'));
    expect(litter).toHaveLength(0);
  });

  it('a failed write leaves the prior file byte-equal (no truncate-then-write)', async () => {
    const good = makeStore();
    await good.writeProviderTokens('claude', claudeBlock('AT-keep', 'RT-keep'));
    const before = readFileSync(tokensPath, 'utf8');
    const failing = new JsonSubscriptionCredentialStore(
      tokensPath,
      makeBox(),
      undefined,
      undefined,
      () => {
        throw new Error('ENOSPC: simulated full disk');
      },
    );
    await expect(failing.writeProviderTokens('claude', claudeBlock('AT-2'))).rejects.toThrow(
      'ENOSPC',
    );
    expect(readFileSync(tokensPath, 'utf8')).toBe(before);
  });
});
