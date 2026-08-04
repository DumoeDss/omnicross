/**
 * P5 external CLI cleanup coverage.
 *
 * Native Claude Code and Codex credential files are read-only, explicit import
 * sources. Managed account listing and every managed refresh path stay inside
 * Omnicross's own encrypted account store.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ClaudeTokenConfig,
  CodexTokenConfig,
} from '@omnicross/contracts/account-tokens-types';
import type { FetchLike } from '@omnicross/subscriptions';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { findDuplicateCredentialIds, buildTokensFromExternal } from '../ports/account-sync';
import {
  decodeJwtExpiryMs,
  parseClaudeOAuthEnvelope,
  parseCodexTokensEnvelope,
  readExternalCliCredentials,
  type ExternalCliCredentials,
  type ExternalCliReader,
} from '../ports/external-cli-credentials';
import { JsonSubscriptionCredentialStore } from '../ports/JsonSubscriptionCredentialStore';
import { resolveMasterKey, SecretBox } from '../secrets';
import { TokenRefreshScheduler } from '../TokenRefreshScheduler';

let tmpDir: string;
let tokensPath: string;
let keyFile: string;

type NativeFileSnapshot = {
  sha256: string;
  mtimeMs: number;
  size: number;
};

function makeBox(): SecretBox {
  return new SecretBox(resolveMasterKey({ keyFilePath: keyFile }));
}

function makeStore(
  fetchImpl?: FetchLike,
  externalReader?: ExternalCliReader,
): JsonSubscriptionCredentialStore {
  return new JsonSubscriptionCredentialStore(tokensPath, makeBox(), fetchImpl, externalReader);
}

function claudeBlock(at: string, rt?: string, expiresAt?: string): ClaudeTokenConfig {
  return {
    authMethod: 'oauth',
    status: 'authorized',
    accessToken: at,
    refreshToken: rt,
    expiresAt,
  };
}

function codexBlock(at: string, rt?: string, expiresAt?: string): CodexTokenConfig {
  return {
    authMethod: 'oauth',
    status: 'authorized',
    accessToken: at,
    refreshToken: rt,
    expiresAt,
  };
}

const future = (ms: number): string => new Date(Date.now() + ms).toISOString();

function nativeFileSnapshot(path: string): NativeFileSnapshot {
  const stat = statSync(path);
  return {
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  };
}

function nativeSnapshots(paths: string[]): Record<string, NativeFileSnapshot> {
  return Object.fromEntries(paths.map((path) => [path, nativeFileSnapshot(path)]));
}

function seedClaudeCliFile(home: string, accessToken: string, refreshToken: string): string {
  const path = join(home, '.claude', '.credentials.json');
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      claudeAiOauth: {
        accessToken,
        refreshToken,
        expiresAt: Date.now() + 3_600_000,
        scopes: ['user:inference'],
      },
      email: 'user@example.com',
    }),
    'utf8',
  );
  return path;
}

function seedCodexCliFile(home: string, accessToken: string, refreshToken: string): string {
  const path = join(home, '.codex', 'auth.json');
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      tokens: {
        access_token: accessToken,
        refresh_token: refreshToken,
        id_token: 'CLI-ID',
      },
      unrelatedSetting: 'preserve-me',
    }),
    'utf8',
  );
  return path;
}

function okRefreshResponse(accessToken: string, refreshToken: string): Response {
  return new Response(
    JSON.stringify({
      access_token: accessToken,
      refresh_token: refreshToken,
      id_token: 'fresh-id-token',
      expires_in: 3600,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
}

function refreshTokenFromInit(init: RequestInit | undefined): string {
  const body = String(init?.body ?? '');
  try {
    const parsed = JSON.parse(body) as { refresh_token?: unknown };
    if (typeof parsed.refresh_token === 'string') return parsed.refresh_token;
  } catch {
    // Codex/Gemini use URL-encoded form bodies.
  }
  return new URLSearchParams(body).get('refresh_token') ?? '';
}

function failedRefreshResponse(): Response {
  return new Response(JSON.stringify({ error: 'invalid_grant' }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

const stubLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-p5-ext-sync-'));
  tokensPath = join(tmpDir, 'tokens.json');
  keyFile = join(tmpDir, 'master.key');
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('external CLI parsers and managed-account helpers', () => {
  it('parses Claude and Codex native credential envelopes', () => {
    const claude = parseClaudeOAuthEnvelope({
      claudeAiOauth: {
        accessToken: 'AT',
        refreshToken: 'RT',
        expiresAt: 1_750_000_000_000,
        scopes: ['user:inference'],
      },
    });
    expect(claude).toEqual({
      accessToken: 'AT',
      refreshToken: 'RT',
      expiresAt: new Date(1_750_000_000_000).toISOString(),
      scopes: ['user:inference'],
    });

    const exp = Math.floor(Date.now() / 1000) + 3600;
    const jwt = ['h', Buffer.from(JSON.stringify({ exp })).toString('base64url'), 's'].join('.');
    const codex = parseCodexTokensEnvelope({
      tokens: { access_token: jwt, refresh_token: 'RT', id_token: 'ID' },
    });
    expect(codex).toMatchObject({ accessToken: jwt, refreshToken: 'RT', idToken: 'ID' });
    expect(codex?.expiresAt).toBe(new Date(exp * 1000).toISOString());
    expect(decodeJwtExpiryMs('not-a-jwt')).toBeUndefined();
    expect(parseClaudeOAuthEnvelope({})).toBeNull();
  });

  it('builds a fresh copy for explicit import and retains duplicate managed warnings', () => {
    const external: ExternalCliCredentials = {
      accessToken: 'CLI-AT',
      refreshToken: 'CLI-RT',
      expiresAt: future(3_600_000),
      idToken: 'CLI-ID',
    };
    expect(buildTokensFromExternal('codex', external)).toMatchObject({
      accessToken: 'CLI-AT',
      refreshToken: 'CLI-RT',
      idToken: 'CLI-ID',
      status: 'authorized',
    });

    const duplicates = findDuplicateCredentialIds([
      { id: 'a', tokens: claudeBlock('AT-A', 'SAME-RT') },
      { id: 'b', tokens: claudeBlock('AT-B', 'SAME-RT') },
      { id: 'c', tokens: claudeBlock('AT-C', 'OTHER-RT') },
    ]);
    expect(duplicates).toEqual(new Set(['a', 'b']));
  });
});

describe('managed refresh isolation from native CLI login', () => {
  it('does not read the native file and keeps active/by-id refreshes on managed tokens after a CLI login change', async () => {
    const home = join(tmpDir, 'home');
    const claudePath = seedClaudeCliFile(home, 'NATIVE-AT-1', 'NATIVE-RT-1');
    const reader = vi.fn<ExternalCliReader>((provider) => readExternalCliCredentials(provider, home));
    const refreshTokens: string[] = [];
    let responseNumber = 0;
    const fetchMock = vi.fn<FetchLike>(async (_url, init) => {
      refreshTokens.push(refreshTokenFromInit(init));
      responseNumber += 1;
      return okRefreshResponse('MANAGED-AT-' + responseNumber, 'MANAGED-RT-' + responseNumber);
    });
    const store = makeStore(fetchMock, reader);

    const { id: accountA } = await store.appendProviderAccount(
      'claude',
      claudeBlock('MANAGED-AT-A', 'MANAGED-RT-A'),
      'Managed A',
    );
    const { id: accountB } = await store.appendProviderAccount(
      'claude',
      claudeBlock('MANAGED-AT-B', 'MANAGED-RT-B'),
      'Managed B',
    );
    await store.setActiveAccount('claude', accountA);

    await store.listSanitizedAccounts();
    expect(reader).not.toHaveBeenCalled();

    const beforeLoginChange = nativeFileSnapshot(claudePath);
    expect(await store.refreshClaudeToken()).toBe(true);
    writeFileSync(
      claudePath,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'NATIVE-AT-2',
          refreshToken: 'NATIVE-RT-2',
          expiresAt: Date.now() + 3_600_000,
        },
      }),
      'utf8',
    );
    const afterLoginChange = nativeFileSnapshot(claudePath);

    expect(await store.refreshAccountById('claude', accountB)).toBe(true);
    expect(await store.refreshClaudeToken()).toBe(true);
    expect(refreshTokens).toEqual(['MANAGED-RT-A', 'MANAGED-RT-B', 'MANAGED-RT-1']);
    expect(reader).not.toHaveBeenCalled();
    expect(nativeFileSnapshot(claudePath)).toEqual(afterLoginChange);
    expect(nativeFileSnapshot(claudePath)).not.toEqual(beforeLoginChange);

    const config = await store.getFullConfig();
    const storedA = config.claudeAccounts?.find((account) => account.id === accountA);
    const storedB = config.claudeAccounts?.find((account) => account.id === accountB);
    expect(storedA?.tokens.accessToken).toBe('MANAGED-AT-3');
    expect(storedB?.tokens.accessToken).toBe('MANAGED-AT-2');
    expect(storedA?.tokens.accessToken).not.toBe('NATIVE-AT-2');
    expect(storedB?.tokens.accessToken).not.toBe('NATIVE-AT-2');
  });

  it('marks only the managed account expired on refresh failure and never imports the native login', async () => {
    const home = join(tmpDir, 'home');
    const claudePath = seedClaudeCliFile(home, 'NATIVE-AT', 'NATIVE-ROTATED-RT');
    const reader = vi.fn<ExternalCliReader>((provider) => readExternalCliCredentials(provider, home));
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(failedRefreshResponse());
    const store = makeStore(fetchMock, reader);

    const { id: failedId } = await store.appendProviderAccount(
      'claude',
      claudeBlock('MANAGED-AT', 'MANAGED-RT'),
      'Failed managed account',
    );
    const { id: healthyId } = await store.appendProviderAccount(
      'claude',
      claudeBlock('HEALTHY-AT', 'HEALTHY-RT'),
      'Healthy managed account',
    );
    await store.setActiveAccount('claude', failedId);
    const before = nativeFileSnapshot(claudePath);

    expect(await store.refreshClaudeToken()).toBe(false);
    expect(reader).not.toHaveBeenCalled();
    expect(nativeFileSnapshot(claudePath)).toEqual(before);

    const config = await store.getFullConfig();
    const failed = config.claudeAccounts?.find((account) => account.id === failedId);
    const healthy = config.claudeAccounts?.find((account) => account.id === healthyId);
    expect(failed?.tokens).toMatchObject({
      accessToken: 'MANAGED-AT',
      refreshToken: 'MANAGED-RT',
      status: 'expired',
    });
    expect(failed?.tokens.errorMessage).toBeTruthy();
    expect(healthy?.tokens).toMatchObject({
      accessToken: 'HEALTHY-AT',
      refreshToken: 'HEALTHY-RT',
      status: 'authorized',
    });
  });
});

describe('native CLI files are read-only and explicit import is copy-only', () => {
  it('keeps availability/import token-free and leaves native hash, mtime, size, and sidecars unchanged', async () => {
    const home = join(tmpDir, 'home');
    const claudePath = seedClaudeCliFile(home, 'CLI-AT', 'CLI-RT');
    const codexPath = seedCodexCliFile(home, 'CODEX-AT', 'CODEX-RT');
    const claudeMarker = claudePath + '.omnicross-managed';
    const claudeBackup = claudePath + '.omnicross-backup';
    writeFileSync(claudeMarker, '{"accountId":"legacy"}\n', 'utf8');
    writeFileSync(claudeBackup, 'legacy backup\n', 'utf8');
    const watched = [claudePath, codexPath, claudeMarker, claudeBackup];
    const before = nativeSnapshots(watched);

    const reader = vi.fn<ExternalCliReader>((provider) => readExternalCliCredentials(provider, home));
    const store = makeStore(undefined, reader);
    await store.appendProviderAccount('claude', claudeBlock('MANAGED-AT', 'MANAGED-RT'), 'Existing managed');
    const availability = await store.listExternalCliAvailability();
    expect(availability).toEqual({ claude: true, codex: true });

    const claudeResult = await store.importExternalCliAccount('claude', 'Imported Claude CLI');
    const codexResult = await store.importExternalCliAccount('codex', 'Imported Codex CLI');
    expect(claudeResult).toMatchObject({
      ok: true,
      nativeCredentialMode: 'read-only',
      refreshWritesNativeCredentials: false,
    });
    expect(codexResult).toMatchObject({
      ok: true,
      nativeCredentialMode: 'read-only',
      refreshWritesNativeCredentials: false,
    });
    expect(JSON.stringify(claudeResult)).not.toContain('CLI-RT');
    expect(JSON.stringify(codexResult)).not.toContain('CODEX-RT');

    if (!claudeResult.ok || !codexResult.ok) throw new Error('expected explicit imports to succeed');
    const config = await store.getFullConfig();
    const importedClaude = config.claudeAccounts?.find((account) => account.id === claudeResult.id);
    const importedCodex = config.codexAccounts?.find((account) => account.id === codexResult.id);
    expect(importedClaude?.tokens).toMatchObject({
      accessToken: 'CLI-AT',
      refreshToken: 'CLI-RT',
      status: 'authorized',
    });
    expect(importedCodex?.tokens).toMatchObject({
      accessToken: 'CODEX-AT',
      refreshToken: 'CODEX-RT',
      idToken: 'CLI-ID',
      status: 'authorized',
    });
    expect(config.claudeAccounts).toHaveLength(2);
    expect(config.codexAccounts).toHaveLength(1);

    const refreshFetch = vi.fn<FetchLike>(async (_url, init) => {
      const rt = refreshTokenFromInit(init) || 'missing';
      return okRefreshResponse('REFRESHED-' + rt, 'ROTATED-' + rt);
    });
    const refreshedStore = new JsonSubscriptionCredentialStore(tokensPath, makeBox(), refreshFetch, reader);
    expect(await refreshedStore.refreshClaudeToken()).toBe(true);
    expect(await refreshedStore.refreshCodexToken()).toBe(true);
    expect(await refreshedStore.refreshAccountById('claude', claudeResult.id)).toBe(true);
    expect(await refreshedStore.refreshAccountById('codex', codexResult.id)).toBe(true);

    expect(reader).toHaveBeenCalledTimes(4);
    expect(nativeSnapshots(watched)).toEqual(before);
    expect(existsSync(claudeMarker)).toBe(true);
    expect(existsSync(claudeBackup)).toBe(true);
  });
});

describe('duplicate warning and background scheduler isolation', () => {
  it('projects duplicate managed-account warnings without consulting native files', async () => {
    const reader = vi.fn<ExternalCliReader>(() => {
      throw new Error('native credential reader must not run for listing');
    });
    const store = makeStore(undefined, reader);
    await store.appendProviderAccount('claude', claudeBlock('AT-A', 'SHARED-RT'), 'A');
    await store.appendProviderAccount('claude', claudeBlock('AT-B', 'SHARED-RT'), 'B');

    const rows = await store.listSanitizedAccounts();
    const warnings = Object.fromEntries(rows.claude!.map((account) => [account.label, account.syncWarning]));
    expect(warnings).toMatchObject({ A: 'duplicate-token', B: 'duplicate-token' });
    expect(reader).not.toHaveBeenCalled();
  });

  it('refreshes all expiring managed accounts in the scheduler without native access', async () => {
    const home = join(tmpDir, 'home');
    const claudePath = seedClaudeCliFile(home, 'NATIVE-AT', 'NATIVE-RT');
    const reader = vi.fn<ExternalCliReader>((provider) => readExternalCliCredentials(provider, home));
    const refreshTokens: string[] = [];
    let responseNumber = 0;
    const fetchMock = vi.fn<FetchLike>(async (_url, init) => {
      refreshTokens.push(refreshTokenFromInit(init));
      responseNumber += 1;
      return okRefreshResponse('SCHED-AT-' + responseNumber, 'SCHED-RT-' + responseNumber);
    });
    const store = makeStore(fetchMock, reader);
    await store.appendProviderAccount(
      'claude',
      claudeBlock('AT-A', 'RT-A', future(60_000)),
      'A',
    );
    await store.appendProviderAccount(
      'claude',
      claudeBlock('AT-B', 'RT-B', future(60_000)),
      'B',
    );
    const before = nativeFileSnapshot(claudePath);

    await new TokenRefreshScheduler(store, stubLogger).sweep();

    expect(refreshTokens).toEqual(['RT-A', 'RT-B']);
    expect(reader).not.toHaveBeenCalled();
    expect(nativeFileSnapshot(claudePath)).toEqual(before);
    const config = await store.getFullConfig();
    expect(config.claudeAccounts?.every((account) => account.tokens.status === 'authorized')).toBe(true);
  });

  it('coalesces concurrent active refreshes without consulting native credentials', async () => {
    const reader = vi.fn<ExternalCliReader>(() => {
      throw new Error('native credential reader must not run for refresh');
    });
    const fetchMock = vi.fn<FetchLike>(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return okRefreshResponse('AT-NEW', 'RT-NEW');
    });
    const store = makeStore(fetchMock, reader);
    await store.appendProviderAccount('claude', claudeBlock('AT', 'RT'), 'A');

    const [first, second] = await Promise.all([
      store.refreshClaudeToken(),
      store.refreshClaudeToken(),
    ]);
    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(reader).not.toHaveBeenCalled();
  });

  it('starts and disposes the scheduler timer idempotently', () => {
    vi.useFakeTimers();
    try {
      const scheduler = new TokenRefreshScheduler(makeStore(undefined, () => null), stubLogger);
      const sweepSpy = vi.spyOn(scheduler, 'sweep').mockResolvedValue();
      scheduler.start();
      scheduler.start();
      vi.advanceTimersByTime(60_000);
      expect(sweepSpy).toHaveBeenCalledTimes(1);
      scheduler.dispose();
      scheduler.dispose();
      vi.advanceTimersByTime(120_000);
      expect(sweepSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
