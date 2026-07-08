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
 *   - OMNICROSS_NODE_VERSION=x.y.z → pin a different Node (default below);
 *   - OMNICROSS_NODE_MIRROR=<url> (or NODEJS_ORG_MIRROR) → fetch from a mirror of
 *     the nodejs.org/dist layout, tried *before* the built-ins. Note: Node's global
 *     fetch() ignores HTTP(S)_PROXY, so a working proxy alone won't unblock this.
 *   - OMNICROSS_NODE_FETCH_TIMEOUT_MS=<ms> → per-request timeout (default 300000);
 *     converts a stalled connection into a clear error instead of an infinite hang.
 *
 * Mirrors are tried in order; on timeout/failure it auto-falls back to the next.
 * Built-in order: nodejs.org → npmmirror (so a blocked nodejs.org self-heals in
 * China). Checksums are verified against SHASUMS256.txt regardless of source.
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
// Mirrors of the nodejs.org/dist layout, tried in order with auto-fallback. An
// explicit env mirror wins; npmmirror is the built-in China fallback. Each must
// expose /v<ver>/{win-x64/node.exe,*.tar.gz,SHASUMS256.txt} — checksums verified.
const envMirror = (process.env.OMNICROSS_NODE_MIRROR || process.env.NODEJS_ORG_MIRROR || '')
  .replace(/\/+$/, '');
const MIRRORS = [
  ...new Set(
    [envMirror, 'https://nodejs.org/dist', 'https://registry.npmmirror.com/-/binary/node'].filter(
      Boolean,
    ),
  ),
];
// fetch() has no default timeout; without this a stalled connection hangs forever.
const FETCH_TIMEOUT_MS = Number(process.env.OMNICROSS_NODE_FETCH_TIMEOUT_MS) || 300_000;

async function fetchBuffer(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`download failed (${res.status}): ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

// Fetch a path (relative to /v<ver>/) trying each mirror until one works. The
// last-good mirror is tried first next time so we don't re-probe a dead host.
let activeMirror;
async function fetchRelative(relPath) {
  const ordered = activeMirror
    ? [activeMirror, ...MIRRORS.filter((m) => m !== activeMirror)]
    : MIRRORS;
  let lastErr;
  for (const base of ordered) {
    try {
      const buf = await fetchBuffer(`${base}/v${NODE_VERSION}/${relPath}`);
      if (base !== activeMirror) {
        if (activeMirror) console.info(`[stage-node] mirror fallback → ${base}`);
        activeMirror = base;
      }
      return buf;
    } catch (err) {
      lastErr = err;
      console.warn(`[stage-node] ${base} failed (${err.message}); trying next mirror …`);
    }
  }
  throw new Error(`all mirrors failed for ${relPath}: ${lastErr?.message}`);
}

// SHASUMS256.txt maps each published file to its sha256 — fetched once, lazily.
let shasums;
async function expectedSha(name) {
  if (!shasums) {
    const txt = (await fetchRelative('SHASUMS256.txt')).toString('utf8');
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

// relPath doubles as the SHASUMS256.txt key (e.g. 'win-x64/node.exe', '<tar>.tar.gz').
async function download(relPath) {
  console.info(`[stage-node] downloading ${relPath} …`);
  const buf = await fetchRelative(relPath);
  const want = await expectedSha(relPath);
  if (!want) throw new Error(`no checksum for ${relPath} in SHASUMS256.txt`);
  const got = createHash('sha256').update(buf).digest('hex');
  if (got !== want) throw new Error(`checksum mismatch for ${relPath}:\n  got  ${got}\n  want ${want}`);
  return buf;
}

/** Return the raw `node` executable bytes for a platform/arch. */
async function nodeBinary(plat, arch) {
  // Windows publishes a bare node.exe — no archive to unpack.
  if (plat === 'win') {
    return download('win-x64/node.exe');
  }
  // darwin / linux: pluck `<dir>/bin/node` straight out of the tarball via tar -O.
  const base = `node-v${NODE_VERSION}-${plat}-${arch}`;
  const tarName = `${base}.tar.gz`;
  const tarBuf = await download(tarName);
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
