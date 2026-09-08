/**
 * opencodego-config.test.ts — the `opencodego` config segment
 * (opencodego-egress-identity).
 *
 * Proves the shape-guard (a `userAgent` string kept trimmed only when
 * non-empty after trim; garbage / blank / wrong-type blocks collapse to
 * undefined — indistinguishable from unset) and that the block is a PLAIN
 * value surviving a save/load round-trip (non-secret, never encrypted).
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

describe('validateConfig — opencodego segment', () => {
  it('keeps a well-formed block, trimming the userAgent', () => {
    const cfg = validateConfig({ providers: [], opencodego: { userAgent: '  elftia/1.2.3  ' } });
    expect(cfg.opencodego).toEqual({ userAgent: 'elftia/1.2.3' });
  });

  it('collapses blank / wrong-type / non-object blocks to undefined', () => {
    expect(validateConfig({ providers: [], opencodego: { userAgent: '   ' } }).opencodego).toBeUndefined();
    expect(validateConfig({ providers: [], opencodego: { userAgent: '' } }).opencodego).toBeUndefined();
    expect(validateConfig({ providers: [], opencodego: { userAgent: 123 } }).opencodego).toBeUndefined();
    expect(validateConfig({ providers: [], opencodego: 'nope' }).opencodego).toBeUndefined();
    expect(validateConfig({ providers: [], opencodego: null }).opencodego).toBeUndefined();
    expect(validateConfig({ providers: [] }).opencodego).toBeUndefined();
  });

  it('the block is NOT a secret — round-trips plaintext with no box', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-occfg-'));
    const path = join(tmpDir, 'config.json');
    saveConfig(path, { providers: [], opencodego: { userAgent: 'elftia/1.2.3' } });
    const raw = readFileSync(path, 'utf8');
    expect(raw).toContain('elftia/1.2.3');
    expect(raw).not.toContain('enc:');
    const reloaded = loadConfig(path);
    expect(reloaded.opencodego).toEqual({ userAgent: 'elftia/1.2.3' });
  });

  it('a load→save round-trip preserves the block (read-modify-write never drops it)', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-occfg-rt'));
    const path = join(tmpDir, 'config.json');
    saveConfig(path, { providers: [], opencodego: { userAgent: 'elftia/1.2.3' } });
    const reloaded = loadConfig(path);
    // Simulate an admin edit that mutates only providers, then saves the whole.
    reloaded.providers.push({
      id: 'x', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:9', apiKey: 'k', models: ['m'],
    } as never);
    saveConfig(path, reloaded);
    expect(loadConfig(path).opencodego).toEqual({ userAgent: 'elftia/1.2.3' });
  });
});
