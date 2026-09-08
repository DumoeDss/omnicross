import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import en from '../en.json';

type Json = Record<string, unknown>;

// multi-provider-image-generation 6.4: the Images routing/override keys must
// exist with non-empty values in EVERY locale (en is the canonical shape).
const IMAGE_KEYS = [
  'defaultModel',
  'routes.title',
  'routes.defaultBadge',
  'codex.title',
  'codex.imageModel',
  'codex.carrierModel',
  'codex.hint',
] as const;

const LOCALE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

function readImages(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(LOCALE_DIR, file), 'utf8'))
    .apiService.images as Record<string, unknown>;
}

/** Resolve one dotted key against the images tree. */
function resolve(images: Record<string, unknown>, key: string): unknown {
  let node: unknown = images;
  for (const segment of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

describe('Images routing i18n (multi-provider-image-generation)', () => {
  it('defines every routing/override key non-empty in all 31 locales', () => {
    const files = readdirSync(LOCALE_DIR).filter((name) => name.endsWith('.json'));
    expect(files.length).toBe(31);
    for (const file of files) {
      const images = readImages(file);
      for (const key of IMAGE_KEYS) {
        const value = resolve(images, key);
        expect(
          typeof value === 'string' && value.length > 0,
          `${file} must define non-empty apiService.images.${key}`,
        ).toBe(true);
      }
    }
  });

  it('keeps the canonical en shape as the reference', () => {
    const images = en.apiService.images as Record<string, unknown>;
    for (const key of IMAGE_KEYS) {
      expect(resolve(images, key), `en must define ${key}`).toEqual(expect.any(String));
    }
  });
});
