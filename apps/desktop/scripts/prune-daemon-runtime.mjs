import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultStaging = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'daemon-runtime');

// Audited development assets in published production dependencies. Keep this
// explicit: a path named "test" in an arbitrary package may be runtime API.
// Runtime code, exports, type declarations and licenses stay in the bundle.
const DEVELOPMENT_ONLY_PATHS = {
  '@mixmark-io/domino': ['test', '.yarn'],
  busboy: ['test', 'bench', '.github'],
  'call-bind-apply-helpers': ['test', '.github'],
  'dunder-proto': ['test', '.github'],
  // entities publishes these Vitest sources, but exports only dist/ entrypoints.
  entities: ['src/decode.spec.ts', 'src/encode.spec.ts', 'src/escape.spec.ts', 'src/index.spec.ts'],
  'es-define-property': ['test', '.github'],
  'es-errors': ['test', '.github'],
  'es-object-atoms': ['test', '.github'],
  'es-set-tostringtag': ['test'],
  'function-bind': ['test', '.github'],
  'get-intrinsic': ['test', '.github'],
  'get-proto': ['test', '.github'],
  gopd: ['test', '.github'],
  'has-symbols': ['test', '.github'],
  'has-tostringtag': ['test', '.github'],
  hasown: ['.github'],
  'iconv-lite': ['.github'],
  'math-intrinsics': ['test', '.github'],
  'requires-port': ['test.js'],
  'safer-buffer': ['tests.js'],
  streamsearch: ['test', '.github'],
  zod: [
    'src/v3/benchmarks',
    'src/v3/tests',
    'src/v4/classic/tests',
    'src/v4/core/tests',
    'src/v4/mini/tests',
  ],
};

const DEVELOPMENT_DIRECTORY_NAMES = new Set([
  'test', 'tests', '__tests__',
  'fixture', 'fixtures', '__fixtures__', '__snapshots__',
  'bench', 'benchmark', 'benchmarks',
  'coverage', '.nyc_output', '.github', '.yarn', '.cache',
]);
const DEVELOPMENT_FILE_NAME = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)(?:\.map)?$/i;

// Exact staging-relative paths, with a reason explaining their runtime use.
// Unknown matches fail packaging; they are never deleted by the generic scan.
const REVIEWED_RUNTIME_PATHS = {};

// Whole package copies that are REDUNDANT in the staged runtime: an
// identical-version copy sits earlier on Node's module-resolution walk, so the
// nested copy ships duplicate bytes — and, on deep private-runtime layouts,
// paths past the Windows MAX_PATH cliff that makensis cannot open (the 0.7.1
// NSIS failure: chatgpt-web's bundled jsdom closure reached 261 chars).
//
// Deletion is CONDITIONAL per entry: the replacement must exist and carry the
// SAME version, or packaging fails — a future version drift between the
// nested copy and its replacement must never silently break resolution.
// Paths are exact and layout-specific (the full daemon-runtime prefix), so the
// daemon tarball's own staging — which reuses this prune from a different
// root, where the closure legitimately sits at `node_modules/jsdom` — never
// matches these keys.
const REDUNDANT_RUNTIME_PACKAGES = {
  'node_modules/@omnicross/daemon/node_modules/@omnicross/chatgpt-web/node_modules/jsdom': {
    replacement: 'node_modules/jsdom',
    reason:
      'The chatgpt-web private-runtime closure bundles jsdom 24.1.3 nested under the daemon package, ' +
      'while the staging install provides the identical version at the runtime root (via @omnicross/core); ' +
      'Node resolution walks up from chatgpt-web to it. The nested copy alone exceeds 253 chars per file.',
  },
};

function readStagedVersion(stagingRoot, relativePath) {
  const manifestPath = join(stagingRoot, relativePath, 'package.json');
  if (!existsSync(manifestPath)) return undefined;
  return JSON.parse(readFileSync(manifestPath, 'utf8')).version;
}

function redundantRuntimePackages(stagingRoot) {
  const targets = [];
  for (const [relativePath, rule] of Object.entries(REDUNDANT_RUNTIME_PACKAGES)) {
    const target = join(stagingRoot, relativePath);
    if (!existsSync(target)) continue;
    // Same safety envelope as the dev-path rules: a real, staging-local tree.
    const info = lstatSync(target);
    const resolvedTarget = realpathSync(target);
    const withinRoot = relative(stagingRoot, resolvedTarget);
    if ((!info.isDirectory() && !info.isFile()) || info.isSymbolicLink() || relative(target, resolvedTarget) !== '' || !withinRoot ||
        withinRoot === '..' || withinRoot.startsWith(`..${sep}`) || isAbsolute(withinRoot)) {
      throw new Error(`Refusing to prune a redundant runtime package at an unsafe path: ${target}`);
    }
    const nestedVersion = readStagedVersion(stagingRoot, relativePath);
    const replacementVersion = readStagedVersion(stagingRoot, rule.replacement);
    if (!replacementVersion) {
      throw new Error(
        `Redundant runtime package ${relativePath} has no replacement at ${rule.replacement}: ` +
        'review REDUNDANT_RUNTIME_PACKAGES in scripts/prune-daemon-runtime.mjs before packaging.',
      );
    }
    if (nestedVersion !== replacementVersion) {
      throw new Error(
        `Redundant runtime package ${relativePath} (${nestedVersion}) differs from its replacement ` +
        `${rule.replacement} (${replacementVersion}); refusing to prune. ` +
        'Review REDUNDANT_RUNTIME_PACKAGES in scripts/prune-daemon-runtime.mjs.',
      );
    }
    targets.push({ target, relativePath, replacementVersion });
  }
  return targets;
}

function developmentPaths(staging) {
  const stagingRoot = realpathSync(staging);
  const modules = realpathSync(join(stagingRoot, 'node_modules'));
  if (relative(stagingRoot, modules) !== 'node_modules') {
    throw new Error(`Runtime node_modules must stay inside its staging directory: ${modules}`);
  }
  const targets = [];
  for (const [packageName, paths] of Object.entries(DEVELOPMENT_ONLY_PATHS)) {
    for (const path of paths) {
      const target = resolve(modules, packageName, path);
      if (!existsSync(target)) continue;
      const info = lstatSync(target);
      const resolvedTarget = realpathSync(target);
      const withinModules = relative(modules, resolvedTarget);
      if ((!info.isDirectory() && !info.isFile()) || info.isSymbolicLink() || relative(target, resolvedTarget) !== '' || !withinModules ||
          withinModules === '..' || withinModules.startsWith(`..${sep}`) || isAbsolute(withinModules)) {
        throw new Error(`Refusing to prune an unsafe runtime path: ${target}`);
      }
      targets.push(resolvedTarget);
    }
  }
  return targets;
}

function suspiciousDevelopmentPaths(staging) {
  const root = realpathSync(staging);
  const matches = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const runtimePath = relative(root, path).split(sep).join('/');
      if (Object.hasOwn(REVIEWED_RUNTIME_PATHS, runtimePath)) {
        const reason = REVIEWED_RUNTIME_PATHS[runtimePath];
        if (typeof reason !== 'string' || !reason.trim()) {
          throw new Error(`Runtime asset exception needs a review reason: ${runtimePath}`);
        }
        continue;
      }
      if (DEVELOPMENT_DIRECTORY_NAMES.has(entry.name.toLowerCase()) || DEVELOPMENT_FILE_NAME.test(entry.name)) {
        matches.push(runtimePath);
      } else if (entry.isDirectory()) {
        walk(path);
      }
      // Do not follow symlinks, including npm's POSIX .bin links.
    }
  }
  walk(root);
  return matches;
}

function directorySize(directory) {
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = directorySize(path);
      files += nested.files;
      bytes += nested.bytes;
    } else {
      files += 1;
      bytes += lstatSync(path).size;
    }
  }
  return { files, bytes };
}

export function pruneDaemonRuntime(staging = defaultStaging) {
  const stagingRoot = realpathSync(staging);
  // Resolve and validate every target before performing any recursive removal.
  const targets = developmentPaths(stagingRoot);
  const redundant = redundantRuntimePackages(stagingRoot);
  let directories = 0;
  let files = 0;
  let bytes = 0;
  for (const target of targets) {
    const info = lstatSync(target);
    const size = info.isDirectory() ? directorySize(target) : { files: 1, bytes: info.size };
    if (info.isDirectory()) directories += 1;
    files += size.files;
    bytes += size.bytes;
    rmSync(target, { recursive: true });
  }
  for (const { target, relativePath, replacementVersion } of redundant) {
    const size = directorySize(target);
    directories += 1;
    files += size.files;
    bytes += size.bytes;
    rmSync(target, { recursive: true });
    console.info(
      `[daemon-runtime] pruned redundant ${relativePath} (identical ${replacementVersion} resolves from the runtime root)`,
    );
  }
  return { directories, files, bytes };
}

export function assertPrunedDaemonRuntime(staging = defaultStaging) {
  const root = realpathSync(staging);
  const remaining = [...new Set([
    ...developmentPaths(root).map((path) => relative(root, path).split(sep).join('/')),
    ...suspiciousDevelopmentPaths(root),
  ])].sort();
  if (remaining.length > 0) {
    throw new Error(
      `Daemon runtime assets require cleanup or review (${remaining.length}):\n${remaining.join('\n')}\n` +
      'Review these paths in scripts/prune-daemon-runtime.mjs. Add confirmed development-only assets to ' +
      'DEVELOPMENT_ONLY_PATHS, or document required runtime assets in REVIEWED_RUNTIME_PATHS, then restage the runtime.',
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = pruneDaemonRuntime();
  console.info(`[daemon-runtime] pruned ${result.files} development files from ${result.directories} directories (${result.bytes} bytes)`);
}
