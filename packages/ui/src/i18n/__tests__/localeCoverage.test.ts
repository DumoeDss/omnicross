/**
 * Locale coverage ratchet.
 *
 * The three maintained locales (en, zh, zh-Hant) are held at EXACT parity by
 * `staticKeyResolution.test.ts`. Every other locale is a partial community
 * translation that falls back to English per key — historically that let new
 * UI ship English-only in 28 languages for months (the gap this file froze:
 * see localeMissingBaseline.json).
 *
 * The rule here makes that impossible going forward, in BOTH directions:
 *
 *  - NO NEW GAPS: a key present in en.json but absent from a locale AND not
 *    recorded in that locale's baseline fails the test. Adding an en key
 *    without translating it into every partial locale does not merge.
 *  - NO STALE BASELINE: a baseline entry whose key is now PRESENT fails too —
 *    after filling translations in, regenerate the snapshot so the accepted
 *    gap only ever shrinks:
 *
 *      npm run i18n:baseline -w @omnicross/ui
 *
 * A brand-new locale file without a baseline entry also fails (add it via the
 * same script). Deleting an en key needs no action beyond regeneration.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import baseline from './localeMissingBaseline.json';
import en from '../en.json';

type Json = Record<string, unknown>;

const i18nDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAINTAINED = new Set(['en', 'zh', 'zh-Hant']);

function flattenKeys(node: Json, prefix = ''): string[] {
  return Object.entries(node).flatMap(([key, value]) =>
    value != null && typeof value === 'object' && !Array.isArray(value)
      ? flattenKeys(value as Json, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}

const partialLocales = readdirSync(i18nDir)
  .filter((name) => name.endsWith('.json') && !MAINTAINED.has(name.slice(0, -5)))
  .map((name) => name.slice(0, -5))
  .sort();

function loadLocale(lang: string): Json {
  return JSON.parse(readFileSync(join(i18nDir, `${lang}.json`), 'utf8')) as Json;
}

const enKeys = flattenKeys(en);

describe('locale coverage ratchet (partial locales)', () => {
  it('every partial locale has a baseline entry', () => {
    const untracked = partialLocales.filter((lang) => !(lang in baseline));
    expect(untracked, `run "npm run i18n:baseline -w @omnicross/ui" to record: ${untracked.join(', ')}`).toEqual([]);
  });

  it.each(partialLocales)('%s may not be missing any en key its baseline does not already cover', (lang) => {
    const accepted = new Set((baseline as Record<string, string[]>)[lang] ?? []);
    const localeKeys = new Set(flattenKeys(loadLocale(lang)));
    const newGaps = [...enKeys].filter((key) => !localeKeys.has(key) && !accepted.has(key));
    expect(
      newGaps,
      `${lang} is missing ${newGaps.length} newly-added key(s) with no baseline coverage — translate them (every partial locale, not just zh/zh-Hant): ${newGaps.slice(0, 10).join(', ')}${newGaps.length > 10 ? ' …' : ''}`,
    ).toEqual([]);
  });

  it.each(partialLocales)('%s baseline holds no already-translated key (regenerate to shrink it)', (lang) => {
    const localeKeys = new Set(flattenKeys(loadLocale(lang)));
    const stale = ((baseline as Record<string, string[]>)[lang] ?? [])
      .filter((key) => localeKeys.has(key) || !enKeys.includes(key));
    expect(
      stale,
      `${lang}'s baseline lists ${stale.length} key(s) that are translated (or no longer exist) — run "npm run i18n:baseline -w @omnicross/ui"`,
    ).toEqual([]);
  });
});
