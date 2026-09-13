/**
 * electronHost.ts — dedicated Electron browser host for the bridge.
 *
 * Instead of driving the user's daily Chrome, spawn an isolated Electron
 * child with its own persistent profile: ChatGPT login lives there, the
 * user's Chrome is never touched, and automation risk never splashes onto
 * their everyday browser session.
 *
 * Lifecycle: ensure runtime (npm-installed under the data dir) → spawn
 * `electron main.cjs --data-dir=…` → wait for DevToolsActivePort in that
 * data dir → hand the endpoint to the existing CdpConnection machinery.
 * A `--login` relaunch opens a visible window for interactive sign-in.
 *
 * @module @omnicross/chatgpt-web/browserHost/electronHost
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

export const ELECTRON_VERSION = '39.2.0';
const HOST_READY_TIMEOUT_MS = 90_000;

export interface ElectronHostHandle {
  /** The DevToolsActivePort ws path the bridge should connect to. */
  wsPath: string;
  port: number;
  /** Tab lifecycle over the host's loopback control endpoint. */
  targetFactory: { create(url: string): Promise<string>; close(targetId: string): Promise<void> };
  /** Relaunch with a visible login window (resolves once relaunched). */
  openLoginWindow: () => Promise<void>;
  stop: () => Promise<void>;
}

export class ElectronHostError extends Error {
  constructor(message: string, readonly guidance?: string) {
    super(message);
    this.name = 'ElectronHostError';
  }
}

function moduleDir(): string {
  // dist/browserHost/electronHost.js or src/browserHost/electronHost.ts —
  // main.cjs sits next to this file in both layouts.
  return dirname(fileURLToPath(import.meta.url));
}

function electronInstallDir(dataDir: string): string {
  return join(dataDir, 'browser');
}

function electronBinary(dataDir: string): string {
  return join(
    electronInstallDir(dataDir),
    'node_modules',
    'electron',
    'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron',
  );
}

function hostScript(): string {
  const here = moduleDir();
  const candidates = [
    join(here, 'main.cjs'), // src layout (tsx) and dist layout
    join(here, '..', 'browserHost', 'main.cjs'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

/**
 * Resolve a spawnable npm: prefer npm-cli.js next to the running Node binary
 * (win32 `.cmd` shims cannot be spawned directly on Node >= 20 — EINVAL).
 */
function resolveNpmCommand(): { command: string; args: string[] } {
  const execDir = dirname(process.execPath);
  const cliCandidates = [
    join(execDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(execDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const cli = cliCandidates.find((candidate) => existsSync(candidate));
  if (cli) return { command: process.execPath, args: [cli] };
  if (process.platform === 'win32') {
    const comSpec = process.env['ComSpec'] ?? 'cmd.exe';
    return { command: comSpec, args: ['/d', '/s', '/c', 'npm'] };
  }
  return { command: 'npm', args: [] };
}

/**
 * Install the pinned Electron runtime under the data dir (no-op when present).
 * Uses a plain npm child install so the core package stays dependency-light.
 */
export async function ensureElectronRuntime(dataDir: string): Promise<string> {
  const binary = electronBinary(dataDir);
  if (existsSync(binary)) return binary;
  const installDir = electronInstallDir(dataDir);
  mkdirSync(installDir, { recursive: true });
  writeFileSync(
    join(installDir, 'package.json'),
    `${JSON.stringify({ name: 'omnicross-chatgpt-web-browser', private: true }, null, 2)}\n`,
  );
  const npm = resolveNpmCommand();
  const child = spawn(
    npm.command,
    [
      ...npm.args,
      'install',
      `electron@${ELECTRON_VERSION}`,
      '--no-save',
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
    ],
    { cwd: installDir, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, shell: false },
  );
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const status = await new Promise<number>((resolve) => {
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
  if (status !== 0 || !existsSync(binary)) {
    throw new ElectronHostError(
      `Failed to install the Electron browser runtime under ${installDir}: ${stderr.slice(-400)}`,
      'Check network access to the npm registry (Electron is ~100MB, first time only).',
    );
  }
  return binary;
}

interface DevToolsPortFile {
  port: number;
  wsPath: string | null;
}

function readDevToolsPort(dataDir: string): DevToolsPortFile | null {
  const file = join(dataDir, 'DevToolsActivePort');
  if (!existsSync(file)) return null;
  try {
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    const port = Number.parseInt(lines[0] ?? '', 10);
    if (!Number.isInteger(port) || port <= 0) return null;
    const wsPath = lines[1]?.trim();
    return { port, wsPath: wsPath && wsPath.startsWith('/') ? wsPath : null };
  } catch {
    return null;
  }
}

async function waitForControlEndpoint(dataDir: string, timeoutMs = 30_000): Promise<{ port: number }> {
  const file = join(dataDir, 'host-control.json');
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const { statSync } = await import('node:fs');
  for (;;) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { port?: number };
      // Freshness: a previous run's stale control port would point nowhere.
      if (typeof parsed.port === 'number' && parsed.port > 0 && statSync(file).mtimeMs >= startedAt - 2_000) {
        return { port: parsed.port };
      }
    } catch {
      // Not written yet.
    }
    if (Date.now() >= deadline) {
      throw new ElectronHostError(`Electron host control endpoint did not appear within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function waitForPortFile(dataDir: string, timeoutMs: number): Promise<DevToolsPortFile> {
  const deadline = Date.now() + timeoutMs;
  // A previous run's stale port file must not fool us: require mtime freshness.
  const startedAt = Date.now();
  for (;;) {
    const parsed = readDevToolsPort(dataDir);
    const file = join(dataDir, 'DevToolsActivePort');
    if (parsed && existsSync(file)) {
      const { statSync } = await import('node:fs');
      if (statSync(file).mtimeMs >= startedAt - 2_000) return parsed;
    }
    if (Date.now() >= deadline) {
      throw new ElectronHostError(
        `Electron host did not expose its DevTools port within ${timeoutMs}ms (data dir: ${dataDir})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * Reference-implementation-style interactive sign-in: a standalone visible
 * window with **no remote debugging port at all**, so the login surface is
 * indistinguishable from a plain packaged Chromium app (accounts.google.com
 * and Cloudflare both reject the debug-port/automation shape). Progress is
 * reported through the host control endpoint's cookie-based /login-state.
 */
export async function startStandaloneLoginWindow(options: {
  dataDir: string;
  onStderr?: (line: string) => void;
}): Promise<{
  waitUntilAuthenticated: (timeoutMs?: number) => Promise<{ authenticated: boolean }>;
  stop: () => Promise<void>;
}> {
  const binary = await ensureElectronRuntime(options.dataDir);
  const script = hostScript();
  const args = [script, `--data-dir=${options.dataDir}`, '--login'];
  const proxy =
    process.env['HTTPS_PROXY'] ??
    process.env['https_proxy'] ??
    process.env['HTTP_PROXY'] ??
    process.env['http_proxy'];
  if (proxy) args.unshift(`--proxy-server=${proxy}`);
  const attempt = async (): Promise<{ child: ReturnType<typeof spawn>; control: { port: number } }> => {
    const spawned = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: false });
    spawned.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim()) options.onStderr?.(line.trim());
      }
    });
    const exited = new Promise<null>((resolve) => spawned.once('exit', () => resolve(null)));
    const control = await Promise.race([
      waitForControlEndpoint(options.dataDir, 60_000).then((value) => value),
      exited.then(() => new Promise<never>((_, reject) =>
        reject(new ElectronHostError('login window exited before its control endpoint came up')))),
    ]);
    return { child: spawned, control };
  };
  let child: ReturnType<typeof spawn>;
  let control: { port: number };
  try {
    ({ child, control } = await attempt());
  } catch {
    // A leftover host holding the single-instance lock kills the window at
    // spawn. Clear our own instances (never by image name) and retry once.
    await stopExistingElectronHosts(options.dataDir);
    ({ child, control } = await attempt());
  }
  const pollOnce = async (): Promise<{ authenticated: boolean } | null> => {
    try {
      const response = await fetch(`http://127.0.0.1:${control.port}/login-state`);
      if (!response.ok) return null;
      return (await response.json()) as { authenticated: boolean };
    } catch {
      return null;
    }
  };
  return {
    waitUntilAuthenticated: async (timeoutMs = 10 * 60_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const state = await pollOnce();
        if (state?.authenticated) return { authenticated: true };
        // Window closed (or crashed): the login attempt is over.
        if (child.exitCode !== null) return { authenticated: false };
        if (Date.now() >= deadline) return { authenticated: false };
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
    },
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

/**
 * Stop OUR OWN browser hosts without touching anyone else's electron.
 *
 * NEVER kill by image name (`taskkill /IM electron.exe`) — that matches every
 * Electron app on the machine, including unrelated dev instances. Instead:
 *   1. graceful: POST /shutdown on the live host's control endpoint
 *   2. fallback: kill only processes whose executable path equals our
 *      managed binary under the data dir (targeted, by full path)
 */
export async function stopExistingElectronHosts(dataDir: string): Promise<void> {
  // Graceful first: a live host shuts down cleanly via its control endpoint.
  try {
    const file = join(dataDir, 'host-control.json');
    if (existsSync(file)) {
      const { port } = JSON.parse(readFileSync(file, 'utf8')) as { port?: number };
      if (typeof port === 'number' && port > 0) {
        await fetch(`http://127.0.0.1:${port}/shutdown`, {
          method: 'POST',
          signal: AbortSignal.timeout(3_000),
        }).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
    }
  } catch {
    // No live control endpoint — fall through to the targeted kill.
  }
  // Fallback for zombie hosts without a control endpoint (e.g. a crashed
  // daemon's leftover holding the single-instance lock). Match by FULL
  // executable path so other projects' electron processes are never hit.
  const binary = join(
    electronInstallDir(dataDir),
    'node_modules',
    'electron',
    'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron',
  );
  if (!existsSync(binary)) return;
  if (process.platform === 'win32') {
    const psScript =
      `Get-Process electron -ErrorAction SilentlyContinue | ` +
      `Where-Object { $_.Path -eq '${binary.replaceAll("'", "''")}' } | Stop-Process -Force`;
    await new Promise<void>((resolve) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-Command', psScript], {
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('error', () => resolve());
      child.on('close', () => resolve());
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    return;
  }
  await new Promise<void>((resolve) => {
    const child = spawn('pkill', ['-f', binary], { stdio: 'ignore' });
    child.on('error', () => resolve());
    child.on('close', () => resolve());
  });
}

/**
 * Start the Electron host and resolve once its CDP endpoint is live.
 * `visible` keeps the window shown (useful while dogfooding).
 */
export async function startElectronHost(options: {
  dataDir: string;
  visible?: boolean;
  onStderr?: (line: string) => void;
}): Promise<ElectronHostHandle> {
  const binary = await ensureElectronRuntime(options.dataDir);
  const script = hostScript();
  if (!existsSync(script)) {
    throw new ElectronHostError(`browser host main script not found: ${script}`);
  }
  const args = [
    // Chromium only writes DevToolsActivePort when remote debugging is on;
    // port 0 = random port, recorded into <userData>/DevToolsActivePort.
    '--remote-debugging-port=0',
    script,
    `--data-dir=${options.dataDir}`,
    ...(options.visible ? ['--show'] : []),
  ];
  // The host must ride the user's proxy like their browser does; Chromium
  // picks the system proxy by default, explicit env wins when present.
  const proxy = process.env['HTTPS_PROXY'] ?? process.env['https_proxy'] ?? process.env['HTTP_PROXY'] ?? process.env['http_proxy'];
  if (proxy) args.unshift(`--proxy-server=${proxy}`);
  // windowsHide must stay false: it plants STARTF_USESHOWWINDOW/SW_HIDE into
  // the GUI process's startup info, and Electron then honors it — every
  // BrowserWindow (even show:true tabs) ends up a real but never-visible
  // HWND. That was the whole "window never appears" saga.
  const attempt = async (): Promise<{
    child: ReturnType<typeof spawn>;
    endpoint: DevToolsPortFile;
    control: { port: number };
  }> => {
    const spawned = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: false });
    const tail: string[] = [];
    spawned.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        tail.push(line.trim());
        if (tail.length > 30) tail.shift();
        options.onStderr?.(line.trim());
      }
    });
    const exited = new Promise<never>((_, reject) => {
      spawned.once('exit', (code) => reject(new ElectronHostError(`Electron host exited early (code ${code}): ${tail.join(' | ').slice(0, 400)}`)));
    });
    const endpoint = await Promise.race([waitForPortFile(options.dataDir, HOST_READY_TIMEOUT_MS), exited]);
    // The control endpoint appears right after the CDP port; wait for it too.
    const control = await waitForControlEndpoint(options.dataDir);
    return { child: spawned, endpoint, control };
  };
  let current: Awaited<ReturnType<typeof attempt>>;
  try {
    current = await attempt();
  } catch {
    // A leftover instance holding the single-instance lock makes a fresh
    // child exit immediately. Clear OUR hosts only (never by image name —
    // that would kill unrelated Electron apps) and retry once.
    await stopExistingElectronHosts(options.dataDir);
    current = await attempt();
  }
  const { child, endpoint, control } = current;
  const controlCall = async <T>(op: string, body: Record<string, unknown>): Promise<T> => {
    const response = await fetch(`http://127.0.0.1:${control.port}${op}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ElectronHostError(`host control ${op} failed: ${response.status} ${text.slice(0, 300)}`);
    }
    return (await response.json()) as T;
  };
  return {
    port: endpoint.port,
    wsPath: endpoint.wsPath ?? '/devtools/browser',
    targetFactory: {
      create: async (url: string, opts?: { show?: boolean }) =>
        (await controlCall<{ targetId: string }>('/new-target', { url, show: opts?.show === true })).targetId,
      close: async (targetId: string) => {
        await controlCall('/close-target', { targetId }).catch(() => undefined);
      },
    },
    openLoginWindow: async () => {
      // A visible login relaunch: the single-instance lock routes it to the
      // running host, which re-shows its window on chatgpt.com.
      const loginChild = spawn(binary, [script, `--data-dir=${options.dataDir}`, '--login'], {
        stdio: 'ignore',
        windowsHide: false,
        detached: process.platform !== 'win32',
      });
      loginChild.unref();
    },
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}
