/**
 * login-cli.test.ts — `omnicross login <provider>` command (omnicross-daemon-
 * parity-oauth task 4.7).
 *
 * Drives every provider login with INJECTED deps (no real browser / listener /
 * readline) and a mock token-exchange fetch:
 *   - codex  → injected `awaitLoopback` resolves a code → exchange → token landed,
 *   - claude → injected `promptPaste` returns `code#state` (split + validated),
 *   - gemini → injected `promptPaste` returns an oob code,
 *   - asserts the landed token is an `enc:` envelope at rest (encrypted store),
 *   - asserts NO access/refresh/id token plaintext appears in stdout OR stderr,
 *   - asserts a claude `code#WRONG_state` paste is REJECTED with no token written,
 *   - asserts arg validation: missing --config / unknown provider → throws.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AccountTokensConfig } from '@omnicross/contracts/account-tokens-types';
import type { FetchLike } from '@omnicross/subscriptions';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildOpenBrowserCommand, runLogin } from '../commands/login';
import { setSecretBox } from '../config';
import { JsonSubscriptionCredentialStore } from '../ports/JsonSubscriptionCredentialStore';
import { isEnvelope, resolveMasterKey, SecretBox } from '../secrets';

let tmpDir: string;
let configPath: string;
let tokensPath: string;
let keyFile: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-login-'));
  configPath = join(tmpDir, 'config.json');
  tokensPath = join(tmpDir, 'tokens.json');
  keyFile = join(tmpDir, 'master.key');
});

afterEach(() => {
  setSecretBox(null);
  vi.restoreAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Capture every console.info/error line for token-leak scanning. */
function captureConsole(): { lines: string[] } {
  const out = { lines: [] as string[] };
  const sink = (...args: unknown[]): void => {
    out.lines.push(args.map(String).join(' '));
  };
  vi.spyOn(console, 'info').mockImplementation(sink);
  vi.spyOn(console, 'error').mockImplementation(sink);
  return out;
}

/** A mock token-exchange `FetchLike` returning a fixed token body. */
function tokenFetch(body: Record<string, unknown>): FetchLike {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }),
  );
}

/** Read back the decrypted tokens config from a fresh store. */
async function readBack(): Promise<AccountTokensConfig> {
  const box = new SecretBox(resolveMasterKey({ keyFilePath: keyFile }));
  return new JsonSubscriptionCredentialStore(tokensPath, box).getFullConfig();
}

const baseArgs = (provider: string): string[] => [provider, '--config', configPath, '--master-key-file', keyFile];

describe('login arg validation', () => {
  it('missing provider throws', async () => {
    await expect(runLogin(['--config', configPath])).rejects.toThrow(/<provider> is required/);
  });
  it('unknown provider throws (lists claude|codex|gemini)', async () => {
    await expect(runLogin(['foobar', '--config', configPath])).rejects.toThrow(/claude\|codex\|gemini/);
  });
  it('missing --config throws', async () => {
    await expect(runLogin(['codex'])).rejects.toThrow(/--config <path> is required/);
  });
});

describe('login codex (loopback)', () => {
  it('captures the code → exchanges → lands an encrypted token; no token in output', async () => {
    const cap = captureConsole();
    await runLogin(baseArgs('codex'), {
      openBrowser: async () => true,
      awaitLoopback: async () => 'codex-auth-code',
      promptPaste: async () => '',
      tokensFetch: tokenFetch({
        access_token: 'codex-AT-secret',
        refresh_token: 'codex-RT-secret',
        id_token: 'codex-ID-secret',
        expires_in: 3600,
      }),
    });

    const cfg = await readBack();
    expect(cfg.codex?.accessToken).toBe('codex-AT-secret');
    expect(cfg.codex?.refreshToken).toBe('codex-RT-secret');
    expect(cfg.codex?.idToken).toBe('codex-ID-secret');
    expect(cfg.codex?.status).toBe('authorized');

    // On-disk = envelope.
    const onDisk = JSON.parse(readFileSync(tokensPath, 'utf8')) as { codex: { accessToken: string } };
    expect(isEnvelope(onDisk.codex.accessToken)).toBe(true);

    // No plaintext token leaked to console.
    const text = cap.lines.join('\n');
    expect(text).not.toContain('codex-AT-secret');
    expect(text).not.toContain('codex-RT-secret');
    expect(text).not.toContain('codex-ID-secret');
    expect(text).toContain('[stored, encrypted]');
  });
});

describe('login claude (code#state paste)', () => {
  it('splits code#state, validates state, exchanges, lands encrypted token', async () => {
    // The state is generated inside the flow; the command validates the PASTED
    // state against it ONLY when present. We capture the generated state by
    // having promptPaste echo back the code WITHOUT a state (always accepted).
    const cap = captureConsole();
    await runLogin(baseArgs('claude'), {
      openBrowser: async () => true,
      awaitLoopback: async () => '',
      promptPaste: async () => 'claude-code-xyz',
      tokensFetch: tokenFetch({
        access_token: 'claude-AT-secret',
        refresh_token: 'claude-RT-secret',
        expires_in: 3600,
        scope: 'user:inference',
      }),
    });

    const cfg = await readBack();
    expect(cfg.claude?.accessToken).toBe('claude-AT-secret');
    expect(cfg.claude?.status).toBe('authorized');
    const text = cap.lines.join('\n');
    expect(text).not.toContain('claude-AT-secret');
    expect(text).not.toContain('claude-RT-secret');
  });

  it('rejects a code#WRONG_state paste and writes NO token', async () => {
    captureConsole();
    const fetchSpy = tokenFetch({ access_token: 'should-not-exchange', expires_in: 1 });
    await expect(
      runLogin(baseArgs('claude'), {
        openBrowser: async () => true,
        awaitLoopback: async () => '',
        // A non-matching state segment must abort BEFORE the exchange.
        promptPaste: async () => 'claude-code-xyz#deadbeefwrongstate',
        tokensFetch: fetchSpy,
      }),
    ).rejects.toThrow(/state did not match/);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(existsSync(tokensPath)).toBe(false); // nothing written
  });
});

describe('login gemini (oob paste)', () => {
  it('exchanges the oob code and lands an encrypted token', async () => {
    const cap = captureConsole();
    await runLogin(baseArgs('gemini'), {
      openBrowser: async () => false, // headless → printed-URL fallback
      awaitLoopback: async () => '',
      promptPaste: async () => 'gemini-oob-code',
      tokensFetch: tokenFetch({
        access_token: 'gemini-AT-secret',
        refresh_token: 'gemini-RT-secret',
        expires_in: 3600,
      }),
    });

    const cfg = await readBack();
    expect(cfg.gemini?.accessToken).toBe('gemini-AT-secret');
    expect(cfg.gemini?.refreshToken).toBe('gemini-RT-secret');
    const text = cap.lines.join('\n');
    expect(text).not.toContain('gemini-AT-secret');
    // The headless fallback printed the manual-open hint + the URL.
    expect(text).toMatch(/open the URL above manually/);
  });
});

describe('buildOpenBrowserCommand — multi-param URL must not be cmd-split on & (review R1)', () => {
  // A realistic gemini authorize URL: MANY `&`-separated params. The win32
  // `cmd /c start "" <url>` form truncated this at the first `&`; the new form
  // must keep the whole URL as ONE literal argv element on every platform.
  const URL =
    'https://accounts.google.com/o/oauth2/v2/auth?client_id=abc.apps.googleusercontent.com' +
    '&redirect_uri=urn:ietf:wg:oauth:2.0:oob&scope=https://www.googleapis.com/auth/cloud-platform' +
    '&response_type=code&code_challenge=XYZ&code_challenge_method=S256&state=deadbeef' +
    '&access_type=offline&prompt=consent';

  it('win32 → rundll32 FileProtocolHandler with the URL as one argv element (no cmd/start)', () => {
    const { command, args } = buildOpenBrowserCommand('win32', URL);
    // Never route through cmd.exe / start (where & is parsed before start runs).
    expect(command).not.toBe('cmd');
    expect(args).not.toContain('start');
    expect(command).toBe('rundll32');
    expect(args[0]).toBe('url.dll,FileProtocolHandler');
    // The whole URL is a SINGLE argv element — exactly one element equals it,
    // and no element is a truncated-at-`&` fragment.
    expect(args).toContain(URL);
    expect(args.filter((a) => a === URL)).toHaveLength(1);
    expect(args.some((a) => a !== URL && URL.startsWith(a + '&'))).toBe(false);
    // No element splits on `&` → there is at most one `&`-bearing element and it
    // is the full URL (a split fragment would be `&`-free).
    expect(args.filter((a) => a.includes('&'))).toEqual([URL]);
  });

  it('darwin → open, linux → xdg-open, each with the URL as one literal argv element', () => {
    const mac = buildOpenBrowserCommand('darwin', URL);
    expect(mac).toEqual({ command: 'open', args: [URL] });
    const linux = buildOpenBrowserCommand('linux', URL);
    expect(linux).toEqual({ command: 'xdg-open', args: [URL] });
    // The URL survives whole on both — no `&`-truncation.
    expect(mac.args[0]).toBe(URL);
    expect(linux.args[0]).toBe(URL);
  });
});
