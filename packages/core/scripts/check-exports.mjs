/**
 * Verify that the subpaths this package advertises actually resolve through its
 * `exports` map, against the BUILT `dist` and under both conditions.
 *
 * Why this exists: the root `vitest.config.ts` aliases `@omnicross/core` and
 * every one of its subpaths to `src/`, so NO test in this repo can detect a
 * module that exists in `src/` but was never registered as a `tsup.config.ts`
 * entry. Core's `exports` map is a `./*` wildcard, so the failure mode is not a
 * missing `exports` line (as it is in `@omnicross/contracts`) but a missing
 * BUILD OUTPUT: the wildcard happily points at a `dist/<subpath>.js` that tsup
 * never wrote. Same symptom, same fix — check against `dist`.
 *
 * This guard is deliberately NOT exhaustive over core's ~50 entries. It covers
 * the paths whose breakage is silent and expensive:
 *   - subpaths a downstream repo imports (Elftia consumes
 *     `ports/web-search-backend` directly), and
 *   - newly added trees, which are the ones an author forgets to register.
 *
 * Run after `npm run build -w @omnicross/core`.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Entry point -> runtime values that must survive the build. */
const ENTRY_POINTS = {
  // search-phase1-orchestrator (阶段3): the search runtime. This is the subpath
  // 阶段5's protocol frontends and Phase-2 hosts import, so a missing build
  // output here breaks consumers that no test in this repo can see.
  '@omnicross/core/search': [
    'createSearchRuntime',
    'SearchOrchestrator',
    'SearchProviderRegistry',
    'SearchRegistryError',
    'searchRuntimeAsWebSearchBackend',
    'normalizeSearchResults',
    // search-phase1-api-providers (阶段4): the egress policy ships through this
    // existing subpath rather than claiming one of its own.
    'validateEgressUrl',
    'createEgressGuardedDispatcher',
  ],
  // search-phase1-api-providers (阶段4): the keyed API search providers.
  '@omnicross/core/search/api': [
    'apiSearchContributions',
    'TavilySearchProvider',
    'JinaSearchProvider',
    'JinaReaderClient',
    'SearxngSearchProvider',
    'ZhipuSearchProvider',
    'createSearchApiTransport',
    'ApiKeyRotator',
  ],
  // search-phase1-http-slice (阶段2): the keyless HTTP search providers.
  '@omnicross/core/search/http': [
    'HttpBingProvider',
    'HttpDuckDuckGoProvider',
    'builtinHttpSearchContributions',
    'createSearchHttpTransport',
    'defaultSearchHttpTransport',
    'HTTP_SEARCH_CAPABILITIES',
  ],
  // Consumed directly by Elftia's `proxySearchIntercept`; it must keep
  // resolving across every refactor of the search tree.
  '@omnicross/core/ports/web-search-backend': [],
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
  console.error('Build first: npm run build -w @omnicross/core');
  console.error('A new core subpath needs an entry in packages/core/tsup.config.ts —');
  console.error('the package.json "./*" exports wildcard does NOT create the dist file.');
  process.exit(1);
}

const count = Object.keys(ENTRY_POINTS).length;
console.log(`exports check OK — ${count} entry points resolve via require() and import()`);
