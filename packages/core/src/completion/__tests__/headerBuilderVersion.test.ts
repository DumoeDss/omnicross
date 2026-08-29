/**
 * Version/beta header fidelity pins (`claude-api-protocol-fidelity`, R5 /
 * capability anthropic-header-fidelity): the official default
 * `anthropic-version: 2023-06-01`, and the purged non-official value absent
 * from the whole source tree (the needle is assembled from parts so this file
 * itself never contains the literal).
 *
 * @module completion/__tests__/headerBuilderVersion.test
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { getProviderHeaders } from '../header-builder';

const here = dirname(fileURLToPath(import.meta.url));

/** The purged non-official version literal, assembled (this file must not carry it). */
const PURGED_VERSION = ['2025', '-01', '-10'].join('');

const ANTHROPIC_PROVIDER = {
  id: 'anth',
  name: 'Anthropic',
  api_base_url: 'https://api.anthropic.com',
  api_key: 'sk-x',
  models: ['claude-x'],
  enabled: true,
  apiFormat: 'anthropic',
} as Parameters<typeof getProviderHeaders>[0];

describe('getProviderHeaders anthropic version default (R5)', () => {
  it('sends the official documented version 2023-06-01', () => {
    expect(getProviderHeaders(ANTHROPIC_PROVIDER, 'sk-x')['anthropic-version']).toBe('2023-06-01');
  });

  it('the non-official purged version value is absent from the whole source tree', () => {
    const offenders: string[] = [];
    const visit = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) {
          visit(full);
        } else if (name.endsWith('.ts')) {
          const text = readFileSync(full, 'utf8');
          if (text.includes(PURGED_VERSION)) offenders.push(full);
        }
      }
    };
    // this file: packages/core/src/completion/__tests__/ → repo root is 5 up.
    visit(join(here, '..', '..', '..', '..', '..'));
    expect(offenders).toEqual([]);
  });
});
