/**
 * The secrets knobs the embedding entry relies on: the env master key can be
 * ignored, and the decrypt-failure message is host-configurable (the default
 * still names the daemon's env var and keyfile, unchanged).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveMasterKey, SecretBox } from '../../secrets';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('resolveMasterKey readEnv', () => {
  it('readEnv:false never consults OMNICROSS_MASTER_KEY; the default still does', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mk-'));
    dirs.push(dir);
    const envKey = 'cd'.repeat(32);
    const previous = process.env['OMNICROSS_MASTER_KEY'];
    process.env['OMNICROSS_MASTER_KEY'] = envKey;
    try {
      expect(resolveMasterKey({ keyFilePath: join(dir, 'a.key') }).toString('hex')).toBe(envKey);
      const fromFile = resolveMasterKey({ keyFilePath: join(dir, 'b.key'), readEnv: false });
      expect(fromFile.toString('hex')).not.toBe(envKey);
      expect(resolveMasterKey({ keyFilePath: join(dir, 'b.key'), readEnv: false }).equals(fromFile)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env['OMNICROSS_MASTER_KEY'];
      else process.env['OMNICROSS_MASTER_KEY'] = previous;
    }
  });
});

describe('SecretBox decrypt failure message', () => {
  const sealed = new SecretBox(Buffer.alloc(32, 1)).encrypt('secret');

  it('defaults to the daemon wording', () => {
    expect(() => new SecretBox(Buffer.alloc(32, 2)).decrypt(sealed)).toThrow(/OMNICROSS_MASTER_KEY \/ master\.key/);
  });

  it('uses the host wording when supplied', () => {
    const box = new SecretBox(Buffer.alloc(32, 2), { decryptFailureMessage: 'stored secrets cannot be read' });
    expect(() => box.decrypt(sealed)).toThrow('stored secrets cannot be read');
  });
});
