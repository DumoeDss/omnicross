/**
 * secrets-master-key.test.ts — master-key lifecycle (secrets task 5.3).
 *
 * Covers: no-key auto-generation (0600 mode on POSIX), env override beats the
 * keyfile + is NOT written to disk, `--master-key-file` path override, and the
 * fail-fast on an invalid env length.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MASTER_KEY_ENV, resolveMasterKey } from '../secrets';

const HEX_64 = 'a'.repeat(64); // 32 bytes of 0xaa
const B64_32 = Buffer.alloc(32, 7).toString('base64');

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-mk-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('master key resolution (5.3)', () => {
  it('auto-generates a 32-byte keyfile when none exists', () => {
    const keyFilePath = join(tmpDir, 'sub', 'master.key');
    expect(existsSync(keyFilePath)).toBe(false);
    const key = resolveMasterKey({ envVar: undefined, keyFilePath });
    expect(key).toHaveLength(32);
    expect(existsSync(keyFilePath)).toBe(true);
    expect(readFileSync(keyFilePath)).toHaveLength(32);
  });

  it('reuses an existing keyfile (stable key across resolves)', () => {
    const keyFilePath = join(tmpDir, 'master.key');
    const first = resolveMasterKey({ envVar: undefined, keyFilePath });
    const second = resolveMasterKey({ envVar: undefined, keyFilePath });
    expect(first.equals(second)).toBe(true);
  });

  it.runIf(process.platform !== 'win32')('writes the auto-gen keyfile with 0600 mode (POSIX)', () => {
    const keyFilePath = join(tmpDir, 'master.key');
    resolveMasterKey({ envVar: undefined, keyFilePath });
    const mode = statSync(keyFilePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('env (64 hex) beats the keyfile AND is NOT written to disk', () => {
    const keyFilePath = join(tmpDir, 'master.key');
    // Seed a DIFFERENT keyfile to prove env wins.
    writeFileSync(keyFilePath, Buffer.alloc(32, 9));
    const before = readFileSync(keyFilePath);
    const key = resolveMasterKey({ envVar: HEX_64, keyFilePath });
    expect(key.equals(Buffer.from(HEX_64, 'hex'))).toBe(true);
    // keyfile untouched (env not persisted).
    expect(readFileSync(keyFilePath).equals(before)).toBe(true);
  });

  it('env accepts base64-encoded 32 bytes', () => {
    const key = resolveMasterKey({ envVar: B64_32, keyFilePath: join(tmpDir, 'k') });
    expect(key.equals(Buffer.from(B64_32, 'base64'))).toBe(true);
  });

  it('env does NOT auto-generate a keyfile (highest priority, no disk write)', () => {
    const keyFilePath = join(tmpDir, 'never.key');
    resolveMasterKey({ envVar: HEX_64, keyFilePath });
    expect(existsSync(keyFilePath)).toBe(false);
  });

  it('fails fast on an invalid env length (no silent half-key)', () => {
    expect(() => resolveMasterKey({ envVar: 'too-short', keyFilePath: join(tmpDir, 'k') })).toThrow(
      new RegExp(MASTER_KEY_ENV),
    );
  });

  it('reads a keyfile authored as 64 hex chars', () => {
    const keyFilePath = join(tmpDir, 'hex.key');
    writeFileSync(keyFilePath, HEX_64, 'utf8');
    const key = resolveMasterKey({ envVar: undefined, keyFilePath });
    expect(key.equals(Buffer.from(HEX_64, 'hex'))).toBe(true);
  });
});
