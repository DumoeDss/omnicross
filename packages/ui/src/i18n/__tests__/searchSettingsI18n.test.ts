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

const SEARCH_KEYS = flatten(en.apiService.search as unknown as Json);
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
    for (const key of ['title', 'restartBanner', 'modes.codex', 'status.ready', 'field.apiKeyPlaceholder', 'policy.maxAttempts', 'egress.add']) {
      expect(SEARCH_KEYS).toContain(key);
    }
  });

  it('carries the complete tree with non-empty values in EVERY supported locale file', () => {
    const locales = loadLocales();
    expect(locales.length).toBe(31);
    for (const { file, data } of locales) {
      const api = data.apiService as Json | undefined;
      const search = api?.search as Json | undefined;
      expect(search, `${file} must carry apiService.search`).toBeDefined();
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
    }
  });

  it('keeps the interpolation placeholders intact in every locale', () => {
    for (const { file, data } of loadLocales()) {
      const search = (data.apiService as Json).search as Json;
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
    }
  });
});
