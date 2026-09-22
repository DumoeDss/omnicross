/**
 * chatgptWebApi — the dashboard's ChatGPT Web management surface
 * (`/admin/api/chatgpt-web/*`).
 *
 * The chatgpt-web feature is a chain of independently checkable pieces
 * (harness config → tunnel → Electron host login → bridge). This module
 * aggregates their status for the UI, saves the harness config from the
 * setup form (kicking the tunnel-client download), opens the CDP-less login
 * window on demand, probes the persisted ChatGPT session, and manages one
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

import { CHATGPT_WEB_MODEL_ROUTES } from '@omnicross/chatgpt-web/bridge/models';
import { loadHarnessConfig, saveHarnessConfig } from '@omnicross/chatgpt-web/tunnel/harnessConfig';
import { installTunnelClient, isValidTunnelId } from '@omnicross/chatgpt-web/tunnel/tunnelClient';

import { buildCodexCommand } from '../commands/chatgpt-web';
import {
  askProInstalledEntryFile,
  askProMcpInstalled,
  CODEX_ASK_PRO_MCP_NAME,
  codexProfileInstalled,
  ensureBridgeToken,
  installAskProServer,
  uninstallAskProServer,
  writeCodexProfile,
} from './chatgptWebCodexProfile';

/** Stable BYO provider id the bridge registers itself under on start. */
export const CHATGPT_WEB_PROVIDER_ID = 'chatgpt-web';
/**
 * Universal (non-Pro) bridge routes seeded on first registration. The
 * account-gated rows (`extra-high`, `pro`) and Luna routes stay a
 * discover-models / manual edit away — they depend on the signed-in account.
 */
export const CHATGPT_WEB_BRIDGE_MODELS: readonly string[] = CHATGPT_WEB_MODEL_ROUTES
  .filter((route) => !route.requiresPro)
  .map((route) => route.slug);

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
/** Whether THIS bridge session successfully ensured its BYO provider row. */
let bridgeProviderRegistered = false;
let loginCache: { authenticated: boolean; checkedAt: number } | null = null;
/** Background tunnel-client download kicked by a config save. */
let tunnelInstall: 'idle' | 'installing' | 'done' | 'failed' = 'idle';

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
  installing: boolean;
  running: boolean;
  healthy: boolean;
  ready: boolean;
  detail: string;
}

async function tunnelStatus(): Promise<TunnelStatusView> {
  const installed = existsSync(tunnelBinary());
  const installing = tunnelInstall === 'installing';
  if (!installed) {
    return {
      installed: false,
      installing,
      running: false,
      healthy: false,
      ready: false,
      detail: installing ? 'downloading tunnel-client…' : 'tunnel-client not installed',
    };
  }
  const { status, output } = await runBinary(tunnelBinary(), ['runtimes', 'status', 'omnicross-chatgpt-web', '--json'], 12_000);
  try {
    const parsed = JSON.parse(output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1)) as Record<string, unknown>;
    return {
      installed: true,
      installing: false,
      running: parsed['process_running'] === true,
      healthy: parsed['healthy'] === true,
      ready: parsed['ready'] === true,
      detail: `${String(parsed['runtime_state'] ?? '')}${parsed['stop_error'] ? `: ${String(parsed['stop_error'])}` : ''}`.trim(),
    };
  } catch {
    return { installed: true, installing: false, running: false, healthy: false, ready: false, detail: `status exit ${status ?? 'timeout'}` };
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

/** Stop our own Electron hosts — targeted, never by image name. */
async function stopOwnElectronHosts(): Promise<void> {
  const { stopExistingElectronHosts } = await import('@omnicross/chatgpt-web/browserHost/electronHost');
  await stopExistingElectronHosts(dataDir());
}

/**
 * Verify the persisted ChatGPT login. Fast path: the session cookie via a
 * live or short-lived hidden host. The cookie says "signed out" → confirm
 * against the real page (the DOM check) before reporting a definitive
 * signed-out, so cookie-shape changes never produce false negatives.
 */
async function probeLogin(): Promise<boolean> {
  const live = await liveLoginState();
  if (live === true) {
    loginCache = { authenticated: true, checkedAt: Date.now() };
    return true;
  }
  await stopOwnElectronHosts();
  const { startElectronHost } = await import('@omnicross/chatgpt-web/browserHost/electronHost');
  const host = await startElectronHost({ dataDir: dataDir() });
  try {
    const cookieState = await liveLoginState();
    if (cookieState === true) {
      loginCache = { authenticated: true, checkedAt: Date.now() };
      return true;
    }
    // Cookie-based check says no — confirm with the page itself.
    const { CdpConnection, inspectChatGptSession } = await import('@omnicross/chatgpt-web');
    const connection = new CdpConnection({
      endpoint: { port: host.port, wsPath: host.wsPath },
      targetFactory: host.targetFactory,
    });
    try {
      // inspectChatGptSession opens (and closes) its own background tab.
      const inspection = await inspectChatGptSession(connection, {});
      const authenticated = inspection.authenticated === true;
      loginCache = { authenticated, checkedAt: Date.now() };
      return authenticated;
    } finally {
      connection.close();
    }
  } finally {
    await host.stop();
  }
}

/**
 * The copy-paste command for the operator's shell: mirrors the flags the
 * daemon's own launch path uses (full model_providers definition — codex
 * rejects a bare `model_provider` selection — token via env_key, /v1 base).
 * Shell syntax per platform lives in buildCodexCommand (both forms must stay
 * paste-runnable: PowerShell statement vs POSIX prefix assignment).
 */
function codexCommandFor(): string {
  if (!bridge) return '';
  return buildCodexCommand({
    token: bridge.token,
    baseUrl: bridge.baseUrl,
    model: bridge.model,
  });
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
    codexCommand: codexCommandFor(),
    providerId: CHATGPT_WEB_PROVIDER_ID,
    providerRegistered: bridgeProviderRegistered,
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
    install: tunnelInstall,
    codex: { installed: codexProfileInstalled(), command: 'codex --profile chatgptweb' },
    askPro: {
      installed: askProMcpInstalled() && existsSync(askProInstalledEntryFile(dataDir())),
      entryFile: askProInstalledEntryFile(dataDir()),
      mcpName: CODEX_ASK_PRO_MCP_NAME,
    },
    bridge: bridgeView(),
  };
}

/** Kick the tunnel-client download in the background (idempotent). */
function kickTunnelInstall(): void {
  if (existsSync(tunnelBinary())) {
    tunnelInstall = 'done';
    return;
  }
  if (tunnelInstall === 'installing') return;
  tunnelInstall = 'installing';
  void installTunnelClient(join(dataDir(), 'bin'))
    .then(() => {
      tunnelInstall = 'done';
    })
    .catch(() => {
      tunnelInstall = 'failed';
    });
}

/** Save the harness config and start the tunnel-client download. */
async function saveConfig(tunnelId: string, runtimeKey: string): Promise<void> {
  if (!isValidTunnelId(tunnelId.trim())) {
    throw new Error('tunnel id must look like tunnel_<32 hex chars> (copy it from platform.openai.com → Tunnels)');
  }
  if (!runtimeKey.trim() || /\s/.test(runtimeKey)) {
    throw new Error('runtime key must be a non-empty single-line value (create one on platform.openai.com → API keys)');
  }
  saveHarnessConfig({ tunnelId: tunnelId.trim(), runtimeKey: runtimeKey.trim() });
  kickTunnelInstall();
}

/**
 * Optional seams the host (adminApi) injects. The bridge provider
 * registration lives in adminApi so it can reuse the provider CRUD's
 * persistence path (encrypt-at-rest + catalog hot-reload + routing rederive)
 * without an import cycle.
 */
export interface ChatGptWebHooks {
  /** Ensure the BYO provider row exists for a freshly started bridge.
   *  Best-effort at the call site: a failure must never take the (already
   *  running) bridge down with it — the row can be ensured on the next start. */
  registerBridgeProvider?: (bridge: { baseUrl: string; token: string }) => Promise<void>;
}

export async function handleChatGptWeb(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  rest: string[],
  hooks: ChatGptWebHooks = {},
): Promise<void> {
  const respond = (status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const fail = (status: number, message: string): void => respond(status, { error: { type: 'admin_api_error', message } });
  const readBody = async (): Promise<Record<string, unknown>> => {
    const raw = await new Promise<string>((resolve) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      req.on('end', () => resolve(body));
    });
    if (!raw.trim()) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };

  try {
    if (method === 'GET' && rest.length === 0) {
      return respond(200, await statusView());
    }
    if (method === 'POST' && rest[0] === 'config') {
      const body = await readBody();
      await saveConfig(String(body['tunnelId'] ?? ''), String(body['runtimeKey'] ?? ''));
      return respond(200, await statusView());
    }
    if (method === 'POST' && rest[0] === 'tunnel-install') {
      if (existsSync(tunnelBinary())) return respond(200, { installed: true });
      kickTunnelInstall();
      return respond(200, { started: true });
    }
    if (method === 'POST' && rest[0] === 'codex-setup') {
      const body = await readBody();
      const model = typeof body['model'] === 'string' && body['model'] ? body['model'] : 'chatgpt-web/light';
      const result = writeCodexProfile(dataDir(), { baseUrl: 'http://127.0.0.1:17850/v1', model });
      // A running bridge keeps serving its own (now persistent) token — the
      // profile just wrote the same one, so nothing to restart.
      return respond(200, {
        profileName: result.profileName,
        envVarWritten: result.envVarWritten,
        command: 'codex --profile chatgptweb',
      });
    }
    if (method === 'POST' && rest[0] === 'ask-pro' && rest[1] === 'install') {
      const body = await readBody();
      const model = typeof body['model'] === 'string' && body['model'] ? body['model'] : undefined;
      const writable = body['writable'] === true;
      const result = await installAskProServer(dataDir(), { model, writable });
      return respond(200, {
        installed: true,
        entryFile: result.entryFile,
        command: result.command,
        args: result.args,
        toolTimeoutSec: result.toolTimeoutSec,
        status: await statusView(),
      });
    }
    if (method === 'POST' && rest[0] === 'ask-pro' && rest[1] === 'uninstall') {
      const result = uninstallAskProServer(dataDir());
      return respond(200, { installed: false, configPath: result.configPath, removedEntry: result.removedEntry, status: await statusView() });
    }
    if (method === 'POST' && rest[0] === 'login') {
      // The login window is CDP-less (reference-implementation style) — it
      // must not share a profile with a running host, so free the lock first.
      await stopOwnElectronHosts();
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
      if (tunnelInstall === 'installing') {
        return fail(409, 'the tunnel client is still downloading — wait for the download to finish, then start again');
      }
      if (!existsSync(tunnelBinary())) {
        // The bridge would download it synchronously and hang the request
        // for minutes on a slow network — start it explicitly instead.
        kickTunnelInstall();
        return fail(409, 'the tunnel client is not installed yet — download started, try again when it finishes');
      }
      const body = await readBody();
      const model = typeof body['model'] === 'string' && body['model'] ? body['model'] : 'chatgpt-web/light';
      const harness = body['harness'] !== false;
      const { startChatGptWebBridge } = await import('@omnicross/chatgpt-web/server');
      // Persistent token: a codex profile baked into config.toml must keep
      // authenticating across bridge restarts.
      const token = ensureBridgeToken(dataDir());
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
      // The bridge IS a native Responses upstream — ensure its BYO provider
      // row so codex keeps using the single `omnicross` provider and routes
      // chatgpt-web/* models through the normal mapping table. Best-effort:
      // the bridge is already serving; registration retries on next start.
      bridgeProviderRegistered = false;
      try {
        await hooks.registerBridgeProvider?.({ baseUrl: handle.baseUrl, token });
        bridgeProviderRegistered = true;
      } catch (error) {
        console.error(
          '[chatgpt-web] bridge provider registration failed (the bridge keeps running):',
          error instanceof Error ? error.message : error,
        );
      }
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
