/**
 * secrets-cli.test.ts — the `secrets` command family + offline encrypt-on-write
 * (secrets task 5.9).
 *
 * Covers: `secrets encrypt` migrates in place, `secrets status` reports
 * classification + mask WITHOUT leaking the value/envelope, `secrets rotate`
 * re-seals under a new key (new decrypts, old fails), `secrets decrypt --force`
 * restores plaintext (and refuses without --force), and offline `providers add`
 * lands an encrypted apiKey.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runProviders } from '../commands/providers';
import { runSecrets } from '../commands/secrets';
import { loadConfig, setSecretBox } from '../config';
import { isEnvelope, resolveMasterKey, SecretBox } from '../secrets';

let tmpDir: string;
let configPath: string;
let keyFile: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-sec-cli-'));
  configPath = join(tmpDir, 'config.json');
  keyFile = join(tmpDir, 'master.key');
});

afterEach(() => {
  setSecretBox(null);
  vi.restoreAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
});

function writePlaintextConfig(): void {
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        providers: [
          { id: 'openai', apiFormat: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-plain-wxyz' },
          { id: 'env', apiFormat: 'openai', baseUrl: 'https://x/v1', apiKey: '$OPENAI_KEY' },
        ],
        admin: { token: 'admin-secret-1234' },
      },
      null,
      2,
    ),
    'utf8',
  );
}

function captureInfo(): { lines: string[] } {
  const out = { lines: [] as string[] };
  vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
    out.lines.push(args.map(String).join(' '));
  });
  return out;
}

describe('secrets encrypt (5.9)', () => {
  it('migrates plaintext secrets in place; $ENV + non-secret fields untouched', async () => {
    writePlaintextConfig();
    await runSecrets(['encrypt', '--config', configPath, '--master-key-file', keyFile]);
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as {
      providers: Array<Record<string, string>>;
      admin: Record<string, string>;
    };
    expect(isEnvelope(onDisk.providers[0]['apiKey'])).toBe(true);
    expect(onDisk.providers[1]['apiKey']).toBe('$OPENAI_KEY'); // env-ref untouched
    expect(onDisk.providers[0]['baseUrl']).toBe('https://api.openai.com/v1');
    expect(isEnvelope(onDisk.admin['token'])).toBe(true);
    expect(readFileSync(configPath, 'utf8')).not.toContain('sk-plain-wxyz');
    expect(readFileSync(configPath, 'utf8')).not.toContain('admin-secret-1234');

    // It decrypts back with the same key.
    setSecretBox(new SecretBox(resolveMasterKey({ keyFilePath: keyFile })));
    const loaded = loadConfig(configPath);
    expect(loaded.providers[0].apiKey).toBe('sk-plain-wxyz');
    expect(loaded.admin?.token).toBe('admin-secret-1234');
  });
});

describe('secrets status (5.9)', () => {
  it('reports classification + mask but NEVER the value or the envelope', async () => {
    writePlaintextConfig();
    await runSecrets(['encrypt', '--config', configPath, '--master-key-file', keyFile]);
    const cap = captureInfo();
    await runSecrets(['status', '--config', configPath, '--master-key-file', keyFile]);
    const text = cap.lines.join('\n');

    expect(text).toContain('encrypted'); // openai apiKey
    expect(text).toContain('env-ref'); // $ENV provider
    expect(text).toMatch(/\$ENV\(•••\)/);
    // No full secret, no envelope body.
    expect(text).not.toContain('sk-plain-wxyz');
    expect(text).not.toContain('admin-secret-1234');
    expect(text).not.toContain('enc:v1:');
  });

  it('classifies a legacy plaintext field as plaintext (last-4 mask only)', async () => {
    writePlaintextConfig();
    const cap = captureInfo();
    await runSecrets(['status', '--config', configPath, '--master-key-file', keyFile]);
    const text = cap.lines.join('\n');
    expect(text).toContain('plaintext');
    expect(text).toContain('sk-…wxyz'); // last4 mask
    expect(text).not.toContain('sk-plain-wxyz'); // never the full value
  });
});

describe('secrets rotate (5.9)', () => {
  it('re-seals under a new key: new decrypts, old fails', async () => {
    writePlaintextConfig();
    await runSecrets(['encrypt', '--config', configPath, '--master-key-file', keyFile]);
    const oldEnvelope = (JSON.parse(readFileSync(configPath, 'utf8')) as { providers: Array<{ apiKey: string }> })
      .providers[0].apiKey;

    const newKeyFile = join(tmpDir, 'new-master.key');
    await runSecrets([
      'rotate',
      '--config',
      configPath,
      '--master-key-file',
      keyFile,
      '--new-master-key-file',
      newKeyFile,
    ]);

    const rotated = (JSON.parse(readFileSync(configPath, 'utf8')) as { providers: Array<{ apiKey: string }> })
      .providers[0].apiKey;
    expect(rotated).not.toBe(oldEnvelope);

    // New key decrypts.
    const newBox = new SecretBox(resolveMasterKey({ keyFilePath: newKeyFile }));
    expect(newBox.decrypt(rotated)).toBe('sk-plain-wxyz');
    // Old key no longer decrypts the rotated envelope.
    const oldBox = new SecretBox(resolveMasterKey({ keyFilePath: keyFile }));
    expect(() => oldBox.decrypt(rotated)).toThrow();
  });

  it('rotate refuses without --new-master-key-file', async () => {
    writePlaintextConfig();
    await expect(
      runSecrets(['rotate', '--config', configPath, '--master-key-file', keyFile]),
    ).rejects.toThrow(/new-master-key-file/);
  });
});

describe('secrets decrypt --force (5.9)', () => {
  it('refuses without --force', async () => {
    writePlaintextConfig();
    await runSecrets(['encrypt', '--config', configPath, '--master-key-file', keyFile]);
    await expect(
      runSecrets(['decrypt', '--config', configPath, '--master-key-file', keyFile]),
    ).rejects.toThrow(/--force/);
  });

  it('restores plaintext with --force (and warns on stderr)', async () => {
    writePlaintextConfig();
    await runSecrets(['encrypt', '--config', configPath, '--master-key-file', keyFile]);
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runSecrets(['decrypt', '--config', configPath, '--master-key-file', keyFile, '--force']);
    expect(warn).toHaveBeenCalled();
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as { providers: Array<{ apiKey: string }> };
    expect(onDisk.providers[0].apiKey).toBe('sk-plain-wxyz');
    expect(isEnvelope(onDisk.providers[0].apiKey)).toBe(false);
  });
});

describe('offline providers add encrypt-on-write (5.9)', () => {
  it('writes the provider apiKey as an envelope (literal key)', async () => {
    writeFileSync(configPath, JSON.stringify({ providers: [] }, null, 2), 'utf8');
    await runProviders([
      'add',
      'deepseek',
      '--key',
      'sk-deepseek-literal',
      '--config',
      configPath,
      '--master-key-file',
      keyFile,
    ]);
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as { providers: Array<Record<string, string>> };
    expect(onDisk.providers).toHaveLength(1);
    expect(isEnvelope(onDisk.providers[0]['apiKey'])).toBe(true);
    expect(readFileSync(configPath, 'utf8')).not.toContain('sk-deepseek-literal');

    setSecretBox(new SecretBox(resolveMasterKey({ keyFilePath: keyFile })));
    expect(loadConfig(configPath).providers[0].apiKey).toBe('sk-deepseek-literal');
  });

  it('a $ENV key stays literal through offline add', async () => {
    writeFileSync(configPath, JSON.stringify({ providers: [] }, null, 2), 'utf8');
    await runProviders([
      'add',
      'deepseek',
      '--key',
      '$DEEPSEEK_API_KEY',
      '--config',
      configPath,
      '--master-key-file',
      keyFile,
    ]);
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as { providers: Array<Record<string, string>> };
    expect(onDisk.providers[0]['apiKey']).toBe('$DEEPSEEK_API_KEY');
  });
});
