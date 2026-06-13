/**
 * providers-cli.test.ts — `omnicross providers presets|add` CLI assertions
 * (design D4/D6). Drives the real `runProviders` against a temp config.json and
 * reads it back with `loadConfig`.
 *
 * Asserts: add writes the preset-derived row ($ENV_VAR literal preserved, id/
 * baseUrl overrides honored); unknown presetId / excluded preset / missing key /
 * id conflict each throw AND leave config.json unchanged; presets lists both the
 * mappable and the excluded sets.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runProviders } from '../commands/providers';
import { type DaemonConfig, loadConfig, setSecretBox } from '../config';
import { resolveMasterKey, SecretBox } from '../secrets';

let tmpDir: string;
let configPath: string;
let keyFile: string;

/** Seed an empty (or pre-populated) daemon config.json. */
function seedConfig(providers: unknown[] = []): void {
  writeFileSync(configPath, JSON.stringify({ providers }, null, 2), 'utf8');
}

/**
 * Load the config with a box keyed to the test's temp master.key, so encrypted-
 * on-write secrets (from `runProviders` offline encrypt-on-write) decrypt back
 * for the value assertions. `runProviders` passes the SAME `--master-key-file`
 * (see `args` helper) so the key matches.
 */
function loadDecrypted(): DaemonConfig {
  setSecretBox(new SecretBox(resolveMasterKey({ keyFilePath: keyFile })));
  try {
    return loadConfig(configPath);
  } finally {
    setSecretBox(null);
  }
}

/** Append the hermetic `--master-key-file` so no `runProviders` touches ~/.omnicross. */
function args(...rest: string[]): string[] {
  return [...rest, '--master-key-file', keyFile];
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-providers-cli-'));
  configPath = join(tmpDir, 'config.json');
  keyFile = join(tmpDir, 'master.key');
  seedConfig();
});

afterEach(() => {
  setSecretBox(null);
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('providers add', () => {
  it('writes a preset-derived provider row to config.json', async () => {
    await runProviders(args('add', 'openai', '--key', 'sk-x', '--config', configPath));
    const cfg = loadDecrypted();
    expect(cfg.providers).toHaveLength(1);
    const row = cfg.providers[0];
    expect(row.id).toBe('openai');
    expect(row.apiFormat).toBe('openai');
    expect(row.apiKey).toBe('sk-x');
    expect(row.baseUrl.length).toBeGreaterThan(0);
  });

  it('preserves a $ENV_VAR key literally (no expansion at add time)', async () => {
    await runProviders(args('add', 'openai', '--key', '$OPENAI_KEY', '--config', configPath));
    expect(loadDecrypted().providers[0].apiKey).toBe('$OPENAI_KEY');
  });

  it('honors --id and --base-url overrides', async () => {
    await runProviders(
      args('add', 'openai', '--key', 'sk-x', '--id', 'my-oai', '--base-url', 'https://proxy/v1', '--config', configPath),
    );
    const row = loadDecrypted().providers[0];
    expect(row.id).toBe('my-oai');
    expect(row.baseUrl).toBe('https://proxy/v1');
  });

  it('translates a google preset to a gemini row', async () => {
    await runProviders(args('add', 'gemini', '--key', 'AIza-x', '--config', configPath));
    expect(loadDecrypted().providers[0].apiFormat).toBe('gemini');
  });

  it('throws on an unknown presetId and leaves config unchanged', async () => {
    await expect(
      runProviders(args('add', 'nope-not-a-preset', '--key', 'sk-x', '--config', configPath)),
    ).rejects.toThrow(/unknown preset/i);
    expect(loadConfig(configPath).providers).toHaveLength(0);
  });

  it('throws on an excluded preset (azure-openai) with the reason', async () => {
    await expect(
      runProviders(args('add', 'azure-openai', '--key', 'sk-x', '--config', configPath)),
    ).rejects.toThrow(/azure/i);
    expect(loadConfig(configPath).providers).toHaveLength(0);
  });

  it('throws when --key is missing and leaves config unchanged', async () => {
    await expect(
      runProviders(args('add', 'openai', '--config', configPath)),
    ).rejects.toThrow(/--key/);
    expect(loadConfig(configPath).providers).toHaveLength(0);
  });

  it('throws on an id conflict and does not write a duplicate', async () => {
    seedConfig([{ id: 'openai', apiFormat: 'openai', baseUrl: 'https://existing/v1', apiKey: 'sk-old' }]);
    await expect(
      runProviders(args('add', 'openai', '--key', 'sk-new', '--config', configPath)),
    ).rejects.toThrow(/already exists/i);
    // The add threw before writing, so the seeded plaintext row is untouched.
    const cfg = loadConfig(configPath);
    expect(cfg.providers).toHaveLength(1);
    expect(cfg.providers[0].apiKey).toBe('sk-old'); // untouched
  });

  it('requires --config', async () => {
    await expect(runProviders(['add', 'openai', '--key', 'sk-x'])).rejects.toThrow(/--config/);
  });
});

describe('providers presets', () => {
  it('lists both mappable and excluded presets', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(' '));
    });
    await runProviders(['presets', '--config', configPath]);
    const out = logs.join('\n');
    expect(out).toMatch(/Mappable presets/);
    expect(out).toMatch(/openai\s+openai/); // an openai row
    expect(out).toMatch(/Excluded/);
    expect(out).toMatch(/openai-response\s+EXCLUDED/);
    expect(out).toMatch(/azure-openai\s+EXCLUDED/);
  });
});

describe('providers (bad action)', () => {
  it('throws on an unknown action', async () => {
    await expect(runProviders(['frobnicate', '--config', configPath])).rejects.toThrow(/unknown action/i);
  });
});

// ── Pool key management (key-pool design D8) ───────────────────────────────────

describe('providers keys|add-key|rm-key', () => {
  /** Capture console.info into a string array for list assertions. */
  function captureInfo(): string[] {
    const logs: string[] = [];
    vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(' '));
    });
    return logs;
  }

  it('add-key appends a pool key (auto id) without hot-reload', async () => {
    seedConfig([{ id: 'openai', apiFormat: 'openai', baseUrl: 'https://x/v1', apiKey: 'sk-old' }]);
    await runProviders(args('add-key', 'openai', '--key', 'sk-new', '--weight', '5', '--config', configPath));
    const row = loadDecrypted().providers[0];
    expect(row.apiKeys).toHaveLength(1);
    expect(row.apiKeys![0].apiKey).toBe('sk-new');
    expect(row.apiKeys![0].weight).toBe(5);
    expect(typeof row.apiKeys![0].id).toBe('string');
    expect(row.apiKeys![0].id.length).toBeGreaterThan(0);
    // The single apiKey field is untouched (single-key fallback still valid).
    expect(row.apiKey).toBe('sk-old');
  });

  it('add-key preserves a $ENV reference literally (no expansion)', async () => {
    seedConfig([{ id: 'openai', apiFormat: 'openai', baseUrl: 'https://x/v1', apiKey: 'sk-old' }]);
    await runProviders(args('add-key', 'openai', '--key', '$OPENAI_KEY', '--config', configPath));
    expect(loadDecrypted().providers[0].apiKeys![0].apiKey).toBe('$OPENAI_KEY');
  });

  it('keys lists the pool with masked keys', async () => {
    seedConfig([
      {
        id: 'openai',
        apiFormat: 'openai',
        baseUrl: 'https://x/v1',
        apiKey: '',
        apiKeys: [
          { id: 'k1', apiKey: 'sk-abcwxyz', label: 'primary', weight: 2 },
          { id: 'k2', apiKey: '$OAI', enabled: false },
        ],
      },
    ]);
    const logs = captureInfo();
    await runProviders(args('keys', 'openai', '--config', configPath));
    const out = logs.join('\n');
    expect(out).toMatch(/Pool for 'openai' \(2 keys\)/);
    expect(out).toMatch(/k1\s+primary\s+sk-…wxyz\s+enabled\s+weight=2/);
    expect(out).toMatch(/k2.*\$ENV\(•••\).*disabled/);
    expect(out).not.toContain('sk-abcwxyz'); // never the literal
  });

  it('keys shows the single-key 1-key fallback view', async () => {
    seedConfig([{ id: 'openai', apiFormat: 'openai', baseUrl: 'https://x/v1', apiKey: 'sk-single' }]);
    const logs = captureInfo();
    await runProviders(args('keys', 'openai', '--config', configPath));
    const out = logs.join('\n');
    expect(out).toMatch(/Pool for 'openai' \(1 key\)/);
    expect(out).toMatch(/openai:default/);
    expect(out).not.toContain('sk-single');
  });

  it('rm-key removes one pool key', async () => {
    seedConfig([
      {
        id: 'openai', apiFormat: 'openai', baseUrl: 'https://x/v1', apiKey: '',
        apiKeys: [{ id: 'k1', apiKey: 'sk-a' }, { id: 'k2', apiKey: 'sk-b' }],
      },
    ]);
    await runProviders(args('rm-key', 'openai', 'k1', '--config', configPath));
    const row = loadDecrypted().providers[0];
    expect(row.apiKeys).toHaveLength(1);
    expect(row.apiKeys![0].id).toBe('k2');
  });

  it('rm-key of the last key clears the pool to undefined', async () => {
    seedConfig([
      { id: 'openai', apiFormat: 'openai', baseUrl: 'https://x/v1', apiKey: '', apiKeys: [{ id: 'k1', apiKey: 'sk-a' }] },
    ]);
    await runProviders(args('rm-key', 'openai', 'k1', '--config', configPath));
    expect(loadDecrypted().providers[0].apiKeys).toBeUndefined();
  });

  it('keys throws on an unknown provider and leaves config unchanged', async () => {
    seedConfig([{ id: 'openai', apiFormat: 'openai', baseUrl: 'https://x/v1', apiKey: 'sk-x' }]);
    await expect(runProviders(args('keys', 'nope', '--config', configPath))).rejects.toThrow(/unknown provider/i);
    // The throw happens before any write — seeded plaintext row is untouched.
    expect(loadConfig(configPath).providers[0].apiKey).toBe('sk-x');
  });

  it('add-key throws when --key is missing and does not write', async () => {
    seedConfig([{ id: 'openai', apiFormat: 'openai', baseUrl: 'https://x/v1', apiKey: 'sk-x' }]);
    await expect(runProviders(args('add-key', 'openai', '--config', configPath))).rejects.toThrow(/--key/);
    expect(loadConfig(configPath).providers[0].apiKeys).toBeUndefined();
  });

  it('rm-key throws on a missing keyId and does not write', async () => {
    seedConfig([
      { id: 'openai', apiFormat: 'openai', baseUrl: 'https://x/v1', apiKey: '', apiKeys: [{ id: 'k1', apiKey: 'sk-a' }] },
    ]);
    await expect(runProviders(args('rm-key', 'openai', 'ghost', '--config', configPath))).rejects.toThrow(/no pool key/i);
    expect(loadConfig(configPath).providers[0].apiKeys).toHaveLength(1);
  });
});
