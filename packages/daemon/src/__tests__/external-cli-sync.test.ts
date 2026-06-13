/**
 * external-cli-sync.test.ts — external CLI credential import, conflict
 * warnings, refresh coalescing, and the background refresh scheduler.
 *
 * Drives a REAL `JsonSubscriptionCredentialStore` over a temp `tokens.json` +
 * a real `SecretBox`, with an injected external-CLI reader (never the real
 * home directory) and a mocked OAuth fetch.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ClaudeTokenConfig } from '@omnicross/contracts/account-tokens-types';
import type { FetchLike } from '@omnicross/subscriptions';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildImportedTokens,
  decideExternalImport,
  findDuplicateCredentialIds,
  isExternalDivergent,
} from '../ports/account-sync';
import {
  decodeJwtExpiryMs,
  type ExternalCliCredentials,
  type ExternalCliReader,
  parseClaudeOAuthEnvelope,
  parseCodexTokensEnvelope,
  readExternalCliCredentials,
} from '../ports/external-cli-credentials';
import { createExternalCliStore } from '../ports/external-cli-store';
import { JsonSubscriptionCredentialStore } from '../ports/JsonSubscriptionCredentialStore';
import { resolveMasterKey, SecretBox } from '../secrets';
import { TokenRefreshScheduler } from '../TokenRefreshScheduler';

let tmpDir: string;
let tokensPath: string;
let keyFile: string;

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
  return { authMethod: 'oauth', status: 'authorized', accessToken: at, refreshToken: rt, expiresAt };
}

const future = (ms: number) => new Date(Date.now() + ms).toISOString();
const past = (ms: number) => new Date(Date.now() - ms).toISOString();

const okRefreshResponse = (at: string, rt: string) =>
  new Response(JSON.stringify({ access_token: at, refresh_token: rt, expires_in: 3600 }), {
    headers: { 'Content-Type': 'application/json' },
  });

const failedRefreshResponse = () =>
  new Response(JSON.stringify({ error: 'invalid_grant' }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });

const stubLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-ext-sync-'));
  tokensPath = join(tmpDir, 'tokens.json');
  keyFile = join(tmpDir, 'master.key');
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('external store parsers', () => {
  it('parses the claude claudeAiOauth envelope (ms epoch → ISO)', () => {
    const parsed = parseClaudeOAuthEnvelope({
      claudeAiOauth: {
        accessToken: 'AT',
        refreshToken: 'RT',
        expiresAt: 1_750_000_000_000,
        scopes: ['user:inference'],
      },
    });
    expect(parsed).toEqual({
      accessToken: 'AT',
      refreshToken: 'RT',
      expiresAt: new Date(1_750_000_000_000).toISOString(),
      scopes: ['user:inference'],
    });
  });

  it('rejects a claude file without a usable access token', () => {
    expect(parseClaudeOAuthEnvelope({})).toBeNull();
    expect(parseClaudeOAuthEnvelope({ claudeAiOauth: { accessToken: '' } })).toBeNull();
  });

  it('parses the codex tokens envelope and derives expiry from the JWT exp claim', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const jwt = `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;
    const parsed = parseCodexTokensEnvelope({
      tokens: { access_token: jwt, refresh_token: 'RT', id_token: 'ID' },
    });
    expect(parsed?.accessToken).toBe(jwt);
    expect(parsed?.refreshToken).toBe('RT');
    expect(parsed?.idToken).toBe('ID');
    expect(parsed?.expiresAt).toBe(new Date(exp * 1000).toISOString());
  });

  it('decodeJwtExpiryMs tolerates non-JWT input', () => {
    expect(decodeJwtExpiryMs('not-a-jwt')).toBeUndefined();
  });
});

describe('account-sync decisions', () => {
  const captured = claudeBlock('AT', 'RT');

  it('imports when the external refresh token rotated', () => {
    expect(
      decideExternalImport(captured, { accessToken: 'X', refreshToken: 'RT2', expiresAt: past(1) }),
    ).toBe('import');
  });

  it('imports when the external access token is still valid (same RT)', () => {
    expect(
      decideExternalImport(captured, {
        accessToken: 'X',
        refreshToken: 'RT',
        expiresAt: future(3_600_000),
      }),
    ).toBe('import');
  });

  it('refuses when nothing rotated and the access token is dead (true revocation)', () => {
    expect(
      decideExternalImport(captured, { accessToken: 'X', refreshToken: 'RT', expiresAt: past(1) }),
    ).toBe('not-rotated');
  });

  it('refuses when there is no external credential', () => {
    expect(decideExternalImport(captured, null)).toBe('no-credential');
  });

  it('buildImportedTokens clears error/warning state and carries metadata', () => {
    const imported = buildImportedTokens(
      { ...captured, errorMessage: 'boom', syncWarning: 'external-not-rotated' },
      { accessToken: 'EXT-AT', refreshToken: 'EXT-RT', expiresAt: future(1000) },
    ) as ClaudeTokenConfig;
    expect(imported.accessToken).toBe('EXT-AT');
    expect(imported.refreshToken).toBe('EXT-RT');
    expect(imported.status).toBe('authorized');
    expect(imported.errorMessage).toBeUndefined();
    expect(imported.syncWarning).toBeUndefined();
    expect(imported.authMethod).toBe('oauth');
  });

  it('flags divergence only when the external RT rotated AND is fresher', () => {
    const stored = claudeBlock('AT', 'RT', future(60_000));
    const fresher: ExternalCliCredentials = {
      accessToken: 'X',
      refreshToken: 'RT2',
      expiresAt: future(3_600_000),
    };
    expect(isExternalDivergent(stored, fresher)).toBe(true);
    // Same RT (normal "we refreshed, CLI file stale" direction) → no warning.
    expect(isExternalDivergent(stored, { ...fresher, refreshToken: 'RT' })).toBe(false);
    // Rotated but STALER than stored → no warning.
    expect(isExternalDivergent(stored, { ...fresher, expiresAt: past(1) })).toBe(false);
    expect(isExternalDivergent(stored, null)).toBe(false);
  });

  it('finds duplicate credentials across accounts (both sides flagged)', () => {
    const dup = findDuplicateCredentialIds([
      { id: 'a', tokens: claudeBlock('AT-A', 'SAME') },
      { id: 'b', tokens: claudeBlock('AT-B', 'SAME') },
      { id: 'c', tokens: claudeBlock('AT-C', 'OTHER') },
    ]);
    expect(dup).toEqual(new Set(['a', 'b']));
  });
});

describe('store: external import fallback on refresh failure', () => {
  it('imports the rotated external credential when the refresh fails', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(failedRefreshResponse());
    const external = vi.fn<ExternalCliReader>().mockReturnValue({
      accessToken: 'EXT-AT',
      refreshToken: 'EXT-RT',
      expiresAt: future(3_600_000),
    });
    const store = makeStore(fetchMock, external);
    await store.appendProviderAccount('claude', claudeBlock('AT-old', 'RT-old'), 'A');

    const ok = await store.refreshClaudeToken();
    expect(ok).toBe(true);
    expect(external).toHaveBeenCalledWith('claude');
    const cfg = await store.getFullConfig();
    expect(cfg.claude?.accessToken).toBe('EXT-AT');
    expect(cfg.claude?.refreshToken).toBe('EXT-RT');
    expect(cfg.claude?.status).toBe('authorized');
  });

  it('refreshes once with the rotated RT when the imported access token is expired', async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(failedRefreshResponse()) // our RT → dead
      .mockResolvedValueOnce(okRefreshResponse('AT-minted', 'RT-minted')); // rotated RT
    const external = vi.fn<ExternalCliReader>().mockReturnValue({
      accessToken: 'EXT-AT-dead',
      refreshToken: 'EXT-RT',
      expiresAt: past(1),
    });
    const store = makeStore(fetchMock, external);
    await store.appendProviderAccount('claude', claudeBlock('AT-old', 'RT-old'), 'A');

    const ok = await store.refreshClaudeToken();
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const cfg = await store.getFullConfig();
    expect(cfg.claude?.accessToken).toBe('AT-minted');
    expect(cfg.claude?.refreshToken).toBe('RT-minted');
  });

  it('flags external-not-rotated when the external file holds the same dead credential', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(failedRefreshResponse());
    const external = vi.fn<ExternalCliReader>().mockReturnValue({
      accessToken: 'EXT-AT-dead',
      refreshToken: 'RT-old', // same as ours — never rotated
      expiresAt: past(1),
    });
    const store = makeStore(fetchMock, external);
    await store.appendProviderAccount('claude', claudeBlock('AT-old', 'RT-old'), 'A');

    const ok = await store.refreshClaudeToken();
    expect(ok).toBe(false);
    const cfg = await store.getFullConfig();
    expect(cfg.claude?.status).toBe('expired');
    expect(cfg.claude?.syncWarning).toBe('external-not-rotated');
    const sanitized = await store.listSanitizedAccounts();
    expect(sanitized.claude?.[0].syncWarning).toBe('external-not-rotated');
  });

  it('a successful refresh clears a persisted sync warning', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(failedRefreshResponse());
    const external = vi.fn<ExternalCliReader>().mockReturnValue({
      accessToken: 'X',
      refreshToken: 'RT-old',
      expiresAt: past(1),
    });
    const store = makeStore(fetchMock, external);
    await store.appendProviderAccount('claude', claudeBlock('AT-old', 'RT-old'), 'A');
    await store.refreshClaudeToken(); // → expired + external-not-rotated

    fetchMock.mockResolvedValue(okRefreshResponse('AT-new', 'RT-new'));
    expect(await store.refreshClaudeToken()).toBe(true);
    const cfg = await store.getFullConfig();
    expect(cfg.claude?.syncWarning).toBeUndefined();
    expect(cfg.claude?.status).toBe('authorized');
  });
});

describe('store: list-time conflict warnings', () => {
  it('flags duplicate-token on every account sharing a credential', async () => {
    const store = makeStore(undefined, () => null);
    await store.appendProviderAccount('claude', claudeBlock('AT-A', 'SAME-RT'), 'A');
    await store.appendProviderAccount('claude', claudeBlock('AT-B', 'SAME-RT'), 'B');
    await store.appendProviderAccount('claude', claudeBlock('AT-C', 'OTHER-RT'), 'C');

    const sanitized = await store.listSanitizedAccounts();
    const byLabel = Object.fromEntries(sanitized.claude!.map((a) => [a.label, a.syncWarning]));
    expect(byLabel.A).toBe('duplicate-token');
    expect(byLabel.B).toBe('duplicate-token');
    expect(byLabel.C).toBeUndefined();
  });

  it('flags external-divergent on the active account when the CLI file rotated past it', async () => {
    const external = vi.fn<ExternalCliReader>().mockImplementation((provider) =>
      provider === 'claude'
        ? { accessToken: 'X', refreshToken: 'ROTATED-RT', expiresAt: future(7_200_000) }
        : null,
    );
    const store = makeStore(undefined, external);
    await store.appendProviderAccount(
      'claude',
      claudeBlock('AT-A', 'RT-A', future(60_000)),
      'A',
    );

    const sanitized = await store.listSanitizedAccounts();
    expect(sanitized.claude?.[0].syncWarning).toBe('external-divergent');
  });
});

describe('store: refresh coalescing', () => {
  it('two concurrent active refreshes share one upstream round-trip', async () => {
    const fetchMock = vi.fn<FetchLike>().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return okRefreshResponse('AT-new', 'RT-new');
    });
    const store = makeStore(fetchMock, () => null);
    await store.appendProviderAccount('claude', claudeBlock('AT', 'RT'), 'A');

    const [a, b] = await Promise.all([store.refreshClaudeToken(), store.refreshClaudeToken()]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('external-cli-store: marker-gated write-back (round-trip with the reader)', () => {
  it('writeBack only fires for the marker-named account, merges, backs up once', () => {
    const home = join(tmpDir, 'home');
    const store = createExternalCliStore(home);
    const claudePath = join(home, '.claude', '.credentials.json');
    // Seed a native file with an unrelated key the merge must preserve.
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      claudePath,
      JSON.stringify({ email: 'user@example.com', claudeAiOauth: { accessToken: 'OLD' } }),
      'utf8',
    );

    // Unmanaged (no marker) → never writes.
    expect(
      store.writeBack('claude', 'acc-1', claudeBlock('NEW-AT', 'NEW-RT', future(3_600_000))),
    ).toBe(false);

    store.writeMarker('claude', 'acc-1');
    // Foreign account → still never writes.
    expect(
      store.writeBack('claude', 'acc-2', claudeBlock('EVIL-AT', 'EVIL-RT')),
    ).toBe(false);
    expect(readExternalCliCredentials('claude', home)?.accessToken).toBe('OLD');

    // Owning account → writes; the reader parses the result back (no drift).
    const expiresAt = future(3_600_000);
    expect(store.writeBack('claude', 'acc-1', claudeBlock('NEW-AT', 'NEW-RT', expiresAt))).toBe(
      true,
    );
    const parsed = readExternalCliCredentials('claude', home);
    expect(parsed?.accessToken).toBe('NEW-AT');
    expect(parsed?.refreshToken).toBe('NEW-RT');
    expect(parsed?.expiresAt).toBe(new Date(Date.parse(expiresAt)).toISOString());
    // Unrelated top-level key preserved; original backed up exactly once.
    const raw = JSON.parse(readFileSync(claudePath, 'utf8')) as Record<string, unknown>;
    expect(raw.email).toBe('user@example.com');
    const backup = JSON.parse(
      readFileSync(`${claudePath}.omnicross-backup`, 'utf8'),
    ) as { claudeAiOauth?: { accessToken?: string } };
    expect(backup.claudeAiOauth?.accessToken).toBe('OLD');
    // Second write does NOT clobber the backup with the already-managed content.
    store.writeBack('claude', 'acc-1', claudeBlock('NEWER-AT', 'NEWER-RT'));
    const backupAgain = JSON.parse(
      readFileSync(`${claudePath}.omnicross-backup`, 'utf8'),
    ) as { claudeAiOauth?: { accessToken?: string } };
    expect(backupAgain.claudeAiOauth?.accessToken).toBe('OLD');
  });
});

describe('store: import existing CLI login + refresh write-back (full loop)', () => {
  function makeIntegratedStore(fetchImpl?: FetchLike) {
    const home = join(tmpDir, 'home');
    return {
      home,
      store: new JsonSubscriptionCredentialStore(
        tokensPath,
        makeBox(),
        fetchImpl,
        (p) => readExternalCliCredentials(p, home),
        createExternalCliStore(home),
      ),
    };
  }

  function seedClaudeCliFile(home: string, accessToken: string, refreshToken: string): void {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      join(home, '.claude', '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken,
          refreshToken,
          expiresAt: Date.now() + 3_600_000,
          scopes: ['user:inference'],
        },
      }),
      'utf8',
    );
  }

  it('detects availability, imports as an active managed account', async () => {
    const { home, store } = makeIntegratedStore();
    seedClaudeCliFile(home, 'CLI-AT', 'CLI-RT');

    expect(await store.listExternalCliAvailability()).toEqual({ claude: true, codex: false });

    const result = await store.importExternalCliAccount('claude', 'From CLI');
    expect(result.ok).toBe(true);
    const cfg = await store.getFullConfig();
    expect(cfg.claudeAccounts).toHaveLength(1);
    expect(cfg.claude?.accessToken).toBe('CLI-AT');
    expect(cfg.claude?.refreshToken).toBe('CLI-RT');
    expect(cfg.claude?.status).toBe('authorized');
    expect(cfg.claudeAccounts?.[0].label).toBe('From CLI');
    // Managed ownership recorded for the imported account.
    expect(createExternalCliStore(home).readMarkerAccountId('claude')).toBe(
      cfg.activeClaudeAccountId,
    );
  });

  it('a refresh after import writes the rotated credential back to the CLI file', async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(okRefreshResponse('ROTATED-AT', 'ROTATED-RT'));
    const { home, store } = makeIntegratedStore(fetchMock);
    seedClaudeCliFile(home, 'CLI-AT', 'CLI-RT');
    await store.importExternalCliAccount('claude');

    expect(await store.refreshClaudeToken()).toBe(true);

    // Internal store rotated…
    const cfg = await store.getFullConfig();
    expect(cfg.claude?.accessToken).toBe('ROTATED-AT');
    // …and the external CLI file rotated WITH it (the bare CLI stays signed in).
    const external = readExternalCliCredentials('claude', home);
    expect(external?.accessToken).toBe('ROTATED-AT');
    expect(external?.refreshToken).toBe('ROTATED-RT');
  });

  it('refresh of a NON-managed account leaves the CLI file untouched', async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(okRefreshResponse('ROTATED-AT', 'ROTATED-RT'));
    const { home, store } = makeIntegratedStore(fetchMock);
    seedClaudeCliFile(home, 'CLI-AT', 'CLI-RT');
    // A separately added account (NOT imported) — no marker ownership.
    await store.appendProviderAccount('claude', claudeBlock('OWN-AT', 'OWN-RT'), 'Own');

    expect(await store.refreshClaudeToken()).toBe(true);
    expect(readExternalCliCredentials('claude', home)?.accessToken).toBe('CLI-AT');
  });

  it('auto-import recovery is blocked when the marker names a different account', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(failedRefreshResponse());
    const { home, store } = makeIntegratedStore(fetchMock);
    seedClaudeCliFile(home, 'CLI-AT', 'CLI-ROTATED-RT');
    // The file belongs to another (since-removed) account.
    createExternalCliStore(home).writeMarker('claude', 'someone-else');
    await store.appendProviderAccount('claude', claudeBlock('AT-old', 'RT-old'), 'Mine');

    expect(await store.refreshClaudeToken()).toBe(false);
    const cfg = await store.getFullConfig();
    expect(cfg.claude?.status).toBe('expired');
    expect(cfg.claude?.accessToken).toBe('AT-old'); // never cross-contaminated
  });
});

describe('TokenRefreshScheduler', () => {
  it('refreshes accounts entering the expiry lead window (active + by-id)', async () => {
    const fetchMock = vi.fn<FetchLike>().mockImplementation(async () =>
      okRefreshResponse('AT-fresh', 'RT-fresh'),
    );
    const store = makeStore(fetchMock, () => null);
    // Both expire within the 5-minute lead window; B is active (appended last).
    await store.appendProviderAccount('claude', claudeBlock('AT-A', 'RT-A', future(60_000)), 'A');
    await store.appendProviderAccount('claude', claudeBlock('AT-B', 'RT-B', future(120_000)), 'B');

    const scheduler = new TokenRefreshScheduler(store, stubLogger);
    await scheduler.sweep();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const cfg = await store.getFullConfig();
    for (const account of cfg.claudeAccounts ?? []) {
      expect(account.tokens.accessToken).toBe('AT-fresh');
      expect(account.tokens.status).toBe('authorized');
    }
  });

  it('skips healthy, expired-flagged, and non-refreshable accounts', async () => {
    const fetchMock = vi.fn<FetchLike>();
    const store = makeStore(fetchMock, () => null);
    await store.appendProviderAccount('claude', claudeBlock('AT-A', 'RT-A', future(3_600_000)), 'healthy');
    await store.appendProviderAccount(
      'claude',
      { ...claudeBlock('AT-B', 'RT-B', past(1)), status: 'expired' },
      'dead',
    );
    await store.appendProviderAccount('claude', claudeBlock('AT-C', undefined, future(1000)), 'no-rt');

    const scheduler = new TokenRefreshScheduler(store, stubLogger);
    await scheduler.sweep();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('start()/dispose() arm and clear the interval idempotently', () => {
    vi.useFakeTimers();
    try {
      const store = makeStore(undefined, () => null);
      const scheduler = new TokenRefreshScheduler(store, stubLogger);
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
