/**
 * dev.mjs — one-command dev environment: `npm run dev` at the repo root.
 *
 * Starts BOTH halves of the Control Panel dev loop:
 *   [daemon] node packages/daemon/dist/cli.js start --config omnicross.dev.config.json
 *   [ui]     vite dev server in packages/ui (http://localhost:1430)
 *
 * Conveniences:
 *  - missing daemon dist  → runs `npm run build` once first,
 *  - missing dev config   → seeds `omnicross.dev.config.json` (gitignored;
 *    empty providers, admin on 8766 — add providers via the UI or the CLI),
 *  - Ctrl+C (or either process dying) tears both down.
 *
 * This is the dev-mode analogue of the installed `omnicross ui` command (which
 * serves the prebuilt UI from the daemon itself at /ui).
 */

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const daemonCli = join(root, 'packages', 'daemon', 'dist', 'cli.js');
const devConfig = join(root, 'omnicross.dev.config.json');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const DEFAULT_DEV_CONFIG = {
  providers: [],
  server: { enabled: true, networkBinding: false, port: 0, endpoints: [] },
  admin: { port: 8766 },
};

// Windows note: npm is a .cmd shim, so it needs a shell — pass ONE command
// string (not an args array) to avoid Node's DEP0190 warning. All parts are
// fixed strings, nothing user-controlled.
function runNpm(argString, opts = {}) {
  return spawn(`${npmCmd} ${argString}`, { cwd: root, stdio: 'inherit', shell: true, ...opts });
}

function prefixed(child, tag) {
  const fwd = (stream, out) =>
    stream.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) out.write(`[${tag}] ${line}\n`);
      }
    });
  fwd(child.stdout, process.stdout);
  fwd(child.stderr, process.stderr);
}

// 1. Build once if the daemon dist is missing.
if (!existsSync(daemonCli)) {
  console.info('[dev] daemon dist missing — running `npm run build` once…');
  const code = await new Promise((res) => runNpm('run build').on('exit', res));
  if (code !== 0) process.exit(code ?? 1);
}

// 2. Seed a dev config on first run.
if (!existsSync(devConfig)) {
  writeFileSync(devConfig, JSON.stringify(DEFAULT_DEV_CONFIG, null, 2) + '\n', 'utf8');
  console.info('[dev] seeded omnicross.dev.config.json (no providers yet — add them in the UI)');
}

// 3. Start both; either one dying (or Ctrl+C) stops the other.
console.info('[dev] daemon → http://127.0.0.1:8766   ui → http://localhost:1430');
const daemon = spawn(process.execPath, [daemonCli, 'start', '--config', devConfig], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const ui = spawn(`${npmCmd} run dev -w @omnicross/ui`, {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: true,
});
prefixed(daemon, 'daemon');
prefixed(ui, 'ui');

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of [daemon, ui]) {
    if (child.exitCode === null) child.kill();
  }
  process.exitCode = code;
}
daemon.on('exit', (code) => shutdown(code ?? 0));
ui.on('exit', (code) => shutdown(code ?? 0));
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
