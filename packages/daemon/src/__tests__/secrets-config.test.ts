/**
 * secrets-config.test.ts — config.json load/save encryption + pool round-trip +
 * tokens store round-trip + migration (secrets tasks 5.5, 5.6, 5.7).
 *
 * Covers: encrypt-on-write (saveConfig encrypts secrets, baseUrl/models stay
 * plaintext), loadConfig decrypts back byte-identically, the pool loader yields
 * the correct plaintext upstream key (incl. multi-key), `$ENV` never encrypted,
 * legacy plaintext loads with NO box at all, mixed files load, admin.token
 * dual-form, and the credential store read/write round-trip.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type DaemonConfig,
  loadConfig,
  saveConfig,
  setSecretBox,
} from '../config';
import { AutoDisableStore } from '../pool/autoDisableStore';
import { createPoolKeysLoader, setSecretBox as setPoolSecretBox } from '../pool/loadPoolKeys';
import { JsonSubscriptionCredentialStore } from '../ports/JsonSubscriptionCredentialStore';
import { isEnvelope, resolveMasterKey, SecretBox } from '../secrets';

let tmpDir: string;
let box: SecretBox;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-sec-cfg-'));
  box = new SecretBox(resolveMasterKey({ keyFilePath: join(tmpDir, 'master.key') }));
});

afterEach(() => {
  setSecretBox(null);
  setPoolSecretBox(null);
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeRaw(path: string, obj: unknown): void {
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

describe('config secrets round-trip (5.5)', () => {
  it('saveConfig encrypts secrets; non-secret fields stay plaintext; loadConfig decrypts', () => {
    const configPath = join(tmpDir, 'config.json');
    const cfg: DaemonConfig = {
      providers: [
        {
          id: 'openai',
          apiFormat: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-literal-secret-aaaa',
          models: ['gpt-4o'],
        },
      ],
    };
    setSecretBox(box);
    saveConfig(configPath, cfg);

    // On disk: apiKey is an envelope; baseUrl/models/id are plaintext JSON.
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const p0 = (onDisk['providers'] as Array<Record<string, unknown>>)[0];
    expect(isEnvelope(String(p0['apiKey']))).toBe(true);
    expect(p0['baseUrl']).toBe('https://api.openai.com/v1');
    expect(p0['models']).toEqual(['gpt-4o']);
    expect(readFileSync(configPath, 'utf8')).not.toContain('sk-literal-secret-aaaa');

    // loadConfig with the box decrypts back byte-identically.
    const loaded = loadConfig(configPath);
    expect(loaded.providers[0].apiKey).toBe('sk-literal-secret-aaaa');
  });

  it('the pool loader yields the decrypted upstream key after encrypt→load', async () => {
    const configPath = join(tmpDir, 'config.json');
    setSecretBox(box);
    setPoolSecretBox(box);
    saveConfig(configPath, {
      providers: [
        { id: 'p', apiFormat: 'openai', baseUrl: 'https://x/v1', apiKey: 'sk-upstream-zzz9' },
      ],
    });
    const cfg = loadConfig(configPath);
    const loader = createPoolKeysLoader((id) => cfg.providers.find((p) => p.id === id), new AutoDisableStore());
    const keys = await loader('p');
    expect(keys).toHaveLength(1);
    expect(keys[0].apiKey).toBe('sk-upstream-zzz9');
  });

  it('multi-key pool: each apiKeys[].apiKey is an independent envelope, decrypts to its own value', async () => {
    const configPath = join(tmpDir, 'config.json');
    setSecretBox(box);
    setPoolSecretBox(box);
    saveConfig(configPath, {
      providers: [
        {
          id: 'p',
          apiFormat: 'openai',
          baseUrl: 'https://x/v1',
          apiKey: '',
          apiKeys: [
            { id: 'k1', apiKey: 'sk-key-one' },
            { id: 'k2', apiKey: 'sk-key-two' },
          ],
        },
      ],
    });
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const pool = (onDisk['providers'] as Array<Record<string, unknown>>)[0]['apiKeys'] as Array<Record<string, unknown>>;
    expect(isEnvelope(String(pool[0]['apiKey']))).toBe(true);
    expect(isEnvelope(String(pool[1]['apiKey']))).toBe(true);
    expect(String(pool[0]['apiKey'])).not.toBe(String(pool[1]['apiKey']));

    const cfg = loadConfig(configPath);
    const loader = createPoolKeysLoader((id) => cfg.providers.find((p) => p.id === id), new AutoDisableStore());
    const keys = await loader('p');
    expect(keys.map((k) => k.apiKey).sort()).toEqual(['sk-key-one', 'sk-key-two']);
  });
});

describe('migration / tri-state on disk (5.6)', () => {
  it('a $ENV reference is NEVER encrypted on write', () => {
    const configPath = join(tmpDir, 'config.json');
    setSecretBox(box);
    saveConfig(configPath, {
      providers: [{ id: 'p', apiFormat: 'openai', baseUrl: 'https://x/v1', apiKey: '$OPENAI_KEY' }],
    });
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const p0 = (onDisk['providers'] as Array<Record<string, unknown>>)[0];
    expect(p0['apiKey']).toBe('$OPENAI_KEY');
  });

  it('a legacy ALL-PLAINTEXT config loads with NO box set (zero migration needed)', () => {
    const configPath = join(tmpDir, 'config.json');
    writeRaw(configPath, {
      providers: [{ id: 'p', apiFormat: 'openai', baseUrl: 'https://x/v1', apiKey: 'sk-legacy-plain' }],
    });
    // No box → passthrough.
    const loaded = loadConfig(configPath);
    expect(loaded.providers[0].apiKey).toBe('sk-legacy-plain');
  });

  it('a LAZY box loading a pure-plaintext config does NOT auto-generate the keyfile', () => {
    const configPath = join(tmpDir, 'config.json');
    const keyFile = join(tmpDir, 'lazy-master.key');
    writeRaw(configPath, {
      providers: [
        { id: 'p', apiFormat: 'openai', baseUrl: 'https://x/v1', apiKey: 'sk-legacy-plain' },
        { id: 'e', apiFormat: 'openai', baseUrl: 'https://x/v1', apiKey: '$ENV_KEY' },
      ],
      admin: { token: 'plain-admin' },
    });
    // Lazy box keyed to a file that does NOT yet exist.
    setSecretBox(new SecretBox(() => resolveMasterKey({ keyFilePath: keyFile })));
    const loaded = loadConfig(configPath);
    // All plaintext / $ENV → only tri-state passthroughs ran (no encrypt/decrypt).
    expect(loaded.providers[0].apiKey).toBe('sk-legacy-plain');
    expect(loaded.providers[1].apiKey).toBe('$ENV_KEY');
    expect(loaded.admin?.token).toBe('plain-admin');
    // The key was never touched → NO keyfile materialized.
    expect(existsSync(keyFile)).toBe(false);
  });

  it('a MIXED file (enc / plaintext / $ENV) loads correctly', () => {
    const configPath = join(tmpDir, 'config.json');
    const encOpenai = box.encrypt('sk-encrypted-one');
    writeRaw(configPath, {
      providers: [
        { id: 'enc', apiFormat: 'openai', baseUrl: 'https://x/v1', apiKey: encOpenai },
        { id: 'plain', apiFormat: 'openai', baseUrl: 'https://x/v1', apiKey: 'sk-plain-two' },
        { id: 'env', apiFormat: 'openai', baseUrl: 'https://x/v1', apiKey: '$ENV_THREE' },
      ],
    });
    setSecretBox(box);
    const loaded = loadConfig(configPath);
    expect(loaded.providers[0].apiKey).toBe('sk-encrypted-one');
    expect(loaded.providers[1].apiKey).toBe('sk-plain-two');
    expect(loaded.providers[2].apiKey).toBe('$ENV_THREE');
  });

  it('encrypt-on-write does not re-encrypt an already-enc field (idempotent migration)', () => {
    const configPath = join(tmpDir, 'config.json');
    setSecretBox(box);
    saveConfig(configPath, {
      providers: [{ id: 'p', apiFormat: 'openai', baseUrl: 'https://x/v1', apiKey: 'sk-x' }],
    });
    const firstEnvelope = (JSON.parse(readFileSync(configPath, 'utf8')) as { providers: Array<{ apiKey: string }> })
      .providers[0].apiKey;
    // Load (decrypts) then save again — the value should re-seal but still decrypt.
    const cfg = loadConfig(configPath);
    saveConfig(configPath, cfg);
    const secondEnvelope = (JSON.parse(readFileSync(configPath, 'utf8')) as { providers: Array<{ apiKey: string }> })
      .providers[0].apiKey;
    expect(isEnvelope(secondEnvelope)).toBe(true);
    expect(secondEnvelope.startsWith('enc:enc:')).toBe(false);
    expect(loadConfig(configPath).providers[0].apiKey).toBe('sk-x');
    // First + second are both valid envelopes of the same plaintext.
    void firstEnvelope;
  });
});

describe('admin.token dual-form (5.7)', () => {
  it('plaintext admin.token loads as plaintext (no box)', () => {
    const configPath = join(tmpDir, 'config.json');
    writeRaw(configPath, {
      providers: [{ id: 'p', apiFormat: 'openai', baseUrl: 'https://x/v1', apiKey: 'sk-x' }],
      admin: { token: 'my-secret' },
    });
    expect(loadConfig(configPath).admin?.token).toBe('my-secret');
  });

  it('encrypted admin.token decrypts back to plaintext for the constant-time compare', () => {
    const configPath = join(tmpDir, 'config.json');
    setSecretBox(box);
    saveConfig(configPath, {
      providers: [{ id: 'p', apiFormat: 'openai', baseUrl: 'https://x/v1', apiKey: 'sk-x' }],
      admin: { token: 'my-secret', port: 8766 },
    });
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as { admin: { token: string; port: number } };
    expect(isEnvelope(onDisk.admin.token)).toBe(true);
    expect(onDisk.admin.port).toBe(8766); // non-secret admin field untouched
    expect(loadConfig(configPath).admin?.token).toBe('my-secret');
  });
});

describe('subscription credential store round-trip (5.5)', () => {
  it('writes tokens encrypted, reads them back as plaintext, preserves other blocks', async () => {
    const tokensPath = join(tmpDir, 'tokens.json');
    const store = new JsonSubscriptionCredentialStore(tokensPath, box);

    await store.writeProviderTokens('claude', {
      authMethod: 'oauth',
      status: 'authorized',
      accessToken: 'oat-claude-xyz',
      refreshToken: 'rt-claude-xyz',
    });

    // On disk: token material encrypted, metadata plaintext.
    const onDisk = JSON.parse(readFileSync(tokensPath, 'utf8')) as { claude: Record<string, string> };
    expect(isEnvelope(onDisk.claude['accessToken'])).toBe(true);
    expect(isEnvelope(onDisk.claude['refreshToken'])).toBe(true);
    expect(onDisk.claude['authMethod']).toBe('oauth');
    expect(onDisk.claude['status']).toBe('authorized');
    expect(readFileSync(tokensPath, 'utf8')).not.toContain('oat-claude-xyz');

    // Read path decrypts → plaintext bearer.
    expect(await store.getValidClaudeAccessToken()).toBe('oat-claude-xyz');
    const full = await store.getFullConfig();
    expect(full.claude?.accessToken).toBe('oat-claude-xyz');

    // Read-merge-write a SECOND provider keeps claude's encrypted block intact.
    await store.writeProviderTokens('opencodego', {
      authMethod: 'manual',
      status: 'configured',
      apiKey: 'sk-ocg-static',
    });
    const onDisk2 = JSON.parse(readFileSync(tokensPath, 'utf8')) as {
      claude: Record<string, string>;
      opencodego: Record<string, string>;
    };
    expect(isEnvelope(onDisk2.claude['accessToken'])).toBe(true);
    expect(isEnvelope(onDisk2.opencodego['apiKey'])).toBe(true);
    expect(await store.getValidClaudeAccessToken()).toBe('oat-claude-xyz');
    expect(await store.getValidOpenCodeGoApiKey()).toBe('sk-ocg-static');
  });
});

describe('subscription credential store wrong-key / tamper fail-fast (5.4 mirror)', () => {
  it('FAILS FAST (loud, secret-free) when tokens.json is encrypted with a DIFFERENT key', async () => {
    const tokensPath = join(tmpDir, 'tokens.json');
    // Encrypt with box A (the suite's `box`).
    const writer = new JsonSubscriptionCredentialStore(tokensPath, box);
    await writer.writeProviderTokens('claude', {
      authMethod: 'oauth',
      status: 'authorized',
      accessToken: 'oat-claude-SENTINEL',
    });
    const ciphertext = (JSON.parse(readFileSync(tokensPath, 'utf8')) as { claude: { accessToken: string } })
      .claude.accessToken;

    // A store keyed to a DIFFERENT master key (box B) must NOT silently report
    // "no token" — it must throw the box's clear, secret-free error.
    const boxB = new SecretBox(resolveMasterKey({ keyFilePath: join(tmpDir, 'other-master.key') }));
    const reader = new JsonSubscriptionCredentialStore(tokensPath, boxB);

    let thrown: Error | undefined;
    try {
      await reader.getValidClaudeAccessToken();
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown, 'wrong-key read must fail fast, not return null').toBeDefined();
    expect(thrown!.message).toMatch(/master key does not match|tampered/i);
    // Secret-free: no ciphertext, no plaintext token.
    expect(thrown!.message).not.toContain(ciphertext);
    expect(thrown!.message).not.toContain('oat-claude-SENTINEL');

    // getFullConfig + a read-modify-write (writeProviderTokens) likewise propagate.
    await expect(reader.getFullConfig()).rejects.toThrow(/master key does not match|tampered/i);
    await expect(
      reader.writeProviderTokens('codex', { authMethod: 'oauth', status: 'authorized', accessToken: 'x' }),
    ).rejects.toThrow(/master key does not match|tampered/i);
  });

  it('still TOLERATES a missing file and a corrupt-JSON file (returns empty, no throw)', async () => {
    const missingStore = new JsonSubscriptionCredentialStore(join(tmpDir, 'nope.json'), box);
    expect(await missingStore.getValidClaudeAccessToken()).toBeNull();
    expect((await missingStore.getFullConfig()).updatedAt).toBe('');

    const corruptPath = join(tmpDir, 'corrupt.json');
    writeFileSync(corruptPath, '{ not valid json', 'utf8');
    const corruptStore = new JsonSubscriptionCredentialStore(corruptPath, box);
    expect(await corruptStore.getValidClaudeAccessToken()).toBeNull();
    expect((await corruptStore.getFullConfig()).updatedAt).toBe('');
  });
});
