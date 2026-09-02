import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import en from '../en.json';

type Json = Record<string, unknown>;

/** Flatten one subtree to dotted keys. */
function flatten(node: Json, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object') keys.push(...flatten(value as Json, path));
    else keys.push(path);
  }
  return keys;
}

// search-settings-tab: the search tree moved from `apiService.search` to the
// TOP-LEVEL `search` namespace (the standalone Search page's own tree).
const SEARCH_KEYS = flatten(en.search as unknown as Json);
const LOCALE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every locale file, parsed — read via fs so the test also sees raw-file damage. */
function loadLocales(): Array<{ file: string; data: Json }> {
  return readdirSync(LOCALE_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((file) => ({
      file,
      data: JSON.parse(readFileSync(join(LOCALE_DIR, file), 'utf8')) as Json,
    }));
}

describe('search settings translations', () => {
  it('defines the canonical tree as a full set of keys', () => {
    expect(SEARCH_KEYS.length).toBeGreaterThan(60);
    for (const key of [
      'title',
      'restartBanner',
      'modes.codex',
      'status.ready',
      'field.apiKeyPlaceholder',
      'policy.maxAttempts',
      'egress.add',
      // search-settings-tab additions: the interactive test panel + page.
      'page.loading',
      'test.queryPlaceholder',
      'test.action',
      'test.testing',
      'test.saveFirst',
      'test.empty',
      'test.providerUsed',
    ]) {
      expect(SEARCH_KEYS).toContain(key);
    }
  });

  it('carries the complete tree with non-empty values in EVERY supported locale file', () => {
    const locales = loadLocales();
    expect(locales.length).toBe(31);
    for (const { file, data } of locales) {
      const search = data.search as Json | undefined;
      expect(search, `${file} must carry the top-level search tree`).toBeDefined();
      const flat = new Set(flatten(search as Json));
      for (const key of SEARCH_KEYS) {
        expect(flat.has(key), `${file} must define ${key}`).toBe(true);
      }
      // A missing translation renders the key itself, but an EMPTY value
      // renders nothing — assert the stronger property per value.
      const walk = (node: Json): void => {
        for (const value of Object.values(node)) {
          if (value !== null && typeof value === 'object') walk(value as Json);
          else expect(typeof value === 'string' && value.length > 0, `${file} has an empty value`).toBe(true);
        }
      };
      walk(search as Json);
      // The nav label rides every locale too.
      expect(typeof (data.nav as Json).search === 'string' && ((data.nav as Json).search as string).length > 0)
        .toBe(true);
    }
  });

  it('removed the apiService.search subtree in the same edit (moved, not duplicated)', () => {
    for (const { file, data } of loadLocales()) {
      const api = data.apiService as Json | undefined;
      expect(api?.search, `${file} must not keep apiService.search`).toBeUndefined();
    }
  });

  it('keeps the interpolation placeholders intact in every locale', () => {
    for (const { file, data } of loadLocales()) {
      const search = data.search as Json;
      const flat: Record<string, string> = {};
      const walk = (node: Json, prefix = ''): void => {
        for (const [key, value] of Object.entries(node)) {
          const path = prefix ? `${prefix}.${key}` : key;
          if (value !== null && typeof value === 'object') walk(value as Json, path);
          else flat[path] = String(value);
        }
      };
      walk(search);
      expect(flat['restartBanner'], `${file} restartBanner`).toContain('{{providers}}');
      expect(flat['testOutcome.error'], `${file} testOutcome.error`).toContain('{{error}}');
      expect(flat['testOutcome.count'], `${file} testOutcome.count`).toContain('{{count}}');
      expect(flat['test.providerUsed'], `${file} test.providerUsed`).toContain('{{provider}}');
    }
  });
});
