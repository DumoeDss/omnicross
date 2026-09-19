/**
 * refresh-locale-baseline.mjs — (re)generate the partial-locale missing-key
 * baseline consumed by `localeCoverage.test.ts`.
 *
 * The ratchet rule: a locale may never be missing MORE en keys than the
 * baseline records; filling keys in shrinks the baseline (regenerate), adding
 * an en key without translating it fails the test. Run this script ONLY after
 * legitimately changing the accepted gap (initial snapshot, or after filling
 * translations in — it never widens anything on its own, it just records
 * reality; the test is what prevents widening).
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const i18nDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'i18n');
const MAINTAINED = new Set(['en', 'zh', 'zh-Hant']);

function flattenKeys(node, prefix = '') {
  return Object.entries(node).flatMap(([key, value]) =>
    value != null && typeof value === 'object' && !Array.isArray(value)
      ? flattenKeys(value, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}

function loadLocale(lang) {
  return JSON.parse(readFileSync(join(i18nDir, `${lang}.json`), 'utf8'));
}

const enKeys = new Set(flattenKeys(loadLocale('en')));
const baseline = {};
for (const name of readdirSync(i18nDir)) {
  if (!name.endsWith('.json')) continue;
  const lang = name.slice(0, -5);
  if (MAINTAINED.has(lang)) continue;
  const localeKeys = new Set(flattenKeys(loadLocale(lang)));
  baseline[lang] = [...enKeys].filter((key) => !localeKeys.has(key)).sort();
}

const out = join(i18nDir, '__tests__', 'localeMissingBaseline.json');
writeFileSync(out, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
const total = Object.values(baseline).reduce((sum, keys) => sum + keys.length, 0);
console.log(`baseline written: ${Object.keys(baseline).length} locales, ${total} missing keys total`);
