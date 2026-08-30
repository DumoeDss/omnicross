// check-i18n.mjs — validate every locale JSON; report lines with unbalanced
// unescaped double quotes (the usual hand-edit corruption).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = new URL('../src/i18n', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
let failed = false;
const requiredUpdateKeys = [
  'title', 'description', 'autoDownload', 'autoDownloadHint', 'version',
  'currentVersion', 'latestVersion', 'checkNow', 'checking', 'upToDate',
  'available', 'downloading', 'ready', 'failed', 'download', 'retry',
  'installRestart', 'releasePage',
];

const english = JSON.parse(readFileSync(join(dir, 'en.json'), 'utf8'));
const englishUpdates = english.updates;
const placeholders = (value) => [...value.matchAll(/{{[^{}]+}}/g)].map(([token]) => token).sort();
const getPath = (value, path) => path.split('.').reduce((current, key) => current?.[key], value);
const stringLeaves = (value, prefix = '') => Object.entries(value).flatMap(([key, child]) => {
  const path = prefix ? prefix + '.' + key : key;
  return typeof child === 'string' ? [[path, child]] : stringLeaves(child, path);
});
const requiredLocalizedSections = [
  ['apiService.keys.permissions', english.apiService.keys.permissions],
  ['apiService.images', english.apiService.images],
];
const narrativePaths = [
  'apiService.keys.permissions.hint',
  'apiService.images.description',
  'apiService.images.unsupportedDaemon',
  'apiService.images.entitlementWarning',
  'apiService.images.noEvidence',
  'apiService.images.resources.unavailable',
  'apiService.images.remote.enabledWarning',
  'apiService.images.storage.custom',
];

for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const text = readFileSync(join(dir, f), 'utf8');
  try {
    const parsed = JSON.parse(text);
    const missing = requiredUpdateKeys.filter((key) => typeof parsed.updates?.[key] !== 'string' || parsed.updates[key].trim() === '');
    if (missing.length > 0) {
      failed = true;
      console.log(`${f}: missing update strings: ${missing.join(', ')}`);
    }

    for (const key of requiredUpdateKeys.filter((key) => !missing.includes(key))) {
      const expected = placeholders(englishUpdates[key]);
      const actual = placeholders(parsed.updates[key]);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        failed = true;
        console.log(`${f}: update placeholder mismatch for ${key}: expected ${expected.join(', ') || '<none>'}, found ${actual.join(', ') || '<none>'}`);
      }
    }

    if (f !== 'en.json' && requiredUpdateKeys.every((key) => parsed.updates[key] === englishUpdates[key])) {
      failed = true;
      console.log(`${f}: updates block is identical to English`);
    }
    for (const [sectionPath, englishSection] of requiredLocalizedSections) {
      for (const [leafPath, englishValue] of stringLeaves(englishSection)) {
        const fullPath = sectionPath + '.' + leafPath;
        const actual = getPath(parsed, fullPath);
        if (typeof actual !== 'string' || actual.trim() === '') {
          failed = true;
          console.log(f + ': missing localized string: ' + fullPath);
          continue;
        }
        const expectedPlaceholders = placeholders(englishValue);
        const actualPlaceholders = placeholders(actual);
        if (JSON.stringify(actualPlaceholders) !== JSON.stringify(expectedPlaceholders)) {
          failed = true;
          console.log(f + ': placeholder mismatch for ' + fullPath + ': expected ' + (expectedPlaceholders.join(', ') || '<none>') + ', found ' + (actualPlaceholders.join(', ') || '<none>'));
        }
      }
    }

    if (f !== 'en.json') {
      for (const path of narrativePaths) {
        if (getPath(parsed, path) === getPath(english, path)) {
          failed = true;
          console.log(f + ': localized narrative is identical to English: ' + path);
        }
      }
    }
  } catch (e) {
    failed = true;
    console.log(`${f}: ${e.message}`);
    text.split('\n').forEach((ln, i) => {
      let count = 0;
      for (let j = 0; j < ln.length; j++) {
        if (ln[j] === '"' && ln[j - 1] !== '\\') count++;
      }
      if (count % 2 !== 0) console.log(`  ${f}:${i + 1} odd quotes → ${ln.trim().slice(0, 110)}`);
    });
  }
}
process.exit(failed ? 1 : 0);
