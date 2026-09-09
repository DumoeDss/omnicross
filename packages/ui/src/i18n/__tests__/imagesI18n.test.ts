import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import en from '../en.json';

type Json = Record<string, unknown>;

// images-settings-tab: the Images tree MOVED from `apiService.images` to the
// TOP-LEVEL `images` namespace (the standalone Images page's own tree — the
// search-settings-tab precedent: moved, not duplicated). The page/providers/
// verify keys are new; en is the canonical shape.
const IMAGE_KEYS = [
  'title',
  'description',
  'unsupportedDaemon',
  'enable',
  'entitlementWarning',
  'defaultModel',
  'routes.title',
  'routes.defaultBadge',
  'codex.title',
  'codex.imageModel',
  'codex.carrierModel',
  'codex.hint',
  'page.title',
  'page.description',
  'page.loading',
  'providers.bootstrap',
  'providers.healthy',
  'providers.unhealthy',
  'providers.evidence',
  'providers.noEvidence',
  'providers.noModels',
  'verify.title',
  'verify.run',
  'verify.running',
  'verify.warning',
  'verify.codexOnly',
  'verify.codexOnlyPlain',
  'verify.success',
] as const;

const LOCALE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadLocale(file: string): Json {
  return JSON.parse(readFileSync(join(LOCALE_DIR, file), 'utf8')) as Json;
}

/** Resolve one dotted key against a tree. */
function resolve(tree: Json, key: string): unknown {
  let node: unknown = tree;
  for (const segment of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

describe('Images i18n (images-settings-tab)', () => {
  it('defines every images key non-empty in all 31 locales', () => {
    const files = readdirSync(LOCALE_DIR).filter((name) => name.endsWith('.json'));
    expect(files.length).toBe(31);
    for (const file of files) {
      const data = loadLocale(file);
      const images = data.images as Json | undefined;
      expect(images, `${file} must carry the top-level images tree`).toBeDefined();
      for (const key of IMAGE_KEYS) {
        const value = resolve(images as Json, key);
        expect(
          typeof value === 'string' && value.length > 0,
          `${file} must define non-empty images.${key}`,
        ).toBe(true);
      }
      // The nav label rides every locale.
      expect(typeof (data.nav as Json).images === 'string').toBe(true);
    }
  });

  it('keeps the canonical en shape as the reference', () => {
    const images = en.images as Record<string, unknown>;
    for (const key of IMAGE_KEYS) {
      expect(resolve(images, key), `en must define ${key}`).toEqual(expect.any(String));
    }
  });

  it('removed the apiService.images subtree (moved, not duplicated)', () => {
    for (const file of readdirSync(LOCALE_DIR).filter((name) => name.endsWith('.json'))) {
      const api = loadLocale(file).apiService as Json | undefined;
      expect(api?.images, `${file} must not keep apiService.images`).toBeUndefined();
    }
  });

  it('keeps the interpolation placeholders intact in every locale', () => {
    for (const file of readdirSync(LOCALE_DIR).filter((name) => name.endsWith('.json'))) {
      const images = loadLocale(file).images as Json;
      expect(resolve(images, 'providers.evidence'), `${file} providers.evidence`)
        .toContain('{{age}}');
      expect(resolve(images, 'account.group'), `${file} account.group`)
        .toContain('{{group}}');
      expect(resolve(images, 'verify.success'), `${file} verify.success`)
        .toContain('{{model}}');
    }
  });
});
