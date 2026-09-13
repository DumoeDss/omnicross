/**
 * Static i18n key resolution audit.
 *
 * A `t('some.key.path')` call whose key does not exist in ANY locale renders
 * the raw key string in the UI for every user — no fallback fires, because the
 * inline `defaultValue` argument is optional. That bug class shipped twice
 * (apiService.keys.bindUpstream.* missing its `bindings.` segment;
 * accounts.management.fields.priorityHint vs the real accounts.detail path), so
 * this test scans every static `t('…')` call in the UI source and asserts each
 * key resolves in `en.json` (the source of truth every locale is translated
 * against).
 *
 * The companion invariant below keeps the two fully-maintained locales (zh,
 * zh-Hant) at parity with en: any key added to en.json must be translated in
 * both before it can merge.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import en from '../en.json';
import zh from '../zh.json';
import zhHant from '../zh-Hant.json';

type Json = Record<string, unknown>;

const uiRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function resolveKey(root: Json, key: string): unknown {
  return key.split('.').reduce<unknown>(
    (node, segment) =>
      node != null && typeof node === 'object' ? (node as Json)[segment] : undefined,
    root,
  );
}

function flattenKeys(node: Json, prefix = ''): string[] {
  return Object.entries(node).flatMap(([key, value]) =>
    value != null && typeof value === 'object' && !Array.isArray(value)
      ? flattenKeys(value as Json, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}

function* walkSources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      // The locale files themselves (and tests) are not call sites.
      if (name === 'i18n' || name === '__tests__' || name === 'node_modules') continue;
      yield* walkSources(path);
    } else if (/\.tsx?$/.test(name)) {
      // `LocaleContext.ts` is the t() IMPLEMENTATION — its doc comments cite
      // example key paths (`providerSettings.x`), which are not real calls.
      if (name === 'LocaleContext.ts') continue;
      yield path;
    }
  }
}

describe('static i18n key resolution', () => {
  it("every static t('key') call in the UI source resolves in en.json", () => {
    const callSite = /\bt\(\s*'([a-zA-Z0-9_.-]+)'/g;
    const unresolved: string[] = [];
    for (const file of walkSources(uiRoot)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        callSite.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = callSite.exec(line)) !== null) {
          if (resolveKey(en as Json, match[1]!) === undefined) {
            unresolved.push(`${relative(uiRoot, file).split('\\').join('/')}:${index + 1}  ${match[1]}`);
          }
        }
      });
    }
    expect(unresolved, `unresolved static t() keys:\n${unresolved.join('\n')}`).toEqual([]);
  });

  it.each([
    ['zh', zh as Json],
    ['zh-Hant', zhHant as Json],
  ])('%s.json covers every en.json key', (_locale, locale) => {
    const present = new Set(flattenKeys(locale));
    const missing = flattenKeys(en as Json).filter((key) => !present.has(key));
    expect(missing, `keys missing from the locale file:\n${missing.join('\n')}`).toEqual([]);
  });
});
