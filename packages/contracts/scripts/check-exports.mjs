/**
 * Verify that every subpath this package advertises actually resolves through its
 * `exports` map, against the BUILT `dist` and under both conditions.
 *
 * Why this exists: the root `vitest.config.ts` aliases `@omnicross/contracts` and
 * every one of its subpaths to `src/`, so no test in this repo can detect a module
 * that was added to the barrel but never registered in `tsup.config.ts` and
 * `package.json#exports`. `src/account-allowance-types.ts` is the live example of
 * that failure mode: it is in the barrel, it has neither registration, and
 * `@omnicross/contracts/account-allowance-types` does not resolve.
 *
 * Run after `npm run build -w @omnicross/contracts`.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Entry point -> a few runtime values that must survive the build and the barrel. */
const ENTRY_POINTS = {
  // The barrel drops names exported by two modules SILENTLY; these cover both new
  // modules plus the legacy one, so a future collision fails here as well as in the
  // vitest canary.
  '@omnicross/contracts': [
    'SearchProviderError',
    'isKnownSearchProviderId',
    'toSearchErrorShape',
    'fromLegacyWebSearchResponse',
    'legacyErrorStringToSearchErrorCode',
    'isApiProvider',
  ],
  '@omnicross/contracts/search-types': [
    'SearchProviderError',
    'isKnownSearchProviderId',
    'isSearchProviderError',
    'toSearchErrorShape',
  ],
  '@omnicross/contracts/search-compat': [
    'LEGACY_UNKNOWN_PROVIDER_ID',
    'fromLegacyWebSearchResponse',
    'legacyErrorStringToSearchErrorCode',
    'legacyProviderIdToSearchProviderId',
    'searchErrorToLegacyWebSearchResponse',
    'toLegacyWebSearchResponse',
  ],
  // Consumed read-only by Elftia's re-export shim; it must keep resolving.
  '@omnicross/contracts/websearch-types': ['isApiProvider', 'isLocalProvider'],
};

const LOADERS = [
  ['require', (specifier) => require(specifier)],
  ['import', (specifier) => import(specifier)],
];

const failures = [];

for (const [specifier, expectedSymbols] of Object.entries(ENTRY_POINTS)) {
  for (const [condition, load] of LOADERS) {
    let mod;
    try {
      mod = await load(specifier);
    } catch (error) {
      failures.push(`${condition}('${specifier}') failed: ${error.code ?? error.message}`);
      continue;
    }

    const missing = expectedSymbols.filter((name) => mod[name] === undefined);
    if (missing.length > 0) {
      failures.push(`${condition}('${specifier}') resolved but is missing: ${missing.join(', ')}`);
    }
  }
}

if (failures.length > 0) {
  console.error('exports check FAILED:');
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error('');
  console.error('Build first: npm run build -w @omnicross/contracts');
  console.error('A new module needs THREE registrations to be reachable:');
  console.error('  1. an entry in packages/contracts/tsup.config.ts');
  console.error('  2. a subpath in packages/contracts/package.json "exports"');
  console.error('  3. an `export *` line in packages/contracts/src/index.ts');
  process.exit(1);
}

const count = Object.keys(ENTRY_POINTS).length;
console.log(`exports check OK — ${count} entry points resolve via require() and import()`);
