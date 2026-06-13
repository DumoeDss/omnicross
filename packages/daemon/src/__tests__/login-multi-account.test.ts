/**
 * login-multi-account.test.ts — `omnicross login claude --label` appends a new
 * account + sets it active (subscription-multi-account task 11.5).
 *
 * Sibling of `login-cli.test.ts`. Seeds one claude account, runs `login claude
 * --label Work`, and asserts: a SECOND account labeled "Work" is appended + set
 * active, the prior account is preserved, the mirror equals the new account's
 * tokens, and the console output stays masked-only (never a token).
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AccountTokensConfig } from '@omnicross/contracts/account-tokens-types';
import type { FetchLike } from '@omnicross/subscriptions';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runLogin } from '../commands/login';
import { setSecretBox } from '../config';
import { JsonSubscriptionCredentialStore } from '../ports/JsonSubscriptionCredentialStore';
import { isEnvelope, resolveMasterKey, SecretBox } from '../secrets';

let tmpDir: string;
let configPath: string;
let tokensPath: string;
let keyFile: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-login-multi-'));
  configPath = join(tmpDir, 'config.json');
  tokensPath = join(tmpDir, 'tokens.json');
  keyFile = join(tmpDir, 'master.key');
});

afterEach(() => {
  setSecretBox(null);
  vi.restoreAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
});

function captureConsole(): { lines: string[] } {
  const out = { lines: [] as string[] };
  const sink = (...args: unknown[]): void => {
    out.lines.push(args.map(String).join(' '));
  };
  vi.spyOn(console, 'info').mockImplementation(sink);
  vi.spyOn(console, 'error').mockImplementation(sink);
  return out;
}

function tokenFetch(body: Record<string, unknown>): FetchLike {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }),
  );
}

async function readBack(): Promise<AccountTokensConfig> {
  const box = new SecretBox(resolveMasterKey({ keyFilePath: keyFile }));
  return new JsonSubscriptionCredentialStore(tokensPath, box).getFullConfig();
}

const baseArgs = (provider: string, label?: string): string[] => [
  provider,
  '--config',
  configPath,
  '--master-key-file',
  keyFile,
  ...(label ? ['--label', label] : []),
];

describe('login claude --label appends + sets active', () => {
  it('appends a labeled account, preserves the prior, sets the new one active', async () => {
    // Seed a first claude account directly via the store.
    const box = new SecretBox(resolveMasterKey({ keyFilePath: keyFile }));
    const seedStore = new JsonSubscriptionCredentialStore(tokensPath, box);
    await seedStore.appendProviderAccount(
      'claude',
      { authMethod: 'oauth', status: 'authorized', accessToken: 'first-AT', refreshToken: 'first-RT' },
      'Personal',
    );

    const cap = captureConsole();
    await runLogin(baseArgs('claude', 'Work'), {
      openBrowser: async () => true,
      awaitLoopback: async () => '',
      promptPaste: async () => 'claude-code-xyz',
      tokensFetch: tokenFetch({
        access_token: 'work-AT-secret',
        refresh_token: 'work-RT-secret',
        expires_in: 3600,
        scope: 'user:inference',
      }),
    });

    const cfg = await readBack();
    expect(cfg.claudeAccounts).toHaveLength(2);
    const work = cfg.claudeAccounts?.find((a) => a.label === 'Work');
    const personal = cfg.claudeAccounts?.find((a) => a.label === 'Personal');
    expect(work).toBeDefined();
    expect(personal).toBeDefined();
    // New account is active + the mirror equals its tokens.
    expect(cfg.activeClaudeAccountId).toBe(work?.id);
    expect(cfg.claude?.accessToken).toBe('work-AT-secret');
    // Prior account preserved untouched.
    expect(personal?.tokens.accessToken).toBe('first-AT');

    // On-disk: both accounts' access tokens are envelopes.
    const onDisk = JSON.parse(readFileSync(tokensPath, 'utf8')) as {
      claudeAccounts: Array<{ tokens: { accessToken: string } }>;
    };
    for (const acc of onDisk.claudeAccounts) {
      expect(isEnvelope(acc.tokens.accessToken)).toBe(true);
    }

    // Output stayed masked-only (no token plaintext).
    const text = cap.lines.join('\n');
    expect(text).not.toContain('work-AT-secret');
    expect(text).not.toContain('work-RT-secret');
    expect(text).not.toContain('first-AT');
    expect(text).toContain('[stored, encrypted]');
  });
});
