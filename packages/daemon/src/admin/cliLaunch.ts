/**
 * cliLaunch — the admin API's "launch a coding CLI in a terminal, pointed at the
 * daemon" surface (dashboard parity with the desktop app's Code CLI tab).
 *
 * This is the EXTERNAL-terminal analogue of `commands/launch.ts`: it reuses the
 * same `@omnicross/cli-launcher` builders (which register one route on the
 * RESIDENT `ProviderProxy` and return the redirect env — `ANTHROPIC_BASE_URL` +
 * a one-shot ROUTE token, codex's `-c base_url=…` overrides, etc.), then opens a
 * NEW terminal window running the CLI with that env injected. The route token —
 * NOT an upstream credential — is the only secret in the env; it is removed when
 * the session is stopped (`onSessionEnd`).
 *
 * SECRET DISCIPLINE: the env carries a route token (proxy-scoped, revocable),
 * never a provider key. On win32 the token rides the spawned process environment
 * (inherited by the terminal), never the command line / a file on disk.
 *
 * @module @omnicross/daemon/admin/cliLaunch
 */

import { exec, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import {
  buildChatCliLaunchConfig,
  buildClaudeCliLaunchConfig,
  buildCodexLaunchConfig,
  buildGeminiCliLaunchConfig,
  type ChatCliBackendId,
  type ChatCliLaunchConfig,
} from '@omnicross/cli-launcher';
import type { ProviderConfigSource } from '@omnicross/core';
import {
  ROUTE_LEASE_REQUEST_SCHEMA,
  RouteLeaseError,
  type RouteLeaseManager,
} from '@omnicross/core/provider-proxy';

import { startTerminalLeaseRenewal } from '../routeLeaseRenewal';

/** The CLIs the dashboard can launch (one per cli-launcher builder). */
export const LAUNCHABLE_CLIS = [
  { id: 'claude', displayName: 'Claude Code', command: 'claude' },
  { id: 'codex', displayName: 'Codex CLI', command: 'codex' },
  { id: 'gemini', displayName: 'Gemini CLI', command: 'gemini' },
  { id: 'qwen', displayName: 'Qwen Code', command: 'qwen' },
  { id: 'copilot', displayName: 'GitHub Copilot CLI', command: 'copilot' },
  { id: 'opencode', displayName: 'OpenCode', command: 'opencode' },
] as const;

export type LaunchCliId = (typeof LAUNCHABLE_CLIS)[number]['id'];

/**
 * Per-CLI global install command (run on the daemon host). CLIs absent from this
 * map are manual-install only — the dashboard hides the Install button for them.
 * `Partial` keeps the absence meaningful even though every launchable CLI
 * currently has one.
 */
export const INSTALL_COMMANDS: Partial<Record<LaunchCliId, string>> = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
  gemini: 'npm install -g @google/gemini-cli',
  qwen: 'npm install -g @qwen-code/qwen-code',
  copilot: 'npm install -g @github/copilot',
  opencode: 'npm install -g opencode-ai',
};

const LAUNCHABLE_IDS = new Set<string>(LAUNCHABLE_CLIS.map((c) => c.id));
export function isLaunchCliId(id: string | undefined): id is LaunchCliId {
  return id !== undefined && LAUNCHABLE_IDS.has(id);
}

/** Injectable PATH probe (tests stub this; default scans `process.env.PATH`). */
export type PathProbe = (candidate: string) => string | null;

function probeDefault(candidate: string): string | null {
  const segments = (process.env['PATH'] ?? '').split(delimiter).filter(Boolean);
  for (const seg of segments) {
    const full = join(seg, candidate);
    if (existsSync(full)) return full;
  }
  return null;
}

/** Is the CLI's binary resolvable on PATH (platform-aware extensions)? */
export function isCliInstalled(
  command: string,
  platform: NodeJS.Platform = process.platform,
  probe: PathProbe = probeDefault,
): boolean {
  if (platform === 'win32') {
    return Boolean(probe(`${command}.exe`) || probe(`${command}.cmd`) || probe(`${command}.bat`));
  }
  return Boolean(probe(command));
}

/** One row of the CLI availability list. */
export interface CliStatus {
  id: LaunchCliId;
  displayName: string;
  command: string;
  installed: boolean;
  /** Has a known global install command (dashboard shows an Install button). */
  installable: boolean;
}

export function detectClis(
  platform: NodeJS.Platform = process.platform,
  probe: PathProbe = probeDefault,
): CliStatus[] {
  return LAUNCHABLE_CLIS.map((c) => ({
    id: c.id,
    displayName: c.displayName,
    command: c.command,
    installed: isCliInstalled(c.command, platform, probe),
    installable: Boolean(INSTALL_COMMANDS[c.id]),
  }));
}

/** Pick the provider+model a launch routes through (explicit, else first enabled). */
export interface LaunchTarget {
  providerId: string;
  model: string;
}

interface ProviderRowLike {
  id: string;
  enabled?: boolean;
  models?: string[];
  modelConfigs?: Array<{ id: string }>;
}

/** Resolve the launch target from the provider catalog (throws if none usable). */
export function resolveLaunchTarget(
  providers: ProviderRowLike[],
  requested?: { providerId?: string; model?: string },
): LaunchTarget {
  const pick =
    (requested?.providerId
      ? providers.find((p) => p.id === requested.providerId)
      : undefined) ??
    providers.find((p) => p.enabled !== false && firstModel(p)) ??
    providers.find((p) => firstModel(p));
  if (!pick) {
    throw new Error('no provider with a model is configured — add one on the Providers page first');
  }
  const model = requested?.model || firstModel(pick);
  if (!model) {
    throw new Error(`provider "${pick.id}" has no models — add a model on the Providers page first`);
  }
  return { providerId: pick.id, model };
}

function firstModel(p: ProviderRowLike): string | undefined {
  return p.models?.[0] ?? p.modelConfigs?.[0]?.id;
}

/** Dispatch to the matching cli-launcher builder (registers the resident route). */
export async function buildLaunchEnv(
  cli: LaunchCliId,
  llmConfig: ProviderConfigSource,
  target: LaunchTarget,
): Promise<ChatCliLaunchConfig & { extraArgs?: string[] }> {
  const common = {
    llmConfig,
    providerId: target.providerId,
    model: target.model,
    sessionId: `dashboard:${cli}`,
  };
  switch (cli) {
    case 'claude':
      return buildClaudeCliLaunchConfig(common);
    case 'codex':
      return buildCodexLaunchConfig(common);
    case 'gemini':
      return buildGeminiCliLaunchConfig(common);
    case 'qwen':
    case 'copilot':
    case 'opencode':
      return buildChatCliLaunchConfig({ backendId: cli as ChatCliBackendId, ...common });
  }
}

/** Open a NEW terminal window running `command [extraArgs…]` with `env` injected. */
export type TerminalCleanup = () => void;

export type TerminalOpener = (input: {
  cli: string;
  command: string;
  extraArgs: string[];
  env: Record<string, string>;
  cwd?: string;
  platform: NodeJS.Platform;
  onFailure?: () => void;
}) => void | TerminalCleanup;

/** Single-quote a posix shell word. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Secret-free bootstrap used by macOS Terminal. The descriptor arrives over a
 * private one-shot local socket, then only the final CLI child receives it.
 */
export const MAC_TERMINAL_BOOTSTRAP_SOURCE = `
'use strict';
const fs = require('node:fs');
const net = require('node:net');
const { spawn } = require('node:child_process');
const [socketPath, launchDir, cwd, command, ...args] = process.argv.slice(2);
let payload = '';
const socket = net.createConnection(socketPath);
socket.setEncoding('utf8');
socket.on('data', (chunk) => { payload += chunk; });
socket.on('end', () => {
  const descriptor = JSON.parse(payload);
  if (!descriptor || Array.isArray(descriptor) || Object.values(descriptor).some((value) => typeof value !== 'string')) {
    throw new Error('invalid terminal launch descriptor');
  }
  try { fs.rmSync(launchDir, { recursive: true, force: true }); } catch {}
  const child = spawn(command, args, {
    cwd: cwd || undefined,
    env: { ...process.env, ...descriptor },
    stdio: 'inherit',
  });
  child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code == null ? 1 : code;
  });
});
socket.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
`;

const MAC_TERMINAL_IPC_TIMEOUT_MS = 120_000;
type TerminalSpawn = typeof spawn;

export interface MacTerminalIpcOptions {
  socketPath?: string;
  timeoutMs?: number;
  onListening?: () => void;
  onClaimed?: () => void;
  onAccepted?: (socket: Socket) => void;
  removeArtifacts?: (launchDir: string) => void;
}

/**
 * Default opener. POSIX command strings contain command/cwd arguments but no
 * environment values. macOS transfers its descriptor through private IPC
 * because Launch Services does not propagate the `open` process environment.
 */
export function openTerminal(
  { cli, command, extraArgs, env, cwd, platform, onFailure }: Parameters<TerminalOpener>[0],
  spawnProcess: TerminalSpawn = spawn,
  macIpc: MacTerminalIpcOptions = {},
): () => void {
  const childEnv = { ...process.env, ...env };
  if (platform === 'win32') {
    const args = ['/c', 'start', `"omnicross ${cli}"`];
    if (cwd) args.push('/D', `"${cwd}"`);
    args.push('cmd', '/k', command, ...extraArgs);
    spawnProcess(process.env['ComSpec'] || 'cmd.exe', args, {
      env: childEnv,
      windowsVerbatimArguments: true,
      detached: true,
      stdio: 'ignore',
    }).unref();
    return () => {};
  }

  const runLine = [command, ...extraArgs].map(shq).join(' ');
  const script = `${cwd ? `cd ${shq(cwd)}; ` : ''}${runLine}`;

  if (platform === 'darwin') {
    const launchDir = mkdtempSync(join(tmpdir(), 'omnicross-terminal-'));
    const commandFile = join(launchDir, 'launch.command');
    const bootstrapFile = join(launchDir, 'bootstrap.cjs');
    const socketPath = macIpc.socketPath ?? join(launchDir, 'descriptor.sock');
    const openerEnv = { ...process.env };
    for (const key of Object.keys(env)) delete openerEnv[key];
    let claimed = false;
    let cleaned = false;
    let failureNotified = false;
    let timer: NodeJS.Timeout | undefined;
    const notifyFailure = (): void => {
      cleanup();
      if (failureNotified) return;
      failureNotified = true;
      try {
        onFailure?.();
      } catch {}
    };
    const handleLaunchFailure = (): void => {
      if (claimed) cleanup();
      else notifyFailure();
    };
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      socket.unref();
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      try {
        macIpc.onAccepted?.(socket);
      } catch {
        cleanup();
        return;
      }
      if (claimed || cleaned) {
        socket.destroy();
        return;
      }
      claimed = true;
      try {
        macIpc.onClaimed?.();
        if (cleaned) return;
        socket.end(JSON.stringify(env), cleanup);
      } catch {
        cleanup();
      }
    });
    const cleanup = (): void => {
      if (!cleaned) {
        cleaned = true;
        if (timer) clearTimeout(timer);
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        try {
          server.close();
        } catch {}
      }
      try {
        if (macIpc.removeArtifacts) {
          macIpc.removeArtifacts(launchDir);
        } else {
          rmSync(launchDir, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 20,
          });
        }
      } catch {}
    };

    try {
      writeFileSync(bootstrapFile, MAC_TERMINAL_BOOTSTRAP_SOURCE, { encoding: 'utf8', mode: 0o700 });
      writeFileSync(commandFile, `#!/bin/bash\nrm -f -- "$0"\nexec ${shq(process.execPath)} ${shq(bootstrapFile)} ${shq(socketPath)} ${shq(launchDir)} ${shq(cwd ?? '')} ${runLine}\n`, {
        encoding: 'utf8',
        mode: 0o700,
      });
      chmodSync(commandFile, 0o700);
      chmodSync(bootstrapFile, 0o700);

      server.once('error', handleLaunchFailure);
      server.listen(socketPath, () => {
        if (cleaned) return;
        try {
          macIpc.onListening?.();
          if (cleaned) return;
          if (process.platform !== 'win32') chmodSync(socketPath, 0o600);
          const opener = spawnProcess('open', ['-n', '-a', 'Terminal', commandFile], {
            env: openerEnv,
            detached: true,
            stdio: 'ignore',
          });
          opener.once('error', handleLaunchFailure);
          opener.unref();
          server.unref();
        } catch {
          handleLaunchFailure();
        }
      });
      timer = setTimeout(handleLaunchFailure, macIpc.timeoutMs ?? MAC_TERMINAL_IPC_TIMEOUT_MS);
      timer.unref?.();
      return cleanup;
    } catch (error) {
      cleanup();
      throw error;
    }
  }
  // linux (best-effort): the generic Debian alternative, keep the shell open.
  spawnProcess('x-terminal-emulator', ['-e', 'bash', '-lc', `${script}; exec bash`], {
    env: childEnv,
    detached: true,
    stdio: 'ignore',
  }).unref();
  return () => {};
}

export const defaultTerminalOpener: TerminalOpener = (input) => openTerminal(input);

// ── Session registry + admin handlers ─────────────────────────────────────────
//
// A launched CLI runs in a DETACHED external terminal the daemon cannot track, so
// its resident route stays registered until the user stops it (or the daemon
// restarts). The registry holds the `onSessionEnd` (route removal) per launch.

interface CliSession {
  id: string;
  cli: LaunchCliId;
  providerId: string;
  model: string;
  leaseId?: string;
  startedAt: string;
  onSessionEnd: () => void;
}

const sessions = new Map<string, CliSession>();

/** Tear down every live route (test isolation + daemon shutdown hook). */
export function resetCliSessions(): void {
  for (const s of sessions.values()) {
    try {
      s.onSessionEnd();
    } catch {
      // best-effort
    }
  }
  sessions.clear();
}

export interface CliHandlerResult {
  status: number;
  body: unknown;
}

function errBody(message: string): { error: { type: string; message: string } } {
  return { error: { type: 'admin_api_error', message } };
}

/**
 * Injectable shell runner for `POST /cli/:cli/install` (tests stub this; the
 * default execs the install command with a bounded timeout). Returns the host's
 * honest install outcome — `error` carries stderr/the failure reason.
 */
export type CommandRunner = (command: string) => Promise<{ ok: boolean; error?: string }>;

const defaultCommandRunner: CommandRunner = (command) =>
  new Promise((resolve) => {
    exec(command, { timeout: 180_000 }, (err, _stdout, stderr) => {
      if (err) resolve({ ok: false, error: stderr.trim() || err.message });
      else resolve({ ok: true });
    });
  });

/**
 * POST /cli/:cli/install → run the CLI's global install command on the daemon
 * host (npm/curl). STATUS-ONLY `{ ok: true }` on success; a 400 when the CLI has
 * no known install command, a 500 (with the failure reason) when the command
 * fails. No secret is involved — this is a plain package-manager invocation.
 */
export async function handleCliInstall(
  cli: LaunchCliId,
  runner: CommandRunner = defaultCommandRunner,
): Promise<CliHandlerResult> {
  const cmd = INSTALL_COMMANDS[cli];
  if (!cmd) {
    return { status: 400, body: errBody(`no install command for cli '${cli}' (manual install only)`) };
  }
  const result = await runner(cmd);
  if (!result.ok) {
    return { status: 500, body: errBody(result.error || 'install failed') };
  }
  return { status: 200, body: { ok: true } };
}

/** GET /cli → the per-CLI availability list. */
export function handleCliList(
  platform: NodeJS.Platform = process.platform,
  probe: PathProbe = probeDefault,
): CliHandlerResult {
  return { status: 200, body: { clis: detectClis(platform, probe) } };
}

/** GET /cli/sessions → the running launches (token-free). */
export function handleCliSessions(): CliHandlerResult {
  const list = [...sessions.values()].map(({ onSessionEnd: _drop, ...rest }) => rest);
  return { status: 200, body: { sessions: list } };
}

/** DELETE /cli/sessions/:id → remove the route + forget the session. */
export function handleCliStop(id: string): CliHandlerResult {
  const s = sessions.get(id);
  if (!s) return { status: 404, body: errBody(`session '${id}' not found`) };
  try {
    s.onSessionEnd();
  } catch {
    // best-effort
  }
  sessions.delete(id);
  return { status: 200, body: { ok: true } };
}

/** Context the launch handler needs (the caller supplies the live deps). */
export interface CliLaunchContext {
  llmConfig: ProviderConfigSource;
  providers: ProviderRowLike[];
  /** Daemon-owned Route Lease service used by Claude/Codex launches. */
  routeLeaseManager?: RouteLeaseManager;
  opener?: TerminalOpener;
  platform?: NodeJS.Platform;
  probe?: PathProbe;
}

interface LaunchMaterial {
  readonly env: Record<string, string>;
  readonly extraArgs?: string[];
  readonly onSessionEnd: () => void;
}


/**
 * POST /cli/:cli/launch { providerId?, model?, cwd? } → register the resident
 * route, open a terminal with the redirect env, track the session. STATUS-ONLY:
 * the response carries the sessionId + resolved provider/model — NEVER the route
 * token (it rides only the spawned terminal's environment).
 */
export async function handleCliLaunch(
  cli: LaunchCliId,
  body: Record<string, unknown>,
  ctx: CliLaunchContext,
): Promise<CliHandlerResult> {
  const platform = ctx.platform ?? process.platform;
  const probe = ctx.probe ?? probeDefault;
  const meta = LAUNCHABLE_CLIS.find((c) => c.id === cli);
  if (!meta) return { status: 404, body: errBody(`unknown cli '${cli}'`) };
  if (!isCliInstalled(meta.command, platform, probe)) {
    return { status: 400, body: errBody(`"${meta.command}" is not installed (not found on PATH)`) };
  }

  let target: LaunchTarget;
  try {
    target = resolveLaunchTarget(ctx.providers, {
      providerId: typeof body['providerId'] === 'string' ? body['providerId'] : undefined,
      model: typeof body['model'] === 'string' ? body['model'] : undefined,
    });
  } catch (err) {
    return { status: 400, body: errBody(err instanceof Error ? err.message : 'no launch target') };
  }

  const id = randomUUID();
  let leaseId: string | undefined;
  let launch: LaunchMaterial;
  try {
    if ((cli === 'claude' || cli === 'codex') && ctx.routeLeaseManager) {
      const outcome = await ctx.routeLeaseManager.createFromRequest({
        schemaVersion: ROUTE_LEASE_REQUEST_SCHEMA,
        consumer: 'omnicross-terminal',
        runtime: cli,
        upstream: { kind: 'provider', providerId: target.providerId },
        model: target.model,
        execution: { sessionId: id },
      }, `omnicross-terminal:${id}`);
      leaseId = outcome.result.leaseId;
      const stopRenewal = startTerminalLeaseRenewal(ctx.routeLeaseManager, leaseId);
      launch = {
        env: outcome.result.launch.env,
        extraArgs: outcome.result.launch.extraArgs,
        onSessionEnd: () => {
          stopRenewal();
          ctx.routeLeaseManager?.release(outcome.result.leaseId);
        },
      };
    } else {
      launch = await buildLaunchEnv(cli, ctx.llmConfig, target);
    }
  } catch (err) {
    const status = err instanceof RouteLeaseError ? err.status : 400;
    return { status, body: errBody(err instanceof Error ? err.message : 'failed to build launch env') };
  }

  const cwd = typeof body['cwd'] === 'string' && body['cwd'].trim() ? body['cwd'].trim() : undefined;
  const opener = ctx.opener ?? defaultTerminalOpener;
  let openerCleanup: TerminalCleanup | undefined;
  let ended = false;
  let published = false;
  const onSessionEnd = (): void => {
    if (ended) return;
    ended = true;
    if (published) sessions.delete(id);
    try {
      openerCleanup?.();
    } finally {
      launch.onSessionEnd();
    }
  };
  try {
    const cleanup = opener({
      cli,
      command: meta.command,
      extraArgs: launch.extraArgs ?? [],
      env: launch.env,
      cwd,
      platform,
      onFailure: onSessionEnd,
    });
    if (cleanup) openerCleanup = cleanup;
  } catch (err) {
    onSessionEnd();
    return { status: 500, body: errBody(err instanceof Error ? err.message : 'failed to open terminal') };
  }
  if (ended) {
    openerCleanup?.();
    return { status: 500, body: errBody('failed to open terminal') };
  }

  sessions.set(id, {
    id,
    cli,
    providerId: target.providerId,
    model: target.model,
    ...(leaseId ? { leaseId } : {}),
    startedAt: new Date().toISOString(),
    onSessionEnd,
  });
  published = true;
  if (ended) sessions.delete(id);
  return { status: 200, body: { sessionId: id, providerId: target.providerId, model: target.model } };
}
