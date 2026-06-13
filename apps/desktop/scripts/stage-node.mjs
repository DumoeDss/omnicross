/**
 * stage-node.mjs — bundle a private Node runtime next to the staged daemon.
 *
 * Tauri ships no JS engine (unlike Electron), and the daemon is plain JS, so a
 * packaged app still needs *a* node to run `daemon-runtime/.../cli.js`. Instead
 * of requiring Node.js on the end user's PATH, we download the official Node
 * binary for the build target and drop it at `daemon-runtime/runtime/node[.exe]`,
 * which ships inside the existing `daemon-runtime` Tauri resource. The Rust shell
 * prefers this bundled node and only falls back to PATH `node` if it's absent.
 *
 * Runs AFTER build-daemon-runtime.mjs (which (re)creates daemon-runtime/).
 *
 * Target selection:
 *   - host platform/arch by default (local `npm run build:app`);
 *   - OMNICROSS_NODE_TARGET=darwin-universal → lipo arm64 + x64 into one fat
 *     binary (for CI's `tauri build --target universal-apple-darwin`).
 *
 * Escape hatches:
 *   - OMNICROSS_SKIP_NODE_BUNDLE=1 → skip (the shell falls back to PATH node);
 *   - OMNICROSS_NODE_VERSION=x.y.z → pin a different Node (default below).
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE_VERSION = process.env.OMNICROSS_NODE_VERSION || '20.18.1';

if (process.env.OMNICROSS_SKIP_NODE_BUNDLE) {
  console.info('[stage-node] OMNICROSS_SKIP_NODE_BUNDLE set — skipping (PATH node fallback).');
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const runtimeDir = resolve(here, '..', 'src-tauri', 'daemon-runtime', 'runtime');
const DIST = `https://nodejs.org/dist/v${NODE_VERSION}`;

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status}): ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

// SHASUMS256.txt maps each published file to its sha256 — fetched once, lazily.
let shasums;
async function expectedSha(name) {
  if (!shasums) {
    const txt = (await fetchBuffer(`${DIST}/SHASUMS256.txt`)).toString('utf8');
    shasums = new Map(
      txt
        .split('\n')
        .map((l) => l.trim().split(/\s+/))
        .filter((p) => p.length === 2)
        .map(([sha, file]) => [file, sha]),
    );
  }
  return shasums.get(name);
}

async function download(name, url) {
  console.info(`[stage-node] downloading ${name} …`);
  const buf = await fetchBuffer(url);
  const want = await expectedSha(name);
  if (!want) throw new Error(`no checksum for ${name} in SHASUMS256.txt`);
  const got = createHash('sha256').update(buf).digest('hex');
  if (got !== want) throw new Error(`checksum mismatch for ${name}:\n  got  ${got}\n  want ${want}`);
  return buf;
}

/** Return the raw `node` executable bytes for a platform/arch. */
async function nodeBinary(plat, arch) {
  // Windows publishes a bare node.exe — no archive to unpack.
  if (plat === 'win') {
    return download('win-x64/node.exe', `${DIST}/win-x64/node.exe`);
  }
  // darwin / linux: pluck `<dir>/bin/node` straight out of the tarball via tar -O.
  const base = `node-v${NODE_VERSION}-${plat}-${arch}`;
  const tarName = `${base}.tar.gz`;
  const tarBuf = await download(tarName, `${DIST}/${tarName}`);
  const tmpTar = join(tmpdir(), `omnicross-${base}.tar.gz`);
  writeFileSync(tmpTar, tarBuf);
  try {
    return execFileSync('tar', ['-xzOf', tmpTar, `${base}/bin/node`], {
      maxBuffer: 512 * 1024 * 1024,
    });
  } finally {
    rmSync(tmpTar, { force: true });
  }
}

mkdirSync(runtimeDir, { recursive: true });

if (process.platform === 'win32') {
  writeFileSync(join(runtimeDir, 'node.exe'), await nodeBinary('win', 'x64'));
} else if (process.platform === 'darwin' && process.env.OMNICROSS_NODE_TARGET === 'darwin-universal') {
  // Universal app: a single fat node so the x64 slice doesn't try to exec an arm64 node.
  const arm = join(tmpdir(), 'omnicross-node-arm64');
  const x64 = join(tmpdir(), 'omnicross-node-x64');
  writeFileSync(arm, await nodeBinary('darwin', 'arm64'));
  writeFileSync(x64, await nodeBinary('darwin', 'x64'));
  const out = join(runtimeDir, 'node');
  execFileSync('lipo', ['-create', arm, x64, '-output', out]);
  chmodSync(out, 0o755);
  rmSync(arm, { force: true });
  rmSync(x64, { force: true });
} else {
  const plat = process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const out = join(runtimeDir, 'node');
  writeFileSync(out, await nodeBinary(plat, arch));
  chmodSync(out, 0o755);
}

console.info(`[stage-node] bundled Node v${NODE_VERSION} → ${runtimeDir}`);
