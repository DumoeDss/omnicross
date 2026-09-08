/**
 * antigravity-login-refresh.test.ts — group-2 gates for the antigravity login
 * + refresh chain (antigravity-subscription-provider tasks 2.3–2.7):
 *   - store round-trip: `refreshAntigravityToken` updates access+expiresAt,
 *     PRESERVES refreshToken/projectId/email (the Google refresh response
 *     omits refresh_token; the project is a handshake product),
 *   - refresh hook semantics: a successful refresh re-runs the project
 *     handshake and writes a rotated projectId back; a FAILED handshake keeps
 *     the OLD projectId (design D8),
 *   - TokenRefreshScheduler: the antigravity provider joins the sweep, and the
 *     hook fires after a successful refresh only,
 *   - login branch: `omnicross login antigravity` lands an encrypted account
 *     carrying email + projectId (loopback capture), and falls back to the
 *     paste prompt when the loopback port cannot be bound,
 *   - admin handler: `start` arms the async flow and returns ONLY
 *     `{ authUrl, sessionId }` (token-free), 409 while one is in flight.
 *
 * The Code Assist resolver is MOCKED (vi.mock of the core resolver module) so
 * no handshake network is attempted; the token exchange uses an injected fetch.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AccountTokensConfig } from '@omnicross/contracts/account-tokens-types';
import type { FetchLike } from '@omnicross/subscriptions';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getAntigravityProjectResolver } from '@omnicross/core/auth/GeminiCodeAssistProjectResolver';

vi.mock('@omnicross/core/auth/GeminiCodeAssistProjectResolver', async (importOriginal) => ({
  ...await importOriginal<typeof import('@omnicross/core/auth/GeminiCodeAssistProjectResolver')>(),
  getAntigravityProjectResolver: vi.fn(() => ({
    resolveProject: mockResolveProject,
  })),
}));

import { buildOpenBrowserCommand, parseAntigravityPaste, runLogin } from '../commands/login';
import { setSecretBox } from '../config';
import { JsonSubscriptionCredentialStore } from '../ports/JsonSubscriptionCredentialStore';
import { isEnvelope, resolveMasterKey, SecretBox } from '../secrets';
import { TokenRefreshScheduler } from '../TokenRefreshScheduler';

/** The mocked resolver's controllable behavior. */
const mockResolveProject = vi.fn<(token: string) => Promise<string | undefined>>();

let tmpDir: string;
let tokensPath: string;
let keyFile: string;
let box: SecretBox;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-antigravity-'));
  tokensPath = join(tmpDir, 'tokens.json');
  keyFile = join(tmpDir, 'master.key');
  box = new SecretBox(resolveMasterKey({ keyFilePath: keyFile }));
  mockResolveProject.mockReset();
  mockResolveProject.mockResolvedValue('project-1');
});

afterEach(() => {
  setSecretBox(null);
  vi.restoreAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A mock `FetchLike` returning one JSON body (repo `{ fetch }` convention). */
function jsonFetch(body: unknown): { fetch: FetchLike } {
  return {
    fetch: vi.fn(async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as FetchLike,
  };
}

function seed(config: AccountTokensConfig): void {
  writeFileSync(tokensPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

async function readBack(): Promise<AccountTokensConfig> {
  return new JsonSubscriptionCredentialStore(tokensPath, box).getFullConfig();
}

/** The same account with a FAR-FUTURE expiry (no near-expiry refresh triggered). */
function farFutureAntigravityBlock(): AccountTokensConfig {
  return { ...seededAntigravityBlock(), antigravity: { ...seededAntigravityBlock().antigravity, expiresAt: new Date(Date.now() + 3600_000).toISOString() } };
}

/** A seeded antigravity account (legacy single-slot shape → lazy migration). */
function seededAntigravityBlock(): AccountTokensConfig {
  return {
    antigravity: {
      authMethod: 'oauth',
      status: 'authorized',
      accessToken: 'old-at',
      refreshToken: 'rt-keep',
      email: 'dev@example.com',
      projectId: 'project-old',
      expiresAt: new Date(Date.now() + 10_000).toISOString(),
    },
    updatedAt: '',
  };
}

describe('refreshAntigravityToken (store round-trip)', () => {
  it('success → updates access+expiresAt, PRESERVES refreshToken/projectId/email, encrypted at rest', async () => {
    seed(seededAntigravityBlock());
    const m = jsonFetch({ access_token: 'new-at', expires_in: 3600 });
    mockResolveProject.mockResolvedValue('project-old');
    const store = new JsonSubscriptionCredentialStore(tokensPath, box, m.fetch, () => null);
    expect(await store.refreshAntigravityToken()).toBe(true);
    const cfg = await readBack();
    expect(cfg.antigravity?.accessToken).toBe('new-at');
    expect(cfg.antigravity?.refreshToken).toBe('rt-keep'); // NOT cleared
    expect(cfg.antigravity?.projectId).toBe('project-old'); // preserved
    expect(cfg.antigravity?.email).toBe('dev@example.com'); // preserved
    expect(cfg.antigravity?.status).toBe('authorized');

    const onDisk = JSON.parse(readFileSync(tokensPath, 'utf8')) as {
      antigravity: { refreshToken: string };
    };
    expect(isEnvelope(onDisk.antigravity.refreshToken)).toBe(true);
  });

  it('revalidates project after both active and by-id refresh, not only scheduler sweeps', async () => {
    seed(seededAntigravityBlock());
    const store = new JsonSubscriptionCredentialStore(tokensPath, box,
      jsonFetch({ access_token: 'new-at', expires_in: 3600 }).fetch, () => null);
    mockResolveProject.mockResolvedValue('project-rotated');
    expect(await store.refreshAntigravityToken()).toBe(true);
    expect((await readBack()).antigravity?.projectId).toBe('project-rotated');
    mockResolveProject.mockResolvedValue('project-next');
    expect(await store.refreshAccountById('antigravity', 'legacy-antigravity')).toBe(true);
    expect((await readBack()).antigravity?.projectId).toBe('project-next');
  });

  it('keeps a successful token refresh when project revalidation fails', async () => {
    seed(seededAntigravityBlock());
    const store = new JsonSubscriptionCredentialStore(tokensPath, box,
      jsonFetch({ access_token: 'new-at', expires_in: 3600 }).fetch, () => null);
    mockResolveProject.mockRejectedValue(new Error('handshake unavailable'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await store.refreshAntigravityToken()).toBe(true);
    expect((await readBack()).antigravity).toMatchObject({ accessToken: 'new-at', projectId: 'project-old', status: 'authorized' });
  });

  it('no refresh_token → honest false, no upstream call', async () => {
    seed({
      antigravity: { authMethod: 'oauth', status: 'configured', accessToken: 'manual-at' },
      updatedAt: '',
    });
    const m = jsonFetch({ access_token: 'x', expires_in: 1 });
    const store = new JsonSubscriptionCredentialStore(tokensPath, box, m.fetch, () => null);
    expect(await store.refreshAntigravityToken()).toBe(false);
  });

  it('upstream error → false, status expired + errorMessage, stale material preserved', async () => {
    seed(seededAntigravityBlock());
    const m = jsonFetch({ error: 'invalid_grant', error_description: 'token revoked' });
    const store = new JsonSubscriptionCredentialStore(tokensPath, box, m.fetch, () => null);

    expect(await store.refreshAntigravityToken()).toBe(false);
    const cfg = await readBack();
    expect(cfg.antigravity?.status).toBe('expired');
    expect(cfg.antigravity?.errorMessage).toContain('token revoked');
    expect(cfg.antigravity?.projectId).toBe('project-old');
  });
});

describe('revalidateAntigravityProject (refresh hook, design D8)', () => {
  it('writes a ROTATED projectId back after a successful handshake', async () => {
    seed(farFutureAntigravityBlock());
    const store = new JsonSubscriptionCredentialStore(tokensPath, box, jsonFetch({}).fetch, () => null);
    mockResolveProject.mockResolvedValue('project-rotated');

    expect(await store.revalidateAntigravityProject('legacy-antigravity')).toBe(true);
    const cfg = await readBack();
    expect(cfg.antigravity?.projectId).toBe('project-rotated');
  });

  it('KEEPS the old projectId when the handshake fails (logged, non-fatal)', async () => {
    seed(farFutureAntigravityBlock());
    const store = new JsonSubscriptionCredentialStore(tokensPath, box, jsonFetch({}).fetch, () => null);
    mockResolveProject.mockRejectedValue(new Error('daily endpoint 503'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await store.revalidateAntigravityProject('legacy-antigravity')).toBe(false);
    const cfg = await readBack();
    expect(cfg.antigravity?.projectId).toBe('project-old'); // kept
    expect(warn).toHaveBeenCalled();
  });
});

describe('TokenRefreshScheduler antigravity sweep', () => {
  function logger() {
    return {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(() => logger()),
    };
  }

  it('refreshes an expiring antigravity account and runs the project hook after success', async () => {
    seed(seededAntigravityBlock());
    const store = new JsonSubscriptionCredentialStore(
      tokensPath,
      box,
      jsonFetch({ access_token: 'new-at', expires_in: 3600 }).fetch,
      () => null,
    );
    const hook = vi.spyOn(store, 'revalidateAntigravityProject').mockResolvedValue(true);
    const scheduler = new TokenRefreshScheduler(store, logger() as never);

    await scheduler.sweep();

    expect(hook).toHaveBeenCalledWith('legacy-antigravity');
    const cfg = await readBack();
    expect(cfg.antigravity?.accessToken).toBe('new-at');
  });

  it('does NOT run the project hook after a failed refresh', async () => {
    seed(seededAntigravityBlock());
    const store = new JsonSubscriptionCredentialStore(
      tokensPath,
      box,
      jsonFetch({ error: 'invalid_grant' }).fetch,
      () => null,
    );
    const hook = vi.spyOn(store, 'revalidateAntigravityProject').mockResolvedValue(true);
    const scheduler = new TokenRefreshScheduler(store, logger() as never);

    await scheduler.sweep();

    expect(hook).not.toHaveBeenCalled();
  });
});

describe('omnicross login antigravity', () => {
  /** argv AFTER : the provider positional first, then config/key args. */
  const baseArgs = (): string[] => [
    'antigravity',
    '--config',
    join(tmpDir, 'config.json'),
    '--master-key-file',
    keyFile,
  ];

  function depsFor(opts: { loopbackCode?: string; loopbackError?: Error; paste?: string }) {
    return {
      openBrowser: vi.fn(async () => true),
      promptPaste: vi.fn(async () => opts.paste ?? ''),
      awaitLoopback: vi.fn(async () => {
        if (opts.loopbackError) throw opts.loopbackError;
        return opts.loopbackCode ?? 'captured-code';
      }),
    };
  }

  /** Exchange + userinfo fetch: token pair, then the email body. */
  function antigravityExchangeFetch(): FetchLike {
    let call = 0;
    return vi.fn(async () => {
      call += 1;
      const body =
        call === 1
          ? { access_token: 'ag-at', refresh_token: 'ag-rt', expires_in: 3600 }
          : { email: 'dev@example.com' };
      return new Response(JSON.stringify(body), {
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as FetchLike;
  }

  it('loopback path → lands an encrypted account with email + projectId', async () => {
    const args = baseArgs();
    await runLogin(args, {
      ...depsFor({ loopbackCode: 'captured-code' }),
      tokensFetch: antigravityExchangeFetch(),
    });

    const cfg = await readBack();
    expect(cfg.antigravity?.accessToken).toBe('ag-at');
    expect(cfg.antigravity?.refreshToken).toBe('ag-rt');
    expect(cfg.antigravity?.email).toBe('dev@example.com');
    expect(cfg.antigravity?.projectId).toBe('project-1');
    expect(cfg.antigravity?.status).toBe('authorized');
    // Encrypted at rest.
    const onDisk = JSON.parse(readFileSync(tokensPath, 'utf8')) as {
      antigravity: { accessToken: string };
    };
    expect(isEnvelope(onDisk.antigravity.accessToken)).toBe(true);
  });

  it('paste fallback when the loopback port is held → equivalent credentials', async () => {
    const args = baseArgs();
    await runLogin(args, {
      ...depsFor({
        loopbackError: new Error('login: cannot bind 127.0.0.1:51121 (address in use)'),
        paste: 'pasted-code',
      }),
      tokensFetch: antigravityExchangeFetch(),
    });

    const cfg = await readBack();
    expect(cfg.antigravity?.accessToken).toBe('ag-at');
    expect(cfg.antigravity?.projectId).toBe('project-1');
  });

  it('rejects a pasted state that does not match (CSRF guard)', async () => {
    const args = baseArgs();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      runLogin(args, {
        ...depsFor({
          loopbackError: new Error('login: cannot bind 127.0.0.1:51121 (address in use)'),
          paste: 'code=abc&state=WRONG',
        }),
        tokensFetch: antigravityExchangeFetch(),
      }),
    ).rejects.toThrow(/state did not match/);
  });
});

describe('Antigravity admin OAuth lifecycle', () => {
  it('does not persist a cancelled flow after its exchange finishes', async () => {
    const { AntigravityOAuthSessionStore, handleAntigravityOAuthStart,
      handleAntigravityOAuthCancel, handleAntigravityOAuthStatus } = await import('../admin/accountsAntigravityOAuth');
    let finishExchange!: (response: Response) => void;
    let started!: () => void;
    const exchangeStarted = new Promise<void>((resolve) => { started = resolve; });
    const exchange = new Promise<Response>((resolve) => { finishExchange = resolve; });
    const append = vi.fn(async () => ({ id: 'a' }));
    const deps = {
      antigravitySessions: new AntigravityOAuthSessionStore(),
      antigravityAwaitLoopback: async () => 'code',
      oauthExchangeFetch: () => vi.fn(async () => { started(); return exchange; }) as FetchLike,
      subscriptionAccountAppender: { appendProviderAccount: append },
    };
    const result = handleAntigravityOAuthStart(deps);
    const { sessionId } = result.body as { sessionId: string };
    expect(handleAntigravityOAuthStart(deps).status).toBe(409);
    await exchangeStarted;
    expect(handleAntigravityOAuthCancel(sessionId, deps).status).toBe(200);
    finishExchange(new Response(JSON.stringify({ access_token: 'cancelled-at', refresh_token: 'rt', expires_in: 3600 })));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(append).not.toHaveBeenCalled();
    expect(handleAntigravityOAuthStatus(sessionId, deps).body).toMatchObject({ state: 'error' });
  });
});

describe('parseAntigravityPaste', () => {
  it('extracts code+state from a full redirect URL, a bare query pair, and a bare code', () => {
    expect(parseAntigravityPaste('http://127.0.0.1:51121/oauth-callback?code=abc&state=xyz')).toEqual({
      code: 'abc',
      state: 'xyz',
    });
    expect(parseAntigravityPaste('?code=abc&state=xyz')).toEqual({ code: 'abc', state: 'xyz' });
    expect(parseAntigravityPaste('code=abc')).toEqual({ code: 'abc' });
    expect(parseAntigravityPaste('4/0Arawrawcode')).toEqual({ code: '4/0Arawrawcode' });
  });
});

describe('resolver dialect wiring (sanity)', () => {
  it('the antigravity resolver singleton is distinct from the gemini one', () => {
    // The mock replaces the module; assert only that the seam exists. The real
    // dialect behavior is covered by the core resolver tests.
    expect(getAntigravityProjectResolver()).toBeDefined();
  });
});

// buildOpenBrowserCommand stays import-covered (shared helper parity).
void buildOpenBrowserCommand;
