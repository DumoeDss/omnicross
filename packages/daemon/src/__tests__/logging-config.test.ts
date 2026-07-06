/**
 * logging-config.test.ts — the `logging` config segment (configurable-logging).
 *
 * Proves the shape-guard (enum-or-omit level/format, non-empty-string file,
 * garbage collapses to undefined) and that `logging.file` is a PLAIN value — it
 * round-trips through save/load with NO SecretBox unchanged (never encrypted).
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig, saveConfig, setSecretBox, validateConfig } from '../config';

let tmpDir: string | undefined;

afterEach(() => {
  setSecretBox(null);
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

describe('validateConfig — logging segment', () => {
  it('keeps a well-formed logging block', () => {
    const cfg = validateConfig({
      providers: [],
      logging: { level: 'warn', format: 'json', file: '/var/log/omnicross.log' },
    });
    expect(cfg.logging).toEqual({ level: 'warn', format: 'json', file: '/var/log/omnicross.log' });
  });

  it('drops garbage fields and collapses an all-bad block to undefined', () => {
    expect(validateConfig({ providers: [], logging: { level: 'loud', format: 'xml', file: '' } }).logging).toBeUndefined();
    expect(validateConfig({ providers: [], logging: 'nope' }).logging).toBeUndefined();
    expect(validateConfig({ providers: [] }).logging).toBeUndefined();
  });

  it('keeps only the valid subset when some fields are bad', () => {
    const cfg = validateConfig({ providers: [], logging: { level: 'debug', format: 'yaml' } });
    expect(cfg.logging).toEqual({ level: 'debug' });
  });

  it('logging.file is NOT a secret — round-trips plaintext with no box', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-logcfg-'));
    const path = join(tmpDir, 'config.json');
    saveConfig(path, { providers: [], logging: { level: 'info', file: '/tmp/plain-path.log' } });
    const raw = readFileSync(path, 'utf8');
    // The file path appears verbatim on disk (not an `enc:` envelope).
    expect(raw).toContain('/tmp/plain-path.log');
    expect(raw).not.toContain('enc:');
    const reloaded = loadConfig(path);
    expect(reloaded.logging).toEqual({ level: 'info', file: '/tmp/plain-path.log' });
  });
});
