import { execFileSync } from 'node:child_process';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertPrunedDaemonRuntime, pruneDaemonRuntime,
} from '../../../apps/desktop/scripts/prune-daemon-runtime.mjs';
import { replacePrivateRuntime } from './replace-private-runtime.mjs';

const daemon = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = realpathSync(resolve(daemon, '..', '..'));
const privateName = '@omnicross/chatgpt-web';
const source = join(repo, 'packages', 'chatgpt-web');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Stage the private runtime through npm pack or npm publish.');

function npm(args) {
  return JSON.parse(execFileSync(process.execPath, [npmCli, ...args], {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  }));
}

// No dependency resolution or install here: ship the same production versions
// tested by npm ci. npm ls gives actual locations, including nested versions.
const lock = JSON.parse(readFileSync(join(repo, 'package-lock.json'), 'utf8'));
const tree = npm(['ls', '--workspace', privateName, '--omit=dev', '--all', '--long', '--json']);
const privateTree = tree.dependencies?.[privateName];
if (!privateTree?.path) throw new Error('The private runtime workspace must be installed before packing.');
const closure = new Map();
function collect(node) {
  if (!node.path) return; // Absent optional peers, e.g. ws's native accelerators.
  const path = realpathSync(node.path);
  const lockPath = relative(repo, path).split(sep).join('/');
  if (lock.packages[lockPath]?.version !== node.version || node.invalid || node.missing) {
    throw new Error(`Installed runtime dependency differs from package-lock.json: ${node.name ?? path}`);
  }
  if (path !== source && !lockPath.startsWith('node_modules/')) {
    throw new Error(`Private runtime dependency must be installed under repository node_modules: ${path}`);
  }
  closure.set(path, lockPath);
  for (const dependency of Object.values(node.dependencies ?? {})) collect(dependency);
}
collect(privateTree);
const [packed] = npm(['pack', '--workspace', privateName, '--ignore-scripts', '--dry-run', '--json']);
const requiredAssets = [
  'LICENSE', 'NOTICE', 'dist/index.js', 'dist/index.cjs', 'dist/index.d.ts',
  'dist/server.js', 'dist/server.cjs', 'dist/session.js',
  'dist/bridge/models.js', 'dist/tunnel/harnessConfig.js',
  'dist/tunnel/tunnelClient.js', 'dist/tunnel/mcpServer.js',
  'dist/askpro/askProServer.js', 'dist/askpro/askProServer.d.ts',
  'dist/askpro/askProCore.js', 'dist/askpro/askProCore.cjs', 'dist/askpro/askProCore.d.ts',
  'dist/browserHost/electronHost.js', 'dist/browserHost/main.cjs',
  'node_modules/ws/package.json',
];

// npm cannot bundle workspace links hoisted outside the packed workspace.
// Preserve installed node_modules topology in ordinary directories instead.
replacePrivateRuntime({
  daemon,
  populate(runtime) {
    for (const { path } of packed.files) {
      const destination = join(runtime, path);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(source, path), destination);
    }
    const cleanupRoots = new Set([runtime]);
    for (const [path, lockPath] of closure) {
      if (path === source) continue;
      const destination = join(runtime, lockPath);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(path, destination, {
        recursive: true,
        filter: (entry) => relative(path, entry).split(sep)[0] !== 'node_modules',
      });
      // Apply the same explicit reviewed package rules to nested versions too.
      const modules = lockPath.slice(0, lockPath.lastIndexOf('node_modules/') + 'node_modules'.length);
      cleanupRoots.add(dirname(join(runtime, modules)));
    }
    // This policy removes only enumerated tests/.github/.yarn paths, never
    // declarations, declaration maps, licenses, exports or runtime assets.
    for (const root of cleanupRoots) pruneDaemonRuntime(root);
    assertPrunedDaemonRuntime(runtime);
  },
  validate(runtime) {
    const manifest = JSON.parse(readFileSync(join(runtime, 'package.json'), 'utf8'));
    if (manifest.name !== privateName || manifest.private !== true || manifest.version !== privateTree.version) {
      throw new Error('The staged ChatGPT Web package must remain private and lock-versioned.');
    }
    for (const file of [...requiredAssets, ...packed.files.map(({ path }) => path)]) {
      if (!existsSync(join(runtime, file))) throw new Error(`Private runtime asset missing: ${file}`);
    }
    for (const [path, lockPath] of closure) {
      const packageRoot = path === source ? runtime : join(runtime, lockPath);
      const installed = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
      if (installed.version !== lock.packages[lockPath].version) {
        throw new Error(`Staged production dependency differs from package-lock.json: ${lockPath}`);
      }
      const require = createRequire(join(packageRoot, 'package.json'));
      for (const name of Object.keys(installed.dependencies ?? {})) {
        // Locate the package independently of exports: some valid dependencies
        // (math-intrinsics) expose only subpaths, not a root entry.
        const metadata = require.resolve.paths(`${name}/package.json`)
          ?.map((base) => join(base, name, 'package.json')).find((file) => existsSync(file));
        if (!metadata) throw new Error(`Staged production dependency missing: ${name}`);
        const resolved = realpathSync(metadata);
        const withinRuntime = relative(runtime, resolved);
        if (withinRuntime === '..' || withinRuntime.startsWith(`..${sep}`)) {
          throw new Error(`Staged production dependency escapes the private runtime: ${name}`);
        }
      }
    }
  },
});
console.info(`[daemon-pack] staged private ChatGPT Web and ${closure.size - 1} locked production dependencies`);
