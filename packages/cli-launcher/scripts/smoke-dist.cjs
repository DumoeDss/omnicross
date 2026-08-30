'use strict';

const { readFileSync, readdirSync } = require('node:fs');
const { resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

async function main() {
  const dist = resolve(__dirname, '..', 'dist');
  const cjs = require(resolve(dist, 'index.cjs'));
  const cjsPty = require(resolve(dist, 'pty-adapter.cjs'));
  const esmIndexUrl = pathToFileURL(resolve(dist, 'index.js')).href;
  const esmPtyUrl = pathToFileURL(resolve(dist, 'pty-adapter.js')).href;
  const esm = await import(esmIndexUrl);
  const esmPty = await import(esmPtyUrl);

  for (const [label, value] of [
    ['CJS index', cjs.getProcessSupervisor],
    ['CJS PTY subpath', cjsPty.buildPtyEnv],
    ['ESM index', esm.getProcessSupervisor],
    ['ESM PTY subpath', esmPty.buildPtyEnv],
  ]) {
    if (typeof value !== 'function') throw new TypeError(`${label} export is unavailable`);
  }

  for (const name of readdirSync(dist).filter((entry) => entry.endsWith('.cjs'))) {
    if (readFileSync(resolve(dist, name), 'utf8').includes('import.meta')) {
      throw new SyntaxError(`${name} contains import.meta in CommonJS output`);
    }
  }

  // `node -e` exposes a non-path __filename value ("[eval]") that ESM imports
  // must not pass to createRequire.
  const evalImport = spawnSync(process.execPath, [
    '-e',
    `Promise.all([import(${JSON.stringify(esmIndexUrl)}), import(${JSON.stringify(esmPtyUrl)})])`
      + `.then(([index, pty]) => {`
      + `if (typeof index.getProcessSupervisor !== 'function' || typeof pty.buildPtyEnv !== 'function') process.exit(2);`
      + `})`,
  ], { encoding: 'utf8' });
  if (evalImport.status !== 0) {
    throw new Error(`CommonJS eval import failed: ${evalImport.stderr.trim()}`);
  }

  console.log('cli-launcher CJS/ESM dist smoke passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
