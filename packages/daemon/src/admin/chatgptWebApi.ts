/**
 * chatgptWebApi — the dashboard's ChatGPT Web management surface
 * (`/admin/api/chatgpt-web/*`).
 *
 * The chatgpt-web feature is a chain of independently checkable pieces
 * (harness config → tunnel → Electron host login → bridge). This module
 * aggregates their status for the UI, opens the CDP-less login window on
 * demand, probes the persisted ChatGPT session cookie, and manages one
 * background bridge instance.
 *
 * SECRET DISCIPLINE: the harness runtime key never crosses this boundary —
 * only its presence. The tunnel id is truncated. The bridge token is shown
 * to the local operator only (this surface is loopback + admin-auth).
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { loadHarnessConfig } from '@omnicross/chatgpt-web/tunnel/harnessConfig';

/** One background bridge owned by this daemon (singleton). */
interface BridgeState {
  stop: () => Promise<void>;
  baseUrl: string;
  token: string;
  model: string;
  harness: boolean;
  startedAt: number;
}

let bridge: BridgeState | null = null;
let loginCache: { authenticated: boolean; checkedAt: number } | null = null;

function dataDir(): string {
  return join(homedir(), '.omnicross', 'chatgpt-web');
}

function tunnelBinary(): string {
  return join(dataDir(), 'bin', process.platform === 'win32' ? 'tunnel-client.exe' : 'tunnel-client');
}

function electronBinaryInstalled(): boolean {
  return existsSync(join(dataDir(), 'browser', 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'));
}

/** Run a command with a timeout; resolves stdout+stderr. */
function runBinary(command: string, args: string[], timeoutMs: number): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const finish = (status: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, output });
    };
    const child = spawn(command, args, { windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
  });
}

interface TunnelStatusView {
  installed: boolean;
  running: boolean;
  healthy: boolean;
  ready: boolean;
  detail: string;
}

async function tunnelStatus(): Promise<TunnelStatusView> {
  const binary = tunnelBinary();
  if (!existsSync(binary)) {
    return { installed: false, running: false, healthy: false, ready: false, detail: 'tunnel-client not installed' };
  }
  const { status, output } = await runBinary(binary, ['runtimes', 'status', 'omnicross-chatgpt-web', '--json'], 12_000);
  try {
    const parsed = JSON.parse(output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1)) as Record<string, unknown>;
    return {
      installed: true,
      running: parsed['process_running'] === true,
      healthy: parsed['healthy'] === true,
      ready: parsed['ready'] === true,
      detail: `${String(parsed['runtime_state'] ?? '')}${parsed['stop_error'] ? `: ${String(parsed['stop_error'])}` : ''}`.trim(),
    };
  } catch {
    return { installed: true, running: false, healthy: false, ready: false, detail: `status exit ${status ?? 'timeout'}` };
  }
}

/** Read the live host's login state from its control endpoint, if one is up. */
async function liveLoginState(): Promise<boolean | null> {
  const file = join(dataDir(), 'host-control.json');
  if (!existsSync(file)) return null;
  try {
    // Fresh files only: a previous run's port points nowhere.
    if (Date.now() - statSync(file).mtimeMs > 30 * 60_000) return null;
    const { port } = JSON.parse(readFileSync(file, 'utf8')) as { port?: number };
    if (typeof port !== 'number') return null;
    const response = await fetch(`http://127.0.0.1:${port}/login-state`, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) return null;
    return ((await response.json()) as { authenticated?: boolean }).authenticated === true;
  } catch {
    return null;
  }
}

/** Kill any Electron hosts first — the single-instance lock must be free. */
async function killElectronHosts(): Promise<void> {
  if (process.platform !== 'win32') return;
  await new Promise<void>((resolve) => {
    const child = spawn('taskkill', ['/IM', 'electron.exe', '/F'], { stdio: 'ignore', windowsHide: true });
    child.on('error', () => undefined);
    child.on('close', () => resolve());
  });
  await new Promise((resolve) => setTimeout(resolve, 1_200));
}

/**
 * Spawn a short-lived hidden host and read its cookie-based login state.
 * Reuses a live host's control endpoint when one is already up.
 */
async function probeLogin(): Promise<boolean> {
  const live = await liveLoginState();
  if (live !== null) {
    loginCache = { authenticated: live, checkedAt: Date.now() };
    return live;
  }
  await killElectronHosts();
  const { startElectronHost } = await import('@omnicross/chatgpt-web/browserHost/electronHost');
  const host = await startElectronHost({ dataDir: dataDir() });
  try {
    const state = await liveLoginState();
    const authenticated = state === true;
    loginCache = { authenticated, checkedAt: Date.now() };
    return authenticated;
  } finally {
    await host.stop();
  }
}

function bridgeView() {
  if (!bridge) return { running: false };
  return {
    running: true,
    baseUrl: bridge.baseUrl,
    token: bridge.token,
    model: bridge.model,
    harness: bridge.harness,
    startedAt: bridge.startedAt,
  };
}

async function statusView() {
  const harness = loadHarnessConfig();
  const [tunnel, login] = await Promise.all([tunnelStatus(), liveLoginState()]);
  const loginState: 'signed-in' | 'signed-out' | 'unknown' =
    login === true ? 'signed-in' : login === false ? 'signed-out'
      : loginCache ? (loginCache.authenticated ? 'signed-in' : 'signed-out') : 'unknown';
  return {
    config: {
      present: harness !== null,
      connectorName: harness?.connectorName ?? null,
      tunnelId: harness ? `${harness.tunnelId.slice(0, 13)}…` : null,
      hasRuntimeKey: harness ? true : false,
    },
    electronRuntimeInstalled: electronBinaryInstalled(),
    login: { state: loginState, checkedAt: loginCache?.checkedAt ?? null },
    tunnel,
    bridge: bridgeView(),
  };
}

export async function handleChatGptWeb(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  rest: string[],
): Promise<void> {
  const respond = (status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const fail = (status: number, message: string): void => respond(status, { error: { type: 'admin_api_error', message } });

  try {
    if (method === 'GET' && rest.length === 0) {
      return respond(200, await statusView());
    }
    if (method === 'POST' && rest[0] === 'login') {
      // The login window is CDP-less (reference-implementation style) — it
      // must not share a profile with a running host, so free the lock first.
      await killElectronHosts();
      const { startStandaloneLoginWindow } = await import('@omnicross/chatgpt-web/browserHost/electronHost');
      const loginWindow = await startStandaloneLoginWindow({ dataDir: dataDir() });
      // Keep the handle referenced so the window is not torn down with a
      // request; the user closes it when done. Poll via /login-check.
      void loginWindow.waitUntilAuthenticated(60 * 60_000).then((state) => {
        if (state.authenticated) loginCache = { authenticated: true, checkedAt: Date.now() };
      });
      return respond(200, { opened: true });
    }
    if (method === 'POST' && rest[0] === 'login-check') {
      const authenticated = await probeLogin();
      return respond(200, { authenticated });
    }
    if (method === 'POST' && rest[0] === 'bridge') {
      if (bridge) return fail(409, 'a chatgpt-web bridge is already running');
      const raw = await new Promise<string>((resolve) => {
        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8');
        });
        req.on('end', () => resolve(body));
      });
      let parsed: Record<string, unknown> = {};
      try {
        parsed = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        return fail(400, 'invalid JSON body');
      }
      const model = typeof parsed['model'] === 'string' && parsed['model'] ? parsed['model'] : 'chatgpt-web/light';
      const harness = parsed['harness'] !== false;
      const { startChatGptWebBridge, generateBridgeToken } = await import('@omnicross/chatgpt-web/server');
      const token = generateBridgeToken();
      const handle = await startChatGptWebBridge({
        port: 17850,
        authToken: token,
        harness,
        browserHost: 'electron',
        onError: () => undefined,
      });
      bridge = {
        stop: async () => {
          await handle.stop();
          bridge = null;
        },
        baseUrl: handle.baseUrl,
        token,
        model,
        harness,
        startedAt: Date.now(),
      };
      return respond(200, bridgeView());
    }
    if (method === 'DELETE' && rest[0] === 'bridge') {
      if (!bridge) return fail(404, 'no chatgpt-web bridge is running');
      const current = bridge;
      bridge = null;
      await current.stop();
      return respond(200, { stopped: true });
    }
    return fail(405, `method ${method} not allowed on chatgpt-web`);
  } catch (err) {
    return fail(500, err instanceof Error ? err.message : String(err));
  }
}
